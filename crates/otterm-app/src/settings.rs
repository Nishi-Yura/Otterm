//! The settings screen's side (docs/04 §6, docs/06 §3): the JSON Schema and current values of
//! `config.toml`, writing one key back with `toml_edit` (comments and order survive), themes
//! (save, import, delete, export as a mod), saved layouts, `user.css`, the background image and
//! the installed fonts.
//!
//! Every write reloads the configuration and tells the UI at once, so a change shows while the
//! user is still looking at the control (the file watcher would take up to a second).

use std::path::{Path, PathBuf};

use otterm_config::{Config, Theme};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::{AppState, CmdResult, err};

/// Background images larger than this are refused.
const MAX_IMAGE: u64 = 30 << 20;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Form {
    /// JSON Schema of [`Config`] (schemars), with `$defs`.
    schema: Value,
    /// What config.toml says, defaults filled in (the workspace file's overrides left out: a
    /// change here is written to config.toml).
    values: Value,
    /// Dotted paths the file sets itself, for "reset to default".
    set: Vec<String>,
    /// Dotted leaf paths the workspace file changes, with the value in effect (docs/06 §1).
    workspace: serde_json::Map<String, Value>,
    /// The workspace's name, when there is one.
    workspace_name: Option<String>,
    path: Option<String>,
}

#[tauri::command]
pub fn config_form(state: State<'_, AppState>) -> CmdResult<Form> {
    let path = state.config.path();
    let text = path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    let mut set = Vec::new();
    if let Ok(doc) = text.parse::<toml_edit::DocumentMut>() {
        collect_paths(doc.as_table(), "", &mut set);
    }
    let values = serde_json::to_value(state.config.file_config()).map_err(err)?;
    let effective = serde_json::to_value(state.config.config()).map_err(err)?;
    let mut workspace = serde_json::Map::new();
    overridden(&values, &effective, "", &mut workspace);
    Ok(Form {
        schema: serde_json::to_value(schemars::schema_for!(Config)).map_err(err)?,
        values,
        set,
        workspace,
        workspace_name: state
            .config
            .workspace()
            .map(|(ws, _)| ws.config.name.clone().unwrap_or_else(|| ws.root.display().to_string())),
        path: path.map(|p| p.display().to_string()),
    })
}

/// Leaves where `effective` differs from `file`, by dotted path. Arrays count as one value.
fn overridden(file: &Value, effective: &Value, prefix: &str, out: &mut serde_json::Map<String, Value>) {
    match (file, effective) {
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in b {
                let path = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
                overridden(a.get(k).unwrap_or(&Value::Null), v, &path, out);
            }
        }
        (a, b) if a != b => {
            out.insert(prefix.to_owned(), b.clone());
        }
        _ => {}
    }
}

fn collect_paths(table: &dyn toml_edit::TableLike, prefix: &str, out: &mut Vec<String>) {
    for (key, item) in table.iter() {
        let path = if prefix.is_empty() { key.to_owned() } else { format!("{prefix}.{key}") };
        match item.as_table_like() {
            // Arrays of tables ([[profiles]]) and maps of free keys count as one value.
            Some(t) if !matches!(item, toml_edit::Item::ArrayOfTables(_)) => {
                out.push(path.clone());
                collect_paths(t, &path, out);
            }
            _ => out.push(path),
        }
    }
}

/// Set one key (`path` split into its parts, so map keys may contain dots), or remove it so that
/// the default applies again (`value` null).
#[tauri::command]
pub fn config_write(app: AppHandle, state: State<'_, AppState>, path: Vec<String>, value: Option<Value>) -> CmdResult {
    write_config(state.config, &path, value)?;
    crate::config_changed(&app);
    Ok(())
}

