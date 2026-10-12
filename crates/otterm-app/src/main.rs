//! The otterm desktop app.
//!
//! Screen frames go to the WebView over the local WebSocket in [`screen`] (decision M2); commands,
//! input and the other session events use Tauri IPC.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod assist;
mod config;
mod config_tools;
mod crash;
mod editor;
mod helptext;
mod history;
mod instance;
mod launch;
mod mascot;
mod mod_assets;
mod mod_io;
mod mods;
mod open;
mod profiles;
mod quote;
mod registry;
mod screen;
mod settings;
mod shell;
mod shell_history;
mod text;
mod update;
mod window_state;

use otterm_session::{
    BlockState, Key, LocalSessionManager, Mouse, MouseAction, MouseButton, PtySize, SearchOptions, SessionEvent,
    SessionId, SessionManager, SpawnOptions,
};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;

use crate::config::{ConfigState, UiConfig};
use crate::screen::ScreenServer;

/// Folder, command and profile for a tab, from the command line (this process's or a later
/// launch's, handed over by [`instance`]).
#[derive(Default)]
struct TabLaunch {
    cwd: Option<std::path::PathBuf>,
    command: Option<Vec<String>>,
    profile: Option<String>,
    /// Typed into the shell once it starts: a trusted workspace tab's `command` (docs/06 §2).
    input: Option<String>,
}

/// Keep a launch for the tab the UI is about to open; the UI passes the id to `session_create`.
fn add_launch(state: &AppState, launch: TabLaunch) -> u32 {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
    let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    state.launches.lock().unwrap().insert(id, launch);
    id
}

struct AppState {
    sessions: Box<LocalSessionManager>,
    screen: std::sync::Arc<ScreenServer>,
    config: &'static ConfigState,
    /// Folder and command from the command line, for the first session only.
    first: std::sync::Mutex<Option<TabLaunch>>,
    /// Tabs later launches asked for, by the id the UI gets in `instance-open`.
    launches: std::sync::Mutex<std::collections::HashMap<u32, TabLaunch>>,
    /// Later launches waiting for the UI's answer (`otterm workflow run`, `otterm ask`).
    replies: std::sync::Mutex<std::collections::HashMap<u32, std::sync::mpsc::Sender<instance::Reply>>>,
    /// Command-line arguments that were not understood.
    unknown_args: Vec<String>,
    /// The shell each session started, to quote dropped paths for it.
    shells: std::sync::Mutex<std::collections::HashMap<SessionId, String>>,
    /// The run history (decision K1).
    history: std::sync::Arc<history::History>,
    /// What the `--help` of commands the dictionary lacks says (decision B9).
    help: &'static helptext::HelpCache,
    /// The WSL distribution a session runs, for host paths (decision J2).
    wsl: std::sync::Mutex<std::collections::HashMap<SessionId, String>>,
    /// The folder of each session as the shell reported it (OSC 7), as a path, for the history.
    cwds: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<SessionId, String>>>,
}

type CmdResult<T = ()> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Session events other than frames, for the UI. `BlockStart` / `BlockEnd` are a command of the
/// shell integration starting and ending; the tab title shows it while it runs (decision I10).
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum UiEvent {
    Title {
        title: String,
    },
    Bell,
    Cwd {
        url: String,
    },
    Clipboard {
        data: String,
    },
    BlockStart {
        line: u64,
        command: String,
    },
    BlockEnd {
        line: u64,
        exit: i32,
        ms: u32,
    },
    /// The line being typed (docs/02 §6, estimated). `active` is false once input ended.
    Input {
        line: String,
        cursor: usize,
        active: bool,
        /// The shell reported it (method A) rather than otterm reading the screen.
        exact: bool,
    },
    /// Echo went off (a password prompt) or back on (decision K2).
    EchoOff {
        off: bool,
    },
    Exited {
        code: Option<u32>,
    },
}

/// A block of the shell integration (docs/03 §6.3) for the block menu: re-run, copy, save.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BlockInfo {
    /// Line numbers of its head row and its last row.
    line: u64,
    end: u64,
    command: Option<String>,
    /// The command runs (its output is still coming).
    running: bool,
    /// Exit code and duration once it ended.
    exit: Option<i32>,
    ms: Option<u32>,
    /// The prompt bar's base64 JSON (cwd, home, branch); empty without a bar.
    info: String,
    output: String,
    /// The output has rows to fold; some of them are folded now.
    foldable: bool,
    folded: bool,
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

