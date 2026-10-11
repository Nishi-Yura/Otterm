//! Tauri commands for mods (docs/05): the installed list, grants, enable / disable, install, and
//! the capability broker's operations. The Worker gates every call first; this side checks again
//! against the real filesystem (docs/05 §6.1), using `otterm-modhost`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use otterm_modhost::{Found, Grant, Installed, PathVars, Platform, Protected};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::config::ConfigState;
use crate::registry;
use crate::{AppState, CmdResult, err};

/// How often the mods folder is checked for changes (hot reload of linked mods, docs/05 §8.1).
const WATCH_INTERVAL: Duration = Duration::from_secs(1);
/// Longest response body `http.fetch` hands to a mod.
const HTTP_BODY_LIMIT: u64 = 16 * 1024 * 1024;

/// The host's own version as mods see it (`compat.otterm`; 0.0.0 matches anything in development).
pub(crate) fn host_version() -> semver::Version {
    semver::Version::parse(env!("CARGO_PKG_VERSION")).unwrap_or_else(|_| semver::Version::new(0, 0, 0))
}

/// otterm's data folder (docs/06 §1): mods, state, logs. `OTTERM_DATA_DIR` overrides it, for
/// tests and for `create-otterm-mod`'s link step.
pub fn data_dir() -> Option<PathBuf> {
    otterm_config::data_dir()
}

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_default()
}

/// A mod as the UI lists it (`ModEntry` in packages/ui/src/mods/host.ts).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModEntry {
    id: String,
    dir: String,
    name: String,
    version: String,
    description: String,
    author: String,
    kind: String,
    official: bool,
    linked: bool,
    /// Ships with otterm (docs/05 §9): pre-approved, can be disabled but not removed (decision M8).
    bundled: bool,
    enabled: bool,
    granted: bool,
    problems: Vec<String>,
    permissions: UiPermissions,
    adds: Vec<UiAdds>,
    /// Effective settings: the manifest's defaults under `[mods.settings."<id>"]`.
    settings: BTreeMap<String, Value>,
    settings_schema: BTreeMap<String, Value>,
    has_entry: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPermissions {
    process: Vec<String>,
    fs_read: Vec<String>,
    fs_write: Vec<String>,
    network: Vec<String>,
    clipboard: bool,
    ai: bool,
    terminal_read: bool,
    terminal_write: bool,
    events: Vec<String>,
}

#[derive(Serialize)]
pub struct UiAdds {
    #[serde(skip_serializing_if = "Option::is_none")]
    slot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    panel: Option<String>,
    label: String,
}

/// The mods compiled into the executable (build.rs): `mods/*` of the repository.
mod bundled {
    include!(concat!(env!("OUT_DIR"), "/bundled_mods.rs"));
}

/// Where the bundled mods are written out: `<data>/bundled-mods/<folder>/`.
pub fn bundled_dir(data: &Path) -> PathBuf {
    data.join("bundled-mods")
}

/// Write the bundled mods to the data folder when the executable's copy differs from the one
/// there (a hash file remembers which). Like the shell hooks (decision M5), so that `${mod}` is a
/// real folder and the same code paths serve bundled and installed mods.
pub fn extract_bundled() {
    let Some(data) = data_dir() else { return };
    let dir = bundled_dir(&data);
    let stamp = dir.join(".hash");
    if std::fs::read_to_string(&stamp).is_ok_and(|h| h.trim() == bundled::HASH) {
        return;
    }
    let _ = std::fs::remove_dir_all(&dir);
    for (rel, bytes) in bundled::FILES {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, bytes);
    }
    let _ = std::fs::write(&stamp, bundled::HASH);
}

/// What `mods_list` found last time, to serve `mod_source` and the broker without rescanning.
#[derive(Default)]
pub struct ModsState {
    installed: Mutex<Vec<Installed>>,
}

/// Every mod folder, for other modules of the app (the mascot's outfits).
pub fn discover_everything(data: &Path) -> Vec<Found> {
    discover_all(data)
}

/// Every mod folder: the user's, then the bundled ones.
fn discover_all(data: &Path) -> Vec<Found> {
    let mut all = otterm_modhost::discover(data, Platform::current(), &host_version());
    all.extend(otterm_modhost::discover_dir(&bundled_dir(data), Platform::current(), &host_version()));
    all
}

