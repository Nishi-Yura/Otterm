//! Remember the window's size and position (decision I7): saved when the window closes, restored
//! at startup when it still fits on a monitor, otherwise the default size centered on the primary
//! monitor. Stored in `<data dir>/state/window.json` (docs/06 §1).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
struct Saved {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

/// The folder for otterm's own data: mods, state, logs (docs/06 §1).
fn data_dir() -> Option<PathBuf> {
    let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    if cfg!(windows) {
        env("LOCALAPPDATA").map(|d| d.join("otterm"))
    } else if cfg!(target_os = "macos") {
        env("HOME").map(|h| h.join("Library").join("Application Support").join("otterm"))
    } else {
        env("XDG_DATA_HOME").or_else(|| env("HOME").map(|h| h.join(".local").join("share"))).map(|d| d.join("otterm"))
    }
}

fn state_file() -> Option<PathBuf> {
    // Automated UI tests and benches must not move or resize the user's window next time.
    if std::env::var_os("OTTERM_CONFIG").is_some() || std::env::var_os("OTTERM_BENCH").is_some() {
        return None;
    }
    data_dir().map(|d| d.join("state").join("window.json"))
}

/// Put the window where it was last time, then show it. Always shows it, whatever fails.
pub fn restore(window: &WebviewWindow) {
    let saved = state_file()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Saved>(&t).ok())
        .filter(|s| s.width >= 200 && s.height >= 150 && on_a_monitor(window, s));
    match saved {
        Some(s) => {
            let _ = window.set_size(PhysicalSize::new(s.width, s.height));
            let _ = window.set_position(PhysicalPosition::new(s.x, s.y));
            if s.maximized {
                let _ = window.maximize();
            }
        }
        None => {
            let _ = window.center();
        }
    }
    let _ = window.show();
}

/// Some part of the title bar area is on a monitor that is connected now.
fn on_a_monitor(window: &WebviewWindow, s: &Saved) -> bool {
    let Ok(monitors) = window.available_monitors() else { return false };
    // A point near the top middle of the window: where the user grabs it to move it.
    let (px, py) = (s.x + s.width as i32 / 2, s.y + 16);
    monitors.iter().any(|m| {
        let (p, z) = (m.position(), m.size());
        px >= p.x && px < p.x + z.width as i32 && py >= p.y && py < p.y + z.height as i32
    })
}

/// Save the window's place; called when it is about to close.
pub fn save(window: &WebviewWindow) {
    let Some(path) = state_file() else { return };
    let maximized = window.is_maximized().unwrap_or(false);
    // While maximized the size is the monitor's; keep the last normal size if we have one.
    let previous = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Saved>(&t).ok());
    // Position is the outer corner (what set_position takes); size is the inner size (what
    // set_size takes), so the frame does not add up over restarts.
    let state = match (window.outer_position(), window.inner_size(), maximized, previous) {
        (_, _, true, Some(p)) => Saved { maximized: true, ..p },
        (Ok(pos), Ok(size), _, _) => Saved { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized },
        _ => return,
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string(&state) {
        let _ = std::fs::write(path, text);
    }
}
