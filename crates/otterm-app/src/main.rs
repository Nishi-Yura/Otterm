//! The otterm desktop app.
//!
//! Screen frames go to the WebView over the local WebSocket in [`screen`] (decision M2); commands,
//! input and the other session events use Tauri IPC.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod screen;

use otterm_session::{Key, LocalSessionManager, PtySize, SessionEvent, SessionId, SessionManager, SpawnOptions};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;

use crate::screen::ScreenServer;

struct AppState {
    sessions: Box<dyn SessionManager>,
    screen: std::sync::Arc<ScreenServer>,
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

/// Start a shell. Frames go to the screen socket; everything else to `events`.
#[tauri::command]
fn session_create(state: State<'_, AppState>, cols: u16, rows: u16, events: Channel<UiEvent>) -> CmdResult<SessionId> {
    let opts = SpawnOptions { size: PtySize { cols, rows }, ..Default::default() };
    let screen = std::sync::Arc::clone(&state.screen);
    state
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
                    SessionEvent::ClipboardWrite(data) => events.send(UiEvent::Clipboard { data }),
                    SessionEvent::Exited { code } => events.send(UiEvent::Exited { code }),
                    SessionEvent::Output(_) => Ok(()),
                };
            }),
        )
        .map_err(err)
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

#[tauri::command]
fn session_close(state: State<'_, AppState>, id: SessionId) -> CmdResult {
    state.sessions.close(id).map_err(err)
}

fn app_state() -> AppState {
    AppState {
        sessions: Box::new(LocalSessionManager::new()),
        screen: std::sync::Arc::new(ScreenServer::start().expect("start the screen socket")),
    }
}

#[cfg(not(feature = "bench"))]
fn main() {
    tauri::Builder::default()
        .manage(app_state())
        .invoke_handler(tauri::generate_handler![
            screen_endpoint,
            session_create,
            session_write,
            session_key,
            session_paste,
            session_resize,
            session_redraw,
            session_close,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run otterm");
}

#[cfg(feature = "bench")]
mod bench;

#[cfg(feature = "bench")]
fn main() {
    tauri::Builder::default()
        .manage(app_state())
        .manage(bench::BenchState::default())
        .invoke_handler(tauri::generate_handler![
            screen_endpoint,
            session_create,
            session_write,
            session_key,
            session_paste,
            session_resize,
            session_redraw,
            session_close,
            bench::bench_mode,
            bench::bench_ipc_start,
            bench::bench_ipc_ack,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run otterm");
}
