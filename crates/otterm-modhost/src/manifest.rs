//! The mod manifest `otmod.toml` (docs/05-mod-system.md §3.1) and its validation.
//!
//! The types mirror `Manifest` in `packages/api/src/index.d.ts`, which is the source of truth for field names.
//! Unknown keys are rejected at every level: a typo such as `fs_read` then fails loudly at install time instead of
//! silently granting nothing.

use std::collections::BTreeMap;
use std::fmt;
use std::path::Component;

use anyhow::{Result, bail};
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};

use crate::paths::template_error;

/// Slots a mod can add UI to (`SlotName` in index.d.ts).
pub const SLOT_NAMES: &[&str] = &[
    "titlebar.left",
    "titlebar.right",
    "tabbar.before",
    "tabbar.after",
    "tab.decoration",
    "sidebar.left",
    "sidebar.right",
    "panel.bottom",
    "terminal.overlay",
    "assist.bar",
    "block.gutter",
    "block.footer",
    "statusbar.left",
    "statusbar.right",
    "mascot",
];

/// Events a mod can subscribe to through `permissions.events` (`ManifestEvent` in index.d.ts).
pub const MANIFEST_EVENTS: &[&str] = &[
    "session-created",
    "session-closed",
    "cwd-changed",
    "input-changed",
    "before-execute",
    "block-start",
    "block-end",
    "output",
    "title-changed",
    "focus-changed",
];

/// The `type` values a `[settings.schema]` entry can have (`SettingSchema` in index.d.ts).
pub const SETTING_TYPES: &[&str] = &["boolean", "integer", "number", "string", "enum", "path", "color", "keychord"];

/// A parsed `otmod.toml`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    /// The `[mod]` table. Named `mod_` in Rust because `mod` is a keyword.
    #[serde(rename = "mod")]
    pub mod_: ModInfo,
    /// The `[compat]` table: which otterm and API versions the mod runs on.
    pub compat: Compat,
    /// The `[entry]` table. Required for `extension` mods.
    #[serde(default)]
    pub entry: Option<Entry>,
    /// The `[[adds]]` list: what the mod adds, shown to the user on the permission screen.
    #[serde(default)]
    pub adds: Vec<Adds>,
    /// The `[permissions]` table. Anything not declared here is not granted.
    #[serde(default)]
    pub permissions: Permissions,
    /// The `[settings]` table, whose `schema` drives the settings form.
    #[serde(default)]
    pub settings: Option<Settings>,
    /// The `[dependencies]` table: mod id to a version range.
    #[serde(default)]
    pub dependencies: BTreeMap<String, String>,
    /// The `[outfit]` table of an `outfit` mod (docs/08 §6.4).
    #[serde(default)]
    pub outfit: Option<Outfit>,
}

/// An outfit for Kotsume (docs/08 §6.4): SVG layers put over the base sprite, by slot.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Outfit {
    /// `default` keeps Kotsume underneath; `custom` replaces the whole sprite (decision E6).
    pub base: Option<String>,
    pub layers: Vec<OutfitLayer>,
    /// A whole sprite per mood, relative to the mod folder (with `base = "custom"`, or to override one mood).
    pub moods: BTreeMap<String, String>,
    /// Replacement lines by translation key: `{ ja = "...", en = "..." }`.
    #[serde(default)]
    pub lines: BTreeMap<String, BTreeMap<String, String>>,
}

/// One layer of an outfit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutfitLayer {
    /// `head`, `face`, `body`, `hand`, `shell`, `back` or `effect`.
    pub slot: String,
    /// An SVG file relative to the mod folder.
    pub file: String,
}

/// The `[mod]` table: identity and display information.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModInfo {
    /// `namespace.name`, lowercase letters, digits, and `-`. The `otterm.` namespace is for official mods only.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Semver version of the mod.
    pub version: String,
    /// One-line description.
    #[serde(default)]
    pub description: Option<String>,
    /// Author name.
    pub author: String,
    /// SPDX license identifier.
    #[serde(default)]
    pub license: Option<String>,
    /// Project page.
    #[serde(default)]
    pub homepage: Option<String>,
    /// What the mod is made of. Decides whether it has code to run.
    pub kind: ModKind,
    /// Path of the icon, relative to the mod folder.
    #[serde(default)]
    pub icon: Option<String>,
}

