//! Workspace files (`.otterm/workspace.toml`, docs/06 §2) and the trust that gates them (K4).
//!
//! A cloned repository can ship a workspace file, so nothing in it runs or sends data until the
//! user trusts that folder. Trust is stored in the data folder, never in the repository, so a
//! repo cannot trust itself.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::load::{self, Warning};
use crate::schema::{Config, WorkspaceConfig};

/// `config.toml` sections that a workspace file may override.
const SECTIONS: &[&str] = &[
    "general",
    "appearance",
    "font",
    "terminal",
    "mascot",
    "assist",
    "keybindings",
    "accessibility",
    "shell",
    "open",
    "history",
    "mods",
    "ai",
    "profiles",
];

/// Keys a cloned repository must not set: they run programs or send data.
const FORBIDDEN: &[&str] = &[
    "shell",
    "profiles",
    "open",
    "ai",
    "mods",
    "history",
    "keybindings.custom",
    "general.check_updates",
    "general.update_channel",
];

/// A workspace file read from disk. Nothing is applied yet; see [`apply_workspace`].
#[derive(Debug, Clone)]
pub struct Workspace {
    /// The `workspace.toml` file, absolute.
    pub file: PathBuf,
    /// The folder the workspace opens in: `cwd` resolved against the folder that holds `.otterm/`.
    pub root: PathBuf,
    pub config: WorkspaceConfig,
    /// `[section]` tables that override `config.toml`. Used only when trusted.
    pub overrides: toml::Table,
}

/// The nearest `.otterm/workspace.toml` at or above `start`. The search stops after the home
/// folder, so a file in a folder above home is never picked up.
pub fn find_workspace(start: &Path) -> Option<PathBuf> {
    let start = std::path::absolute(start).ok()?;
    let home = home_dir();
    for dir in start.ancestors() {
        let file = dir.join(".otterm").join("workspace.toml");
        if file.is_file() {
            return Some(file);
        }
        if home.as_deref().is_some_and(|h| same_path(h, dir)) {
            break;
        }
    }
    None
}

/// Read a workspace file. Keys may sit at top level or inside `[workspace]`; section names go to
/// `overrides`, the rest to `config`. A broken key is dropped with a [`Warning`].
pub fn load_workspace(file: &Path) -> (Option<Workspace>, Vec<Warning>) {
    let mut warnings = Vec::new();
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) => {
            warnings.push(Warning { key: String::new(), message: e.to_string() });
            return (None, warnings);
        }
    };
    let mut top = match text.parse::<toml::Table>() {
        Ok(t) => t,
        Err(e) => {
            warnings.push(Warning { key: String::new(), message: e.message().to_owned() });
            return (None, warnings);
        }
    };
    let inner = match top.remove("workspace") {
        Some(toml::Value::Table(t)) => t,
        Some(_) => {
            warnings.push(Warning { key: "workspace".into(), message: "expected a table".into() });
            toml::Table::new()
        }
        None => toml::Table::new(),
    };

    let mut fields = toml::Table::new();
    let mut overrides = toml::Table::new();
    // Top-level keys come last, so they win over the same key inside `[workspace]`.
    for (key, value) in inner.into_iter().chain(top) {
        if SECTIONS.contains(&key.as_str()) {
            overrides.insert(key, value);
        } else {
            fields.insert(key, value);
        }
    }
    let config: WorkspaceConfig = load::section("workspace", toml::Value::Table(fields), &mut warnings);

    let file = std::path::absolute(file).unwrap_or_else(|_| file.to_path_buf());
    // The file is `<root>/.otterm/workspace.toml`, so the root is two levels up.
    let base = file.parent().and_then(Path::parent).unwrap_or(Path::new("."));
    let root = normalize(&base.join(config.cwd.as_deref().unwrap_or(".")));
    (Some(Workspace { file, root, config, overrides }), warnings)
}