/// The `theme.toml` of every theme mod not in `[mods] disabled` (docs/05 §2): themes have no code,
/// so they need no permission and are offered as soon as they are installed.
pub fn theme_mod_files(disabled: &[String]) -> Vec<PathBuf> {
    let Some(data) = data_dir() else { return Vec::new() };
    discover_all(&data)
        .into_iter()
        .filter_map(|f| match f {
            Found::Mod(m) if m.manifest.mod_.kind == otterm_modhost::ModKind::Theme && !disabled.contains(&m.id) => {
                Some(m.dir.join("theme.toml"))
            }
            _ => None,
        })
        .filter(|p| p.is_file())
        .collect()
}

/// Installed mods that did not come with otterm, as (id, version), for a settings export.
pub fn installed_mods() -> Vec<(String, String)> {
    let Some(data) = data_dir() else { return Vec::new() };
    otterm_modhost::discover(&data, Platform::current(), &host_version())
        .into_iter()
        .filter_map(|f| match f {
            Found::Mod(m) => Some((m.id.clone(), m.manifest.mod_.version.clone())),
            Found::Broken { .. } => None,
        })
        .collect()
}

/// Whether the installed mod `id` may type into the terminal (`terminal.write`); `None` when no
/// such mod is installed. A workspace file may not turn those on (docs/06 §1).
pub fn writes_terminal(id: &str) -> Option<bool> {
    let data = data_dir()?;
    discover_all(&data).into_iter().find_map(|f| match f {
        Found::Mod(m) if m.id == id => Some(m.manifest.permissions.terminal.write),
        _ => None,
    })
}

fn is_bundled(m: &Installed, data: &Path) -> bool {
    m.dir.starts_with(bundled_dir(data))
}

impl ModsState {
    fn find(&self, id: &str) -> CmdResult<Installed> {
        self.installed.lock().unwrap().iter().find(|m| m.id == id).cloned().ok_or_else(|| format!("no mod {id}"))
    }
}

fn entry(m: &Installed, config: &otterm_config::Config, data: &Path) -> ModEntry {
    let mf = &m.manifest;
    let lists =
        otterm_modhost::EnabledLists { enabled: config.mods.enabled.clone(), disabled: config.mods.disabled.clone() };
    let mut settings = mf.setting_defaults();
    if let Some(user) = config.mods.settings.get(&m.id) {
        for (k, v) in user {
            if settings.contains_key(k)
                && let Ok(json) = serde_json::to_value(v)
            {
                settings.insert(k.clone(), json);
            }
        }
    }
    let schema = mf
        .settings
        .as_ref()
        .map(|s| s.schema.iter().filter_map(|(k, v)| Some((k.clone(), serde_json::to_value(v).ok()?))).collect())
        .unwrap_or_default();
    ModEntry {
        id: m.id.clone(),
        dir: m.dir.display().to_string(),
        name: mf.mod_.name.clone(),
        version: mf.mod_.version.clone(),
        description: mf.mod_.description.clone().unwrap_or_default(),
        author: mf.mod_.author.clone(),
        kind: serde_json::to_value(mf.mod_.kind).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default(),
        official: mf.is_official(),
        linked: m.linked,
        bundled: is_bundled(m, data),
        // The AI mod follows `[ai] enabled` as well: off by default (docs/10 §5).
        enabled: otterm_modhost::is_enabled(&lists, &m.id, mf.is_official())
            && (m.id != "otterm.ai-assist" || config.ai.enabled),
        granted: is_bundled(m, data) || otterm_modhost::granted(data, &m.id, &mf.mod_.version),
        problems: m.problems.iter().map(|p| p.message.clone()).collect(),
        permissions: UiPermissions {
            process: mf.permissions.process.clone(),
            fs_read: mf.permissions.fs.read.clone(),
            fs_write: mf.permissions.fs.write.clone(),
            network: mf.permissions.network.clone(),
            clipboard: mf.permissions.clipboard,
            ai: mf.permissions.ai,
            terminal_read: mf.permissions.terminal.read,
            terminal_write: mf.permissions.terminal.write,
            events: mf.permissions.events.clone(),
        },
        adds: mf
            .adds
            .iter()
            .map(|a| match a {
                otterm_modhost::Adds::Slot { slot, label } => {
                    UiAdds { slot: Some(slot.clone()), command: None, panel: None, label: label.clone() }
                }
                otterm_modhost::Adds::Command { command, label } => {
                    UiAdds { slot: None, command: Some(command.clone()), panel: None, label: label.clone() }
                }
                otterm_modhost::Adds::Panel { panel, label } => {
                    UiAdds { slot: None, command: None, panel: Some(panel.clone()), label: label.clone() }
                }
            })
            .collect(),
        settings,
        settings_schema: schema,
        has_entry: mf.entry.is_some(),
    }
}

