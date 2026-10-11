//! `otterm config get|set|path|reset|export|import` (docs/06 §3, §4), and the same export, import
//! and reset for the settings screen.
//!
//! An export is one zip with what lives in the configuration folder — `config.toml`, `user.css`,
//! `themes/`, `layouts/`, `backgrounds/` — plus `mods.toml`, the list of installed mods to install
//! again. Mods themselves are not packed: they come from their own sources.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::config::ConfigState;

/// Folders of the configuration folder that go into an export, besides the two files.
const FOLDERS: &[&str] = &["themes", "layouts", "backgrounds"];
const FILES: &[&str] = &["config.toml", "user.css"];
/// Limits for an import: one file, and everything unpacked.
const MAX_FILE: u64 = 30 * 1024 * 1024;
const MAX_TOTAL: u64 = 100 * 1024 * 1024;

pub fn cli(args: &[String]) -> Result<String, String> {
    let usage = "usage: otterm config path | get [key] | set <key> <value> | reset <key>|--all | export [file.zip] | import <file.zip>";
    let config = ConfigState::load(None, None);
    match args.first().map(String::as_str) {
        Some("path") => {
            let data = otterm_config::data_dir().map(|d| d.display().to_string()).unwrap_or_default();
            let file = config.path().map(|p| p.display().to_string()).unwrap_or_default();
            Ok(format!("config\t{file}\ndata\t{data}\n"))
        }
        Some("get") => get(&config, args.get(1).map(String::as_str)),
        Some("set") if args.len() >= 3 => {
            let key = split_key(&args[1])?;
            let value = parse_value(&args[2..].join(" "));
            crate::settings::write_config(&config, &key, Some(value))?;
            Ok(String::new())
        }
        Some("reset") if args.get(1).is_some_and(|a| a == "--all") => {
            let backup = reset_all(&config)?;
            Ok(format!("reset; the old file is {}\n", backup.display()))
        }
        Some("reset") if args.len() == 2 => {
            crate::settings::write_config(&config, &split_key(&args[1])?, None)?;
            Ok(String::new())
        }
        Some("export") => {
            let file = args.get(1).map_or_else(|| PathBuf::from(default_export_name()), PathBuf::from);
            std::fs::write(&file, export(&config)?).map_err(|e| format!("{}: {e}", file.display()))?;
            Ok(format!("exported to {}\n", file.display()))
        }
        Some("import") if args.len() == 2 => {
            let bytes = std::fs::read(&args[1]).map_err(|e| format!("{}: {e}", args[1]))?;
            import(&config, &bytes)
        }
        _ => Err(usage.into()),
    }
}

/// The value at `key` as TOML (defaults included), or the whole configuration.
fn get(config: &ConfigState, key: Option<&str>) -> Result<String, String> {
    let table = toml::Table::try_from(config.config()).map_err(|e| e.to_string())?;
    let mut value = toml::Value::Table(table);
    if let Some(key) = key {
        for part in split_key(key)? {
            value = value.get(&part).cloned().ok_or_else(|| format!("no key {key}"))?;
        }
    }
    Ok(match value {
        toml::Value::Table(t) => toml::to_string(&t).map_err(|e| e.to_string())?,
        v => format!("{v}\n"),
    })
}

/// Split `a.b."c.d"` into its parts; quotes keep dots in map keys (`keybindings.bindings."tab.new"`).
pub fn split_key(key: &str) -> Result<Vec<String>, String> {
    let mut parts = vec![String::new()];
    let mut quoted = false;
    for c in key.chars() {
        match c {
            '"' => quoted = !quoted,
            '.' if !quoted => parts.push(String::new()),
            c => parts.last_mut().expect("never empty").push(c),
        }
    }
    if quoted || parts.iter().any(String::is_empty) {
        return Err(format!("not a key: {key}"));
    }
    Ok(parts)
}

/// A value as TOML would read it (`14`, `true`, `["a", "b"]`), else the text as a string.
fn parse_value(text: &str) -> Value {
    #[derive(serde::Deserialize)]
    struct One {
        v: toml::Value,
    }
    match toml::from_str::<One>(&format!("v = {text}")) {
        Ok(one) => serde_json::to_value(one.v).unwrap_or(Value::String(text.into())),
        Err(_) => Value::String(text.into()),
    }
}

/// Put config.toml back to the defaults, keeping the old file beside it.
pub fn reset_all(config: &ConfigState) -> Result<PathBuf, String> {
    let file = config.path().ok_or("no configuration folder")?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let backup = file.with_file_name(format!("config.toml.bak-reset-{stamp}"));
    if file.exists() {
        std::fs::copy(&file, &backup).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, format!("schema = {}\n", otterm_config::CURRENT_SCHEMA)).map_err(|e| e.to_string())?;
    config.reload();
    Ok(backup)
}

pub fn default_export_name() -> String {
    let days =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0);
    let (y, m, d) = civil(days as i64);
    format!("otterm-settings-{y:04}{m:02}{d:02}.zip")
}

