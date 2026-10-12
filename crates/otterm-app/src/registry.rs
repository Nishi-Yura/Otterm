//! The mod registry (docs/05 §7.2, decisions D1–D4): a static `index.json` on GitHub, searched on
//! this side. otterm reads it only when the user asks — `otterm mod search|install|update`, or the
//! store screen after its one-time question (decision K5).
//!
//! An install downloads the `.otmod` the index points at, checks its size and SHA-256 against the
//! index, and installs it like a local package (K7 checks in `otterm_modhost::unpack`). The index
//! entry is all the trust there is: sigstore signatures (D2) are checked once the registry signs
//! (not yet; docs/05 §7.2 says so).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use otterm_modhost::{Found, Platform};
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};

/// Where the index is unless `[mods] registry` says otherwise.
pub const DEFAULT_INDEX: &str = "https://raw.githubusercontent.com/Nishi-Yura/Otterm/main/registry/index.json";
/// A cached index younger than this is used without asking the network.
const FRESH: Duration = Duration::from_secs(60 * 60);
/// Largest `.otmod` the client downloads (K7).
const MAX_PACKAGE: u64 = 50 * 1024 * 1024;
const MAX_INDEX: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Index {
    pub schema: u32,
    #[serde(default)]
    pub mods: Vec<Entry>,
    /// Whether `index.json.sig` checked out against the registry key. Never read from the file
    /// itself, so an index cannot claim it.
    #[serde(skip_deserializing)]
    pub signed: bool,
}

/// The registry's public key (minisign, base64 as `tauri signer` writes it). The private half
/// stays with the maintainer; `registry/scripts/sign.mjs` signs `index.json` with it.
const PUBLIC_KEY: &str = include_str!("../../../registry/registry-key.pub");

/// Check `sig` (base64 of a `.minisig` file, as `tauri signer sign` writes it) over `data`.
fn verify(data: &[u8], sig: &[u8]) -> Result<(), String> {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    let text = |v: &[u8]| -> Result<String, String> {
        let raw = b64.decode(v.trim_ascii()).map_err(|e| format!("not base64: {e}"))?;
        String::from_utf8(raw).map_err(|e| e.to_string())
    };
    let key = minisign_verify::PublicKey::decode(&text(PUBLIC_KEY.as_bytes())?).map_err(|e| e.to_string())?;
    let sig = minisign_verify::Signature::decode(&text(sig)?).map_err(|e| e.to_string())?;
    // Only the prehashed form `tauri signer` writes; the legacy one signs the whole file.
    key.verify(data, &sig, false).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub author: String,
    pub kind: String,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub reviewed: bool,
    #[serde(default)]
    pub hidden: bool,
    pub versions: Vec<Release>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Release {
    pub version: String,
    pub otterm: String,
    #[serde(default)]
    pub api: String,
    #[serde(default)]
    pub platforms: Vec<String>,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub published: String,
}

fn platform_name(p: Platform) -> &'static str {
    match p {
        Platform::Windows => "windows",
        Platform::Macos => "macos",
        Platform::Linux => "linux",
    }
}

impl Entry {
    /// The newest release for this platform that says it runs on `host`; failing that, the
    /// newest one for this platform (development builds are version 0.0.0) — `compatible` says
    /// which it was.
    pub fn best(&self, host: &Version, platform: Platform) -> Option<(&Release, bool)> {
        let mut usable: Vec<(&Release, Version)> = self
            .versions
            .iter()
            .filter(|r| r.platforms.is_empty() || r.platforms.iter().any(|p| p == platform_name(platform)))
            .filter_map(|r| Some((r, Version::parse(&r.version).ok()?)))
            .collect();
        usable.sort_by(|a, b| b.1.cmp(&a.1));
        let fits = |r: &Release| VersionReq::parse(&r.otterm.replace(' ', ", ")).is_ok_and(|req| req.matches(host));
        usable
            .iter()
            .find(|(r, _)| fits(r))
            .map(|(r, _)| (*r, true))
            .or_else(|| usable.first().map(|(r, _)| (*r, false)))
    }
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(timeout)).build().into()
}

fn cache_path(data: &Path) -> PathBuf {
    data.join("state").join("registry-index.json")
}

/// Beside the cached index: the source it came from and whether it was signed, so a cache from
/// another registry, or from before a signature failed, is not taken for this one.
fn cache_meta(source: &str, signed: bool) -> String {
    format!(
        "{source}
{signed}
"
    )
}