/// Scan the mods folder and describe every mod. Folders without a readable manifest are listed
/// with their error so the user sees why nothing happened.
#[tauri::command]
pub fn mods_list(state: State<'_, AppState>, mods: State<'_, ModsState>) -> CmdResult<Vec<ModEntry>> {
    let data = data_dir().ok_or("no data folder")?;
    let config = state.config.config();
    let mut installed = Vec::new();
    let mut out = Vec::new();
    for found in discover_all(&data) {
        match found {
            Found::Mod(m) => {
                // A user copy of a bundled mod wins (an update, or a fork); the bundled one is hidden.
                if installed.iter().any(|x: &Installed| x.id == m.id) {
                    continue;
                }
                out.push(entry(&m, &config, &data));
                installed.push(*m);
            }
            Found::Broken { dir, error } => out.push(ModEntry {
                id: dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                dir: dir.display().to_string(),
                name: dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                version: String::new(),
                description: String::new(),
                author: String::new(),
                kind: String::new(),
                official: false,
                linked: false,
                bundled: false,
                enabled: false,
                granted: false,
                problems: vec![error],
                permissions: UiPermissions {
                    process: vec![],
                    fs_read: vec![],
                    fs_write: vec![],
                    network: vec![],
                    clipboard: false,
                    ai: false,
                    terminal_read: false,
                    terminal_write: false,
                    events: vec![],
                },
                adds: vec![],
                settings: BTreeMap::new(),
                settings_schema: BTreeMap::new(),
                has_entry: false,
            }),
        }
    }
    *mods.installed.lock().unwrap() = installed;
    Ok(out)
}

#[derive(Serialize)]
pub struct ModSource {
    source: String,
    /// Fluent sources by language from `locales/<lang>.ftl`.
    locales: BTreeMap<String, String>,
}

/// The bundle of a mod's entry and its translations, for the Worker.
#[tauri::command]
pub fn mod_source(mods: State<'_, ModsState>, id: String) -> CmdResult<ModSource> {
    let m = mods.find(&id)?;
    let main = m.manifest.entry.as_ref().ok_or("the mod has no entry")?;
    let source = std::fs::read_to_string(m.dir.join(&main.main)).map_err(|e| format!("{}: {e}", main.main))?;
    let mut locales = BTreeMap::new();
    if let Ok(dir) = std::fs::read_dir(m.dir.join("locales")) {
        for f in dir.flatten() {
            let path = f.path();
            if path.extension().is_some_and(|e| e == "ftl")
                && let (Some(stem), Ok(text)) = (path.file_stem(), std::fs::read_to_string(&path))
            {
                locales.insert(stem.to_string_lossy().into_owned(), text);
            }
        }
    }
    Ok(ModSource { source, locales })
}

/// The user approved the mod's permissions for its current version (decision D5).
#[tauri::command]
pub fn mod_grant(mods: State<'_, ModsState>, id: String) -> CmdResult {
    let data = data_dir().ok_or("no data folder")?;
    let m = mods.find(&id)?;
    otterm_modhost::grant(&data, &id, &m.manifest.mod_.version).map_err(err)
}

#[tauri::command]
pub fn mod_revoke(id: String) -> CmdResult {
    let data = data_dir().ok_or("no data folder")?;
    otterm_modhost::revoke(&data, &id).map_err(err)
}

/// Enable or disable in `config.toml` (`[mods] enabled / disabled`); the config watcher tells the UI.
#[tauri::command]
pub fn mod_set_enabled(state: State<'_, AppState>, id: String, enabled: bool) -> CmdResult {
    let path = state.config.path().ok_or("no configuration folder")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    otterm_modhost::set_enabled(&path, &id, enabled).map_err(err)
}

/// The registry index URL: `[mods] registry`, else the official one.
fn registry_source(config_path: &Path) -> String {
    let (config, _) = otterm_config::load(config_path);
    config.mods.registry.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| registry::DEFAULT_INDEX.to_owned())
}

/// A registry mod as the store lists it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreEntry {
    #[serde(flatten)]
    entry: registry::Entry,
    /// The release this platform would get.
    latest: Option<String>,
    /// It says it runs on this otterm.
    compatible: bool,
    /// The installed version, if any.
    installed: Option<String>,
}

/// Whether the store may connect (decision K5); `allow` records a yes.
#[tauri::command]
pub fn store_consent(allow: bool) -> CmdResult<bool> {
    let data = data_dir().ok_or("no data folder")?;
    if allow {
        registry::set_consent(&data)?;
    }
    Ok(registry::consent(&data))
}