/// Write `value` at `path` into config.toml, refusing values the configuration would not accept.
pub fn write_config(config: &crate::config::ConfigState, path: &[String], value: Option<Value>) -> CmdResult {
    let (last, parents) = path.split_last().ok_or("an empty key")?;
    if path.iter().any(|p| p.is_empty()) {
        return Err("an empty key part".into());
    }
    let file = config.path().ok_or("no configuration folder")?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    let text = std::fs::read_to_string(&file).unwrap_or_default();
    let mut doc: toml_edit::DocumentMut = text.parse().map_err(err)?;
    let mut table: &mut dyn toml_edit::TableLike = doc.as_table_mut();
    for part in parents {
        if !table.contains_key(part) {
            if value.is_none() {
                return Ok(()); // nothing to remove
            }
            let mut t = toml_edit::Table::new();
            t.set_implicit(true);
            table.insert(part, toml_edit::Item::Table(t));
        }
        table =
            table.get_mut(part).and_then(|i| i.as_table_like_mut()).ok_or_else(|| format!("{part} is not a table"))?;
    }
    match value {
        None => {
            table.remove(last);
        }
        Some(v) => {
            let item = match v {
                Value::Array(a) if a.iter().all(|x| x.is_object()) && !a.is_empty() => {
                    let mut tables = toml_edit::ArrayOfTables::new();
                    for x in a {
                        let Value::Object(o) = x else { unreachable!() };
                        let mut t = toml_edit::Table::new();
                        for (k, v) in o {
                            if !v.is_null() {
                                t.insert(&k, toml_edit::Item::Value(to_toml(v)?));
                            }
                        }
                        tables.push(t);
                    }
                    toml_edit::Item::ArrayOfTables(tables)
                }
                other => toml_edit::Item::Value(to_toml(other)?),
            };
            table.insert(last, item);
        }
    }
    let new_text = doc.to_string();
    // The section the key is in must still read without new complaints.
    let section = path.iter().take(2).cloned().collect::<Vec<_>>().join(".");
    let (_, before) = otterm_config::parse(&text);
    let (_, after) = otterm_config::parse(&new_text);
    if let Some(w) = after.iter().find(|w| {
        (w.key.is_empty() || section.starts_with(&w.key) || w.key.starts_with(&section)) && !before.contains(w)
    }) {
        return Err(format!("{}: {}", if w.key.is_empty() { &section } else { &w.key }, w.message));
    }
    let tmp = file.with_extension("toml.tmp");
    std::fs::write(&tmp, new_text).map_err(err)?;
    std::fs::rename(&tmp, &file).map_err(err)?;
    config.reload();
    Ok(())
}

fn to_toml(v: Value) -> CmdResult<toml_edit::Value> {
    Ok(match v {
        Value::Bool(b) => b.into(),
        Value::Number(n) => match n.as_i64() {
            Some(i) => i.into(),
            None => {
                // f32 settings arrive as 1.2000000476837158; keep what the user meant.
                let f = n.as_f64().unwrap_or(0.0);
                ((f * 1e6).round() / 1e6).into()
            }
        },
        Value::String(s) => s.into(),
        Value::Array(a) => {
            let mut arr = toml_edit::Array::new();
            for x in a {
                arr.push(to_toml(x)?);
            }
            toml_edit::Value::Array(arr)
        }
        Value::Object(o) => {
            let mut t = toml_edit::InlineTable::new();
            for (k, v) in o {
                if !v.is_null() {
                    t.insert(&k, to_toml(v)?);
                }
            }
            toml_edit::Value::InlineTable(t)
        }
        Value::Null => return Err("null inside a value".into()),
    })
}

// ---------------------------------------------------------------------------
// Themes (docs/04 §2.4, §2.5)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeEntry {
    theme: Theme,
    /// Shipped with otterm (and not replaced by a user file).
    bundled: bool,
    /// A file in `<config>/themes/` that can be deleted.
    user_file: Option<String>,
}

