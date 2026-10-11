//! Installed mods, their grants, mod storage, and the enable lists (docs/05 §3.1, §4, §7.1; docs/06 §2;
//! decisions D5, K7, K8).
//!
//! Layout under the data folder: `mods/<id>/` is a mod (a copy, or a link to a dev checkout), `mods/permissions.json`
//! holds the grants, and `mod-data/<id>/` is the mod's private data and `ctx.storage`. The enable lists live in
//! `config.toml`, under `[mods]`.

use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use anyhow::{Context, Result, bail};
use semver::Version;
use serde::{Deserialize, Serialize};
use toml_edit::{Array, DocumentMut, Item, Table, Value};

use crate::broker::unix_ms;
use crate::manifest::{Manifest, Platform, Problem, parse_manifest, valid_id};
use crate::paths::{canonical, key, within};

/// File name of the manifest inside a mod folder.
const MANIFEST_FILE: &str = "otmod.toml";
/// Grants file, inside `mods/`.
const GRANTS_FILE: &str = "permissions.json";
/// Quota of `ctx.storage` per mod (decision K8): 10 MiB, counted on the serialized file.
pub const STORAGE_QUOTA: u64 = 10 * 1024 * 1024;

/// The folder of installed mods: `data_dir/mods`. Each mod is a folder named after its id.
pub fn mods_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("mods")
}

/// The private data folder of one mod, which is `${data}` and holds its `ctx.storage` file.
///
/// The id is checked, because it becomes a folder name. The folder itself is not created here; see
/// [`Storage::open`].
pub fn data_dir_of(data_dir: &Path, id: &str) -> Result<PathBuf> {
    if !valid_id(id) {
        bail!("invalid mod id: {id}");
    }
    Ok(data_dir.join("mod-data").join(id))
}

/// A mod folder that was read and parsed.
#[derive(Debug, Clone)]
pub struct Installed {
    /// The id from the manifest.
    pub id: String,
    /// The mod folder, as it sits in `mods/`. For a link, this is the link.
    pub dir: PathBuf,
    /// The parsed manifest.
    pub manifest: Manifest,
    /// Whether `dir` is a symlink or junction to a folder elsewhere, such as a dev checkout.
    pub linked: bool,
    /// Problems from [`Manifest::validate`], plus a `dir-name` problem when the folder name is not the id.
    pub problems: Vec<Problem>,
    /// Modification time of the entry file, which tells the dev reload when to restart the Worker.
    pub main_modified: Option<SystemTime>,
}

/// One entry of `mods/`: either a readable mod, or a folder that could not be read.
#[derive(Debug, Clone)]
pub enum Found {
    /// A mod that could be read.
    Mod(Box<Installed>),
    /// A folder with no readable `otmod.toml`. The error says why.
    Broken {
        /// The folder.
        dir: PathBuf,
        /// Why it could not be read.
        error: String,
    },
}

impl Found {
    /// The key used to sort entries: the id for a mod, the folder name for a broken one.
    fn sort_key(&self) -> &str {
        match self {
            Self::Mod(m) => &m.id,
            Self::Broken { dir, .. } => dir.file_name().and_then(|n| n.to_str()).unwrap_or(""),
        }
    }
}

/// Scan `mods/`. Results are sorted by id. A missing `mods/` folder gives an empty list.
pub fn discover(data_dir: &Path, platform: Platform, host: &Version) -> Vec<Found> {
    discover_dir(&mods_dir(data_dir), platform, host)
}

/// Scan any folder of mod folders (the app keeps the mods it ships with in a second one).
pub fn discover_dir(mods: &Path, platform: Platform, host: &Version) -> Vec<Found> {
    let Ok(entries) = fs::read_dir(mods) else {
        return Vec::new();
    };
    let mut found: Vec<Found> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')))
        .map(|dir| load_dir(&dir, platform, host))
        .collect();
    found.sort_by(|a, b| a.sort_key().cmp(b.sort_key()));
    found
}

