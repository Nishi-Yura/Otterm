//! The `--help` cache (decision B9). otterm learns a command's help text only after the user has run
//! that command once, in a background thread. Typing never starts a program. The cache is kept in
//! `<data>/help-cache.json`.

use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, MutexGuard, PoisonError, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use crate::history::now_ms;

/// A learned entry is trusted for this long. Older entries are learned again when the command runs.
const MAX_AGE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const RUN_TIMEOUT: Duration = Duration::from_secs(2);
/// Output kept per stream. Anything beyond is read and dropped.
const MAX_OUTPUT: usize = 256 * 1024;
const MAX_OPTIONS: usize = 60;
const MAX_SUMMARY: usize = 200;
const MAN_LINES: usize = 200;

/// Commands that are never run, even with `--help`. Matched without a `.exe` or `.com` suffix.
/// Includes the shell builtins, which are not programs at all.
const SKIP: &[&str] = &[
    "rm", "del", "erase", "rmdir", "rd", "unlink", "shred", "format", "shutdown", "reboot", "halt", "poweroff", "mkfs",
    "dd", "fdisk", "parted", "wipefs", "diskpart", "reg", "sudo", "su", "doas", "alias", "bg", "bind", "break",
    "builtin", "cd", "cls", "command", "continue", "copy", "declare", "dir", "echo", "eval", "exec", "exit", "export",
    "false", "fc", "fg", "getopts", "hash", "help", "history", "jobs", "let", "local", "logout", "move", "popd",
    "pushd", "pwd", "read", "readonly", "ren", "return", "set", "shift", "source", "test", "times", "trap", "true",
    "type", "typeset", "ulimit", "umask", "unalias", "unset", "wait",
];

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// What one command's help says. Stored in `help-cache.json`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelpEntry {
    /// The command name, as the user typed it.
    pub name: String,
    /// The first meaningful line of the help text (a sentence describing the command), trimmed, at
    /// most 200 characters.
    pub summary: String,
    /// Options found in the help text: the flags (`-f`, `--force`) and their one-line description.
    /// At most 60.
    pub options: Vec<(Vec<String>, String)>,
    /// ms since the Unix epoch when the help text was read.
    pub fetched_at: i64,
}

struct State {
    entries: HashMap<String, HelpEntry>,
    /// Names being learned right now, so the same command is not started twice.
    inflight: HashSet<String>,
}

/// The learned help texts. Keep one for the whole app, as a `&'static` (for example in a
/// `OnceLock` or leaked once), because `learn` runs its work on a thread.
pub struct HelpCache {
    /// `<data>/help-cache.json`, or None when there is no data folder (then nothing is saved).
    path: Option<PathBuf>,
    state: Mutex<State>,
}

impl HelpCache {
    /// Load the cache from `<data_dir>/help-cache.json`. A missing or broken file starts empty.
    pub fn open(data_dir: Option<PathBuf>) -> Self {
        let path = data_dir.map(|d| d.join("help-cache.json"));
        let entries = path
            .as_ref()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<HashMap<String, HelpEntry>>(&s).ok())
            .unwrap_or_default();
        Self { path, state: Mutex::new(State { entries, inflight: HashSet::new() }) }
    }

    /// The learned entry for `name`, however old it is.
    pub fn get(&self, name: &str) -> Option<HelpEntry> {
        self.lock().entries.get(name).cloned()
    }

    /// Learn `name` on a background thread, unless it was learned within the last 30 days or is
    /// already being learned. Names that are not bare program names are ignored (see `learnable`).
    /// Nothing is cached when the command gives no help text.
    pub fn learn(&'static self, name: &str) {
        if !learnable(name) {
            return;
        }
        {
            let mut state = self.lock();
            let fresh = state.entries.get(name).is_some_and(|e| now_ms().saturating_sub(e.fetched_at) < MAX_AGE_MS);
            if fresh || !state.inflight.insert(name.to_owned()) {
                return;
            }
        }
        let name = name.to_owned();
        thread::spawn(move || {
            let learned = fetch(&name);
            let mut state = self.lock();
            state.inflight.remove(&name);
            if let Some(entry) = learned {
                state.entries.insert(name, entry);
                self.save(&state.entries);
            }
        });
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Write the whole map to the JSON file through a `.tmp` file, so a crash never leaves half a file.
    fn save(&self, entries: &HashMap<String, HelpEntry>) {
        let Some(path) = &self.path else {
            return;
        };
        let Ok(json) = serde_json::to_string(entries) else {
            return;
        };
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let tmp = path.with_extension("json.tmp");
        if fs::write(&tmp, json).is_ok() {
            let _ = fs::rename(&tmp, path);
        }
    }
}

