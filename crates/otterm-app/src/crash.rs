//! Local crash logs (decision C11): a panic writes `<data>/logs/crash-<time>.log`, and the next
//! start offers to copy it or open a GitHub issue. Nothing is sent anywhere by otterm; the user
//! pastes the log into the issue themselves and sees everything it contains first.

use std::io::Write;
use std::path::PathBuf;

use serde::Serialize;

/// Logs kept; older ones are deleted when a new one is written.
const KEEP: usize = 10;

fn logs_dir() -> Option<PathBuf> {
    otterm_config::data_dir().map(|d| d.join("logs"))
}

/// Write a crash log for every panic, then let the default hook print as before.
pub fn install_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = write_log(info);
        previous(info);
    }));
}

fn write_log(info: &std::panic::PanicHookInfo<'_>) -> std::io::Result<()> {
    let dir = logs_dir().ok_or_else(|| std::io::Error::other("no data folder"))?;
    std::fs::create_dir_all(&dir)?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let path = dir.join(format!("crash-{}.log", now.as_millis()));
    let message = info
        .payload()
        .downcast_ref::<&str>()
        .map(|s| (*s).to_owned())
        .or_else(|| info.payload().downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "(no message)".into());
    let location = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
    let thread = std::thread::current().name().unwrap_or("unnamed").to_owned();
    let mut file = std::fs::File::create(&path)?;
    writeln!(file, "otterm {} ({} {})", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH)?;
    writeln!(file, "time: {} (unix seconds)", now.as_secs())?;
    writeln!(file, "thread: {thread}")?;
    writeln!(file, "panic: {message}")?;
    writeln!(file, "at: {location}")?;
    writeln!(file, "\n{}", std::backtrace::Backtrace::force_capture())?;
    prune(&dir);
    Ok(())
}

/// Keep the newest [`KEEP`] logs.
fn prune(dir: &std::path::Path) {
    let mut logs = crash_logs(dir);
    logs.sort();
    let extra = logs.len().saturating_sub(KEEP);
    for old in logs.into_iter().take(extra) {
        let _ = std::fs::remove_file(old);
    }
}

fn crash_logs(dir: &std::path::Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("crash-") && n.ends_with(".log"))
        })
        .collect()
}

#[derive(Serialize)]
pub struct Crash {
    /// The file name, to acknowledge it with `crash_ack`.
    name: String,
    path: String,
    text: String,
    /// Where to file an issue (`<repository>/issues/new`).
    issue_url: String,
}

/// The newest crash log the user has not seen yet, if any.
#[tauri::command]
pub fn crash_pending() -> Option<Crash> {
    let dir = logs_dir()?;
    let seen = std::fs::read_to_string(dir.join("crash-seen")).unwrap_or_default();
    let newest = crash_logs(&dir).into_iter().max()?;
    let name = newest.file_name()?.to_string_lossy().into_owned();
    if seen.trim() == name {
        return None;
    }
    let text = std::fs::read_to_string(&newest).ok()?;
    Some(Crash {
        name,
        path: newest.display().to_string(),
        text,
        issue_url: format!("{}/issues/new", env!("CARGO_PKG_REPOSITORY")),
    })
}

/// Do not offer this log again.
#[tauri::command]
pub fn crash_ack(name: String) -> Result<(), String> {
    let dir = logs_dir().ok_or("no data folder")?;
    std::fs::write(dir.join("crash-seen"), name).map_err(|e| e.to_string())
}