/// Read one mod folder and check it.
fn load_dir(dir: &Path, platform: Platform, host: &Version) -> Found {
    let manifest = match read_manifest(dir) {
        Ok(m) => m,
        Err(e) => return Found::Broken { dir: dir.to_path_buf(), error: format!("{e:#}") },
    };
    let mut problems = manifest.validate(platform, host);
    // The id is also the folder name, so a mismatch would make `mods/<id>` lie about what is installed.
    if dir.file_name().and_then(|n| n.to_str()) != Some(manifest.mod_.id.as_str()) {
        problems.push(Problem {
            code: "dir-name",
            message: format!("folder `{}` does not match the id `{}`", dir.display(), manifest.mod_.id),
        });
    }
    let main_modified =
        manifest.entry.as_ref().and_then(|e| fs::metadata(dir.join(&e.main)).ok()).and_then(|m| m.modified().ok());
    Found::Mod(Box::new(Installed {
        id: manifest.mod_.id.clone(),
        dir: dir.to_path_buf(),
        linked: is_link_like(dir),
        manifest,
        problems,
        main_modified,
    }))
}

/// Read and parse `otmod.toml` in `dir`.
fn read_manifest(dir: &Path) -> Result<Manifest> {
    let path = dir.join(MANIFEST_FILE);
    let text = fs::read_to_string(&path).with_context(|| format!("cannot read {}", path.display()))?;
    Ok(parse_manifest(&text)?)
}

/// Whether `path` is a link to somewhere else: a symlink, or a Windows junction (which `is_symlink` may not report).
///
/// When the answer cannot be determined, this returns `true`. Removal then takes the link itself, and never
/// follows it into a dev checkout.
fn is_link_like(path: &Path) -> bool {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return true;
    }
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return false;
    };
    match (canonical(path), canonical(parent)) {
        (Ok(real), Ok(dir)) => key(&real) != key(&dir.join(name)),
        _ => true,
    }
}

// ---------------------------------------------------------------------------
// Grants (decision D5)
// ---------------------------------------------------------------------------

/// One entry of `permissions.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct GrantRecord {
    version: String,
    granted_at: u64,
}

fn load_grants(data_dir: &Path) -> Result<BTreeMap<String, GrantRecord>> {
    let path = mods_dir(data_dir).join(GRANTS_FILE);
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).with_context(|| format!("{} is broken", path.display())),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(e.into()),
    }
}

fn save_grants(data_dir: &Path, grants: &BTreeMap<String, GrantRecord>) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(grants)?;
    write_atomic(&mods_dir(data_dir).join(GRANTS_FILE), &bytes)
}

/// Record that the user approved `id` at `version`.
pub fn grant(data_dir: &Path, id: &str, version: &str) -> Result<()> {
    let mut grants = load_grants(data_dir)?;
    let granted_at = unix_ms(SystemTime::now()).unwrap_or(0);
    grants.insert(id.to_owned(), GrantRecord { version: version.to_owned(), granted_at });
    save_grants(data_dir, &grants)
}

/// Whether the user approved exactly this `version` of `id`.
///
/// Equality is required: a new version needs a new approval, because it may ask for more. An unreadable grants
/// file counts as not granted.
pub fn granted(data_dir: &Path, id: &str, version: &str) -> bool {
    load_grants(data_dir).is_ok_and(|g| g.get(id).is_some_and(|r| r.version == version))
}