/// The index from `source` (an https URL, or a local path / `file:` URL for a registry checkout),
/// cached in the data folder for an hour unless `refresh`.
pub fn index(data: &Path, source: &str, refresh: bool) -> Result<Index, String> {
    let cache = cache_path(data);
    if !refresh
        && let Ok(meta) = std::fs::metadata(&cache)
        && meta.modified().ok().and_then(|m| m.elapsed().ok()).is_some_and(|age| age < FRESH)
        && let Ok(meta) = std::fs::read_to_string(cache.with_extension("meta"))
        && let Some(signed) = [true, false].into_iter().find(|s| meta == cache_meta(source, *s))
        && let Ok(text) = std::fs::read_to_string(&cache)
        && let Ok(mut index) = serde_json::from_str::<Index>(&text)
    {
        index.signed = signed;
        return Ok(index);
    }
    let bytes = fetch(source, MAX_INDEX, Duration::from_secs(20))?;
    let signed = signature(source, &bytes)?;
    let mut index: Index =
        serde_json::from_slice(&bytes).map_err(|e| format!("the registry index is not valid: {e}"))?;
    if index.schema != 1 {
        return Err(format!("the registry index has schema {}; this otterm reads 1", index.schema));
    }
    index.signed = signed;
    if let Some(dir) = cache.parent() {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(&cache, &bytes);
        let _ = std::fs::write(cache.with_extension("meta"), cache_meta(source, signed));
    }
    Ok(index)
}

/// Check the index against `<source>.sig` (docs/05 §7.3). The index lists every package's SHA-256,
/// so a good signature covers the packages as well. The official registry must be signed. Another
/// registry the user configured may be unsigned (the store then says so), but a signature it does
/// have must be good.
fn signature(source: &str, bytes: &[u8]) -> Result<bool, String> {
    let official = source == DEFAULT_INDEX;
    match fetch(&format!("{source}.sig"), 4096, Duration::from_secs(20)) {
        Ok(sig) => {
            verify(bytes, &sig).map_err(|e| format!("the registry index signature is not valid ({e})"))?;
            Ok(true)
        }
        Err(e) if official => Err(format!("the registry index is not signed: {e}")),
        Err(_) => Ok(false),
    }
}

/// Read `source` whole: https only for the network (never plain http), or a local file.
fn fetch(source: &str, limit: u64, timeout: Duration) -> Result<Vec<u8>, String> {
    if let Some(path) = local(source) {
        let meta = std::fs::metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        if meta.len() > limit {
            return Err(format!("{} is too large", path.display()));
        }
        return std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()));
    }
    if !source.starts_with("https://") {
        return Err(format!("not an https URL: {source}"));
    }
    let response = agent(timeout).get(source).call().map_err(|e| format!("{source}: {e}"))?;
    let mut bytes = Vec::new();
    response.into_body().into_reader().take(limit + 1).read_to_end(&mut bytes).map_err(|e| format!("{source}: {e}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!("{source} is larger than {} MB", limit >> 20));
    }
    Ok(bytes)
}

fn local(source: &str) -> Option<PathBuf> {
    if let Some(rest) = source.strip_prefix("file:///") {
        // file:///C:/x on Windows, file:///home/x elsewhere.
        return Some(PathBuf::from(if cfg!(windows) { rest.to_owned() } else { format!("/{rest}") }));
    }
    if source.contains("://") { None } else { Some(PathBuf::from(source)) }
}

/// Download a release into `<data>/tmp/`, verifying its size and SHA-256 against the index.
pub fn download(data: &Path, entry: &Entry, release: &Release) -> Result<PathBuf, String> {
    if release.size > MAX_PACKAGE {
        return Err(format!("{} {} is larger than 50 MB", entry.id, release.version));
    }
    let bytes = fetch(&release.url, MAX_PACKAGE, Duration::from_secs(120))?;
    if bytes.len() as u64 != release.size {
        return Err(format!("{}: {} bytes, the index says {}", release.url, bytes.len(), release.size));
    }
    let dir = data.join("tmp");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{}-{}.otmod", entry.id, release.version));
    std::fs::write(&file, &bytes).map_err(|e| e.to_string())?;
    let sum = otterm_modhost::sha256_file(&file).map_err(|e| e.to_string())?;
    if !sum.eq_ignore_ascii_case(&release.sha256) {
        let _ = std::fs::remove_file(&file);
        return Err(format!("{}: the checksum does not match the index; not installed", entry.id));
    }
    Ok(file)
}

/// Install `id` from the registry. Returns what to tell the user.
pub fn install(data: &Path, source: &str, id: &str, host: &Version) -> Result<String, String> {
    let index = index(data, source, false)?;
    let entry = index.mods.iter().find(|m| m.id == id).ok_or_else(|| format!("no mod {id} in the registry"))?;
    install_entry(data, entry, host)
}