/// What kind of mod this is (`ModKind` in index.d.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModKind {
    /// Colors, fonts, and CSS. No code.
    Theme,
    /// Slot placement and panel presets. No code.
    Layout,
    /// Command descriptions and completions, as JSON. No code.
    Dictionary,
    /// Workflows, as TOML. No code.
    Workflows,
    /// Mascot outfits. No code.
    Outfit,
    /// Code that builds UI and reacts to events. Needs `[entry]`.
    Extension,
    /// Several mods and recommended settings, bundled.
    Pack,
    /// A switch for a feature built into otterm (the mascot, the history picker, the prompt bar).
    /// No code; only official bundled mods may be one.
    Feature,
}

/// The `[compat]` table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Compat {
    /// otterm version range, such as `>=1.0.0 <2.0.0`.
    pub otterm: String,
    /// API major version. Must be `"1"` for now.
    pub api: String,
    /// Platforms the mod supports. Absent means all of them.
    #[serde(default)]
    pub platforms: Option<Vec<Platform>>,
}

/// An operating system, as written in `compat.platforms`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    /// Windows.
    Windows,
    /// macOS.
    Macos,
    /// Linux and other Unix-likes.
    Linux,
}

impl Platform {
    /// The platform this binary was built for.
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Macos
        } else {
            Self::Linux
        }
    }
}

/// The `[entry]` table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    /// Script run in the Worker. A relative path inside the mod folder, ending in `.js`.
    pub main: String,
}

/// One `[[adds]]` entry. The three forms are told apart by their key.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Adds {
    /// Adds UI to a slot.
    Slot {
        /// Slot name, one of [`SLOT_NAMES`].
        slot: String,
        /// Text shown to the user.
        label: String,
    },
    /// Adds a command.
    Command {
        /// Command id.
        command: String,
        /// Text shown to the user.
        label: String,
    },
    /// Adds a panel.
    Panel {
        /// Panel id.
        panel: String,
        /// Text shown to the user.
        label: String,
    },
}

/// The `[permissions]` table (docs/05 §6). Written in TOML as dotted keys, for example `fs.read = [...]`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Permissions {
    /// Executable names the mod may start. A bare name with no path, and no `.exe` suffix.
    pub process: Vec<String>,
    /// `fs.read` and `fs.write`: path glob patterns, using `${cwd}`-style variables.
    pub fs: FsPermissions,
    /// URL patterns the mod may reach, such as `https://api.github.com/*`.
    pub network: Vec<String>,
    /// Whether the mod may read the clipboard.
    pub clipboard: bool,
    /// Whether the mod may ask the user's AI provider.
    pub ai: bool,
    /// `terminal.read` and `terminal.write`.
    pub terminal: TerminalPermissions,
    /// Events the mod receives. Each must be one of [`MANIFEST_EVENTS`].
    pub events: Vec<String>,
}

/// The `fs.*` keys of `[permissions]`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct FsPermissions {
    /// Glob patterns that may be read.
    pub read: Vec<String>,
    /// Glob patterns that may be written. Still subject to the protected list (docs/05 §6.4).
    pub write: Vec<String>,
}

/// The `terminal.*` keys of `[permissions]`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TerminalPermissions {
    /// Read block output and the screen.
    pub read: bool,
    /// Type into the terminal. The most sensitive permission.
    pub write: bool,
}

/// The `[settings]` table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    /// Setting key to its schema table, kept as raw TOML so that each `type` can carry its own fields.
    #[serde(default)]
    pub schema: BTreeMap<String, toml::Value>,
}

/// A manifest that could not be read. The message includes the line and column when TOML has them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestError {
    /// Human-readable reason, shown to the user.
    pub message: String,
}