/// Forget the approval of `id`. Revoking a mod that has no approval is not an error.
pub fn revoke(data_dir: &Path, id: &str) -> Result<()> {
    let mut grants = load_grants(data_dir)?;
    if grants.remove(id).is_some() {
        save_grants(data_dir, &grants)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Install and uninstall (docs/05 §7.1, decision K7)
// ---------------------------------------------------------------------------

/// Install the mod in `source` into `mods/<id>/`, replacing any previous install with that id.
///
/// With `link`, `mods/<id>` links to `source`, which is for development: edits take effect at once. Without it, the
/// folder is copied. `node_modules` and `.git` are not copied, and a link inside `source` is an error (K7).
/// On Windows, a link falls back to a junction, which needs no admin rights.
///
/// `platform` and `host` are used only for the returned problems. An install is refused when the id is invalid,
/// because the id is the folder name. Other problems are reported, not refused.
pub fn install(data_dir: &Path, source: &Path, link: bool, platform: Platform, host: &Version) -> Result<Installed> {
    let manifest = read_manifest(source)?;
    let id = manifest.mod_.id.clone();
    if !valid_id(&id) {
        bail!("invalid mod id `{id}` in {}", source.join(MANIFEST_FILE).display());
    }
    let mods = mods_dir(data_dir);
    fs::create_dir_all(&mods)?;
    let src = canonical(source).with_context(|| format!("cannot read {}", source.display()))?;
    let target = mods.join(&id);
    if fs::symlink_metadata(&target).is_ok() {
        // Replacing a copy must not delete the folder we are installing from.
        let existing = canonical(&target).unwrap_or_else(|_| target.clone());
        if !is_link_like(&target) && within(&src, &existing) {
            bail!("the source is inside the installed copy of {id}");
        }
        remove_entry(&target)?;
    }
    let result = if link { make_link(&src, &target) } else { copy_tree(&src, &target) };
    if let Err(e) = result {
        let _ = remove_entry(&target);
        return Err(e);
    }
    match load_dir(&target, platform, host) {
        Found::Mod(installed) => Ok(*installed),
        Found::Broken { error, .. } => bail!("installed {id}, but it cannot be read: {error}"),
    }
}

/// Remove the install of `id`. The mod's data (`mod-data/<id>`) is kept, and so is nothing else. Its grant is
/// revoked, so a later reinstall asks again.
pub fn uninstall(data_dir: &Path, id: &str) -> Result<()> {
    if !valid_id(id) {
        bail!("invalid mod id: {id}");
    }
    remove_entry(&mods_dir(data_dir).join(id))?;
    revoke(data_dir, id)
}

/// Remove a mod folder or link. A link is removed as a link, so the folder it points to is never touched.
fn remove_entry(target: &Path) -> Result<()> {
    if fs::symlink_metadata(target).is_err() {
        return Ok(());
    }
    if is_link_like(target) {
        // `remove_dir` removes a directory link (symlink or junction) without touching what it points to.
        // A file symlink is removed by `remove_file` instead.
        fs::remove_dir(target).or_else(|_| fs::remove_file(target))?;
    } else if target.is_dir() {
        fs::remove_dir_all(target)?;
    } else {
        fs::remove_file(target)?;
    }
    Ok(())
}

/// Copy `src` to `dst`, skipping `node_modules` and `.git`. A link anywhere in the tree is an error (K7).
fn copy_tree(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src).with_context(|| format!("cannot read {}", src.display()))? {
        let entry = entry?;
        let name = entry.file_name();
        if name == "node_modules" || name == ".git" {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        // `DirEntry::metadata` does not follow links, so a link shows up here as a link.
        let meta = entry.metadata()?;
        if meta.file_type().is_symlink() || (meta.is_dir() && is_link_like(&from)) {
            bail!("links are not allowed in a mod package: {}", from.display());
        }
        if meta.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            fs::copy(&from, &to).with_context(|| format!("cannot copy {}", from.display()))?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn make_link(src: &Path, target: &Path) -> Result<()> {
    std::os::unix::fs::symlink(src, target).with_context(|| format!("cannot link {}", target.display()))
}

#[cfg(windows)]
fn make_link(src: &Path, target: &Path) -> Result<()> {
    if std::os::windows::fs::symlink_dir(src, target).is_ok() {
        return Ok(());
    }
    // A symlink needs Developer Mode or admin rights. A junction needs neither, so fall back to one.
    use crate::broker::hide_window;
    use std::process::Command;
    let mut cmd = Command::new("cmd");
    cmd.args(["/C", "mklink", "/J"]).arg(target).arg(src);
    hide_window(&mut cmd);
    let status = cmd.status().context("cannot run mklink")?;
    if status.success() { Ok(()) } else { bail!("cannot link {} to {}", target.display(), src.display()) }
}

// ---------------------------------------------------------------------------
// Enable lists (docs/06 §2)
// ---------------------------------------------------------------------------

/// The `[mods] enabled` and `disabled` lists from `config.toml`. Kept here so that this crate does not depend on
/// `otterm-config`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EnabledLists {
    /// Ids the user turned on.
    pub enabled: Vec<String>,
    /// Ids the user turned off. Wins over `enabled`.
    pub disabled: Vec<String>,
}

/// Whether `id` is on. `disabled` wins, then `enabled`. A mod on neither list is on only if it is official.
pub fn is_enabled(lists: &EnabledLists, id: &str, official: bool) -> bool {
    if lists.disabled.iter().any(|x| x == id) {
        false
    } else if lists.enabled.iter().any(|x| x == id) {
        true
    } else {
        official
    }
}

/// Turn `id` on or off in `config.toml`, keeping the comments and formatting of the file.
///
/// Turning a mod on adds it to `enabled` and removes it from `disabled`, and turning it off does the reverse. The
/// file is created if it is missing. A file that is not valid TOML is an error, and it is left as it was.
pub fn set_enabled(config_path: &Path, id: &str, enabled: bool) -> Result<()> {
    let mut doc = read_document(config_path)?;
    let mods = table_mut(doc.as_table_mut(), "mods")?;
    let (add, remove) = if enabled { ("enabled", "disabled") } else { ("disabled", "enabled") };
    set_membership(list_mut(mods, add)?, id, true);
    set_membership(list_mut(mods, remove)?, id, false);
    write_atomic(config_path, doc.to_string().as_bytes())
}

/// Write one setting of a mod to `[mods.settings."<id>"]` in `config.toml`, with `key = value`.
///
/// Only scalars and arrays can be stored. `null` and objects are refused, because TOML has no form for them.
pub fn set_setting(config_path: &Path, id: &str, key: &str, value: &serde_json::Value) -> Result<()> {
    let item = json_to_toml(value)?;
    let mut doc = read_document(config_path)?;
    let mods = table_mut(doc.as_table_mut(), "mods")?;
    let settings = table_mut(mods, "settings")?;
    let mod_table = table_mut(settings, id)?;
    mod_table.insert(key, Item::Value(item));
    write_atomic(config_path, doc.to_string().as_bytes())
}

/// Add or remove `id` in a list. Adding is skipped when it is already there, so the order is kept.
fn set_membership(list: &mut Array, id: &str, present: bool) {
    let has = list.iter().any(|v| v.as_str() == Some(id));
    if present && !has {
        list.push(id);
    } else if !present && has {
        list.retain(|v| v.as_str() != Some(id));
    }
}

fn list_mut<'a>(table: &'a mut Table, key: &str) -> Result<&'a mut Array> {
    table
        .entry(key)
        .or_insert(toml_edit::value(Array::new()))
        .as_array_mut()
        .with_context(|| format!("[mods] {key} must be an array"))
}

/// The table `key` under `parent`, created if missing. A new table is implicit, so that `[mods.settings]` is not
/// written as an empty header when only its subtables hold keys.
fn table_mut<'a>(parent: &'a mut Table, key: &str) -> Result<&'a mut Table> {
    let mut fresh = Table::new();
    fresh.set_implicit(true);
    parent
        .entry(key)
        .or_insert(Item::Table(fresh))
        .as_table_mut()
        .with_context(|| format!("`{key}` in config.toml must be a table"))
}