#[tauri::command]
pub fn themes_list(state: State<'_, AppState>) -> Vec<ThemeEntry> {
    let bundled = otterm_config::bundled_themes();
    let files = user_theme_files(state.config);
    state
        .config
        .themes()
        .into_iter()
        .map(|theme| ThemeEntry {
            bundled: bundled.contains(&theme),
            user_file: files
                .iter()
                .find(|(n, _)| n.eq_ignore_ascii_case(&theme.name))
                .map(|(_, p)| p.display().to_string()),
            theme,
        })
        .collect()
}

/// (name, file) of the user's theme files.
fn user_theme_files(config: &crate::config::ConfigState) -> Vec<(String, PathBuf)> {
    let Some(dir) = config.path().and_then(|p| p.parent().map(|d| d.join("themes"))) else { return Vec::new() };
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "toml"))
        .filter_map(|p| Some((otterm_config::load_theme_file(&p).ok()?.name, p)))
        .collect()
}

/// Save a theme as `<config>/themes/<name>.toml` (replacing the user's file of that name).
#[tauri::command]
pub fn theme_save(app: AppHandle, state: State<'_, AppState>, theme: Theme) -> CmdResult<String> {
    let path = save_theme(state.config, &theme)?;
    crate::config_changed(&app);
    Ok(path.display().to_string())
}

fn save_theme(config: &crate::config::ConfigState, theme: &Theme) -> CmdResult<PathBuf> {
    if theme.name.trim().is_empty() {
        return Err("a theme needs a name".into());
    }
    let text = otterm_config::theme_to_toml(theme);
    otterm_config::parse_theme(&text)?;
    let dir = config.dir()?.join("themes");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let path = user_theme_files(config)
        .into_iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(&theme.name))
        .map(|(_, p)| p)
        .unwrap_or_else(|| dir.join(otterm_config::theme_file_name(&theme.name)));
    std::fs::write(&path, text).map_err(err)?;
    config.reload();
    Ok(path)
}

/// Delete one of the user's theme files.
#[tauri::command]
pub fn theme_delete(app: AppHandle, state: State<'_, AppState>, name: String) -> CmdResult {
    let (_, path) = user_theme_files(state.config)
        .into_iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(&name))
        .ok_or_else(|| format!("{name} is not a theme of yours"))?;
    std::fs::remove_file(path).map_err(err)?;
    state.config.reload();
    crate::config_changed(&app);
    Ok(())
}

/// Convert an iTerm2 / Windows Terminal / VS Code / Alacritty / WezTerm color file and save the
/// themes in it. Returns their names.
#[tauri::command]
pub fn theme_import(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    file_name: String,
) -> CmdResult<Vec<String>> {
    let names = import_themes(state.config, &text, &file_name)?;
    crate::config_changed(&app);
    Ok(names)
}

fn import_themes(config: &crate::config::ConfigState, text: &str, file_name: &str) -> CmdResult<Vec<String>> {
    let themes = otterm_config::import_theme(text, file_name)?;
    let mut names = Vec::new();
    for t in themes {
        save_theme(config, &t)?;
        names.push(t.name);
    }
    Ok(names)
}

/// `otterm theme import <file>...` (docs/06 §4).
pub fn cli(args: &[String]) -> CmdResult<String> {
    let usage = "usage: otterm theme import <file>...";
    match args.first().map(String::as_str) {
        Some("import") if args.len() > 1 => {
            let config = crate::config::ConfigState::load(None, None);
            let mut out = String::new();
            for file in &args[1..] {
                let text = std::fs::read_to_string(file).map_err(|e| format!("{file}: {e}"))?;
                let name = Path::new(file).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                for n in import_themes(&config, &text, &name).map_err(|e| format!("{file}: {e}"))? {
                    out.push_str(&format!("imported \"{n}\"\n"));
                }
            }
            Ok(out)
        }
        _ => Err(usage.into()),
    }
}