/// The registry's mods for the store screen. Refuses before the user agreed to connect.
#[tauri::command]
pub async fn store_list(state: State<'_, AppState>, refresh: bool) -> CmdResult<Vec<StoreEntry>> {
    let data = data_dir().ok_or("no data folder")?;
    if !registry::consent(&data) {
        return Err("the store has not been allowed to connect".into());
    }
    let source = state.config.config().mods.registry.filter(|s| !s.trim().is_empty());
    let source = source.unwrap_or_else(|| registry::DEFAULT_INDEX.to_owned());
    tauri::async_runtime::spawn_blocking(move || {
        let index = registry::index(&data, &source, refresh)?;
        let host = host_version();
        let installed: BTreeMap<String, String> = discover_all(&data)
            .into_iter()
            .filter_map(|f| match f {
                Found::Mod(m) => Some((m.id.clone(), m.manifest.mod_.version.clone())),
                Found::Broken { .. } => None,
            })
            .collect();
        Ok(registry::search(&index, "")
            .into_iter()
            .map(|e| {
                let best = e.best(&host, Platform::current());
                StoreEntry {
                    latest: best.map(|(r, _)| r.version.clone()),
                    compatible: best.is_some_and(|(_, ok)| ok),
                    installed: installed.get(&e.id).cloned(),
                    entry: e.clone(),
                }
            })
            .collect())
    })
    .await
    .map_err(err)?
}

/// Install or update a mod from the registry; it stays off until the user grants its permissions.
#[tauri::command]
pub async fn store_install(state: State<'_, AppState>, id: String) -> CmdResult<String> {
    let data = data_dir().ok_or("no data folder")?;
    if !registry::consent(&data) {
        return Err("the store has not been allowed to connect".into());
    }
    let source = state.config.config().mods.registry.filter(|s| !s.trim().is_empty());
    let source = source.unwrap_or_else(|| registry::DEFAULT_INDEX.to_owned());
    tauri::async_runtime::spawn_blocking(move || registry::install(&data, &source, &id, &host_version()))
        .await
        .map_err(err)?
}

/// Copy (or with `link`, link) a mod folder into the mods folder (docs/05 §7.1).
#[tauri::command]
pub fn mod_install(path: String, link: bool) -> CmdResult<String> {
    let data = data_dir().ok_or("no data folder")?;
    let installed =
        otterm_modhost::install(&data, Path::new(&path), link, Platform::current(), &host_version()).map_err(err)?;
    Ok(installed.id)
}

#[tauri::command]
pub fn mod_uninstall(mods: State<'_, ModsState>, id: String) -> CmdResult {
    let data = data_dir().ok_or("no data folder")?;
    if mods.find(&id).is_ok_and(|m| is_bundled(&m, &data)) {
        return Err("a bundled mod can be disabled, not removed".into());
    }
    otterm_modhost::uninstall(&data, &id).map_err(err)
}

#[derive(Serialize)]
pub struct DictionaryData {
    /// Command entries (`dictionary/commands/*.json`), as in the schema.
    entries: Vec<Value>,
    /// Danger rules (`dictionary/rules/*.json`, the `rules` arrays).
    rules: Vec<Value>,
}

/// The JSON of a `dictionary` mod (docs/03 §8.1), for the assist registry in the UI.
#[tauri::command]
pub fn mod_dictionary(mods: State<'_, ModsState>, id: String) -> CmdResult<DictionaryData> {
    let m = mods.find(&id)?;
    let mut data = DictionaryData { entries: Vec::new(), rules: Vec::new() };
    let root = m.dir.join("dictionary");
    let read_json = |p: &Path| -> Option<Value> { serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok() };
    if let Ok(files) = std::fs::read_dir(root.join("commands")) {
        for f in files.flatten() {
            if f.path().extension().is_some_and(|e| e == "json")
                && let Some(v) = read_json(&f.path())
            {
                data.entries.push(v);
            }
        }
    }
    if let Ok(files) = std::fs::read_dir(root.join("rules")) {
        for f in files.flatten() {
            if f.path().extension().is_some_and(|e| e == "json")
                && let Some(Value::Object(mut o)) = read_json(&f.path())
                && let Some(Value::Array(rules)) = o.remove("rules")
            {
                data.rules.extend(rules);
            }
        }
    }
    Ok(data)
}

