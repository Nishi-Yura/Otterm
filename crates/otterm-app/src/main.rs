//! The otterm desktop app.
//!
//! Screen frames go to the WebView over the local WebSocket in [`screen`] (decision M2); commands,
//! input and the other session events use Tauri IPC.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod launch;
mod open;
mod profiles;
mod quote;
mod screen;
mod shell;
mod window_state;

use otterm_session::{
    Key, LocalSessionManager, Mouse, MouseAction, MouseButton, PtySize, SearchOptions, SessionEvent, SessionId,
    SessionManager, SpawnOptions,
};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;

use crate::config::{ConfigState, UiConfig};
use crate::screen::ScreenServer;

/// Folder and command for the first tab, from the command line.
type FirstTab = (Option<std::path::PathBuf>, Option<Vec<String>>);

struct AppState {
    sessions: Box<LocalSessionManager>,
    screen: std::sync::Arc<ScreenServer>,
    config: &'static ConfigState,
    /// Folder and command from the command line, for the first session only.
    first: std::sync::Mutex<Option<FirstTab>>,
    /// Command-line arguments that were not understood.
    unknown_args: Vec<String>,
    /// The shell each session started, to quote dropped paths for it.
    shells: std::sync::Mutex<std::collections::HashMap<SessionId, String>>,
}

type CmdResult<T = ()> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Session events other than frames, for the UI.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum UiEvent {
    Title { title: String },
    Bell,
    Cwd { url: String },
    Clipboard { data: String },
    Exited { code: Option<u32> },
}

#[derive(Serialize)]
struct ScreenEndpoint {
    port: u16,
    token: String,
}

/// Where the UI connects for screen frames.
#[tauri::command]
fn screen_endpoint(state: State<'_, AppState>) -> ScreenEndpoint {
    ScreenEndpoint { port: state.screen.port(), token: state.screen.token().to_owned() }
}

/// The configuration as the UI uses it. Changes arrive later as `config-changed` events.
#[tauri::command]
fn config_get(state: State<'_, AppState>) -> UiConfig {
    state.config.ui()
}

/// Start a shell (the default profile, if one is set). Frames go to the screen socket; everything
/// else to `events`. `cwd` (a path or a `file://` URL from OSC 7) opens a split or a new tab in
/// the directory of the pane it came from (docs/03 §3.2).
#[tauri::command]
fn session_create(
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
    events: Channel<UiEvent>,
    cwd: Option<String>,
    profile: Option<String>,
) -> CmdResult<SessionId> {
    let config = state.config.config();
    state.sessions.set_terminal_options(config::terminal_options(&config));
    let mut opts = SpawnOptions { size: PtySize { cols, rows }, ..Default::default() };
    // A profile picked in the new-tab menu, else the configured default.
    let chosen = profile.as_deref().and_then(|id| profiles::find(&config, id));
    if let Some(p) = chosen.as_ref().or(config::default_profile(&config)) {
        opts.program = Some(p.command.clone());
        opts.args = p.args.clone();
        // A profile without arguments of its own still gets the shell integration (B6).
        if opts.args.is_empty() && config.shell.integration {
            opts.args = shell::integration_args(&p.command);
        }
        opts.cwd = p.cwd.as_deref().filter(|c| !c.is_empty()).map(expand_home);
        opts.env = p.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    } else if config.shell.integration {
        // The platform shell, with otterm's integration loaded through its arguments (B6).
        let program = otterm_session::default_shell();
        opts.args = shell::integration_args(&program);
        opts.program = Some(program);
    }
    // The folder of the pane this one came from, unless the profile names its own.
    if opts.cwd.is_none()
        && let Some(dir) = cwd.as_deref().and_then(local_path).filter(|d| d.is_dir())
    {
        opts.cwd = Some(dir);
    }
    // `otterm <path>` / `otterm -e <command>` apply to the first tab.
    if let Some((dir, command)) = state.first.lock().unwrap().take() {
        if let Some(dir) = dir {
            opts.cwd = Some(dir);
        }
        if let Some(mut command) = command {
            opts.program = Some(command.remove(0));
            opts.args = command;
        }
    }
    #[cfg(feature = "bench")]
    if let Some((program, args)) = bench::bench_child() {
        opts.program = Some(program);
        opts.args = args;
    }
    let shell = opts.program.clone().unwrap_or_else(otterm_session::default_shell);
    let screen = std::sync::Arc::clone(&state.screen);
    let id = state
        .sessions
        .create(
            opts,
            Box::new(move |ev| {
                // A failed send means the window is gone; the session ends with the app.
                let _ = match ev {
                    SessionEvent::Frame(frame) => {
                        screen.broadcast(frame);
                        Ok(())
                    }
                    SessionEvent::Title(title) => events.send(UiEvent::Title { title }),
                    SessionEvent::Bell => events.send(UiEvent::Bell),
                    SessionEvent::Cwd(url) => events.send(UiEvent::Cwd { url }),
                    // OSC 52 carries base64; the UI applies the clipboard policy (decision H2).
                    SessionEvent::ClipboardWrite(data) => match decode_base64(&data) {
                        Some(data) => events.send(UiEvent::Clipboard { data }),
                        None => Ok(()),
                    },
                    SessionEvent::Exited { code } => events.send(UiEvent::Exited { code }),
                    SessionEvent::Output(_) => Ok(()),
                };
            }),
        )
        .map_err(err)?;
    state.shells.lock().unwrap().insert(id, shell);
    Ok(id)
}