fn install_entry(data: &Path, entry: &Entry, host: &Version) -> Result<String, String> {
    // The id names the download's file, so an index from elsewhere must not put a path in it.
    if !otterm_modhost::valid_id(&entry.id) {
        return Err(format!("the registry lists an invalid mod id `{}`", entry.id));
    }
    let platform = Platform::current();
    let (release, compatible) =
        entry.best(host, platform).ok_or_else(|| format!("{} has no release for this platform", entry.id))?;
    let file = download(data, entry, release)?;
    let result = otterm_modhost::install_package(data, &file, Some(entry.id.as_str()), platform, host);
    let _ = std::fs::remove_file(&file);
    let m = result.map_err(|e| e.to_string())?;
    let mut out = format!("installed {} {} → {}\n", m.id, release.version, m.dir.display());
    if !compatible {
        out.push_str(&format!("note: it says it runs on otterm {}; this is {host}\n", release.otterm));
    }
    if !entry.permissions.is_empty() {
        out.push_str(&format!("permissions (asked when you turn it on): {}\n", entry.permissions.join(", ")));
    }
    Ok(out)
}

/// Installed mods (not bundled, not linked) with a newer release in the registry:
/// (id, installed version, newest version).
pub fn updates(
    data: &Path,
    source: &str,
    host: &Version,
    refresh: bool,
) -> Result<Vec<(String, String, String)>, String> {
    let index = index(data, source, refresh)?;
    let mut out = Vec::new();
    for found in otterm_modhost::discover(data, Platform::current(), host) {
        let Found::Mod(m) = found else { continue };
        if m.linked {
            continue;
        }
        let Some(entry) = index.mods.iter().find(|e| e.id == m.id) else { continue };
        let Some((release, _)) = entry.best(host, Platform::current()) else { continue };
        let (Ok(have), Ok(new)) = (Version::parse(&m.manifest.mod_.version), Version::parse(&release.version)) else {
            continue;
        };
        if new > have {
            out.push((m.id.clone(), have.to_string(), new.to_string()));
        }
    }
    Ok(out)
}

/// Update `ids` (all with an update when empty).
pub fn update(data: &Path, source: &str, host: &Version, ids: &[String]) -> Result<String, String> {
    let pending = updates(data, source, host, true)?;
    let index = index(data, source, false)?;
    let mut out = String::new();
    for (id, have, new) in pending {
        if !ids.is_empty() && !ids.contains(&id) {
            continue;
        }
        let entry = index.mods.iter().find(|e| e.id == id).expect("listed by updates");
        out.push_str(&format!("{id}: {have} → {new}\n"));
        out.push_str(&install_entry(data, entry, host)?);
    }
    if out.is_empty() {
        out = "every mod is up to date\n".into();
    }
    Ok(out)
}

/// Matches for a search, best first: the words must all appear in the id, name, description,
/// author or categories. Hidden mods (D4: waiting for review, or reported) are left out.
pub fn search<'a>(index: &'a Index, query: &str) -> Vec<&'a Entry> {
    let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    let mut hits: Vec<(usize, &Entry)> = index
        .mods
        .iter()
        .filter(|m| !m.hidden)
        .filter_map(|m| {
            let hay =
                format!("{} {} {} {} {}", m.id, m.name, m.description, m.author, m.categories.join(" ")).to_lowercase();
            if !words.iter().all(|w| hay.contains(w.as_str())) {
                return None;
            }
            // An id or name hit ranks above a description hit.
            let head = format!("{} {}", m.id, m.name).to_lowercase();
            Some((words.iter().filter(|w| head.contains(w.as_str())).count(), m))
        })
        .collect();
    hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.id.cmp(&b.1.id)));
    hits.into_iter().map(|(_, m)| m).collect()
}

