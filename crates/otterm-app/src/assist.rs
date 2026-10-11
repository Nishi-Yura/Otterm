//! Data for the input assist that lives on the host side (docs/03 §7, §8): executables on PATH for
//! completion, files under a folder for the palette's `@`, and `otterm trash` (decision B8).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Folders the `@` search never enters: large and never what a person means to open.
const SKIP_DIRS: &[&str] =
    &[".git", "node_modules", "target", "dist", "build", ".venv", "venv", "__pycache__", ".next", ".turbo"];
/// How many entries the `@` search looks at before it stops, so a home folder does not stall it.
const WALK_LIMIT: usize = 20_000;
const WALK_DEPTH: usize = 8;

/// Command names on PATH (docs/03 §8.2 source 2), without extensions on Windows, sorted. Read once:
/// a PATH with network folders would be slow to scan per keystroke.
#[tauri::command]
pub async fn path_commands() -> Vec<String> {
    static NAMES: OnceLock<Vec<String>> = OnceLock::new();
    NAMES.get_or_init(scan_path).clone()
}

fn scan_path() -> Vec<String> {
    let Some(path) = std::env::var_os("PATH") else { return Vec::new() };
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
            .split(';')
            .filter(|e| !e.is_empty())
            .map(|e| e.to_ascii_lowercase())
            .collect()
    } else {
        Vec::new()
    };
    let mut names = BTreeSet::new();
    for dir in std::env::split_paths(&path) {
        // A missing folder on PATH is common; skip it quietly.
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if cfg!(windows) {
                let lower = name.to_ascii_lowercase();
                if let Some(ext) = exts.iter().find(|x| lower.ends_with(x.as_str())) {
                    names.insert(name[..name.len() - ext.len()].to_owned());
                }
            } else if is_executable(&e.path()) {
                names.insert(name);
            }
        }
    }
    names.into_iter().collect()
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Files under `cwd` whose relative path contains every word of `query` (case-insensitive), at
/// most `limit`, shortest paths first: the palette's `@` (docs/03 §7). Paths use `/`.
#[tauri::command]
pub async fn files_find(cwd: String, query: String, limit: usize) -> Vec<String> {
    let root = PathBuf::from(&cwd);
    if !root.is_dir() || !crate::open::local(&root) {
        return Vec::new();
    }
    let words: Vec<String> = query.to_lowercase().split_whitespace().map(str::to_owned).collect();
    let limit = limit.clamp(1, 500);
    tauri::async_runtime::spawn_blocking(move || find(&root, &words, limit)).await.unwrap_or_default()
}

fn find(root: &Path, words: &[String], limit: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut seen = 0;
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            seen += 1;
            if seen > WALK_LIMIT {
                break;
            }
            let path = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(kind) = e.file_type() else { continue };
            if kind.is_dir() {
                if depth < WALK_DEPTH && !SKIP_DIRS.contains(&name.as_str()) && !kind.is_symlink() {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            let lower = rel.to_lowercase();
            if words.iter().all(|w| lower.contains(w.as_str())) {
                out.push(rel);
            }
        }
    }
    out.sort_by_key(|p| (p.len(), p.clone()));
    out.truncate(limit);
    out
}

/// `otterm trash <path>...` (decision B8): danger-guard rewrites `rm -r x` into this, so the
/// command that ran is still visible and teaches. Moves to the OS trash; prints what it moved.
pub fn trash_cli(args: &[String]) -> Result<String, String> {
    let paths: Vec<&String> = args.iter().filter(|a| !a.starts_with('-')).collect();
    if paths.is_empty() {
        return Err("usage: otterm trash <path>...".into());
    }
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let mut out = String::new();
    let mut failed = Vec::new();
    for p in paths {
        let full = cwd.join(p);
        if std::fs::symlink_metadata(&full).is_err() {
            failed.push(format!("{p}: not found"));
            continue;
        }
        match trash::delete(&full) {
            Ok(()) => out.push_str(&format!("moved to the trash: {p}\n")),
            Err(e) => failed.push(format!("{p}: {e}")),
        }
    }
    if failed.is_empty() { Ok(out) } else { Err(format!("{out}{}", failed.join("\n"))) }
}
