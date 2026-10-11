//! Updates through the Tauri updater (decision C10). The only connection otterm makes on its own,
//! and only with `general.check_updates` on (decision K5, H4).
//!
//! An update is a signed `latest.json` on the project's GitHub Releases. The public key is baked
//! in at build time (`OTTERM_UPDATER_PUBKEY`, set by `scripts/release.mjs`); a build without one
//! (every development build) cannot update itself and says so. The private key never lives in
//! the repository: docs/release.md has the steps for making and rotating it.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_updater::UpdaterExt;

use crate::AppState;

/// The minisign public key of release builds; `None` in development builds.
const PUBKEY: Option<&str> = option_env!("OTTERM_UPDATER_PUBKEY");
/// Where `latest.json` is, per channel; overridable at build time for a fork or a test server.
const STABLE_URL: Option<&str> = option_env!("OTTERM_UPDATE_URL");
const BETA_URL: Option<&str> = option_env!("OTTERM_UPDATE_URL_BETA");

/// The update found by the last check, kept for `update_install`.
#[derive(Default)]
pub struct UpdateState(Mutex<Option<tauri_plugin_updater::Update>>);

#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    current: String,
    notes: Option<String>,
}

fn endpoint(channel: otterm_config::UpdateChannel) -> String {
    let repo = env!("CARGO_PKG_REPOSITORY");
    match channel {
        otterm_config::UpdateChannel::Stable => {
            STABLE_URL.map_or_else(|| format!("{repo}/releases/latest/download/latest.json"), str::to_owned)
        }
        // The newest prerelease moves the `beta` tag (docs/release.md).
        otterm_config::UpdateChannel::Beta => {
            BETA_URL.map_or_else(|| format!("{repo}/releases/download/beta/latest.json"), str::to_owned)
        }
    }
}

/// Look for a newer version. `Ok(None)`: up to date. An error when this build cannot update
/// itself or the check failed; the automatic check at startup stays quiet about it.
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: State<'_, AppState>,
    pending: State<'_, UpdateState>,
) -> Result<Option<UpdateInfo>, String> {
    let pubkey = PUBKEY.filter(|k| !k.trim().is_empty()).ok_or("this build of otterm cannot update itself")?;
    let channel = state.config.config().general.update_channel;
    let url: tauri::Url = endpoint(channel).parse().map_err(|e| format!("{e}"))?;
    let updater = app
        .updater_builder()
        .pubkey(pubkey)
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| e.to_string())?;
    let info = found.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone(),
    });
    *pending.0.lock().unwrap() = found;
    Ok(info)
}

/// Download and install the update the last check found, then start the new version.
#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, UpdateState>) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take().ok_or("no update to install")?;
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart();
}