/// Files dropped on a pane: their paths, quoted for the pane's shell, typed at the prompt.
#[tauri::command]
fn session_drop_paths(state: State<'_, AppState>, id: SessionId, paths: Vec<String>) -> CmdResult {
    let shell = state.shells.lock().unwrap().get(&id).cloned().unwrap_or_default();
    let text = quote::dropped(&paths, quote::Style::for_shell(&shell));
    if text.is_empty() {
        return Ok(());
    }
    state.sessions.paste(id, &text).map_err(err)
}

#[tauri::command]
fn session_write(state: State<'_, AppState>, id: SessionId, data: String) -> CmdResult {
    state.sessions.write(id, data.as_bytes()).map_err(err)
}

/// A key press from the UI (DOM `KeyboardEvent` fields).
#[derive(Deserialize)]
struct KeyInput {
    key: String,
    ctrl: bool,
    alt: bool,
    shift: bool,
}

/// Returns `false` when the terminal has no encoding for the key.
#[tauri::command]
fn session_key(state: State<'_, AppState>, id: SessionId, input: KeyInput) -> CmdResult<bool> {
    let key = Key { key: input.key, ctrl: input.ctrl, alt: input.alt, shift: input.shift };
    state.sessions.key(id, &key).map_err(err)
}

#[tauri::command]
fn session_paste(state: State<'_, AppState>, id: SessionId, text: String) -> CmdResult {
    state.sessions.paste(id, &text).map_err(err)
}

#[tauri::command]
fn session_resize(state: State<'_, AppState>, id: SessionId, cols: u16, rows: u16) -> CmdResult {
    state.sessions.resize(id, PtySize { cols, rows }).map_err(err)
}

#[tauri::command]
fn session_redraw(state: State<'_, AppState>, id: SessionId) -> CmdResult {
    state.sessions.redraw(id).map_err(err)
}

/// Scroll the view; positive is up into the scrollback.
#[tauri::command]
fn session_scroll(state: State<'_, AppState>, id: SessionId, lines: i32) -> CmdResult {
    state.sessions.scroll(id, lines).map_err(err)
}

/// A mouse event on the grid. `button`: left, middle, right, wheelUp, wheelDown, none.
/// `action`: press, release, motion.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MouseInput {
    button: String,
    action: String,
    row: u16,
    col: u16,
    shift: bool,
    alt: bool,
    ctrl: bool,
}

/// Returns `false` when the application did not ask for this mouse event.
#[tauri::command]
fn session_mouse(state: State<'_, AppState>, id: SessionId, input: MouseInput) -> CmdResult<bool> {
    let button = match input.button.as_str() {
        "left" => MouseButton::Left,
        "middle" => MouseButton::Middle,
        "right" => MouseButton::Right,
        "wheelUp" => MouseButton::WheelUp,
        "wheelDown" => MouseButton::WheelDown,
        "none" => MouseButton::None,
        other => return Err(format!("unknown mouse button {other}")),
    };
    let action = match input.action.as_str() {
        "press" => MouseAction::Press,
        "release" => MouseAction::Release,
        "motion" => MouseAction::Motion,
        other => return Err(format!("unknown mouse action {other}")),
    };
    let mouse =
        Mouse { button, action, row: input.row, col: input.col, shift: input.shift, alt: input.alt, ctrl: input.ctrl };
    state.sessions.mouse(id, &mouse).map_err(err)
}