/// Write a theme out as a theme mod folder (docs/04 §2.5 "export as a mod") under the mods
/// folder, so it can be shared. Returns the folder.
#[tauri::command]
pub fn theme_export_mod(state: State<'_, AppState>, name: String) -> CmdResult<String> {
    let theme = otterm_config::find_theme(&state.config.themes(), &name).cloned().ok_or("no such theme")?;
    let data = otterm_config::data_dir().ok_or("no data folder")?;
    let slug = otterm_config::theme_file_name(&theme.name);
    let slug = slug.trim_end_matches(".toml");
    let id = format!("local.{slug}");
    let dir = otterm_modhost::mods_dir(&data).join(&id);
    std::fs::create_dir_all(&dir).map_err(err)?;
    let quote = |s: &str| toml_edit::Value::from(s).to_string();
    let manifest = format!(
        "[mod]\nid = {}\nname = {}\nversion = \"1.0.0\"\ndescription = {}\nauthor = \"\"\nlicense = \"MIT\"\nkind = \"theme\"\n\n[compat]\notterm = \">=0.0.0\"\napi = \"1\"\n",
        quote(&id),
        quote(&theme.name),
        quote(&format!("{} theme", theme.name)),
    );
    std::fs::write(dir.join("otmod.toml"), manifest).map_err(err)?;
    // The CSS goes into a file next to it, as a theme mod author would write it.
    let mut out = theme.clone();
    if let Some(css) = &mut out.css
        && let Some(text) = css.text.take()
    {
        std::fs::write(dir.join("overrides.css"), text).map_err(err)?;
        css.file = Some("overrides.css".into());
    }
    std::fs::write(dir.join("theme.toml"), otterm_config::theme_to_toml(&out)).map_err(err)?;
    std::fs::write(
        dir.join("README.md"),
        format!("# {}\n\nAn otterm theme exported from the settings screen.\n", theme.name),
    )
    .map_err(err)?;
    Ok(dir.display().to_string())
}

// ---------------------------------------------------------------------------
// Layouts (docs/04 §1.2)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct LayoutEntry {
    layout: otterm_config::Layout,
    saved: bool,
}

#[tauri::command]
pub fn layouts_list(state: State<'_, AppState>) -> Vec<LayoutEntry> {
    let mut out: Vec<LayoutEntry> = otterm_config::PRESET_NAMES
        .iter()
        .filter_map(|n| otterm_config::preset(n))
        .map(|layout| LayoutEntry { layout, saved: false })
        .collect();
    for l in state.config.layouts() {
        out.retain(|e| !e.layout.name.eq_ignore_ascii_case(&l.name));
        out.push(LayoutEntry { layout: l, saved: true });
    }
    out
}

/// Save the window as it is now under `name` and switch to it; the `[appearance]` keys the
/// layout covers go back to `auto`.
#[tauri::command]
pub fn layout_save(app: AppHandle, state: State<'_, AppState>, name: String) -> CmdResult {
    let name = name.trim().to_owned();
    if name.is_empty() {
        return Err("a layout needs a name".into());
    }
    let mut layout = state.config.ui().layout;
    layout.name = name.clone();
    let dir = state.config.dir()?.join("layouts");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let file = otterm_config::theme_file_name(&name);
    std::fs::write(dir.join(file), otterm_config::layout_to_toml(&layout)).map_err(err)?;
    state.config.reload();
    for key in [
        &["appearance", "tabbar", "position"][..],
        &["appearance", "sidebar", "left", "visible"],
        &["appearance", "sidebar", "right", "visible"],
        &["appearance", "panel", "bottom", "visible"],
        &["appearance", "statusbar", "visible"],
        &["appearance", "assist_bar"],
        &["appearance", "blocks"],
        &["appearance", "panels"],
    ] {
        let key: Vec<String> = key.iter().map(|s| (*s).to_owned()).collect();
        write_config(state.config, &key, None)?;
    }
    write_config(state.config, &["appearance".into(), "layout".into()], Some(Value::String(name)))?;
    crate::config_changed(&app);
    Ok(())
}