/// Apply a workspace to `config`. Untrusted, only the theme applies (K4). Trusted, the outfit,
/// the `[section]` overrides and the dotted `settings` apply too, minus [`FORBIDDEN`] keys.
pub fn apply_workspace(config: &mut Config, ws: &Workspace, trusted: bool) -> Vec<Warning> {
    let mut warnings = Vec::new();
    let mut updates = Vec::new();
    // The light-mode theme too: otherwise following the OS would hide the workspace's theme.
    if let Some(theme) = &ws.config.theme {
        for key in ["theme", "theme_light"] {
            updates.push((vec!["appearance".into(), key.into()], toml::Value::String(theme.clone())));
        }
    }
    if trusted {
        if let Some(outfit) = &ws.config.outfit {
            updates.push((vec!["mascot".into(), "outfit".into()], toml::Value::String(outfit.clone())));
        }
        for (key, value) in &ws.overrides {
            flatten(vec![key.clone()], value, &mut updates);
        }
        // `settings` keys are dotted paths; map keys inside the overrides may hold dots themselves
        // (`keybindings.bindings."tab.new"`), so paths are kept as parts, not strings.
        for (key, value) in &ws.config.settings {
            flatten(key.split('.').map(str::to_owned).collect(), value, &mut updates);
        }
    }
    if updates.is_empty() {
        return warnings;
    }

    let mut merged = match toml::Table::try_from(&*config) {
        Ok(t) => t,
        Err(e) => {
            warnings.push(Warning { key: String::new(), message: e.to_string() });
            return warnings;
        }
    };
    for (path, value) in updates {
        let dotted = path.join(".");
        if FORBIDDEN.iter().any(|f| {
            let f: Vec<&str> = f.split('.').collect();
            path.len() >= f.len() && path.iter().zip(&f).all(|(a, b)| a == b)
        }) {
            warnings.push(Warning { key: dotted, message: "not allowed in workspace.toml".into() });
            continue;
        }
        set_path(&mut merged, &path, value);
    }
    // Re-parse so that per-key fallback and warnings match `config.toml`.
    let text = match toml::to_string(&merged) {
        Ok(s) => s,
        Err(e) => {
            warnings.push(Warning { key: String::new(), message: e.to_string() });
            return warnings;
        }
    };
    let (applied, more) = load::parse(&text);
    warnings.extend(more);
    *config = applied;
    warnings
}

/// Flatten a value into dotted leaf paths, so that a forbidden leaf is caught wherever it sits.
fn flatten(path: Vec<String>, value: &toml::Value, out: &mut Vec<(Vec<String>, toml::Value)>) {
    match value {
        toml::Value::Table(t) => {
            for (k, v) in t {
                let mut p = path.clone();
                p.push(k.clone());
                flatten(p, v, out);
            }
        }
        other => out.push((path, other.clone())),
    }
}

/// Set a path, replacing any non-table value on the way.
fn set_path(table: &mut toml::Table, path: &[String], value: toml::Value) {
    match path {
        [] => {}
        [last] => {
            table.insert(last.clone(), value);
        }
        [head, rest @ ..] => {
            let entry = table.entry(head.clone()).or_insert_with(|| toml::Value::Table(toml::Table::new()));
            if !entry.is_table() {
                *entry = toml::Value::Table(toml::Table::new());
            }
            if let Some(t) = entry.as_table_mut() {
                set_path(t, rest, value);
            }
        }
    }
}

/// Which workspace folders the user has trusted (K4), kept in `<data_dir>/state`.
#[derive(Debug)]
pub struct TrustStore {
    path: PathBuf,
    entries: BTreeMap<String, Entry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    trusted: bool,
    /// Unix seconds when the choice was made.
    at: u64,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct StoreFile {
    workspaces: BTreeMap<String, Entry>,
}

impl TrustStore {
    /// Load the store under `data_dir`. A missing or unreadable file means nothing is decided yet.
    pub fn open(data_dir: &Path) -> Self {
        let path = data_dir.join("state").join("trusted-workspaces.json");
        let entries = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<StoreFile>(&t).ok())
            .map(|f| f.workspaces)
            .unwrap_or_default();
        Self { path, entries }
    }

    /// `Some(true)` or `Some(false)` when decided, `None` when the user was never asked.
    pub fn get(&self, root: &Path) -> Option<bool> {
        self.entries.get(&key(root)).map(|e| e.trusted)
    }

    /// Record a choice and write the file. The in-memory state changes only if the write works.
    pub fn set(&mut self, root: &Path, trusted: bool) -> Result<(), String> {
        let at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let mut next = self.entries.clone();
        next.insert(key(root), Entry { trusted, at });

        let dir = self.path.parent().ok_or("trust store path has no folder")?;
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let text = serde_json::to_string_pretty(&StoreFile { workspaces: next.clone() }).map_err(|e| e.to_string())?;
        // Write beside the target, then rename, so a crash never leaves a half-written file.
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())?;
        self.entries = next;
        Ok(())
    }
}

/// Map key for a workspace root: absolute and normalized, lowercase on Windows where case is ignored.
fn key(root: &Path) -> String {
    let abs = std::path::absolute(root).unwrap_or_else(|_| root.to_path_buf());
    let s = normalize(&abs).to_string_lossy().into_owned();
    if cfg!(windows) { s.to_lowercase() } else { s }
}

/// Resolve `.` and `..` without touching the disk, since the folder may not exist yet.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Path equality that ignores case on Windows, where the file system does too.
fn same_path(a: &Path, b: &Path) -> bool {
    if cfg!(windows) { a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy()) } else { a == b }
}

fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from)
}
