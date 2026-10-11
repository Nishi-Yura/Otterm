//! Mod host for otterm: manifests, the capability broker, mod storage, and the mod folder layout.
//!
//! Spec: docs/05-mod-system.md (§3.1 manifest, §4 lifecycle, §6 permissions, §7.1 install) and
//! docs/11-decisions.md (D5, D6, K7, K8). This crate is the capability broker of docs/02-architecture §4.1:
//! the only place where a mod's file, process, and network requests are actually executed. The Worker checks
//! the same rules first, but it is not trusted, so every check is repeated here against the real filesystem.
//!
//! The app crate wraps these functions in Tauri commands. Nothing here talks to the UI or the Worker.

mod broker;
mod manifest;
mod paths;
mod store;

pub use broker::{DirEntry, EntryKind, Grant, ProcessOutput, Protected};
pub use manifest::Manifest;
pub use manifest::{
    Adds, Compat, Entry, FsPermissions, MANIFEST_EVENTS, ManifestError, ModInfo, ModKind, Permissions, Platform,
    Problem, SETTING_TYPES, SLOT_NAMES, Settings, TerminalPermissions, parse_manifest, valid_id,
};
pub use paths::{PathVars, VARIABLES, expand, expand_glob};
pub use store::{
    EnabledLists, Found, Installed, STORAGE_QUOTA, Storage, data_dir_of, discover, grant, granted, install, is_enabled,
    mods_dir, revoke, set_enabled, set_setting, uninstall,
};