/// Text between two (line, column) positions of the frames, inclusive. Line numbers come from the
/// frame header, so they fit in a JS number for any realistic session.
#[tauri::command]
fn session_text(
    state: State<'_, AppState>,
    id: SessionId,
    start_line: u64,
    start_col: usize,
    end_line: u64,
    end_col: usize,
) -> CmdResult<String> {
    state.sessions.text(id, (start_line, start_col), (end_line, end_col)).map_err(err)
}

/// Matches as `[start line, start col, end line, end col]`, oldest first.
#[tauri::command]
fn session_search(
    state: State<'_, AppState>,
    id: SessionId,
    query: String,
    regex: bool,
    case_sensitive: bool,
    whole_word: bool,
) -> CmdResult<Vec<(u64, usize, u64, usize)>> {
    let opts = SearchOptions { regex, case_sensitive, whole_word };
    let matches = state.sessions.search(id, &query, opts).map_err(err)?;
    Ok(matches.into_iter().map(|m| (m.start.0, m.start.1, m.end.0, m.end.1)).collect())
}

/// Scroll so that `line` is in view.
#[tauri::command]
fn session_reveal(state: State<'_, AppState>, id: SessionId, line: u64) -> CmdResult {
    state.sessions.reveal(id, line).map_err(err)
}

#[tauri::command]
fn session_clear_scrollback(state: State<'_, AppState>, id: SessionId) -> CmdResult {
    state.sessions.clear_scrollback(id).map_err(err)
}

/// Run a clipboard operation, retrying for a moment: on Windows the clipboard is unavailable while
/// another program has it open, which clipboard managers and remote desktop do often.
fn with_clipboard<T>(mut f: impl FnMut(&mut arboard::Clipboard) -> Result<T, arboard::Error>) -> CmdResult<T> {
    let mut last = None;
    for _ in 0..20 {
        match arboard::Clipboard::new().and_then(|mut c| f(&mut c)) {
            Ok(v) => return Ok(v),
            Err(e @ arboard::Error::ContentNotAvailable) => return Err(err(e)),
            Err(e) => last = Some(e),
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    Err(last.map(err).unwrap_or_default())
}

/// A program the shell is running, to ask before closing its tab (docs/03 §3.2).
#[tauri::command]
async fn session_running(state: State<'_, AppState>, id: SessionId) -> CmdResult<Option<String>> {
    // Listing processes takes a moment; keep it off the main thread.
    state.sessions.running_program(id).map_err(err)
}

/// Open config.toml in an editor, creating it from a commented template first if it is missing.
/// Returns its path.
#[tauri::command]
fn config_open(state: State<'_, AppState>) -> CmdResult<String> {
    let path = state.config.path().ok_or("no configuration folder")?;
    if !path.exists() {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(err)?;
        }
        std::fs::write(&path, include_str!("config_template.toml")).map_err(err)?;
    }
    open_in_editor(&path, None, None).map_err(err)?;
    Ok(path.display().to_string())
}

/// VS Code when it is on PATH (docs/06 `open.editor`, auto-detect), at `line`:`col` if given, else
/// the platform's text editor. The path is one argument, never parsed by a shell.
fn open_in_editor(path: &std::path::Path, line: Option<u32>, col: Option<u32>) -> std::io::Result<()> {
    let at = line.map(|l| format!("{}:{l}:{}", path.display(), col.unwrap_or(1)));
    // UI tests record it instead (see open_url).
    if let Some(log) = std::env::var_os("OTTERM_TEST_OPEN_LOG") {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(log)?;
        return writeln!(f, "editor {}", at.unwrap_or_else(|| path.display().to_string()));
    }
    let find = |exe: &str| {
        std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join(exe)).find(|f| f.is_file()))
    };
    // VS Code takes `-g path:line:col` to go to a line.
    let code = |program: std::path::PathBuf| {
        let mut c = std::process::Command::new(program);
        match &at {
            Some(at) => c.arg("-g").arg(at),
            None => c.arg(path),
        };
        c
    };
    let mut cmd = if cfg!(windows) {
        // Run the batch file itself: the standard library then quotes the argument for cmd
        // safely (and refuses one it cannot).
        if let Some(program) = find("code.cmd") {
            code(program)
        } else {
            let mut c = std::process::Command::new("notepad.exe");
            c.arg(path);
            c
        }
    } else if let Some(program) = find("code") {
        code(program)
    } else if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.arg("-t").arg(path);
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(path);
        c
    };
    cmd.spawn().map(drop)
}

