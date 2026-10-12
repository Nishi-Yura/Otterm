//! Where the shells run (decision M26): in the session daemon, so they outlive the window, or in
//! this process when `general.keep_sessions = "never"` or the daemon cannot start.
//!
//! On Windows the daemon runs from a copy of otterm's executable in the data folder. The installer
//! of an update replaces `otterm.exe` and stops the processes started from it; a daemon started
//! from the copy keeps running through the update, with the shells.

use std::path::{Path, PathBuf};

use otterm_config::KeepSessions;
use otterm_session::remote::{DaemonLauncher, RemoteSessionManager, build_id, run_daemon};
use otterm_session::{LocalSessionManager, SessionManager};

/// Files the daemon needs next to it: the bundled pseudo console (decision M3).
#[cfg(windows)]
const COMPANIONS: &[&str] = &["conpty.dll", "OpenConsole.exe"];

/// `otterm --daemon`: run the session daemon until it has nothing left to do.
pub fn run() {
    let Some(data) = otterm_config::data_dir() else { return };
    let build = std::env::var("OTTERM_DAEMON_BUILD")
        .ok()
        .unwrap_or_else(|| std::env::current_exe().map(|exe| build_id(&exe)).unwrap_or_default());
    if let Err(e) = run_daemon(&data, &build) {
        log(&format!("the session daemon stopped: {e}"));
    }
}

/// `<data>/logs/daemon.log`: neither the daemon nor a release window has a console to print to.
fn log(text: &str) {
    let Some(dir) = otterm_config::data_dir().map(|d| d.join("logs")) else { return };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("daemon.log")) {
        use std::io::Write;
        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        let _ = writeln!(f, "{secs} {text}");
    }
}

/// The session manager for this window.
pub fn sessions(keep: KeepSessions) -> Box<dyn SessionManager> {
    if keep != KeepSessions::Never
        && let Some(launcher) = launcher()
    {
        match RemoteSessionManager::connect(launcher) {
            Ok(remote) => return Box::new(remote),
            Err(e) => log(&format!("the session daemon did not start, shells run in this window: {e}")),
        }
    }
    let local = LocalSessionManager::new();
    // Unlimited scrollback spills here, one folder per process (docs/09 §5); what a crashed run
    // left is no use now.
    if let Some(root) = otterm_config::data_dir().map(|d| d.join("scrollback")) {
        otterm_session::clean_spill_root(&root);
        local.set_spill_root(Some(root.join(std::process::id().to_string())));
    }
    Box::new(local)
}

fn launcher() -> Option<DaemonLauncher> {
    let data = otterm_config::data_dir()?;
    let exe = std::env::current_exe().ok()?;
    let build = build_id(&exe);
    let exe = daemon_exe(&data, &exe, &build).unwrap_or(exe);
    Some(DaemonLauncher { data, exe, build })
}

/// The executable the daemon starts from: a copy per build in `<data>/daemon/bin/` on Windows
/// (see the module comment), otterm itself elsewhere.
#[cfg(windows)]
fn daemon_exe(data: &Path, exe: &Path, build: &str) -> Option<PathBuf> {
    let bin = data.join("daemon").join("bin");
    let dir = bin.join(build);
    let target = dir.join("otterm-daemon.exe");
    if !target.exists() {
        std::fs::create_dir_all(&dir).ok()?;
        let tmp = dir.join("otterm-daemon.exe.tmp");
        std::fs::copy(exe, &tmp).ok()?;
        let from = exe.parent()?;
        for name in COMPANIONS {
            if from.join(name).exists() {
                std::fs::copy(from.join(name), dir.join(name)).ok()?;
            }
        }
        std::fs::rename(&tmp, &target).ok()?;
    }
    // Copies of other builds go once no daemon runs from them (a running one keeps its file).
    if let Ok(entries) = std::fs::read_dir(&bin) {
        for e in entries.flatten() {
            if e.file_name() != std::ffi::OsStr::new(build) {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    Some(target)
}

#[cfg(not(windows))]
fn daemon_exe(_data: &Path, _exe: &Path, _build: &str) -> Option<PathBuf> {
    None
}