/// Only bare program names: no paths and no `:`. A dash is fine (`docker-compose`, `git-lfs`), but a
/// PowerShell cmdlet (`Get-Item`: capitalised Verb-Noun) is not a program. Shell builtins and
/// commands that change disks, accounts or the system are skipped.
fn learnable(name: &str) -> bool {
    if name.is_empty() || name.len() > 100 || name.starts_with('.') || name.starts_with('-') {
        return false;
    }
    if !name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-')) {
        return false;
    }
    let cmdlet = name.split_once('-').is_some_and(|(verb, noun)| {
        verb.starts_with(|c: char| c.is_ascii_uppercase()) && noun.starts_with(|c: char| c.is_ascii_uppercase())
    });
    if cmdlet {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    let stem = lower.strip_suffix(".exe").or_else(|| lower.strip_suffix(".com")).unwrap_or(&lower);
    !(SKIP.contains(&stem) || stem.starts_with("mkfs"))
}

/// Run the command with `--help` (or `-h`), and on Unix `man` when there is no output at all.
fn fetch(name: &str) -> Option<HelpEntry> {
    let program = resolve(name)?;
    let (mut text, code) = run(&program, &["--help"]);
    if text.trim().is_empty() || (code != Some(0) && text.len() < 40) {
        let (alt, _) = run(&program, &["-h"]);
        if !alt.trim().is_empty() {
            text = alt;
        }
    }
    let mut from_man = false;
    if text.trim().is_empty() && cfg!(unix) {
        let (man, _) = run(Path::new("man"), &["-P", "cat", name]);
        text = man.lines().take(MAN_LINES).collect::<Vec<_>>().join("\n");
        from_man = true;
    }

    let summary = if from_man {
        man_summary(&text).unwrap_or_else(|| first_summary(&text, name))
    } else {
        first_summary(&text, name)
    };
    let options = parse_options(&text);
    if summary.is_empty() && options.is_empty() {
        return None;
    }
    Some(HelpEntry { name: name.to_owned(), summary, options, fetched_at: now_ms() })
}

/// Find the program on PATH. On Windows only `.exe` and `.com` are used, never `.cmd`, `.bat` or
/// `.ps1`, so no script runs.
fn resolve(name: &str) -> Option<PathBuf> {
    let dirs = env::var_os("PATH")?;
    let candidates: Vec<String> = if cfg!(windows) {
        let lower = name.to_ascii_lowercase();
        if lower.ends_with(".exe") || lower.ends_with(".com") {
            vec![name.to_owned()]
        } else {
            vec![format!("{name}.exe"), format!("{name}.com")]
        }
    } else {
        vec![name.to_owned()]
    };
    env::split_paths(&dirs).flat_map(|dir| candidates.iter().map(move |c| dir.join(c))).find(|p| is_program(p))
}

fn is_program(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    meta.is_file() && executable(&meta)
}

#[cfg(unix)]
fn executable(meta: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn executable(_meta: &fs::Metadata) -> bool {
    true
}

/// Run a program with stdin closed, output captured, `PAGER=cat`, and a 2 s limit (it is killed
/// after that). Returns stdout then stderr, cleaned of terminal codes, and the exit code (None when
/// killed).
fn run(program: &Path, args: &[&str]) -> (String, Option<i32>) {
    let mut cmd = Command::new(program);
    cmd.args(args).env("PAGER", "cat").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let Ok(mut child) = cmd.spawn() else {
        return (String::new(), None);
    };

    let (tx, rx) = mpsc::channel();
    if let Some(out) = child.stdout.take() {
        drain(out, 0, tx.clone());
    }
    if let Some(err) = child.stderr.take() {
        drain(err, 1, tx.clone());
    }
    drop(tx);

    let deadline = Instant::now() + RUN_TIMEOUT;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };

    // A grandchild may keep a pipe open, so do not wait for the readers for long.
    let mut parts: [Vec<u8>; 2] = [Vec::new(), Vec::new()];
    for _ in 0..2 {
        match rx.recv_timeout(Duration::from_millis(300)) {
            Ok((index, bytes)) => parts[index] = bytes,
            Err(_) => break,
        }
    }
    let [out, err] = parts;
    let mut text = String::from_utf8_lossy(&out).into_owned();
    if !err.is_empty() {
        text.push('\n');
        text.push_str(&String::from_utf8_lossy(&err));
    }
    (clean(&text), code)
}

/// Read a pipe to its end on a thread and send what was kept, tagged with `index`.
fn drain<R: Read + Send + 'static>(mut src: R, index: usize, tx: mpsc::Sender<(usize, Vec<u8>)>) {
    thread::spawn(move || {
        let mut kept = Vec::new();
        let mut chunk = [0u8; 8192];
        while let Ok(n) = src.read(&mut chunk) {
            if n == 0 {
                break;
            }
            let room = MAX_OUTPUT.saturating_sub(kept.len());
            kept.extend_from_slice(&chunk[..n.min(room)]);
        }
        let _ = tx.send((index, kept));
    });
}

