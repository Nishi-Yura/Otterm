//! Reading `config.toml` (docs/06 §1, §3).
//!
//! A broken value never stops otterm from starting: each top-level section is read on its own,
//! and inside a section that does not parse, every key is tried alone. Keys that fail fall back to
//! their defaults and are reported as [`Warning`]s, which the UI shows once at startup.

use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;

use crate::schema::Config;

/// A key that was ignored, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Warning {
    /// Dotted path, e.g. `terminal.scrollback`. Empty for the file as a whole.
    pub key: String,
    pub message: String,
}

/// The user configuration file for this platform (docs/06 §1). `OTTERM_CONFIG` overrides it.
pub fn config_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("OTTERM_CONFIG") {
        return Some(PathBuf::from(p));
    }
    config_dir().map(|d| d.join("config.toml"))
}

/// The folder holding `config.toml` and `themes/`.
pub fn config_dir() -> Option<PathBuf> {
    let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    if cfg!(windows) {
        env("APPDATA").map(|d| d.join("otterm"))
    } else if cfg!(target_os = "macos") {
        let home = env("HOME")?;
        let xdg = home.join(".config").join("otterm");
        Some(if xdg.is_dir() { xdg } else { home.join("Library").join("Application Support").join("otterm") })
    } else {
        env("XDG_CONFIG_HOME").or_else(|| env("HOME").map(|h| h.join(".config"))).map(|d| d.join("otterm"))
    }
}

/// Read the configuration at `path`. A missing file gives the defaults without warnings.
pub fn load(path: &Path) -> (Config, Vec<Warning>) {
    match std::fs::read_to_string(path) {
        Ok(text) => parse(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Config::default(), Vec::new()),
        Err(e) => (Config::default(), vec![Warning { key: String::new(), message: e.to_string() }]),
    }
}

/// Parse configuration text, falling back to defaults key by key.
pub fn parse(text: &str) -> (Config, Vec<Warning>) {
    let mut warnings = Vec::new();
    let table = match text.parse::<toml::Table>() {
        Ok(t) => t,
        Err(e) => {
            warnings.push(Warning { key: String::new(), message: e.message().to_owned() });
            return (Config::default(), warnings);
        }
    };
    let mut config = Config::default();
    for (key, value) in table {
        let w = &mut warnings;
        match key.as_str() {
            "schema" => config.schema = section(&key, value, w),
            "general" => config.general = section(&key, value, w),
            "appearance" => config.appearance = section(&key, value, w),
            "font" => config.font = section(&key, value, w),
            "terminal" => config.terminal = section(&key, value, w),
            "shell" => config.shell = section(&key, value, w),
            "profiles" => config.profiles = section(&key, value, w),
            "mascot" => config.mascot = section(&key, value, w),
            "assist" => config.assist = section(&key, value, w),
            "open" => config.open = section(&key, value, w),
            "history" => config.history = section(&key, value, w),
            "keybindings" => config.keybindings = section(&key, value, w),
            "mods" => config.mods = section(&key, value, w),
            "ai" => config.ai = section(&key, value, w),
            _ => w.push(Warning { key, message: "unknown section".into() }),
        }
    }
    (config, warnings)
}

/// One section; on failure, keep the keys that parse on their own.
fn section<T: DeserializeOwned + Default>(name: &str, value: toml::Value, warnings: &mut Vec<Warning>) -> T {
    let error = match value.clone().try_into::<T>() {
        Ok(v) => return v,
        Err(e) => e,
    };
    let toml::Value::Table(table) = value else {
        warnings.push(Warning { key: name.to_owned(), message: error.message().to_owned() });
        return T::default();
    };
    let mut good = toml::Table::new();
    for (key, v) in table {
        let mut alone = toml::Table::new();
        alone.insert(key.clone(), v.clone());
        match toml::Value::Table(alone).try_into::<T>() {
            Ok(_) => {
                good.insert(key, v);
            }
            Err(e) => warnings.push(Warning { key: format!("{name}.{key}"), message: e.message().to_owned() }),
        }
    }
    // Keys can still clash with each other; then the whole section falls back.
    toml::Value::Table(good).try_into().unwrap_or_else(|e: toml::de::Error| {
        warnings.push(Warning { key: name.to_owned(), message: e.message().to_owned() });
        T::default()
    })
}
