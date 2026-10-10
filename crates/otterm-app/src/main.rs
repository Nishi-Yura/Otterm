//! The otterm desktop app. M0: one window, one shell, raw output (docs/07-roadmap.md M0).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use otterm_session::{LocalSessionManager, PtySize, SessionEvent, SessionId, SessionManager, SpawnOptions};
use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody};

struct AppState {
    sessions: Box<dyn SessionManager>,
}

type CmdResult<T = ()> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Start a shell. Output goes to `output` as raw bytes (decision C13); `exit` fires once at the end.
#[tauri::command]
fn session_create(
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
    output: Channel<InvokeResponseBody>,
    exit: Channel<Option<u32>>,
) -> CmdResult<SessionId> {
    let opts = SpawnOptions { size: PtySize { cols, rows }, ..Default::default() };
    state
        .sessions
        .create(
            opts,
            Box::new(move |ev| {
                // A failed send means the window is gone; the session ends with the app.
                let _ = match ev {
                    SessionEvent::Output(bytes) => output.send(InvokeResponseBody::Raw(bytes)),
                    SessionEvent::Exited { code } => exit.send(code),
                };
            }),
        )
        .map_err(err)
}

#[tauri::command]
fn session_write(state: State<'_, AppState>, id: SessionId, data: String) -> CmdResult {
    state.sessions.write(id, data.as_bytes()).map_err(err)
}

#[tauri::command]
fn session_resize(state: State<'_, AppState>, id: SessionId, cols: u16, rows: u16) -> CmdResult {
    state.sessions.resize(id, PtySize { cols, rows }).map_err(err)
}

#[tauri::command]
fn session_close(state: State<'_, AppState>, id: SessionId) -> CmdResult {
    state.sessions.close(id).map_err(err)
}

#[cfg(not(feature = "bench"))]
fn main() {
    tauri::Builder::default()
        .manage(AppState { sessions: Box::new(LocalSessionManager::new()) })
        .invoke_handler(tauri::generate_handler![session_create, session_write, session_resize, session_close])
        .run(tauri::generate_context!())
        .expect("failed to run otterm");
}

#[cfg(feature = "bench")]
mod bench;

#[cfg(feature = "bench")]
fn main() {
    tauri::Builder::default()
        .manage(AppState { sessions: Box::new(LocalSessionManager::new()) })
        .manage(bench::BenchState::default())
        .invoke_handler(tauri::generate_handler![
            session_create,
            session_write,
            session_resize,
            session_close,
            bench::bench_mode,
            bench::bench_ipc_start,
            bench::bench_ipc_ack,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run otterm");
}