impl fmt::Display for ManifestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ManifestError {}

/// One problem found by [`Manifest::validate`]. The code is stable, so the UI can group or translate by it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Problem {
    /// Stable identifier of the check, such as `id`, `version`, or `permissions.events`.
    pub code: &'static str,
    /// Human-readable description, shown to the user.
    pub message: String,
}

impl Problem {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

/// Parse the text of an `otmod.toml`. Unknown keys and wrong types are errors.
pub fn parse_manifest(text: &str) -> Result<Manifest, ManifestError> {
    toml::from_str(text).map_err(|e| ManifestError { message: e.to_string() })
}

/// Whether `id` has the `namespace.name` form (docs/05 §3.1): two non-empty parts of lowercase letters,
/// digits, and `-`, separated by one dot. Mod ids become folder names, so this also keeps them path-safe.
pub fn valid_id(id: &str) -> bool {
    let mut parts = id.split('.');
    let part_ok = |s: Option<&str>| {
        s.is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
    };
    part_ok(parts.next()) && part_ok(parts.next()) && parts.next().is_none()
}

/// A process name from `permissions.process`: a bare executable name with no path separators, and with `.exe`
/// removed (case-insensitively). Returns `None` for anything else, so `C:\tools\git.exe` is refused.
pub fn bare_process_name(cmd: &str) -> Option<&str> {
    if cmd.is_empty() || cmd.contains(['/', '\\']) || cmd == "." || cmd == ".." {
        return None;
    }
    let at = cmd.len().saturating_sub(4);
    let has_exe = cmd.len() > 4 && cmd.is_char_boundary(at) && cmd[at..].eq_ignore_ascii_case(".exe");
    let stem = if has_exe { &cmd[..at] } else { cmd };
    (!stem.is_empty()).then_some(stem)
}

/// Parse a version range. The docs write `>=1.0.0 <2.0.0` with spaces, which the `semver` crate rejects, so
/// whitespace-separated comparators are joined with commas first. An operator and its version may be split by a
/// space (`>= 1.0.0`), as long as the operator stands alone.
pub(crate) fn parse_req(text: &str) -> Result<VersionReq> {
    if text.trim().is_empty() {
        bail!("version range is empty");
    }
    if let Ok(req) = VersionReq::parse(text) {
        return Ok(req);
    }
    let mut parts = Vec::new();
    let mut pending = String::new();
    for token in text.split_whitespace() {
        pending.push_str(token);
        if !token.chars().all(|c| "<>=~^".contains(c)) {
            parts.push(std::mem::take(&mut pending));
        }
    }
    if !pending.is_empty() {
        parts.push(pending);
    }
    Ok(VersionReq::parse(&parts.join(", "))?)
}

/// A relative path inside the mod folder that ends in `.js`, with no `..`, root, or drive prefix.
fn valid_entry(main: &str) -> bool {
    main.len() > ".js".len()
        && main.ends_with(".js")
        && std::path::Path::new(main).components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

impl Manifest {
    /// Whether this is an official mod (`otterm.*`). Only official mods may use that namespace.
    pub fn is_official(&self) -> bool {
        self.mod_.id.starts_with("otterm.")
    }

    /// Default values of the settings schema, keyed by setting name. Entries without a `default` are left out.
    pub fn setting_defaults(&self) -> BTreeMap<String, serde_json::Value> {
        let Some(settings) = &self.settings else {
            return BTreeMap::new();
        };
        settings
            .schema
            .iter()
            .filter_map(|(key, schema)| {
                let default = schema.as_table()?.get("default")?;
                Some((key.clone(), serde_json::to_value(default).ok()?))
            })
            .collect()
    }

    /// Check the manifest against the platform and the host version (docs/05 §3.1).
    ///
    /// The host is `0.0.0` during development, so `compat.otterm` is not enforced for it: a version range cannot
    /// be checked against a host that has no release version yet. Every other check still runs.
    /// An empty list means the manifest is usable.
    pub fn validate(&self, platform: Platform, host_version: &Version) -> Vec<Problem> {
        let mut out = Vec::new();
        let info = &self.mod_;

        if !valid_id(&info.id) {
            out.push(Problem::new(
                "id",
                format!("id `{}` must be `namespace.name` with lowercase letters, digits, and -", info.id),
            ));
        }
        if info.name.trim().is_empty() {
            out.push(Problem::new("name", "name is empty"));
        }
        if Version::parse(&info.version).is_err() {
            out.push(Problem::new("version", format!("version `{}` is not semver", info.version)));
        }
        if self.compat.api != "1" {
            out.push(Problem::new(
                "compat.api",
                format!("API version `{}` is not supported (this host provides \"1\")", self.compat.api),
            ));
        }
        match parse_req(&self.compat.otterm) {
            Err(e) => out.push(Problem::new("compat.otterm", format!("`{}`: {e}", self.compat.otterm))),
            Ok(req) => {
                let development = *host_version == Version::new(0, 0, 0);
                if !development && !req.matches(host_version) {
                    out.push(Problem::new(
                        "host",
                        format!("otterm {host_version} is outside the supported range `{}`", self.compat.otterm),
                    ));
                }
            }
        }
        if let Some(list) = &self.compat.platforms
            && !list.contains(&platform)
        {
            out.push(Problem::new("platforms", "this mod does not list the current platform"));
        }

        if info.kind == ModKind::Feature && !self.is_official() {
            out.push(Problem::new("kind", "only otterm's own mods can be a feature switch"));
        }

        if info.kind == ModKind::Extension {
            match &self.entry {
                None => out.push(Problem::new("entry", "an extension needs an [entry] with main")),
                Some(entry) if !valid_entry(&entry.main) => out.push(Problem::new(
                    "entry",
                    format!("entry main `{}` must be a relative path inside the mod, ending in .js", entry.main),
                )),
                Some(_) => {}
            }
        }

        for event in &self.permissions.events {
            if !MANIFEST_EVENTS.contains(&event.as_str()) {
                out.push(Problem::new("permissions.events", format!("unknown event `{event}`")));
            }
        }
        for cmd in &self.permissions.process {
            if bare_process_name(cmd).is_none() {
                out.push(Problem::new(
                    "permissions.process",
                    format!("`{cmd}` must be a bare executable name, such as `git`"),
                ));
            }
        }
        let paths = self.permissions.fs.read.iter().chain(&self.permissions.fs.write);
        for pattern in paths {
            if let Some(message) = template_error(pattern) {
                out.push(Problem::new("permissions.fs", format!("`{pattern}`: {message}")));
            }
        }
        for pattern in &self.permissions.network {
            if let Err(e) = crate::broker::NetPattern::parse(pattern) {
                out.push(Problem::new("permissions.network", format!("`{pattern}`: {e}")));
            }
        }

        for entry in &self.adds {
            if let Adds::Slot { slot, .. } = entry
                && !SLOT_NAMES.contains(&slot.as_str())
            {
                out.push(Problem::new("adds", format!("unknown slot `{slot}`")));
            }
        }

        if let Some(settings) = &self.settings {
            for (key, schema) in &settings.schema {
                let Some(table) = schema.as_table() else {
                    out.push(Problem::new("settings", format!("setting `{key}` must be a table")));
                    continue;
                };
                let kind = table.get("type").and_then(|t| t.as_str());
                if !kind.is_some_and(|k| SETTING_TYPES.contains(&k)) {
                    out.push(Problem::new("settings", format!("setting `{key}` has an unknown type")));
                }
                if !table.contains_key("default") {
                    out.push(Problem::new("settings", format!("setting `{key}` has no default")));
                }
            }
        }

        for (id, range) in &self.dependencies {
            if !valid_id(id) {
                out.push(Problem::new("dependencies", format!("dependency id `{id}` is not valid")));
            }
            if parse_req(range).is_err() {
                out.push(Problem::new("dependencies", format!("`{id}`: `{range}` is not a version range")));
            }
        }

        out
    }
}