/// Grid metrics of a font list at a pixel size (decision C4). Async: the first call loads the
/// system fonts.
#[tauri::command]
async fn text_metrics(req: text::MetricsRequest) -> CmdResult<text::Metrics> {
    text::metrics(&req)
}

/// Bitmaps for grapheme clusters, for the renderer's glyph atlas (format in `text::glyphs`).
#[tauri::command]
async fn text_glyphs(req: text::GlyphRequest) -> CmdResult<tauri::ipc::Response> {
    text::glyphs(&req).map(tauri::ipc::Response::new)
}

/// Runs of cells shaped together for ligatures (format in `text::runs`).
#[tauri::command]
async fn text_runs(req: text::RunRequest) -> CmdResult<tauri::ipc::Response> {
    text::runs(&req).map(tauri::ipc::Response::new)
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
    launch: Option<u32>,
) -> CmdResult<SessionId> {
    let config = state.config.config();
    // `otterm <path>` / `otterm -e <command>` / `--profile`: the first tab, or the tab a later
    // launch asked for.
    let launch = match launch {
        Some(n) => state.launches.lock().unwrap().remove(&n),
        None => state.first.lock().unwrap().take(),
    };
    let profile = profile.or_else(|| launch.as_ref().and_then(|l| l.profile.clone()));
    state.sessions.set_terminal_options(config::terminal_options(&config));
    let mut opts = SpawnOptions { size: PtySize { cols, rows }, ..Default::default() };
    // A profile picked in the new-tab menu, else the configured default (a configured profile or
    // a detected one, by id).
    let chosen = profile
        .as_deref()
        .or(Some(config.shell.default_profile.as_str()).filter(|id| !id.is_empty()))
        .and_then(|id| profiles::find(&config, id));
    if let Some(p) = chosen.as_ref() {
        opts.program = Some(p.command.clone());
        opts.args = p.args.clone();
        opts.cwd = p.cwd.as_deref().filter(|c| !c.is_empty()).map(expand_home);
        opts.env = p.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    } else {
        opts.program = Some(otterm_session::default_shell());
    }
    // otterm's integration, loaded through the shell's arguments and environment (B6).
    if let Some(program) = opts.program.clone() {
        if config.shell.integration {
            let user_files = config.shell.user_startup_files;
            let shell::Integration { args, env } =
                shell::integrate(&program, opts.args.clone(), config.shell.prompt, user_files);
            opts.args = args;
            opts.env.extend(env);
        } else if !config.shell.user_startup_files {
            // Without the hooks, the shell's own flags keep its startup files out (decision M24).
            opts.args = shell::clean_start(&program, opts.args.clone());
        }
    }
    // The folder of the pane this one came from, unless the profile names its own. That folder
    // comes from the shell's output (OSC 7), so a network share is not followed: even checking it
    // would connect to the server with the user's credentials.
    if opts.cwd.is_none()
        && let Some(dir) = cwd.as_deref().and_then(local_path).filter(|d| open::local(d) && d.is_dir())
    {
        opts.cwd = Some(dir);
    }
    let mut input = None;
    if let Some(TabLaunch { cwd, command, input: typed, .. }) = launch {
        input = typed;
        if let Some(dir) = cwd {
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
    // `otterm trash` (danger-guard's alternative, decision B8) must run from the shell: put
    // otterm's folder at the end of PATH, so anything the user installed still wins.
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(std::path::Path::to_path_buf)) {
        let current = opts
            .env
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
            .map(|(_, v)| std::ffi::OsString::from(v))
            .or_else(|| std::env::var_os("PATH"))
            .unwrap_or_default();
        let mut parts: Vec<std::path::PathBuf> = std::env::split_paths(&current).collect();
        if !parts.contains(&dir) {
            parts.push(dir);
        }
        if let Ok(joined) = std::env::join_paths(parts) {
            opts.env.retain(|(k, _)| !k.eq_ignore_ascii_case("PATH"));
            opts.env.push(("PATH".into(), joined.to_string_lossy().into_owned()));
        }
    }
    let wsl_distro = opts
        .program
        .as_deref()
        .filter(|p| p.to_ascii_lowercase().ends_with("wsl.exe") || p.eq_ignore_ascii_case("wsl"))
        .and_then(|_| opts.args.iter().position(|a| a == "-d" || a == "--distribution"))
        .and_then(|i| opts.args.get(i + 1).cloned());
    let shell = opts.program.clone().unwrap_or_else(otterm_session::default_shell);
    let screen = std::sync::Arc::clone(&state.screen);
    let history = std::sync::Arc::clone(&state.history);
    let cwds = std::sync::Arc::clone(&state.cwds);
    let config_state = state.config;
    let profile_id = chosen.as_ref().map(|p| p.id.clone()).unwrap_or_default();
    let id_cell = std::sync::Arc::new(std::sync::Mutex::new(None::<SessionId>));
    let id_for_events = std::sync::Arc::clone(&id_cell);
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
                    SessionEvent::Cwd(url) => {
                        if let (Some(id), Some(path)) = (*id_for_events.lock().unwrap(), local_path(&url)) {
                            cwds.lock().unwrap().insert(id, path.display().to_string());
                        }
                        events.send(UiEvent::Cwd { url })
                    }
                    // OSC 52 carries base64; the UI applies the clipboard policy (decision H2).
                    SessionEvent::ClipboardWrite(data) => match decode_base64(&data) {
                        Some(data) => events.send(UiEvent::Clipboard { data }),
                        None => Ok(()),
                    },
                    SessionEvent::BlockStart { line, command } => events.send(UiEvent::BlockStart { line, command }),
                    SessionEvent::BlockEnd { line, command, exit, ms } => {
                        // The run history (decision K1).
                        let c = config_state.config();
                        if c.history.enabled
                            && let Some(id) = *id_for_events.lock().unwrap()
                        {
                            let cwd = cwds.lock().unwrap().get(&id).cloned().unwrap_or_default();
                            if !command.trim().is_empty() {
                                let started = history::now_ms() - i64::from(ms);
                                let run = history::NewRun {
                                    command: command.clone(),
                                    cwd,
                                    exit,
                                    started,
                                    ms,
                                    profile: profile_id.clone(),
                                };
                                history.record(&run, c.history.redact_secrets);
                            }
                        }
                        events.send(UiEvent::BlockEnd { line, exit, ms })
                    }
                    SessionEvent::Input { line, cursor, active, exact } => {
                        events.send(UiEvent::Input { line, cursor, active, exact })
                    }
                    SessionEvent::EchoOff(off) => events.send(UiEvent::EchoOff { off }),
                    SessionEvent::Exited { code } => events.send(UiEvent::Exited { code }),
                    SessionEvent::Output(_) => Ok(()),
                };
            }),
        )
        .map_err(err)?;
    *id_cell.lock().unwrap() = Some(id);
    // The pseudo console holds typed input until the shell reads it.
    if let Some(text) = input.filter(|t| !t.trim().is_empty()) {
        let _ = state.sessions.write(id, format!("{text}\r").as_bytes());
    }
    state.shells.lock().unwrap().insert(id, shell);
    if let Some(d) = wsl_distro {
        state.wsl.lock().unwrap().insert(id, d);
    }
    Ok(id)
}