/// Open a file with its default app, or a folder in the file manager.
fn open_with_system(path: &std::path::Path) -> std::io::Result<()> {
    if let Some(log) = std::env::var_os("OTTERM_TEST_OPEN_LOG") {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(log)?;
        return writeln!(f, "system {}", path.display());
    }
    let program = if cfg!(windows) {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program).arg(path).spawn().map(drop)
}

/// The existing file or folder a word in the output names (FR-FILE-06), for the link underline.
/// Async so that a slow (network) folder does not hold up the main thread.
#[tauri::command]
async fn path_resolve(cwd: Option<String>, text: String) -> Option<String> {
    let cwd = cwd.as_deref().and_then(local_path);
    let home = expand_home("~");
    open::resolve(cwd.as_deref(), &text, Some(&home)).map(|t| t.path.display().to_string())
}

/// Ctrl+click on a path in the output: folders and files that `[open.rules]` sends to the system
/// open there; other files open in the editor at the line given after the path.
#[tauri::command]
async fn path_open(state: State<'_, AppState>, cwd: Option<String>, text: String) -> CmdResult {
    let cwd = cwd.as_deref().and_then(local_path);
    let home = expand_home("~");
    let target = open::resolve(cwd.as_deref(), &text, Some(&home)).ok_or_else(|| format!("not found: {text}"))?;
    let ext = target.path.extension().map(|e| format!(".{}", e.to_string_lossy().to_lowercase()));
    let config = state.config.config();
    let rule = ext.and_then(|e| config.open.rules.get(&e).copied());
    // There is no preview yet; previewed types open with their app.
    let system = target.path.is_dir() || matches!(rule, Some(r) if r != otterm_config::OpenAction::Editor);
    if system {
        open_with_system(&target.path).map_err(err)
    } else {
        open_in_editor(&target.path, target.line, target.col).map_err(err)
    }
}

#[tauri::command]
fn session_reset_modes(state: State<'_, AppState>, id: SessionId) -> CmdResult {
    state.sessions.reset_modes(id).map_err(err)
}

/// Clipboard text, read in Rust: the WebView would ask the user for permission on every read.
#[tauri::command]
async fn clipboard_read() -> CmdResult<String> {
    // The retries sleep; keep them off the async runtime's threads.
    tauri::async_runtime::spawn_blocking(|| with_clipboard(|c| c.get_text())).await.map_err(err)?
}

#[tauri::command]
async fn clipboard_write(text: String) -> CmdResult {
    tauri::async_runtime::spawn_blocking(move || with_clipboard(|c| c.set_text(text.as_str()))).await.map_err(err)?
}

/// Open a web link in the default browser (decision I2: Ctrl+click). Only http and https, so a
/// link in terminal output cannot start a program.
#[tauri::command]
fn open_url(url: String) -> CmdResult {
    let ok_scheme = url.starts_with("https://") || url.starts_with("http://");
    if !ok_scheme || url.chars().any(|c| c.is_whitespace() || c.is_control()) || url.len() > 4096 {
        return Err(format!("not an http(s) link: {url}"));
    }
    // Automated UI tests set this so that clicking a link records it instead of opening a browser.
    if let Some(log) = std::env::var_os("OTTERM_TEST_OPEN_LOG") {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(log).map_err(err)?;
        return writeln!(f, "{url}").map_err(err);
    }
    // The URL is one argument to a program, never parsed by a shell.
    let program = if cfg!(windows) {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program).arg(&url).spawn().map(drop).map_err(err)
}

#[tauri::command]
fn session_close(state: State<'_, AppState>, id: SessionId) -> CmdResult {
    state.shells.lock().unwrap().remove(&id);
    state.sessions.close(id).map_err(err)
}