/// Host settings a mod may change (`ctx.settings.host.set`, official mods only): written to
/// `config.toml` keeping comments (toml_edit); the config watcher tells everyone.
#[tauri::command]
pub fn config_set(app: tauri::AppHandle, state: State<'_, AppState>, key: String, value: Value) -> CmdResult {
    const ALLOWED: &[&str] = &[
        "general.guide_level",
        "general.language",
        "appearance.theme",
        "appearance.follow_system",
        "general.check_updates",
        "shell.default_profile",
        "font.size",
        // The palette's editor choice (decision I16).
        "open.editor",
    ];
    if !ALLOWED.contains(&key.as_str()) {
        return Err(format!("{key} cannot be set this way"));
    }
    if !matches!(value, Value::Bool(_) | Value::Number(_) | Value::String(_)) {
        return Err("only booleans, numbers and strings".into());
    }
    let path: Vec<String> = key.split('.').map(str::to_owned).collect();
    crate::settings::write_config(state.config, &path, Some(value))?;
    crate::config_changed(&app);
    Ok(())
}

/// `ctx.settings.set`: written under `[mods.settings."<id>"]`.
#[tauri::command]
pub fn mod_setting_set(
    state: State<'_, AppState>,
    mods: State<'_, ModsState>,
    id: String,
    key: String,
    value: Value,
) -> CmdResult {
    let m = mods.find(&id)?;
    if !m.manifest.settings.as_ref().is_some_and(|s| s.schema.contains_key(&key)) {
        return Err(format!("no setting {key} in the manifest"));
    }
    let path = state.config.path().ok_or("no configuration folder")?;
    otterm_modhost::set_setting(&path, &id, &key, &value).map_err(err)
}

/// `ctx.storage`: a JSON key-value file per mod, 10 MB (decision K8).
#[tauri::command]
pub fn mod_storage(id: String, op: String, key: Option<String>, value: Option<Value>) -> CmdResult<Value> {
    let data = data_dir().ok_or("no data folder")?;
    let storage = otterm_modhost::Storage::open(&data, &id).map_err(err)?;
    let key_or = || key.clone().ok_or_else(|| "a key is required".to_owned());
    match op.as_str() {
        "get" => Ok(storage.get(&key_or()?).map_err(err)?.unwrap_or(Value::Null)),
        "set" => {
            storage.set(&key_or()?, value.unwrap_or(Value::Null)).map_err(err)?;
            Ok(Value::Null)
        }
        "delete" => {
            storage.delete(&key_or()?).map_err(err)?;
            Ok(Value::Null)
        }
        "keys" => Ok(serde_json::to_value(storage.keys(key.as_deref().unwrap_or("")).map_err(err)?).map_err(err)?),
        "usage" => {
            let (bytes, quota) = storage.usage();
            Ok(serde_json::json!({ "bytes": bytes, "quota": quota }))
        }
        other => Err(format!("unknown storage op {other}")),
    }
}

/// The broker for one mod, with the session's folder as `${cwd}`.
fn grant_for(mods: &ModsState, config: &ConfigState, id: &str, cwd: Option<&str>) -> CmdResult<Grant> {
    let data = data_dir().ok_or("no data folder")?;
    let m = mods.find(id)?;
    let vars = PathVars {
        cwd: cwd.map(PathBuf::from),
        home: home(),
        workspace: None,
        mod_dir: m.dir.clone(),
        data: otterm_modhost::data_dir_of(&data, id).map_err(err)?,
    };
    let protected = Protected {
        config_dir: config.path().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default(),
        data_dir: data,
        home: home(),
        mod_dirs: mods.installed.lock().unwrap().iter().map(|x| x.dir.clone()).collect(),
    };
    Ok(Grant::new(&m.manifest, vars, protected))
}