/// The program a session runs and its WSL distribution, for the mods' `SessionInfo`.
#[derive(Serialize)]
struct SessionShell {
    shell: String,
    wsl: Option<String>,
}

#[tauri::command]
fn session_info(state: State<'_, AppState>, id: SessionId) -> SessionShell {
    SessionShell {
        shell: state.shells.lock().unwrap().get(&id).cloned().unwrap_or_default(),
        wsl: state.wsl.lock().unwrap().get(&id).cloned(),
    }
}

/// A block head without its output (the palette's `#`, `ctx.terminal.blocks`).
#[derive(Serialize)]
struct BlockRow {
    line: u64,
    command: Option<String>,
    running: bool,
    exit: Option<i32>,
}

#[tauri::command]
fn session_blocks(state: State<'_, AppState>, id: SessionId) -> CmdResult<Vec<BlockRow>> {
    Ok(state
        .sessions
        .blocks(id)
        .map_err(err)?
        .into_iter()
        .map(|b| BlockRow {
            line: b.line,
            command: b.command,
            running: b.state == BlockState::Running,
            exit: match b.state {
                BlockState::Done { exit, .. } => Some(exit),
                _ => None,
            },
        })
        .collect())
}

/// Memory use of otterm and its WebView processes, and the session with the largest scrollback
/// (decision I13). The window polls this every 30 s and warns above 1 GB.
#[derive(Serialize)]
struct MemoryUsage {
    total_bytes: u64,
    largest_scrollback: Option<(SessionId, usize)>,
}