/// Text from OSC 52's base64 payload; `None` if it is not base64 of UTF-8 or is over 1 MiB.
fn decode_base64(s: &str) -> Option<String> {
    const MAX: usize = 1 << 20;
    if s.len() > MAX / 3 * 4 + 4 {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0);
    for c in s.bytes().filter(|c| !c.is_ascii_whitespace()) {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => return None,
        };
        acc = acc << 6 | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A local path from a path or a `file://` URL (OSC 7 sends `file://host/path`, percent-encoded).
fn local_path(s: &str) -> Option<std::path::PathBuf> {
    let Some(rest) = s.strip_prefix("file://") else { return Some(s.into()) };
    let slash = rest.find('/')?;
    let (host, path) = (&rest[..slash], &rest[slash..]);
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(b) = path.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            decoded.push(b);
            i += 3;
        } else {
            decoded.push(bytes[i]);
            i += 1;
        }
    }
    let path = String::from_utf8(decoded).ok()?;
    let has_drive = path.as_bytes().get(2) == Some(&b':');
    if cfg!(windows) && !has_drive && !host.is_empty() && !host.eq_ignore_ascii_case("localhost") {
        // file://server/share/dir is the UNC path \\server\share\dir. (Shells also send their own
        // computer name as the host; a drive letter means the path is local.)
        return Some(format!(r"\\{host}{}", path.replace('/', "\\")).into());
    }
    // file:///C:/Users → C:/Users on Windows.
    let path = if cfg!(windows) && path.as_bytes().get(2) == Some(&b':') { &path[1..] } else { &path[..] };
    Some(path.into())
}

/// `~` at the start of a profile's directory is the home directory.
fn expand_home(path: &str) -> std::path::PathBuf {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
    match (path.strip_prefix('~'), home) {
        (Some(rest), Some(home)) => std::path::PathBuf::from(home).join(rest.trim_start_matches(['/', '\\'])),
        _ => path.into(),
    }
}

fn app_state() -> AppState {
    config::warm_up();
    let launch = launch::parse(std::env::args().skip(1));
    AppState {
        sessions: Box::new(LocalSessionManager::new()),
        screen: std::sync::Arc::new(ScreenServer::start().expect("start the screen socket")),
        // Lives as long as the app; the watcher thread holds it.
        config: Box::leak(Box::new(ConfigState::load(launch.config))),
        first: std::sync::Mutex::new(Some((launch.cwd, launch.command))),
        unknown_args: launch.unknown,
        shells: Default::default(),
    }
}

#[tauri::command]
fn session_focus(state: State<'_, AppState>, id: SessionId, focused: bool) -> CmdResult {
    state.sessions.focus(id, focused).map_err(err)
}

/// The theme in use (`#rrggbb`), for programs that ask the terminal for its colors (OSC 10/11/12).
#[tauri::command]
fn terminal_colors(state: State<'_, AppState>, foreground: String, background: String, cursor: String) -> CmdResult {
    let rgb = |s: &str| -> Result<(u8, u8, u8), String> {
        let hex = s.strip_prefix('#').filter(|h| h.len() == 6).ok_or_else(|| format!("not #rrggbb: {s}"))?;
        let n = u32::from_str_radix(hex, 16).map_err(err)?;
        Ok(((n >> 16) as u8, (n >> 8) as u8, n as u8))
    };
    state.sessions.set_default_colors([rgb(&foreground)?, rgb(&background)?, rgb(&cursor)?]);
    Ok(())
}

/// The new-tab menu: configured profiles, then shells found on this computer.
#[tauri::command]
fn profiles_list(state: State<'_, AppState>) -> Vec<profiles::MenuEntry> {
    let config = state.config.config();
    profiles::all(&config)
        .into_iter()
        .map(|p| profiles::MenuEntry {
            detected: !config.profiles.iter().any(|c| c.id == p.id),
            name: if p.name.is_empty() { p.id.clone() } else { p.name },
            id: p.id,
        })
        .collect()
}

/// Command-line arguments that were not understood, for the UI to mention.
#[tauri::command]
fn launch_problems(state: State<'_, AppState>) -> Vec<String> {
    state.unknown_args.clone()
}