/// `ctx.fs.*`. `op` names the method; `args` are its arguments in order.
#[tauri::command]
pub async fn mod_fs(
    state: State<'_, AppState>,
    mods: State<'_, ModsState>,
    id: String,
    cwd: Option<String>,
    op: String,
    args: Vec<Value>,
) -> CmdResult<Value> {
    let grant = grant_for(&mods, state.config, &id, cwd.as_deref())?;
    let path = |i: usize| -> CmdResult<PathBuf> {
        Ok(PathBuf::from(args.get(i).and_then(Value::as_str).ok_or("a path is required")?))
    };
    let json = |v: Value| Ok(v);
    match op.as_str() {
        "readText" => {
            let max = args.get(1).and_then(Value::as_u64).map(|n| n as usize);
            json(Value::String(grant.read_text(&path(0)?, max).map_err(err)?))
        }
        "readBytes" => {
            let max = args.get(1).and_then(Value::as_u64).map(|n| n as usize);
            json(Value::String(base64(&grant.read_bytes(&path(0)?, max).map_err(err)?)))
        }
        "readDir" => {
            let hidden = args.get(1).and_then(Value::as_bool).unwrap_or(false);
            serde_json::to_value(grant.read_dir(&path(0)?, hidden).map_err(err)?).map_err(err)
        }
        "stat" => match grant.stat(&path(0)?) {
            Ok(e) => serde_json::to_value(e).map_err(err),
            Err(_) => Ok(Value::Null),
        },
        "exists" => json(Value::Bool(grant.exists(&path(0)?).map_err(err)?)),
        "resolve" => {
            let template = args.first().and_then(Value::as_str).ok_or("a template is required")?;
            let vars = PathVars {
                cwd: cwd.map(PathBuf::from),
                home: home(),
                workspace: None,
                mod_dir: mods.find(&id)?.dir,
                data: otterm_modhost::data_dir_of(&data_dir().ok_or("no data folder")?, &id).map_err(err)?,
            };
            json(Value::String(otterm_modhost::expand(template, &vars).map_err(err)?.display().to_string()))
        }
        "writeText" => {
            let text = args.get(1).and_then(Value::as_str).ok_or("text is required")?;
            grant.write_text(&path(0)?, text).map_err(err)?;
            json(Value::Null)
        }
        "writeBytes" => {
            let data = args.get(1).and_then(Value::as_str).ok_or("data is required")?;
            grant.write_bytes(&path(0)?, &unbase64(data)?).map_err(err)?;
            json(Value::Null)
        }
        "mkdir" => {
            grant.mkdir(&path(0)?).map_err(err)?;
            json(Value::Null)
        }
        "rename" => {
            grant.rename(&path(0)?, &path(1)?).map_err(err)?;
            json(Value::Null)
        }
        // The OS trash; hard deletes are not offered to mods (docs/03 §9.2).
        "trash" => {
            let p = grant.check_write(&path(0)?).map_err(err)?;
            trash::delete(&p).map_err(err)?;
            json(Value::Null)
        }
        other => Err(format!("unknown fs op {other}")),
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RunOptions {
    cwd: Option<String>,
    env: BTreeMap<String, String>,
    timeout_ms: Option<u64>,
    stdin: Option<String>,
}

/// `ctx.process.run`: a child process (not a PTY) from the manifest's allow-list.
#[tauri::command]
pub async fn mod_process_run(
    state: State<'_, AppState>,
    mods: State<'_, ModsState>,
    id: String,
    cwd: Option<String>,
    cmd: String,
    args: Vec<String>,
    opts: RunOptions,
) -> CmdResult<otterm_modhost::ProcessOutput> {
    let grant = grant_for(&mods, state.config, &id, cwd.as_deref())?;
    // The default is 30 s so a stuck helper cannot hold a Worker's promise forever.
    let timeout = Some(opts.timeout_ms.unwrap_or(30_000));
    // An empty cwd means "none" (the session's folder is not known yet).
    let cwd = opts.cwd.filter(|c| !c.is_empty()).map(PathBuf::from);
    tauri::async_runtime::spawn_blocking(move || {
        grant.run_process(&cmd, &args, cwd, &opts.env, timeout, opts.stdin).map_err(err)
    })
    .await
    .map_err(err)?
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FetchOptions {
    method: Option<String>,
    headers: BTreeMap<String, String>,
    body: Option<String>,
    /// `body` is base64 of bytes rather than text.
    binary: bool,
    timeout_ms: Option<u64>,
}

#[derive(Serialize)]
pub struct FetchResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    /// base64 of the body.
    body: String,
}

/// `ctx.http.fetch`: only to hosts the manifest's `network` patterns allow.
#[tauri::command]
pub async fn mod_http_fetch(
    state: State<'_, AppState>,
    mods: State<'_, ModsState>,
    id: String,
    url: String,
    opts: FetchOptions,
) -> CmdResult<FetchResponse> {
    let grant = grant_for(&mods, state.config, &id, None)?;
    grant.check_network(&url).map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_millis(opts.timeout_ms.unwrap_or(30_000))))
            .http_status_as_error(false)
            .build()
            .into();
        let method = opts.method.as_deref().unwrap_or("GET").to_ascii_uppercase();
        let mut builder = ureq::http::Request::builder().method(method.as_str()).uri(url.as_str());
        for (k, v) in &opts.headers {
            builder = builder.header(k, v);
        }
        let response = match opts.body {
            Some(body) => {
                let bytes = if opts.binary { unbase64(&body)? } else { body.into_bytes() };
                agent.run(builder.body(bytes).map_err(err)?)
            }
            None => agent.run(builder.body(()).map_err(err)?),
        }
        .map_err(err)?;
        let status = response.status().as_u16();
        let mut headers = BTreeMap::new();
        for (k, v) in response.headers() {
            headers.insert(k.as_str().to_owned(), v.to_str().unwrap_or("").to_owned());
        }
        let body = response.into_body().with_config().limit(HTTP_BODY_LIMIT).read_to_vec().map_err(err)?;
        Ok(FetchResponse { status, headers, body: base64(&body) })
    })
    .await
    .map_err(err)?
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (chunk.get(1).copied().unwrap_or(0) as u32) << 8
            | chunk.get(2).copied().unwrap_or(0) as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