#[tauri::command]
fn memory_usage(state: State<'_, AppState>) -> MemoryUsage {
    let largest_scrollback = state.sessions.scrollback_lines().into_iter().max_by_key(|(_, lines)| *lines);
    MemoryUsage { total_bytes: otterm_session::process_tree_memory(), largest_scrollback }
}

/// The visible screen as text and the cursor (`ctx.terminal.screen`).
#[tauri::command]
fn session_screen(state: State<'_, AppState>, id: SessionId) -> CmdResult<(Vec<String>, (usize, usize))> {
    state.sessions.screen_and_cursor(id).map_err(err)
}

/// Scroll to row `n` (1-based) of the scrollback and screen: the palette's `:`.
#[tauri::command]
fn session_reveal_row(state: State<'_, AppState>, id: SessionId, n: u64) -> CmdResult {
    state.sessions.reveal_row(id, n).map_err(err)
}

/// Editors found on this computer (decision I16).
#[tauri::command]
fn editors_detect() -> Vec<editor::Editor> {
    editor::detect().to_vec()
}

/// What `--help` said for a command the dictionary does not know (decision B9).
#[tauri::command]
fn help_get(state: State<'_, AppState>, name: String) -> Option<helptext::HelpEntry> {
    state.help.get(&name)
}

/// The user ran `name` once: learn its `--help` in the background (decision B9).
#[tauri::command]
fn help_learn(state: State<'_, AppState>, name: String) {
    state.help.learn(&name);
}

/// The shells' own history files, newest first (docs/03 §8.5).
#[tauri::command]
async fn shell_history(limit: usize) -> Vec<shell_history::ShellEntry> {
    tauri::async_runtime::spawn_blocking(move || shell_history::read(limit.min(5000))).await.unwrap_or_default()
}

/// The run history, newest first (decision K1).
#[tauri::command]
fn history_query(state: State<'_, AppState>, query: history::Query) -> Vec<history::Run> {
    state.history.query(&query)
}

#[tauri::command]
fn history_delete(state: State<'_, AppState>, id: Option<i64>) {
    match id {
        Some(id) => state.history.delete(id),
        None => state.history.clear(),
    }
}

/// Files dropped on a pane: their paths, quoted for the pane's shell, typed at the prompt.
#[tauri::command]
fn session_drop_paths(state: State<'_, AppState>, id: SessionId, paths: Vec<String>) -> CmdResult {
    let shell = state.shells.lock().unwrap().get(&id).cloned().unwrap_or_default();
    let (text, refused) = quote::dropped(&paths, quote::Style::for_shell(&shell));
    if !text.is_empty() {
        state.sessions.paste(id, &text).map_err(err)?;
    }
    if refused.is_empty() { Ok(()) } else { Err(format!("cannot be typed safely here: {}", refused.join(", "))) }
}

#[tauri::command]
fn session_write(state: State<'_, AppState>, id: SessionId, data: String) -> CmdResult {
    state.sessions.write(id, data.as_bytes()).map_err(err)
}

