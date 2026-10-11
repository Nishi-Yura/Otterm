//! One otterm per user (docs/06 §4, decision K6): a later `otterm [path]` opens a tab in the
//! window that is already running, and `otterm workflow run` / `otterm ask` talk to it.
//!
//! The running app listens on a named pipe (Windows) or a Unix domain socket. Each start writes a
//! fresh random token to the data folder, readable by the owner only; a request without it is
//! refused, so another user on the same machine cannot drive this user's terminal.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::time::Duration;

use interprocess::local_socket::prelude::*;
use interprocess::local_socket::{GenericFilePath, GenericNamespaced, ListenerOptions, Name, Stream};
use serde::{Deserialize, Serialize};

/// What a later launch asks of the running app.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Request {
    /// A new tab: `otterm [path] [--profile id] [-e command...]`.
    Open { cwd: Option<PathBuf>, command: Option<Vec<String>>, profile: Option<String> },
    /// `otterm workflow run <name>`.
    Workflow { name: String },
    /// `otterm ask [question]`.
    Ask { question: Option<String> },
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    token: String,
    request: Request,
}

#[derive(Serialize, Deserialize)]
pub struct Reply {
    pub ok: bool,
    #[serde(default)]
    pub message: String,
}

impl Reply {
    pub fn ok() -> Self {
        Self { ok: true, message: String::new() }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self { ok: false, message: message.into() }
    }
}

/// How long a request may wait for the running app.
const TIMEOUT: Duration = Duration::from_secs(5);

fn state_dir() -> Option<PathBuf> {
    otterm_config::data_dir().map(|d| d.join("state"))
}

/// The per-user name: a named pipe on Windows, an abstract socket on Linux, a socket file in the
/// data folder where neither exists (macOS).
fn name() -> std::io::Result<Name<'static>> {
    let user = std::env::var(if cfg!(windows) { "USERNAME" } else { "USER" }).unwrap_or_default();
    let user: String = user.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')).collect();
    if GenericNamespaced::is_supported() {
        format!("otterm-{user}.sock").to_ns_name::<GenericNamespaced>().map(|n| n.into_owned())
    } else {
        let dir = state_dir().ok_or_else(|| std::io::Error::other("no data folder"))?;
        dir.join("otterm.sock").to_fs_name::<GenericFilePath>().map(|n| n.into_owned())
    }
}

fn token_path() -> Option<PathBuf> {
    state_dir().map(|d| d.join("ipc-token"))
}

/// Hand `request` to the running app. `None` when no otterm is running (or it does not answer).
pub fn send(request: Request) -> Option<Reply> {
    let token = std::fs::read_to_string(token_path()?).ok()?;
    let stream = Stream::connect(name().ok()?).ok()?;
    let mut line = serde_json::to_string(&Envelope { token: token.trim().to_owned(), request }).ok()?;
    line.push('\n');
    let mut reader = BufReader::new(stream);
    reader.get_mut().write_all(line.as_bytes()).ok()?;
    // The pipe has no read timeout of its own; a reader thread gives up after TIMEOUT.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut answer = String::new();
        let _ = tx.send(reader.read_line(&mut answer).ok().map(|_| answer));
    });
    let answer = rx.recv_timeout(TIMEOUT).ok()??;
    serde_json::from_str(&answer).ok()
}

/// Start listening as the running app; `handle` answers each request from a background thread.
/// Fails when another otterm already listens (then this one simply runs on its own).
pub fn listen(handle: impl Fn(Request) -> Reply + Send + 'static) -> std::io::Result<()> {
    let name = name()?;
    if !GenericNamespaced::is_supported()
        && let Some(dir) = state_dir()
    {
        std::fs::create_dir_all(&dir)?;
        // A socket file left by an otterm that crashed; a live one answered `send` already.
        let _ = std::fs::remove_file(dir.join("otterm.sock"));
    }
    let listener = ListenerOptions::new().name(name).create_sync()?;
    let token = write_token()?;
    std::thread::Builder::new().name("instance".into()).spawn(move || {
        for conn in listener.incoming().flatten() {
            let mut reader = BufReader::new(conn);
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                continue;
            }
            let reply = match serde_json::from_str::<Envelope>(&line) {
                Ok(e) if same(&e.token, &token) => handle(e.request),
                Ok(_) => Reply::error("wrong token"),
                Err(e) => Reply::error(e.to_string()),
            };
            if let Ok(mut text) = serde_json::to_string(&reply) {
                text.push('\n');
                let _ = reader.get_mut().write_all(text.as_bytes());
            }
        }
    })?;
    Ok(())
}

/// A new random token in `state/ipc-token`, readable by this user only.
fn write_token() -> std::io::Result<String> {
    let path = token_path().ok_or_else(|| std::io::Error::other("no data folder"))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    // %LOCALAPPDATA% is already private to the user on Windows.
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(&path)?.write_all(token.as_bytes())?;
    Ok(token)
}

/// Compare without stopping at the first difference.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