fn unbase64(s: &str) -> CmdResult<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0);
    for c in s.bytes().filter(|c| !c.is_ascii_whitespace()) {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => return Err("not base64".into()),
        };
        acc = (acc << 6 | v as u32) & 0xff_ffff;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

/// Append a line to `<data>/logs/mods.log`: crashes, warnings and errors of mods (all levels in
/// developer mode), so a problem can be read after the toast is gone (decision C11: local only).
#[tauri::command]
pub fn mod_log(id: String, level: String, text: String) -> CmdResult {
    use std::io::Write;
    let dir = data_dir().ok_or("no data folder")?.join("logs");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let path = dir.join("mods.log");
    // Start over past 4 MiB rather than growing forever.
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > 4 * 1024 * 1024) {
        let _ = std::fs::rename(&path, dir.join("mods.log.1"));
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(err)?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    writeln!(f, "{now}\t{level}\t{id}\t{}", text.replace('\n', "\n    ")).map_err(err)
}

/// Tell the UI (`mods-changed`, with the folder names that differ) when a mod is added, removed,
/// or a linked mod's manifest or bundle changes.
pub fn watch(app: &tauri::App) {
    use tauri::Emitter;
    let handle = app.handle().clone();
    let Some(data) = data_dir() else { return };
    std::thread::Builder::new()
        .name("mods-watch".into())
        .spawn(move || {
            let mut last = snapshot(&data);
            loop {
                std::thread::sleep(WATCH_INTERVAL);
                let now = snapshot(&data);
                if now != last {
                    let changed: Vec<&String> = now
                        .iter()
                        .chain(last.iter())
                        .filter(|e| !(now.contains(e) && last.contains(e)))
                        .map(|e| &e.0)
                        .collect();
                    let mut changed: Vec<String> = changed.into_iter().cloned().collect();
                    changed.sort();
                    changed.dedup();
                    last = now;
                    let _ = handle.emit("mods-changed", changed);
                }
            }
        })
        .expect("start the mods watcher");
}

/// Each mod folder with the modification times of its manifest and entry.
fn snapshot(data: &Path) -> Vec<(String, Option<SystemTime>, Option<SystemTime>)> {
    let Ok(entries) = std::fs::read_dir(otterm_modhost::mods_dir(data)) else { return Vec::new() };
    let mut out: Vec<_> = entries
        .flatten()
        .map(|e| {
            let dir = e.path();
            let manifest = std::fs::metadata(dir.join("otmod.toml")).and_then(|m| m.modified()).ok();
            // The entry's path is in the manifest; `dist/main.js` is the convention, and reading the
            // manifest every second would be wasteful.
            let main = std::fs::read_to_string(dir.join("otmod.toml"))
                .ok()
                .and_then(|t| otterm_modhost::parse_manifest(&t).ok())
                .and_then(|m| m.entry.map(|e| e.main))
                .and_then(|main| std::fs::metadata(dir.join(main)).and_then(|m| m.modified()).ok());
            (e.file_name().to_string_lossy().into_owned(), manifest, main)
        })
        .collect();
    out.sort();
    out
}