/// Save the window's size and place when it closes (decision I7).
fn remember_window(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { .. } = event
        && let Some(webview) = tauri::Manager::get_webview_window(window, window.label())
    {
        window_state::save(&webview);
    }
}

/// Tell the UI when `config.toml` changes.
fn watch_config(app: &tauri::App) {
    use tauri::{Emitter, Manager};
    let handle = app.handle().clone();
    let config = app.state::<AppState>().config;
    ConfigState::watch(config, move |ui| {
        let _ = handle.emit("config-changed", ui);
    });
}

#[cfg(not(feature = "bench"))]
fn main() {
    tauri::Builder::default()
        .manage(app_state())
        .setup(|app| {
            watch_config(app);
            // The window starts hidden (tauri.conf.json); restore shows it once placed.
            match tauri::Manager::get_webview_window(app, "main") {
                Some(window) => window_state::restore(&window),
                None => {
                    for window in tauri::Manager::webview_windows(app).values() {
                        let _ = window.show();
                    }
                }
            }
            Ok(())
        })
        .on_window_event(remember_window)
        .invoke_handler(tauri::generate_handler![
            screen_endpoint,
            config_get,
            config_open,
            launch_problems,
            profiles_list,
            terminal_colors,
            session_focus,
            session_create,
            session_write,
            session_key,
            session_paste,
            session_drop_paths,
            session_resize,
            session_redraw,
            session_scroll,
            session_mouse,
            session_text,
            session_search,
            session_reveal,
            session_clear_scrollback,
            session_reset_modes,
            session_running,
            clipboard_read,
            clipboard_write,
            open_url,
            path_resolve,
            path_open,
            session_close,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run otterm");
}

#[cfg(feature = "bench")]
mod bench;

#[cfg(feature = "bench")]
fn main() {
    bench::STARTED.get_or_init(|| (std::time::Instant::now(), std::time::SystemTime::now()));
    tauri::Builder::default()
        .manage(app_state())
        .manage(bench::BenchState::default())
        .setup(|app| {
            watch_config(app);
            // The window starts hidden (tauri.conf.json); restore shows it once placed.
            match tauri::Manager::get_webview_window(app, "main") {
                Some(window) => window_state::restore(&window),
                None => {
                    for window in tauri::Manager::webview_windows(app).values() {
                        let _ = window.show();
                    }
                }
            }
            Ok(())
        })
        .on_window_event(remember_window)
        .invoke_handler(tauri::generate_handler![
            screen_endpoint,
            config_get,
            config_open,
            launch_problems,
            profiles_list,
            terminal_colors,
            session_focus,
            session_create,
            session_write,
            session_key,
            session_paste,
            session_drop_paths,
            session_resize,
            session_redraw,
            session_scroll,
            session_mouse,
            session_text,
            session_search,
            session_reveal,
            session_clear_scrollback,
            session_reset_modes,
            session_running,
            clipboard_read,
            clipboard_write,
            open_url,
            path_resolve,
            path_open,
            session_close,
            bench::bench_mode,
            bench::bench_ipc_start,
            bench::bench_ipc_ack,
            bench::bench_typing_done,
            bench::bench_startup_done,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run otterm");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_config_template_reads_without_warnings() {
        let (_, warnings) = otterm_config::parse(include_str!("config_template.toml"));
        assert!(warnings.is_empty(), "{warnings:?}");
    }

    #[test]
    fn osc52_base64_decodes() {
        assert_eq!(decode_base64("aGVsbG8="), Some("hello".into()));
        assert_eq!(decode_base64("5pel5pys"), Some("日本".into()));
        assert_eq!(decode_base64(""), Some(String::new()));
        assert_eq!(decode_base64("not base64!"), None);
    }

    #[test]
    fn file_urls_become_paths() {
        assert_eq!(local_path("/home/a b"), Some("/home/a b".into()));
        assert_eq!(local_path("file://localhost/home/a%20b"), Some("/home/a b".into()));
        if cfg!(windows) {
            assert_eq!(local_path("file://pc/C:/Users/x"), Some("C:/Users/x".into()));
        }
        assert_eq!(local_path("file://no-path"), None);
        if cfg!(windows) {
            assert_eq!(local_path("file://srv/share/a%20b"), Some(r"\\srv\share\a b".into()));
        }
    }
}
