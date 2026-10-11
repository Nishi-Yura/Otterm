//! Kotsume's side in Rust (docs/08): which first-time hints were seen (decision E5) and the
//! outfits installed as `outfit` mods (§6.4). Drawing, moods and speech live in the UI.

use std::collections::BTreeMap;
use std::path::PathBuf;

use otterm_modhost::{Found, ModKind};
use serde::Serialize;
use tauri::State;

use crate::{AppState, CmdResult, err};

/// Outfit SVGs larger than this are skipped: a 16x16 sprite is a few kilobytes.
const MAX_SVG: u64 = 256 * 1024;

fn seen_path(state: &AppState) -> Result<PathBuf, String> {
    Ok(state.config.dir()?.join("mascot-seen.json"))
}

fn read_seen(state: &AppState) -> Vec<String> {
    seen_path(state)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// First-time hints already shown, once per feature for good (decision E5).
#[tauri::command]
pub fn mascot_seen(state: State<'_, AppState>) -> Vec<String> {
    read_seen(&state)
}

#[tauri::command]
pub fn mascot_seen_add(state: State<'_, AppState>, key: String) -> CmdResult {
    let mut seen = read_seen(&state);
    if !seen.contains(&key) {
        seen.push(key);
    }
    std::fs::write(seen_path(&state)?, serde_json::to_string_pretty(&seen).map_err(err)?).map_err(err)
}

/// Settings › Kotsume: "Show the first-time hints again".
#[tauri::command]
pub fn mascot_seen_reset(state: State<'_, AppState>) -> CmdResult {
    let path = seen_path(&state)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(err)?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct OutfitInfo {
    id: String,
    name: String,
    custom: bool,
    /// (slot, SVG text). The UI keeps only the rectangles of each SVG.
    layers: Vec<(String, String)>,
    moods: BTreeMap<String, String>,
    lines: BTreeMap<String, BTreeMap<String, String>>,
}

/// The outfit mods that are installed and not disabled (docs/08 §6.4).
#[tauri::command]
pub fn mascot_outfits(state: State<'_, AppState>) -> Vec<OutfitInfo> {
    let Some(data) = otterm_config::data_dir() else { return Vec::new() };
    let disabled = state.config.config().mods.disabled;
    let read = |dir: &std::path::Path, file: &str| -> Option<String> {
        let path = dir.join(file);
        // Only files inside the mod folder.
        let canon = path.canonicalize().ok()?;
        if !canon.starts_with(dir.canonicalize().ok()?) || std::fs::metadata(&canon).ok()?.len() > MAX_SVG {
            return None;
        }
        std::fs::read_to_string(canon).ok()
    };
    crate::mods::discover_everything(&data)
        .into_iter()
        .filter_map(|f| match f {
            Found::Mod(m) if m.manifest.mod_.kind == ModKind::Outfit && !disabled.contains(&m.id) => Some(m),
            _ => None,
        })
        .filter_map(|m| {
            let outfit = m.manifest.outfit.clone()?;
            Some(OutfitInfo {
                id: m.id.clone(),
                name: m.manifest.mod_.name.clone(),
                custom: outfit.base.as_deref() == Some("custom"),
                layers: outfit.layers.iter().filter_map(|l| Some((l.slot.clone(), read(&m.dir, &l.file)?))).collect(),
                moods: outfit.moods.iter().filter_map(|(k, f)| Some((k.clone(), read(&m.dir, f)?))).collect(),
                lines: outfit.lines.clone(),
            })
        })
        .collect()
}