/// `otterm mod <verb> …` from the command line (docs/06 §4). Returns the text to print.
pub fn cli(args: &[String]) -> Result<String, String> {
    let data = data_dir().ok_or("no data folder")?;
    let config_path = otterm_config::config_path().ok_or("no configuration folder")?;
    let platform = Platform::current();
    let version = host_version();
    match args.first().map(String::as_str) {
        Some("list") => {
            let mut out = String::new();
            extract_bundled();
            for found in discover_all(&data) {
                match found {
                    Found::Mod(m) => {
                        let tag = if is_bundled(&m, &data) { "bundled" } else { "" };
                        out.push_str(&format!("{}\t{}\t{}\t{tag}\n", m.id, m.manifest.mod_.version, m.dir.display()));
                        for p in &m.problems {
                            out.push_str(&format!("\tproblem: {}\n", p.message));
                        }
                    }
                    Found::Broken { dir, error } => out.push_str(&format!("{}\tbroken: {error}\n", dir.display())),
                }
            }
            if out.is_empty() {
                out = format!("no mods in {}\n", otterm_modhost::mods_dir(&data).display());
            }
            Ok(out)
        }
        Some("install")
            if args.get(1).is_some_and(|s| s.ends_with(".otmod") && Path::new(s).is_file()) =>
        {
            let m = otterm_modhost::install_package(&data, Path::new(&args[1]), platform, &version).map_err(err)?;
            Ok(format!("installed {} {} → {}\n", m.id, m.manifest.mod_.version, m.dir.display()))
        }
        // Not a folder: an id from the registry (docs/05 §7.1).
        Some("install") if args.get(1).is_some_and(|s| !Path::new(s).exists() && otterm_modhost::valid_id(s)) => {
            registry::install(&data, &registry_source(&config_path), &args[1], &version)
        }
        Some("search") => {
            let index = registry::index(&data, &registry_source(&config_path), args.iter().any(|a| a == "--refresh"))?;
            let query: Vec<&str> = args[1..].iter().map(String::as_str).filter(|a| *a != "--refresh").collect();
            let hits = registry::search(&index, &query.join(" "));
            if hits.is_empty() {
                return Ok("no mods found\n".into());
            }
            Ok(hits
                .iter()
                .map(|m| {
                    let newest = m.versions.first().map(|r| r.version.as_str()).unwrap_or("");
                    format!("{}\t{newest}\t{}\t{}\n", m.id, m.name, m.description)
                })
                .collect())
        }
        Some("update") => {
            let source = registry_source(&config_path);
            if args.iter().any(|a| a == "--check") {
                let list = registry::updates(&data, &source, &version, true)?;
                if list.is_empty() {
                    return Ok("every mod is up to date\n".into());
                }
                return Ok(list.iter().map(|(id, have, new)| format!("{id}\t{have} → {new}\n")).collect());
            }
            let ids: Vec<String> = args[1..].iter().filter(|a| !a.starts_with('-')).cloned().collect();
            registry::update(&data, &source, &version, &ids)
        }
        Some("publish") => {
            let dir = args.get(1).filter(|a| !a.starts_with('-')).map_or_else(|| std::env::current_dir().unwrap_or_default(), PathBuf::from);
            registry::publish(&dir, &dir.join("dist-otmod"))
        }
        Some(verb @ ("install" | "link")) => {
            let source = args.get(1).ok_or("usage: otterm mod install <path|file.otmod|id> [--link]")?;
            let link = verb == "link" || args.iter().any(|a| a == "--link");
            let m = otterm_modhost::install(&data, Path::new(source), link, platform, &version).map_err(err)?;
            let mut out = format!("{} {} → {}\n", if link { "linked" } else { "installed" }, m.id, m.dir.display());
            for p in &m.problems {
                out.push_str(&format!("problem: {}\n", p.message));
            }
            Ok(out)
        }
        Some("remove" | "uninstall") => {
            let id = args.get(1).ok_or("usage: otterm mod remove <id>")?;
            otterm_modhost::uninstall(&data, id).map_err(err)?;
            Ok(format!("removed {id}\n"))
        }
        Some(verb @ ("enable" | "disable")) => {
            let id = args.get(1).ok_or("usage: otterm mod enable|disable <id>")?;
            if let Some(dir) = config_path.parent() {
                std::fs::create_dir_all(dir).map_err(err)?;
            }
            otterm_modhost::set_enabled(&config_path, id, verb == "enable").map_err(err)?;
            Ok(format!("{verb}d {id}\n"))
        }
        Some("doctor") => {
            let dir = args.get(1).map_or_else(|| std::env::current_dir().unwrap_or_default(), PathBuf::from);
            let text = std::fs::read_to_string(dir.join("otmod.toml")).map_err(err)?;
            let m = otterm_modhost::parse_manifest(&text).map_err(|e| e.message)?;
            let problems = m.validate(platform, &version);
            if problems.is_empty() {
                Ok(format!("{} {}: ok\n", m.mod_.id, m.mod_.version))
            } else {
                Ok(problems.iter().map(|p| format!("{}: {}\n", p.code, p.message)).collect())
            }
        }
        _ => Err("usage: otterm mod list | search [words] | install <path|file.otmod|id> [--link] | link <path> | update [id...] [--check] | publish [dir] | remove <id> | enable <id> | disable <id> | doctor [dir]".into()),
    }
}