/// Remove ANSI escape sequences, carriage returns, and man-page overstrikes (`x<BS>x`).
fn clean(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => {
                // CSI sequences end at a byte in '@'..='~'. Other escapes are two characters.
                if chars.next() == Some('[') {
                    for d in chars.by_ref() {
                        if ('@'..='~').contains(&d) {
                            break;
                        }
                    }
                }
            }
            '\u{8}' => {
                out.pop();
            }
            '\r' => {}
            _ => out.push(c),
        }
    }
    out
}

/// The first meaningful line: not blank, not in a usage block (from `usage:` to the next blank line),
/// not an option, not a heading that ends with `:`, and not the version line (`<name> 1.2.3` or
/// `<name> version 1.2.3`).
fn first_summary(text: &str, name: &str) -> String {
    let mut in_usage = false;
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() {
            in_usage = false;
            continue;
        }
        if in_usage {
            continue;
        }
        if t.to_ascii_lowercase().starts_with("usage:") {
            in_usage = true;
            continue;
        }
        if t.starts_with('-') || t.ends_with(':') || is_version_line(t, name) {
            continue;
        }
        return clip(t);
    }
    String::new()
}

fn is_version_line(line: &str, name: &str) -> bool {
    let Some(rest) = line.get(..name.len()) else {
        return false;
    };
    if !rest.eq_ignore_ascii_case(name) {
        return false;
    }
    let rest = line[name.len()..].trim_start().to_ascii_lowercase();
    let rest = rest.strip_prefix("version").unwrap_or(&rest).trim_start();
    let rest = rest.strip_prefix('v').unwrap_or(rest);
    rest.starts_with(|c: char| c.is_ascii_digit())
}

/// The description after the `NAME` heading of a man page: `git - the stupid content tracker`.
fn man_summary(text: &str) -> Option<String> {
    let mut lines = text.lines();
    lines.by_ref().find(|l| l.trim() == "NAME")?;
    let desc = lines.map(str::trim).find(|l| !l.is_empty())?;
    let desc = desc.split_once(" - ").map_or(desc, |(_, d)| d);
    Some(clip(desc))
}

fn clip(s: &str) -> String {
    s.chars().take(MAX_SUMMARY).collect()
}

fn parse_options(text: &str) -> Vec<(Vec<String>, String)> {
    text.lines().filter_map(parse_option_line).take(MAX_OPTIONS).collect()
}

/// One option line, in the shape
/// `^\s{1,8}(-{1,2}[\w-]+(?:[ =,]\s*-{1,2}[\w-]+)*)(?:[ =]\S+)?\s{2,}(.+)$`:
/// 1 to 8 leading spaces, one or more flags, an optional argument name, two or more spaces, then
/// the description.
fn parse_option_line(line: &str) -> Option<(Vec<String>, String)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if !(1..=8).contains(&indent) {
        return None;
    }
    let s = &line[indent..];
    let b = s.as_bytes();

    let (first, mut pos) = read_flag(s, 0)?;
    let mut flags = vec![first];
    while pos < b.len() && matches!(b[pos], b' ' | b'=' | b',') {
        let at = skip_ws(b, pos + 1);
        match read_flag(s, at) {
            Some((flag, end)) => {
                flags.push(flag);
                pos = end;
            }
            None => break,
        }
    }

    // An argument name such as `=FILE` or ` <path>`: one run of non-space after `=` or a space.
    if pos < b.len() && matches!(b[pos], b' ' | b'=') {
        let mut end = pos + 1;
        while end < b.len() && !b[end].is_ascii_whitespace() {
            end += 1;
        }
        if end > pos + 1 {
            pos = end;
        }
    }

    let start = skip_ws(b, pos);
    if start - pos < 2 {
        return None;
    }
    let desc = s[start..].trim_end();
    if desc.is_empty() {
        return None;
    }
    Some((flags, desc.to_owned()))
}

/// A flag starting at byte `at`: `-x` or `--name`, where the name is `[A-Za-z0-9_-]+`.
fn read_flag(s: &str, at: usize) -> Option<(String, usize)> {
    let b = s.as_bytes();
    let mut i = at;
    if b.get(i) != Some(&b'-') {
        return None;
    }
    i += 1;
    if b.get(i) == Some(&b'-') {
        i += 1;
    }
    let word = i;
    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'-') {
        i += 1;
    }
    (i > word).then(|| (s[at..i].to_owned(), i))
}

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}