// ---------------------------------------------------------------------------
// user.css, the background image, fonts
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn user_css_get(state: State<'_, AppState>) -> String {
    state.config.path().and_then(|p| std::fs::read_to_string(p.with_file_name("user.css")).ok()).unwrap_or_default()
}

#[tauri::command]
pub fn user_css_set(app: AppHandle, state: State<'_, AppState>, text: String) -> CmdResult {
    let path = state.config.dir()?.join("user.css");
    std::fs::write(path, text).map_err(err)?;
    state.config.reload();
    crate::config_changed(&app);
    Ok(())
}

/// Copy a picture the user picked into `<config>/backgrounds/` and use it. The bytes are the
/// request body; the file name comes in the `name` header.
#[tauri::command]
pub fn background_set(app: AppHandle, state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> CmdResult {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected the image bytes".into()) };
    if bytes.len() as u64 > MAX_IMAGE {
        return Err("the image is larger than 30 MB".into());
    }
    let name = request.headers().get("name").and_then(|v| v.to_str().ok()).unwrap_or("background");
    let name = percent_decode(name);
    let ext = Path::new(&name).extension().and_then(|e| e.to_str()).map(str::to_lowercase).unwrap_or_default();
    if !["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"].contains(&ext.as_str()) {
        return Err(format!("not an image otterm can show: .{ext}"));
    }
    let stem: String = Path::new(&name)
        .file_stem()
        .map(|s| s.to_string_lossy().chars().map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' }).collect())
        .unwrap_or_else(|| "background".into());
    let dir = state.config.dir()?.join("backgrounds");
    std::fs::create_dir_all(&dir).map_err(err)?;
    let file = format!("{stem}.{ext}");
    std::fs::write(dir.join(&file), bytes).map_err(err)?;
    write_config(
        state.config,
        &["appearance".into(), "window".into(), "background_image".into()],
        Some(Value::String(format!("backgrounds/{file}"))),
    )?;
    crate::config_changed(&app);
    Ok(())
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(v);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The background image in use (only that one file), as raw bytes.
#[tauri::command]
pub fn background_image_get(state: State<'_, AppState>) -> CmdResult<tauri::ipc::Response> {
    let path = state.config.ui().window.background_image.ok_or("no background image")?;
    let len = std::fs::metadata(&path).map_err(err)?.len();
    if len > MAX_IMAGE {
        return Err("the image is larger than 30 MB".into());
    }
    Ok(tauri::ipc::Response::new(std::fs::read(&path).map_err(err)?))
}

#[derive(Serialize)]
pub struct FontFamily {
    name: String,
    monospace: bool,
}

/// Installed font families, monospaced ones first (for the font settings).
#[tauri::command]
pub async fn fonts_list() -> Vec<FontFamily> {
    let mut map = std::collections::BTreeMap::<String, bool>::new();
    for face in crate::text::db().faces() {
        for (name, _) in &face.families {
            let mono = map.entry(name.clone()).or_insert(false);
            *mono |= face.monospaced;
        }
    }
    let mut out: Vec<FontFamily> = map.into_iter().map(|(name, monospace)| FontFamily { name, monospace }).collect();
    out.sort_by_key(|f| (!f.monospace, f.name.to_lowercase()));
    out
}

// ---------------------------------------------------------------------------
// Window effects (docs/04 §2.1 [theme.window], decision I6)
// ---------------------------------------------------------------------------

/// Blur behind a translucent window, where the OS has it.
pub fn apply_window_effects(app: &AppHandle) {
    use tauri::Manager;
    let ui = app.state::<AppState>().config.ui();
    let Some(window) = app.get_webview_window("main") else { return };
    let on = ui.window.blur && ui.window.opacity < 1.0;
    let effects = on.then(|| {
        let effect =
            if cfg!(windows) { tauri::window::Effect::Acrylic } else { tauri::window::Effect::UnderWindowBackground };
        tauri::window::EffectsBuilder::new().effect(effect).build()
    });
    let _ = window.set_effects(effects);
}