/// Replace the line being typed with `text` (danger-guard's alternatives, decision B8): clear
/// the shell's line editor, then paste. PSReadLine's Windows mode has Escape for "revert line";
/// readline, zle and fish take Ctrl+A Ctrl+K in emacs mode. Enter is left to the caller.
#[tauri::command]
fn session_replace_line(state: State<'_, AppState>, id: SessionId, text: String) -> CmdResult {
    let shell = state.shells.lock().unwrap().get(&id).cloned().unwrap_or_default();
    let name = shell.to_lowercase();
    let clear: &[u8] = if name.contains("pwsh") || name.contains("powershell") { b"\x1b" } else { b"\x01\x0b" };
    state.sessions.write(id, clear).map_err(err)?;
    // A moment for the editor to redraw before the paste arrives.
    std::thread::sleep(std::time::Duration::from_millis(30));
    state.sessions.paste(id, &text).map_err(err)
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
    let trim = state.config.config().terminal.trim_trailing_whitespace;
    state.sessions.text(id, (start_line, start_col), (end_line, end_col), trim).map_err(err)
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

/// The block (docs/03 §6.3) that holds a line of the frames, if the shell integration made one.
#[tauri::command]
fn session_block(state: State<'_, AppState>, id: SessionId, line: u64) -> CmdResult<Option<BlockInfo>> {
    let block = state.sessions.block(id, line).map_err(err)?;
    Ok(block.map(|b| {
        let (exit, ms) = match b.state {
            BlockState::Done { exit, ms } => (Some(exit), Some(ms)),
            _ => (None, None),
        };
        BlockInfo {
            line: b.line,
            end: b.end,
            command: b.command,
            running: b.state == BlockState::Running,
            exit,
            ms,
            info: b.info,
            output: b.output,
            foldable: b.foldable,
            folded: b.folded,
        }
    }))
}

/// Fold, show (`fold`) or toggle (`None`) the output of the block holding `line`, or of the
/// newest finished block when `line` is `None`. Returns whether it is folded now.
#[tauri::command]
fn session_block_fold(
    state: State<'_, AppState>,
    id: SessionId,
    line: Option<u64>,
    fold: Option<bool>,
) -> CmdResult<Option<bool>> {
    state.sessions.block_fold(id, line, fold).map_err(err)
}

/// Scroll to the previous (`dir < 0`) or next block head. `false` when there is none that way.
#[tauri::command]
fn session_block_jump(state: State<'_, AppState>, id: SessionId, dir: i32) -> CmdResult<bool> {
    state.sessions.block_jump(id, dir).map_err(err)
}

/// Save a block's output as `name` in the Downloads folder (decision I12); returns the path.
/// The UI names the file (`otterm-<command>-<date>.txt`); only a plain file name is accepted.
#[tauri::command]
async fn block_save(name: String, text: String) -> CmdResult<String> {
    let path = downloads_path(&name)?;
    std::fs::write(&path, text).map_err(err)?;
    Ok(path.display().to_string())
}

/// A new file named `name` in the Downloads folder (decision I12), never one that exists.
fn downloads_path(name: &str) -> CmdResult<std::path::PathBuf> {
    let name: String = name.chars().filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.')).take(120).collect();
    if name.is_empty() || name.starts_with('.') {
        return Err("bad file name".into());
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).ok_or("no home folder")?;
    let downloads = std::path::PathBuf::from(home).join("Downloads");
    let dir = if downloads.is_dir() { downloads } else { downloads.parent().map(Into::into).unwrap_or(downloads) };
    let (stem, ext) = name.rsplit_once('.').unwrap_or((&name, "txt"));
    // Never overwrite: a second save of the same command in the same second gets a suffix.
    let mut path = dir.join(&name);
    for n in 2.. {
        if !path.exists() {
            break;
        }
        path = dir.join(format!("{stem}-{n}.{ext}"));
    }
    Ok(path)
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
    open_in_editor(&state.config.config().open, &path, None, None).map_err(err)?;
    Ok(path.display().to_string())
}

/// The configured editor (`[open]`, decision I16), at `line`:`col` if given (editor.rs).
fn open_in_editor(
    config: &otterm_config::Open,
    path: &std::path::Path,
    line: Option<u32>,
    col: Option<u32>,
) -> std::io::Result<()> {
    editor::open(path, line, col, config)
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
    // Programs and shortcuts are never handed to the system opener: that would run them.
    let runnable = ext.as_deref().is_some_and(open::runs_when_opened);
    let rule = ext.and_then(|e| config.open.rules.get(&e).copied()).filter(|_| !runnable);
    // There is no preview yet; previewed types open with their app.
    let system = target.path.is_dir() || matches!(rule, Some(r) if r != otterm_config::OpenAction::Editor);
    if system {
        open_with_system(&target.path).map_err(err)
    } else {
        open_in_editor(&config.open, &target.path, target.line, target.col).map_err(err)
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

/// `otterm mod …` runs without a window and exits (docs/06 §4). Release builds on Windows have
/// no console of their own; `otterm.com` (crates/otterm-console) runs this, copies the output
/// to its console and passes the exit code on.
fn cli() -> bool {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("mod") => mods::cli(&args[1..]),
        Some("trash") => assist::trash_cli(&args[1..]),
        Some("theme") => settings::cli(&args[1..]),
        Some("config") => config_tools::cli(&args[1..]),
        Some("workflow") => match args.get(1).map(String::as_str) {
            Some("run") if args.len() == 3 => ask_running(instance::Request::Workflow { name: args[2].clone() }),
            _ => Err("usage: otterm workflow run <name>".into()),
        },
        Some("ask") => {
            let question = Some(args[1..].join(" ")).filter(|q| !q.trim().is_empty());
            ask_running(instance::Request::Ask { question })
        }
        _ => return false,
    };
    match result {
        Ok(text) => print!("{text}"),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    }
    true
}

/// A request only the running window can carry out (`otterm workflow run`, `otterm ask`).
fn ask_running(request: instance::Request) -> Result<String, String> {
    match instance::send(request) {
        Some(r) if r.ok => Ok(String::new()),
        Some(r) => Err(r.message),
        None => Err("otterm is not running; start it first".into()),
    }
}

fn app_state(launch: launch::Launch) -> AppState {
    config::warm_up();
    // Lives as long as the app; the watcher thread holds it.
    // The workspace file is looked for above the folder otterm opens in (docs/06 §1).
    let start = launch.cwd.clone().or_else(|| std::env::current_dir().ok());
    let config: &'static ConfigState = Box::leak(Box::new(ConfigState::load(launch.config, start)));
    config.migrate();
    config.set_safe(launch.safe_mode || std::env::var_os("OTTERM_SAFE_MODE").is_some_and(|v| v == "1"));
    // Resolve the configured fonts while the WebView starts (decision C4).
    std::thread::spawn(move || {
        let font = config.ui().font;
        text::prepare(&font.families, font.size);
    });
    let history = std::sync::Arc::new(history::History::open(otterm_config::data_dir()));
    history.prune(config.config().history.retention_days);
    ai::prune_log(config.config().ai.log_retention_days);
    let sessions = Box::new(LocalSessionManager::new());
    // Unlimited scrollback spills here, one folder per process (docs/09 §5); what a crashed run
    // left is no use now.
    if let Some(root) = otterm_config::data_dir().map(|d| d.join("scrollback")) {
        otterm_session::clean_spill_root(&root);
        sessions.set_spill_root(Some(root.join(std::process::id().to_string())));
    }
    AppState {
        sessions,
        screen: std::sync::Arc::new(ScreenServer::start().expect("start the screen socket")),
        config,
        first: std::sync::Mutex::new(Some(TabLaunch {
            cwd: launch.cwd,
            command: launch.command,
            profile: launch.profile,
            input: None,
        })),
        launches: Default::default(),
        replies: Default::default(),
        unknown_args: launch.unknown,
        shells: Default::default(),
        history,
        cwds: Default::default(),
        help: Box::leak(Box::new(helptext::HelpCache::open(otterm_config::data_dir()))),
        wsl: Default::default(),
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

/// Answer the workspace trust question (decision K4) and apply what it unlocks.
#[tauri::command]
fn workspace_trust(app: tauri::AppHandle, state: State<'_, AppState>, trusted: bool) -> CmdResult {
    state.config.trust_workspace(trusted)?;
    config_changed(&app);
    Ok(())
}

/// A tab of the workspace file for the UI to open: the launch id for `session_create`, and the
/// name to show until the shell sets a title.
#[derive(Serialize)]
struct WorkspaceTabLaunch {
    launch: u32,
    name: Option<String>,
}

/// The workspace file's `tabs` (docs/06 §2). Their commands are typed only once the workspace is
/// trusted (decision K4).
#[tauri::command]
fn workspace_tabs(state: State<'_, AppState>) -> Vec<WorkspaceTabLaunch> {
    let Some((ws, trusted)) = state.config.workspace() else { return Vec::new() };
    // The first tab keeps what the command line asked for (`-e`, `--profile`).
    state.first.lock().unwrap().take();
    ws.config
        .tabs
        .iter()
        .map(|t| {
            let cwd = ws.root.join(t.cwd.as_deref().unwrap_or("."));
            let launch = TabLaunch {
                cwd: Some(cwd).filter(|d| d.is_dir()),
                command: None,
                profile: t.profile.clone(),
                input: t.command.clone().filter(|_| trusted == Some(true)),
            };
            WorkspaceTabLaunch { launch: add_launch(&state, launch), name: t.name.clone() }
        })
        .collect()
}

/// Command-line arguments that were not understood, for the UI to mention.
#[tauri::command]
fn launch_problems(state: State<'_, AppState>) -> Vec<String> {
    state.unknown_args.clone()
}

/// Start otterm again, in safe mode or out of it (docs/04 §2.3), and quit this one. The new
/// process gets the same arguments, with `--safe-mode` added or taken away.
#[tauri::command]
fn app_restart(app: tauri::AppHandle, safe: bool) -> CmdResult {
    let exe = std::env::current_exe().map_err(err)?;
    let mut args: Vec<String> = std::env::args().skip(1).filter(|a| a != "--safe-mode").collect();
    if safe {
        args.push("--safe-mode".into());
    }
    std::process::Command::new(exe).args(args).env_remove("OTTERM_SAFE_MODE").spawn().map_err(err)?;
    if let Some(window) = tauri::Manager::get_webview_window(&app, "main") {
        window_state::save(&window);
    }
    app.exit(0);
    Ok(())
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
    use tauri::Manager;
    let handle = app.handle().clone();
    let config = app.state::<AppState>().config;
    settings::apply_window_effects(&handle);
    ConfigState::watch(config, move |_| config_changed(&handle));
}

/// After the configuration was (re)read: running sessions, the window and the UI follow.
pub(crate) fn config_changed(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let state = app.state::<AppState>();
    // Options read while a session runs (the wheel on the alternate screen) follow at once.
    state.sessions.set_terminal_options(config::terminal_options(&state.config.config()));
    settings::apply_window_effects(app);
    let _ = app.emit("config-changed", state.config.ui());
}

/// A later launch: open its tab in the otterm that already runs, and exit. Not with `--config`,
/// `--safe-mode` or `--new-window`, which ask for a process of their own.
fn hand_over(launch: &launch::Launch) -> bool {
    if launch.new_window || launch.safe_mode || launch.config.is_some() {
        return false;
    }
    let request = instance::Request::Open {
        cwd: launch.cwd.clone(),
        command: launch.command.clone(),
        profile: launch.profile.clone(),
    };
    instance::send(request).is_some_and(|r| r.ok)
}

/// Answer a later launch (see [`instance`]).
fn on_request(app: &tauri::AppHandle, request: instance::Request) -> instance::Reply {
    use tauri::{Emitter, Manager};
    let state = app.state::<AppState>();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    match request {
        instance::Request::Open { cwd, command, profile } => {
            let id = add_launch(&state, TabLaunch { cwd, command, profile, input: None });
            match app.emit("instance-open", id) {
                Ok(()) => instance::Reply::ok(),
                Err(e) => instance::Reply::error(e.to_string()),
            }
        }
        instance::Request::Workflow { name } => ask_ui(app, "instance-workflow", serde_json::json!({ "name": name })),
        instance::Request::Ask { question } => {
            if !state.config.config().ai.enabled {
                return instance::Reply::error("AI is off: turn on [ai] enabled (the otterm.ai-assist mod)");
            }
            ask_ui(app, "instance-ask", serde_json::json!({ "question": question }))
        }
    }
}

/// Hand a request to the UI and wait for its `instance_reply`, so that the command line can say
/// whether it worked (an unknown workflow ends with an error).
fn ask_ui(app: &tauri::AppHandle, event: &str, mut payload: serde_json::Value) -> instance::Reply {
    use tauri::{Emitter, Manager};
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
    let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (tx, rx) = std::sync::mpsc::channel();
    let state = app.state::<AppState>();
    state.replies.lock().unwrap().insert(id, tx);
    payload["id"] = id.into();
    let reply = match app.emit(event, payload) {
        Ok(()) => rx
            .recv_timeout(std::time::Duration::from_secs(4))
            .unwrap_or_else(|_| instance::Reply::error("the otterm window did not answer")),
        Err(e) => instance::Reply::error(e.to_string()),
    };
    state.replies.lock().unwrap().remove(&id);
    reply
}

/// The UI's answer to [`ask_ui`].
#[tauri::command]
fn instance_reply(state: State<'_, AppState>, id: u32, ok: bool, message: String) {
    if let Some(tx) = state.replies.lock().unwrap().remove(&id) {
        let _ = tx.send(instance::Reply { ok, message });
    }
}

#[cfg(not(feature = "bench"))]
fn main() {
    crash::install_hook();
    if cli() {
        return;
    }
    let launch = launch::parse(std::env::args().skip(1));
    if hand_over(&launch) {
        return;
    }
    let listen = !launch.new_window;
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("otmod", mod_assets::handle)
        .manage(app_state(launch))
        .manage(mods::ModsState::default())
        .manage(mod_io::ModStreams::default())
        .manage(update::UpdateState::default())
        .setup(move |app| {
            if listen {
                let handle = app.handle().clone();
                // Fails when another otterm listens already (`--config` and the like); this one
                // then runs on its own.
                let _ = instance::listen(move |r| on_request(&handle, r));
            }
            watch_config(app);
            mods::extract_bundled();
            mods::watch(app);
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
            text_metrics,
            text_glyphs,
            text_runs,
            config_get,
            config_open,
            launch_problems,
            workspace_trust,
            workspace_tabs,
            instance_reply,
            ai::ai_available,
            ai::ai_preview,
            ai::ai_preview_seen,
            ai::ai_complete,
            ai::ai_key_set,
            ai::ai_key_present,
            ai::ai_detect_local,
            ai::ai_workspace_off,
            mascot::mascot_seen,
            mascot::mascot_seen_add,
            mascot::mascot_seen_reset,
            mascot::mascot_outfits,
            crash::crash_pending,
            crash::crash_ack,
            update::update_check,
            update::update_install,
            config_tools::config_reset,
            config_tools::config_export,
            config_tools::config_import,
            profiles_list,
            terminal_colors,
            session_focus,
            session_create,
            session_write,
            session_replace_line,
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
            session_block,
            session_block_jump,
            session_block_fold,
            block_save,
            session_clear_scrollback,
            session_reset_modes,
            session_running,
            clipboard_read,
            clipboard_write,
            open_url,
            path_resolve,
            path_open,
            session_close,
            mods::mods_list,
            mods::mod_source,
            mods::mod_grant,
            mods::mod_revoke,
            mods::mod_set_enabled,
            mods::workspace_mod_set,
            mods::mod_install,
            mods::mod_uninstall,
            mods::store_consent,
            mods::store_list,
            mods::store_install,
            mods::mod_setting_set,
            mods::mod_storage,
            mods::mod_fs,
            mods::mod_process_run,
            mod_io::mod_watch,
            mod_io::mod_unwatch,
            mod_io::mod_process_spawn,
            mod_io::mod_process_write,
            mod_io::mod_process_kill,
            mod_io::mod_release,
            mods::mod_pick_allow,
            mods::mod_http_fetch,
            mods::mod_log,
            session_info,
            session_blocks,
            session_screen,
            memory_usage,
            session_reveal_row,
            editors_detect,
            help_get,
            help_learn,
            shell_history,
            assist::path_commands,
            assist::files_find,
            mods::mod_dictionary,
            mods::config_set,
            history_query,
            history_delete,
            settings::config_form,
            settings::config_write,
            settings::themes_list,
            settings::theme_save,
            settings::theme_delete,
            settings::theme_import,
            settings::theme_export_mod,
            settings::layouts_list,
            settings::layout_save,
            settings::user_css_get,
            settings::user_css_set,
            settings::background_set,
            settings::background_image_get,
            settings::fonts_list,
            app_restart,
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
        .manage(app_state(launch::parse(std::env::args().skip(1))))
        .manage(mods::ModsState::default())
        .manage(mod_io::ModStreams::default())
        .manage(bench::BenchState::default())
        .register_asynchronous_uri_scheme_protocol("otmod", mod_assets::handle)
        .setup(|app| {
            watch_config(app);
            mods::extract_bundled();
            mods::watch(app);
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
            text_metrics,
            text_glyphs,
            text_runs,
            config_get,
            config_open,
            launch_problems,
            profiles_list,
            terminal_colors,
            session_focus,
            session_create,
            session_write,
            session_replace_line,
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
            session_block,
            session_block_jump,
            session_block_fold,
            block_save,
            session_clear_scrollback,
            session_reset_modes,
            session_running,
            clipboard_read,
            clipboard_write,
            open_url,
            path_resolve,
            path_open,
            session_close,
            mods::mods_list,
            mods::mod_source,
            mods::mod_grant,
            mods::mod_revoke,
            mods::mod_set_enabled,
            mods::workspace_mod_set,
            mods::mod_install,
            mods::mod_uninstall,
            mods::mod_setting_set,
            mods::mod_storage,
            mods::mod_fs,
            mods::mod_process_run,
            mod_io::mod_watch,
            mod_io::mod_unwatch,
            mod_io::mod_process_spawn,
            mod_io::mod_process_write,
            mod_io::mod_process_kill,
            mod_io::mod_release,
            mods::mod_pick_allow,
            mods::mod_http_fetch,
            mods::mod_log,
            session_info,
            session_blocks,
            session_screen,
            memory_usage,
            session_reveal_row,
            editors_detect,
            help_get,
            help_learn,
            shell_history,
            assist::path_commands,
            assist::files_find,
            mods::mod_dictionary,
            mods::config_set,
            history_query,
            history_delete,
            bench::bench_mode,
            bench::bench_ipc_start,
            bench::bench_ipc_ack,
            bench::bench_typing_done,
            bench::bench_startup_done,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run otterm");
}