fn read_document(path: &Path) -> Result<DocumentMut> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    text.parse().with_context(|| format!("{} is not valid TOML", path.display()))
}

/// Convert a setting value from JSON to TOML. Objects and `null` have no TOML form, so they are refused.
fn json_to_toml(value: &serde_json::Value) -> Result<Value> {
    use serde_json::Value as Json;
    Ok(match value {
        Json::Bool(b) => Value::from(*b),
        Json::Number(n) => match (n.as_i64(), n.as_f64()) {
            (Some(i), _) => Value::from(i),
            (None, Some(f)) if f.is_finite() => Value::from(f),
            _ => bail!("number out of range: {n}"),
        },
        Json::String(s) => Value::from(s.as_str()),
        Json::Array(items) => {
            let mut array = Array::new();
            for item in items {
                array.push(json_to_toml(item)?);
            }
            Value::Array(array)
        }
        Json::Null => bail!("a setting cannot be null"),
        Json::Object(_) => bail!("a setting cannot be an object"),
    })
}

/// Write a file through a temporary file, so a crash leaves either the old file or the new one.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, bytes).with_context(|| format!("cannot write {}", tmp.display()))?;
    fs::rename(&tmp, path).with_context(|| format!("cannot replace {}", path.display()))
}

// ---------------------------------------------------------------------------
// Storage (`ctx.storage`, decision K8)
// ---------------------------------------------------------------------------