/// `otterm mod publish [dir]` (docs/05 §7.2): pack the mod and write its registry entry, for a
/// pull request to the registry repository. Nothing is uploaded; the output says what to do.
pub fn publish(dir: &Path, out: &Path) -> Result<String, String> {
    let text = std::fs::read_to_string(dir.join("otmod.toml")).map_err(|e| format!("otmod.toml: {e}"))?;
    let m = otterm_modhost::parse_manifest(&text).map_err(|e| e.message)?;
    let version = Version::parse(&m.mod_.version).map_err(|e| format!("version {}: {e}", m.mod_.version))?;
    let host = Version::new(1, 0, 0);
    let problems: Vec<String> = m
        .validate(Platform::current(), &host)
        .into_iter()
        .filter(|p| p.code != "platforms")
        .map(|p| format!("{}: {}", p.code, p.message))
        .collect();
    if !problems.is_empty() {
        return Err(format!("fix these first (otterm mod doctor):\n{}", problems.join("\n")));
    }
    let id = &m.mod_.id;
    let namespace = id.split('.').next().unwrap_or_default();
    if namespace == "otterm" {
        return Err("the otterm. namespace is for official mods only (decision D1)".into());
    }
    std::fs::create_dir_all(out).map_err(|e| e.to_string())?;
    let package = otterm_modhost::pack(dir, out).map_err(|e| e.to_string())?;
    let sha256 = otterm_modhost::sha256_file(&package).map_err(|e| e.to_string())?;
    let size = std::fs::metadata(&package).map_err(|e| e.to_string())?.len();
    let file_name = package.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let repository = m.mod_.homepage.clone().filter(|h| h.starts_with("https://github.com/"));
    let url = match &repository {
        Some(repo) => format!("{}/releases/download/v{version}/{file_name}", repo.trim_end_matches('/')),
        None => format!("https://github.com/{namespace}/<repository>/releases/download/v{version}/{file_name}"),
    };
    let platforms: Vec<String> = match &m.compat.platforms {
        Some(list) => list.iter().map(|p| platform_name(*p).to_owned()).collect(),
        None => vec!["windows".into(), "macos".into(), "linux".into()],
    };
    let kind = serde_json::to_value(m.mod_.kind).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
    let today = crate::config_tools::today();
    let release = Release {
        version: version.to_string(),
        otterm: m.compat.otterm.clone(),
        api: m.compat.api.clone(),
        platforms,
        url,
        sha256,
        size,
        published: today,
    };
    // An existing entry (a later version) keeps its other releases and fields.
    let entry_path = out.join(format!("{id}.json"));
    let mut entry = std::fs::read_to_string(&entry_path)
        .ok()
        .and_then(|t| serde_json::from_str::<Entry>(&t).ok())
        .unwrap_or_else(|| Entry {
            id: id.clone(),
            name: m.mod_.name.clone(),
            description: m.mod_.description.clone().unwrap_or_default(),
            author: namespace.to_owned(),
            kind: kind.clone(),
            categories: vec![if kind == "theme" { "theme".into() } else { "other".into() }],
            license: m.mod_.license.clone(),
            repository: repository.clone(),
            permissions: Vec::new(),
            reviewed: false,
            hidden: false,
            versions: Vec::new(),
        });
    entry.permissions = permission_list(&m.permissions);
    entry.versions.retain(|r| r.version != release.version);
    entry.versions.insert(0, release);
    let json = serde_json::to_string_pretty(&entry).map_err(|e| e.to_string())?;
    std::fs::write(&entry_path, format!("{json}\n")).map_err(|e| e.to_string())?;
    let review = entry.permissions.iter().any(|p| p == "terminal.write" || p.starts_with("network:"));
    let mut text = format!(
        "packed   {}\nentry    {}\n\nnext:\n  1. upload {file_name} to a GitHub Release tagged v{version}{}\n  2. check \"url\" and \"categories\" in {id}.json\n  3. open a pull request adding it as mods/{id}.json to the registry repository, from the GitHub account `{namespace}`\n",
        package.display(),
        entry_path.display(),
        repository.as_deref().map(|r| format!(" in {r}")).unwrap_or_default(),
    );
    if review {
        text.push_str(
            "  it uses terminal.write or network, so a maintainer reviews it before it is listed (decision D4)\n",
        );
    }
    Ok(text)
}

/// The permissions as the registry lists them, e.g. `terminal.read`, `network:https://api.github.com/*`.
pub fn permission_list(p: &otterm_modhost::Permissions) -> Vec<String> {
    let mut out = Vec::new();
    out.extend(p.process.iter().map(|x| format!("process:{x}")));
    out.extend(p.fs.read.iter().map(|x| format!("fs.read:{x}")));
    out.extend(p.fs.write.iter().map(|x| format!("fs.write:{x}")));
    out.extend(p.network.iter().map(|x| format!("network:{x}")));
    if p.clipboard {
        out.push("clipboard".into());
    }
    if p.ai {
        out.push("ai".into());
    }
    if p.terminal.read {
        out.push("terminal.read".into());
    }
    if p.terminal.write {
        out.push("terminal.write".into());
    }
    out
}

/// Whether the store may connect: the user said yes once (decision K5).
pub fn consent(data: &Path) -> bool {
    std::fs::read_to_string(data.join("state").join("registry-consent")).is_ok_and(|t| t.trim() == "yes")
}

pub fn set_consent(data: &Path) -> Result<(), String> {
    let dir = data.join("state");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("registry-consent"), "yes").map_err(|e| e.to_string())
}