/// Days since 1970-01-01 to a calendar date (Howard Hinnant's algorithm).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// The zip of the configuration folder and the mod list.
pub fn export(config: &ConfigState) -> Result<Vec<u8>, String> {
    let dir = config.dir()?;
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut add = |name: &str, bytes: &[u8]| -> Result<(), String> {
        zip.start_file(name, options).map_err(|e| e.to_string())?;
        zip.write_all(bytes).map_err(|e| e.to_string())
    };
    for name in FILES {
        if let Ok(bytes) = std::fs::read(dir.join(name)) {
            add(name, &bytes)?;
        }
    }
    for folder in FOLDERS {
        for entry in std::fs::read_dir(dir.join(folder)).into_iter().flatten().flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
            if path.is_file()
                && let Ok(bytes) = std::fs::read(&path)
            {
                add(&format!("{folder}/{name}"), &bytes)?;
            }
        }
    }
    let mut list =
        String::from("# Mods installed when these settings were exported. `otterm mod install` adds them again.\n");
    for (id, version) in crate::mods::installed_mods() {
        list.push_str(&format!("[[mods]]\nid = {}\nversion = {}\n", quote(&id), quote(&version)));
    }
    add("mods.toml", list.as_bytes())?;
    let cursor = zip.finish().map_err(|e| e.to_string())?;
    Ok(cursor.into_inner())
}

fn quote(s: &str) -> String {
    toml_edit::Value::from(s).to_string()
}

/// Unpack an export into the configuration folder. Only the files an export holds are taken;
/// config.toml is backed up first. Returns what happened, including mods to install again.
pub fn import(config: &ConfigState, bytes: &[u8]) -> Result<String, String> {
    let dir = config.dir()?;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let mut files: Vec<(PathBuf, Vec<u8>)> = Vec::new();
    let mut mods_toml = None;
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        // `enclosed_name` refuses `..` and absolute paths.
        let Some(name) = entry.enclosed_name() else { continue };
        if !allowed(&name) && name != Path::new("mods.toml") {
            continue;
        }
        if entry.size() > MAX_FILE {
            return Err(format!("{} is too large", name.display()));
        }
        total += entry.size();
        if total > MAX_TOTAL {
            return Err("the export unpacks to more than 100 MB".into());
        }
        let mut data = Vec::new();
        entry.by_ref().take(MAX_FILE + 1).read_to_end(&mut data).map_err(|e| e.to_string())?;
        if name == Path::new("mods.toml") {
            mods_toml = Some(String::from_utf8_lossy(&data).into_owned());
        } else {
            files.push((name, data));
        }
    }
    if files.is_empty() {
        return Err("not an otterm settings export".into());
    }
    if let Some((_, text)) = files.iter().find(|(n, _)| n == Path::new("config.toml")) {
        let text = String::from_utf8_lossy(text);
        if text.parse::<toml::Table>().is_err() {
            return Err("its config.toml is not valid TOML".into());
        }
    }
    let mut out = String::new();
    let current = dir.join("config.toml");
    if current.exists() && files.iter().any(|(n, _)| n == Path::new("config.toml")) {
        let stamp =
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let backup = dir.join(format!("config.toml.bak-import-{stamp}"));
        std::fs::copy(&current, &backup).map_err(|e| e.to_string())?;
        out.push_str(&format!("the old config.toml is {}\n", backup.display()));
    }
    for (name, data) in &files {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, data).map_err(|e| format!("{}: {e}", name.display()))?;
        out.push_str(&format!("imported {}\n", name.display()));
    }
    let installed: Vec<String> = crate::mods::installed_mods().into_iter().map(|(id, _)| id).collect();
    let missing: Vec<String> = mods_toml
        .and_then(|t| t.parse::<toml::Table>().ok())
        .and_then(|t| t.get("mods").and_then(|m| m.as_array()).cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(str::to_owned))
        .filter(|id| !installed.contains(id))
        .collect();
    if !missing.is_empty() {
        out.push_str(&format!("mods to install again: {}\n", missing.join(", ")));
    }
    config.reload();
    Ok(out)
}

/// `config.toml`, `user.css`, or one file directly inside an exported folder.
fn allowed(name: &Path) -> bool {
    let parts: Vec<&str> = name.iter().filter_map(|p| p.to_str()).collect();
    match parts.as_slice() {
        [file] => FILES.contains(file),
        [folder, file] => FOLDERS.contains(folder) && !file.starts_with('.'),
        _ => false,
    }
}

/// Reset a category (`["font"]`) or the whole file (`[]`) from the settings screen.
pub fn reset(config: &ConfigState, path: &[String]) -> Result<(), String> {
    if path.is_empty() { reset_all(config).map(|_| ()) } else { crate::settings::write_config(config, path, None) }
}

/// Settings › Advanced: put a category (`["font"]`) or everything (`[]`) back to the defaults.
#[tauri::command]
pub fn config_reset(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    path: Vec<String>,
) -> Result<(), String> {
    reset(state.config, &path)?;
    crate::config_changed(&app);
    Ok(())
}

/// Settings › Advanced: write the export to the Downloads folder (decision I12); returns the path.
#[tauri::command]
pub async fn config_export(state: tauri::State<'_, crate::AppState>) -> Result<String, String> {
    let bytes = export(state.config)?;
    let path = crate::downloads_path(&default_export_name())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// Settings › Advanced: unpack an export the user picked (the zip is the request body).
#[tauri::command]
pub fn config_import(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected the zip".into()) };
    let report = import(state.config, bytes)?;
    crate::config_changed(&app);
    Ok(report)
}