/// A mod's key-value store: one JSON object in `mod-data/<id>/storage.json`.
///
/// The whole file is read and written on each call. The quota is small, so that is simpler than an index, and a
/// file that is not a JSON object is an error rather than being overwritten.
#[derive(Debug, Clone)]
pub struct Storage {
    path: PathBuf,
}

impl Storage {
    /// Open the store of `id`, creating its data folder if needed.
    pub fn open(data_dir: &Path, id: &str) -> Result<Self> {
        let dir = data_dir_of(data_dir, id)?;
        fs::create_dir_all(&dir).with_context(|| format!("cannot create {}", dir.display()))?;
        Ok(Self { path: dir.join("storage.json") })
    }

    fn load(&self) -> Result<serde_json::Map<String, serde_json::Value>> {
        match fs::read(&self.path) {
            Ok(bytes) if bytes.iter().all(u8::is_ascii_whitespace) => Ok(serde_json::Map::new()),
            Ok(bytes) => {
                serde_json::from_slice(&bytes).with_context(|| format!("{} is not a JSON object", self.path.display()))
            }
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(serde_json::Map::new()),
            Err(e) => Err(e.into()),
        }
    }

    /// The value stored under `key`.
    pub fn get(&self, key: &str) -> Result<Option<serde_json::Value>> {
        Ok(self.load()?.remove(key))
    }

    /// Store `value` under `key`. Fails with "quota exceeded" if the file would be larger than [`STORAGE_QUOTA`].
    pub fn set(&self, key: &str, value: serde_json::Value) -> Result<()> {
        let mut map = self.load()?;
        map.insert(key.to_owned(), value);
        let bytes = serde_json::to_vec(&map)?;
        if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > STORAGE_QUOTA {
            bail!("quota exceeded: storage is limited to {} bytes", STORAGE_QUOTA);
        }
        write_atomic(&self.path, &bytes)
    }

    /// Remove `key`. Removing a missing key is not an error.
    pub fn delete(&self, key: &str) -> Result<()> {
        let mut map = self.load()?;
        if map.remove(key).is_some() {
            write_atomic(&self.path, &serde_json::to_vec(&map)?)?;
        }
        Ok(())
    }

    /// The keys that start with `prefix`, sorted.
    pub fn keys(&self, prefix: &str) -> Result<Vec<String>> {
        let mut keys: Vec<String> = self.load()?.keys().filter(|k| k.starts_with(prefix)).cloned().collect();
        keys.sort();
        Ok(keys)
    }

    /// Bytes used by the file, and the quota: `(used, quota)`. A missing file uses zero bytes.
    pub fn usage(&self) -> (u64, u64) {
        (fs::metadata(&self.path).map_or(0, |m| m.len()), STORAGE_QUOTA)
    }
}
