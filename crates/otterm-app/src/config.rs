//! The configuration as the app uses it: `config.toml`, the chosen theme and the resolved font
//! list, reloaded when the file changes (docs/06 §3).

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use otterm_config::{
    AmbiguousWidth, Auto, BackgroundFit, Bell, Config, CursorStyle, Effective, Language, Layout, Permission,
    RightClick, TabbarPosition, Theme, Warning,
};
use serde::Serialize;

/// How often the config file is checked for changes.
const WATCH_INTERVAL: Duration = Duration::from_secs(1);

pub struct ConfigState {
    path: Option<PathBuf>,
    /// Where to look for `.otterm/workspace.toml` (docs/06 §1): the folder otterm started in.
    start: Option<PathBuf>,
    /// Started with `--safe-mode`: what the configuration says about looks and mods is ignored.
    safe: std::sync::atomic::AtomicBool,
    loaded: Mutex<Loaded>,
}

struct Loaded {
    config: Config,
    /// What config.toml alone says, before the workspace file: the settings screen edits this.
    file_config: Config,
    themes: Vec<Theme>,
    /// Saved layouts (`<config>/layouts/*.toml`).
    layouts: Vec<Layout>,
    /// `<config>/user.css`, empty when there is none.
    user_css: String,
    warnings: Vec<Warning>,
    /// The workspace file found above the start folder, and whether it is trusted (K4).
    workspace: Option<(otterm_config::Workspace, Option<bool>)>,
    /// The newest modification time of config.toml, user.css, the theme and layout files and
    /// the workspace file.
    modified: Option<SystemTime>,
}

/// The workspace as the UI needs it (docs/06 §1, decision K4).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiWorkspace {
    pub name: String,
    pub root: String,
    /// `None` until the user answered the trust question.
    pub trusted: Option<bool>,
    /// It has something that waits for trust (tab commands, mods, settings), so ask.
    pub gated: bool,
    pub tabs: usize,
}

/// What the UI needs, resolved.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiConfig {
    /// `ja`, `en` or `auto` (the UI follows the OS language).
    pub language: Language,
    pub font: UiFont,
    pub theme: Theme,
    /// Used instead of `theme` while the OS is in light mode, when `follow_system` is on.
    pub theme_light: Option<Theme>,
    pub follow_system: bool,
    /// `appearance.minimum_contrast`, 1 to 21.
    pub minimum_contrast: f32,
    /// `appearance.renderer`: auto, webgl or canvas.
    pub renderer: otterm_config::RendererKind,
    /// Space around the terminal grid, CSS pixels (`appearance.window.padding`).
    pub padding: u32,
    /// Tab accent colors by profile id (`profiles.color`), only valid `#rrggbb` values.
    pub profile_colors: std::collections::BTreeMap<String, String>,
    /// The profile a new tab runs when none is picked (`shell.default_profile`).
    pub default_profile: String,
    /// Where the tab bar is: top, bottom, left, or hidden-when-single (the layout resolved).
    pub tabbar: TabbarPosition,
    /// The layout with the `auto` settings resolved (docs/04 §1.2).
    pub layout: Layout,
    /// `appearance.ui_scale` for tabs, panels and dialogs.
    pub ui_scale: f32,
    /// Panel sizes in CSS pixels: left and right side panel widths, bottom panel height.
    pub panel_sizes: [u32; 3],
    pub window: UiWindow,
    /// Style overrides (docs/04 §2.3): `<config>/user.css` when `appearance.custom_css` is on.
    pub user_css: String,
    pub accessibility: UiAccessibility,
    /// The theme used while the OS (or `accessibility.high_contrast`) asks for high contrast.
    pub theme_high_contrast: Option<Theme>,
    pub cursor_style: CursorStyle,
    pub cursor_blink: bool,
    pub copy_on_select: bool,
    pub word_separators: String,
    /// `[keybindings.bindings]`: action id → key chords (an empty list unbinds).
    pub keybindings: std::collections::BTreeMap<String, Vec<String>>,
    /// `[[keybindings.custom]]`: keys that run a command with arguments under a `when` clause.
    pub custom_keys: Vec<UiCustomKey>,
    pub alt_screen_passthrough: bool,
    /// Ask before pasting text with line breaks (decision B16, resolved against the guide level).
    pub confirm_multiline_paste: bool,
    /// Right button: menu, paste, or copy-if-selected-else-paste (decision I1).
    pub right_click: RightClick,
    /// OSC 52 clipboard writes from applications (decision H2).
    pub osc52_clipboard: Permission,
    pub bell: Bell,
    /// Ask before closing a tab or the window while a program runs in it.
    pub confirm_close_running: bool,
    /// What happens to a pane when its shell exits.
    pub close_behavior: otterm_config::CloseBehavior,
    /// `general.guide_level`, 0 to 3 (docs/03 §11.2).
    pub guide_level: u8,
    /// `[assist]` with `auto` values resolved against the guide level.
    pub assist: UiAssist,
    /// Whether the status bar shows (the layout resolved).
    pub statusbar: bool,
    /// `appearance.statusbar.order`.
    pub statusbar_order: Vec<String>,
    /// `[mods] developer_mode`: per-mod logs and timings in the mods panel (docs/05 §8.2).
    pub developer_mode: bool,
    /// Started with `--safe-mode`: mods are not started and a banner says so.
    pub safe_mode: bool,
    /// `general.check_updates`: look for a new version a little after startup (decision K5).
    pub check_updates: bool,
    /// `[mascot]` with `auto` resolved against the guide level (docs/08 §4.3).
    pub mascot: UiMascot,
    /// `[ai] question_prefix`: a line starting with `? ` asks the AI mod (decision F1).
    pub ai_question_prefix: bool,
    /// Where installed mods live, to tell the user.
    pub mods_dir: Option<String>,
    /// Keys that were ignored, to show once.
    pub warnings: Vec<UiWarning>,
    pub workspace: Option<UiWorkspace>,
    pub config_path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiFont {
    /// A CSS `font-family` list: the configured fonts, then CJK, Nerd Font and emoji fallbacks.
    pub family: String,
    /// The same families as names, in fallback order, for the Rust rasterizer (decision C4).
    pub families: Vec<String>,
    pub size: f32,
    pub line_height: f32,
    /// CSS pixels between cells (FR-LOOK-02).
    pub letter_spacing: f32,
    pub weight: u16,
    pub weight_bold: u16,
    /// `font.ligatures`: shape runs of cells together so the font can join `->` and the like.
    pub ligatures: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiAssist {
    pub explain: otterm_config::Explain,
    pub completion: bool,
    pub completion_key: otterm_config::CompletionKey,
    pub history_key: otterm_config::HistoryKey,
    pub danger_guard: bool,
    pub error_hint: bool,
    pub learn_hints: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiWindow {
    pub opacity: f32,
    pub blur: bool,
    /// The background image's path; the UI asks for its bytes with `background_image_get`.
    pub background_image: Option<String>,
    pub background_fit: BackgroundFit,
    pub background_image_opacity: f32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiAccessibility {
    pub screen_reader: bool,
    /// `None` follows the OS.
    pub reduce_motion: Option<bool>,
    /// `None` follows the OS.
    pub high_contrast: Option<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiMascot {
    pub visible: bool,
    pub position: otterm_config::MascotPosition,
    pub speech: otterm_config::Speech,
    /// `speech` was left on `auto`: guide level 2 then speaks only for alerts and first-time help.
    pub speech_auto: bool,
    pub mood_changes: bool,
    pub happy_threshold_ms: u32,
    pub outfit: String,
}

#[derive(Clone, Serialize)]
pub struct UiCustomKey {
    pub key: String,
    pub command: String,
    pub args: serde_json::Map<String, serde_json::Value>,
    pub when: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct UiWarning {
    pub key: String,
    pub message: String,
}

impl ConfigState {
    /// Read `path`, or the usual config.toml when it is `None`. Without `start`, no workspace
    /// file is looked for (the command line tools).
    pub fn load(path: Option<PathBuf>, start: Option<PathBuf>) -> Self {
        let path = path.or_else(otterm_config::config_path);
        Self { loaded: Mutex::new(read(path.as_ref(), start.as_deref())), path, start, safe: Default::default() }
    }

    /// Bring an older config.toml up to this otterm's schema (docs/06 §3), keeping a backup.
    pub fn migrate(&self) {
        let Some(path) = self.path.as_ref() else { return };
        let warning = match otterm_config::migrate_file(path) {
            Ok(otterm_config::Migration::UpToDate) => return,
            Ok(otterm_config::Migration::Migrated { from, backup }) => Warning {
                key: "schema".into(),
                message: format!("updated from schema {from}; the old file is {}", backup.display()),
            },
            Ok(otterm_config::Migration::Newer(n)) => Warning {
                key: "schema".into(),
                message: format!("written by a newer otterm (schema {n}); unknown keys are ignored"),
            },
            Err(message) => Warning { key: "schema".into(), message },
        };
        self.reload();
        self.loaded.lock().unwrap().warnings.push(warning);
    }

    /// The workspace in use and whether it is trusted.
    pub fn workspace(&self) -> Option<(otterm_config::Workspace, Option<bool>)> {
        self.loaded.lock().unwrap().workspace.clone()
    }

    /// Record the answer to the trust question (K4) and read everything again.
    pub fn trust_workspace(&self, trusted: bool) -> Result<(), String> {
        let (ws, _) = self.workspace().ok_or("no workspace")?;
        let data = otterm_config::data_dir().ok_or("no data folder")?;
        otterm_config::TrustStore::open(&data).set(&ws.root, trusted)?;
        self.reload();
        Ok(())
    }

    /// Turn safe mode on (docs/04 §2.3).
    pub fn set_safe(&self, on: bool) {
        self.safe.store(on, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn safe(&self) -> bool {
        self.safe.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Where config.toml is (it may not exist yet).
    pub fn path(&self) -> Option<PathBuf> {
        self.path.clone()
    }

    pub fn config(&self) -> Config {
        self.loaded.lock().unwrap().config.clone()
    }

    /// config.toml without the workspace's overrides.
    pub fn file_config(&self) -> Config {
        self.loaded.lock().unwrap().file_config.clone()
    }

    pub fn ui(&self) -> UiConfig {
        let l = self.loaded.lock().unwrap();
        let safe = self.safe();
        // Safe mode: the bundled default themes and a plain window, whatever the file says.
        let mut safe_config;
        let c = if safe {
            safe_config = l.config.clone();
            safe_config.appearance.theme = "otterm Dark".into();
            safe_config.appearance.theme_light = "otterm Light".into();
            safe_config.appearance.window = otterm_config::Window::default();
            safe_config.appearance.custom_css = false;
            &safe_config
        } else {
            &l.config
        };
        let bundled;
        let themes: &[Theme] = if safe {
            bundled = otterm_config::bundled_themes();
            &bundled
        } else {
            &l.themes
        };
        let effective = Effective::resolve(c);
        let theme = otterm_config::find_theme(themes, &c.appearance.theme)
            .or_else(|| otterm_config::find_theme(themes, "otterm Dark"))
            .cloned()
            .expect("the default theme is bundled");
        let mut warnings: Vec<UiWarning> =
            l.warnings.iter().map(|w| UiWarning { key: w.key.clone(), message: w.message.clone() }).collect();
        let theme_light = otterm_config::find_theme(themes, &c.appearance.theme_light).cloned();
        if c.appearance.follow_system && theme_light.is_none() {
            warnings.push(UiWarning {
                key: "appearance.theme_light".into(),
                message: format!("no theme named \"{}\"", c.appearance.theme_light),
            });
        }
        if otterm_config::find_theme(themes, &c.appearance.theme).is_none() {
            warnings.push(UiWarning {
                key: "appearance.theme".into(),
                message: format!("no theme named \"{}\"", c.appearance.theme),
            });
        }
        let window = window(c, theme.window.as_ref(), self.path.as_deref());
        let padding = match &theme.window {
            Some(w) if c.appearance.window.padding == 12 => w.padding.unwrap_or(12),
            _ => c.appearance.window.padding,
        }
        .min(64);
        let layout =
            otterm_config::resolve_layout(&c.appearance, &otterm_config::find_layout(&c.appearance.layout, &l.layouts));
        let auto = |a: &Auto<bool>| match a {
            Auto::Value(b) => Some(*b),
            Auto::Auto(_) => None,
        };
        UiConfig {
            language: c.general.language,
            font: UiFont {
                family: font_family(c),
                families: font_names(c),
                size: c.font.size.clamp(6.0, 72.0),
                line_height: c.font.line_height.clamp(0.8, 2.0),
                letter_spacing: c.font.letter_spacing.clamp(-2.0, 4.0),
                weight: c.font.weight,
                weight_bold: c.font.weight_bold,
                ligatures: c.font.ligatures,
            },
            theme,
            theme_light,
            follow_system: c.appearance.follow_system,
            minimum_contrast: c.appearance.minimum_contrast.clamp(1.0, 21.0),
            renderer: c.appearance.renderer,
            padding,
            profile_colors: c
                .profiles
                .iter()
                .filter_map(|p| Some((p.id.clone(), p.color.clone().filter(|c| is_hex_color(c))?)))
                .collect(),
            default_profile: c.shell.default_profile.clone(),
            tabbar: layout.tabbar,
            ui_scale: c.appearance.ui_scale.clamp(0.8, 2.0),
            panel_sizes: [
                c.appearance.sidebar.left.width.clamp(160, 800),
                c.appearance.sidebar.right.width.clamp(160, 800),
                c.appearance.panel.bottom.height.clamp(100, 800),
            ],
            window,
            user_css: if c.appearance.custom_css { l.user_css.clone() } else { String::new() },
            accessibility: UiAccessibility {
                screen_reader: c.accessibility.screen_reader,
                reduce_motion: auto(&c.accessibility.reduce_motion),
                high_contrast: auto(&c.accessibility.high_contrast),
            },
            theme_high_contrast: otterm_config::find_theme(themes, "High Contrast").cloned(),
            cursor_style: c.terminal.cursor.style,
            cursor_blink: c.terminal.cursor.blink,
            copy_on_select: c.terminal.copy_on_select,
            word_separators: c.terminal.word_separators.clone(),
            keybindings: c
                .keybindings
                .bindings
                .iter()
                .map(|(k, v)| {
                    let keys = match v {
                        otterm_config::OneOrMany::One(s) => vec![s.clone()],
                        otterm_config::OneOrMany::Many(v) => v.clone(),
                    };
                    (k.clone(), keys)
                })
                .collect(),
            custom_keys: c
                .keybindings
                .custom
                .iter()
                .map(|k| UiCustomKey {
                    key: k.key.clone(),
                    command: k.command.clone(),
                    args: k
                        .args
                        .iter()
                        .filter_map(|(name, v)| Some((name.clone(), serde_json::to_value(v).ok()?)))
                        .collect(),
                    when: k.when.clone(),
                })
                .collect(),
            alt_screen_passthrough: c.keybindings.alt_screen_passthrough,
            confirm_multiline_paste: effective.confirm_multiline_paste,
            right_click: effective.right_click,
            osc52_clipboard: c.terminal.osc52_clipboard,
            bell: c.terminal.bell,
            confirm_close_running: c.general.confirm_close_running,
            close_behavior: c.terminal.close_behavior,
            guide_level: c.general.guide_level.min(3),
            assist: UiAssist {
                explain: effective.explain,
                completion: c.assist.completion,
                completion_key: effective.completion_key,
                history_key: effective.history_key,
                danger_guard: c.assist.danger_guard,
                error_hint: c.assist.error_hint,
                learn_hints: effective.learn_hints,
            },
            statusbar: layout.statusbar,
            statusbar_order: c.appearance.statusbar.order.clone(),
            layout,
            developer_mode: c.mods.developer_mode,
            safe_mode: safe,
            check_updates: c.general.check_updates,
            ai_question_prefix: c.ai.question_prefix,
            mascot: UiMascot {
                visible: effective.mascot_visible,
                position: c.mascot.position,
                speech: effective.speech,
                speech_auto: matches!(c.mascot.speech, Auto::Auto(_)),
                mood_changes: c.mascot.mood_changes,
                happy_threshold_ms: c.mascot.happy_threshold_ms,
                outfit: c.mascot.outfit.clone(),
            },
            mods_dir: otterm_config::data_dir().map(|d| otterm_modhost::mods_dir(&d).display().to_string()),
            warnings,
            workspace: l.workspace.as_ref().map(|(ws, trusted)| UiWorkspace {
                name: ws.config.name.clone().unwrap_or_else(|| {
                    ws.root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
                }),
                root: ws.root.display().to_string(),
                trusted: *trusted,
                gated: ws.config.tabs.iter().any(|t| t.command.is_some())
                    || !ws.config.mods.is_empty()
                    || !ws.overrides.is_empty()
                    || !ws.config.settings.is_empty()
                    || ws.config.outfit.is_some(),
                tabs: ws.config.tabs.len(),
            }),
            config_path: self.path.as_ref().map(|p| p.display().to_string()),
        }
    }

    /// Reload if the file changed since the last read. Returns whether it did.
    pub fn reload_if_changed(&self) -> bool {
        let ws_file = self.workspace().map(|(ws, _)| ws.file);
        let modified = newest_change(self.path.as_ref()).max(ws_file.and_then(|f| mtime(&f)));
        if modified == self.loaded.lock().unwrap().modified {
            return false;
        }
        self.reload();
        true
    }

    /// Read everything again (after the settings screen wrote a file).
    pub fn reload(&self) {
        *self.loaded.lock().unwrap() = read(self.path.as_ref(), self.start.as_deref());
    }

    /// Every theme, bundled and the user's.
    pub fn themes(&self) -> Vec<Theme> {
        self.loaded.lock().unwrap().themes.clone()
    }

    /// The saved layouts.
    pub fn layouts(&self) -> Vec<Layout> {
        self.loaded.lock().unwrap().layouts.clone()
    }

    /// The folder config.toml is in, created if needed.
    pub fn dir(&self) -> Result<PathBuf, String> {
        let dir = self.path.as_ref().and_then(|p| p.parent()).ok_or("no configuration folder")?;
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        Ok(dir.to_path_buf())
    }

    /// Call `on_change` from a background thread whenever the file changes.
    pub fn watch(state: &'static Self, on_change: impl Fn(UiConfig) + Send + 'static) {
        std::thread::Builder::new()
            .name("config-watch".into())
            .spawn(move || {
                loop {
                    std::thread::sleep(WATCH_INTERVAL);
                    if state.reload_if_changed() {
                        on_change(state.ui());
                    }
                }
            })
            .expect("start the config watcher");
    }
}

fn read(path: Option<&PathBuf>, start: Option<&std::path::Path>) -> Loaded {
    let (mut config, mut warnings) = match path {
        Some(p) => otterm_config::load(p),
        None => (Config::default(), Vec::new()),
    };
    let file_config = config.clone();
    let workspace = start.and_then(|s| workspace(s, &mut config, &mut warnings));
    let dir = path.and_then(|p| p.parent());
    let (mut themes, theme_warnings) = otterm_config::all_themes(dir.map(|d| d.join("themes")).as_deref());
    warnings.extend(theme_warnings);
    // Theme mods first in the list order, then the user's own files win again.
    let mut from_mods = Vec::new();
    for file in crate::mods::theme_mod_files(&config.mods.disabled) {
        match otterm_config::load_theme_file(&file) {
            Ok(t) => from_mods.push(t),
            Err(message) => warnings.push(Warning { key: file.display().to_string(), message }),
        }
    }
    let (user, _) = otterm_config::all_themes(None);
    let user_names: Vec<String> = themes.iter().filter(|t| !user.contains(t)).map(|t| t.name.to_lowercase()).collect();
    from_mods.retain(|t| !user_names.contains(&t.name.to_lowercase()));
    otterm_config::merge_themes(&mut themes, from_mods);
    let (layouts, layout_warnings) = otterm_config::saved_layouts(dir.map(|d| d.join("layouts")).as_deref());
    warnings.extend(layout_warnings);
    let user_css = dir.and_then(|d| std::fs::read_to_string(d.join("user.css")).ok()).unwrap_or_default();
    let modified = newest_change(path).max(workspace.as_ref().and_then(|(ws, _)| mtime(&ws.file)));
    Loaded { config, file_config, themes, layouts, user_css, warnings, workspace, modified }
}

/// The workspace above `start`, applied to `config` as far as its trust allows (K4): untrusted,
/// only its theme; trusted, its settings and its mods, but never a mod that types into the
/// terminal (`terminal.write`, docs/06 §1).
fn workspace(
    start: &std::path::Path,
    config: &mut Config,
    warnings: &mut Vec<Warning>,
) -> Option<(otterm_config::Workspace, Option<bool>)> {
    let file = otterm_config::find_workspace(start)?;
    let (ws, more) = otterm_config::load_workspace(&file);
    let prefix = |w: Warning| Warning { key: format!("workspace.toml {}", w.key).trim_end().to_owned(), ..w };
    warnings.extend(more.into_iter().map(prefix));
    let ws = ws?;
    let trusted = otterm_config::data_dir().and_then(|d| otterm_config::TrustStore::open(&d).get(&ws.root));
    let on = trusted == Some(true);
    warnings.extend(otterm_config::apply_workspace(config, &ws, on).into_iter().map(prefix));
    if on {
        for id in &ws.config.mods {
            match crate::mods::writes_terminal(id) {
                Some(false) => {
                    if !config.mods.disabled.contains(id) && !config.mods.enabled.contains(id) {
                        config.mods.enabled.push(id.clone());
                    }
                }
                Some(true) => warnings.push(Warning {
                    key: format!("workspace.toml mods.{id}"),
                    message: "a mod with terminal.write cannot be turned on by a workspace".into(),
                }),
                None => {
                    warnings.push(Warning { key: format!("workspace.toml mods.{id}"), message: "not installed".into() })
                }
            }
        }
    }
    Some((ws, trusted))
}

fn mtime(p: &std::path::Path) -> Option<SystemTime> {
    std::fs::metadata(p).ok()?.modified().ok()
}

/// The newest modification time among config.toml, user.css and the files in `themes/` and
/// `layouts/`, so that editing any of them reloads (a handful of files, checked once a second).
fn newest_change(path: Option<&PathBuf>) -> Option<SystemTime> {
    let path = path?;
    let time = |p: &std::path::Path| std::fs::metadata(p).ok()?.modified().ok();
    let mut newest = time(path);
    let mut see = |t: Option<SystemTime>| {
        if t > newest {
            newest = t;
        }
    };
    if let Some(dir) = path.parent() {
        // The folder's own time changes when user.css (or a theme) is deleted or added.
        see(time(dir));
        see(time(&dir.join("user.css")));
        for sub in ["themes", "layouts"] {
            let d = dir.join(sub);
            see(time(&d));
            for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
                see(time(&e.path()));
            }
        }
    }
    newest
}

/// `[appearance.window]`, with the theme's window settings where the config keeps the default.
fn window(c: &Config, theme: Option<&otterm_config::ThemeWindow>, config: Option<&std::path::Path>) -> UiWindow {
    let w = &c.appearance.window;
    let t = theme.cloned().unwrap_or_default();
    let image = w
        .background_image
        .clone()
        .filter(|p| !p.trim().is_empty())
        .map(|p| background_path(config, &p).display().to_string())
        .or(t.background_image);
    let fit = match (w.background_fit, t.background_fit.as_deref()) {
        (BackgroundFit::Cover, Some("contain")) => BackgroundFit::Contain,
        (BackgroundFit::Cover, Some("tile")) => BackgroundFit::Tile,
        (BackgroundFit::Cover, Some("center")) => BackgroundFit::Center,
        (f, _) => f,
    };
    UiWindow {
        opacity: if w.opacity >= 1.0 { t.opacity.unwrap_or(1.0) } else { w.opacity }.clamp(0.3, 1.0),
        blur: w.blur || t.blur.unwrap_or(false),
        background_image: image,
        background_fit: fit,
        background_image_opacity: w.background_image_opacity.clamp(0.05, 1.0),
    }
}

/// A background image path from the config: relative paths are under the config folder.
pub fn background_path(config: Option<&std::path::Path>, p: &str) -> PathBuf {
    let p = std::path::Path::new(p);
    if p.is_absolute() {
        return p.to_path_buf();
    }
    match config.and_then(|c| c.parent()) {
        Some(dir) => dir.join(p),
        None => p.to_path_buf(),
    }
}

/// Settings for new terminals.
pub fn terminal_options(c: &Config) -> otterm_session::TerminalOptions {
    otterm_session::TerminalOptions {
        // 0 means unlimited: old chunks are compressed, then spilled to disk (docs/09 §5).
        scrollback: if c.terminal.scrollback == 0 { usize::MAX } else { c.terminal.scrollback as usize },
        spill_limit_mb: u64::from(c.terminal.scrollback_spill_limit_mb),
        ambiguous_wide: c.terminal.ambiguous_width == AmbiguousWidth::Wide,
        cursor_shape: match c.terminal.cursor.style {
            CursorStyle::Block => otterm_session::CursorShape::Block,
            CursorStyle::Underline => otterm_session::CursorShape::Underline,
            CursorStyle::Bar => otterm_session::CursorShape::Bar,
        },
        cursor_blink: c.terminal.cursor.blink,
        kitty_keyboard: c.terminal.kitty_keyboard,
        wheel_arrows: c.terminal.wheel_to_arrows_in_alt_screen,
        fold_lines: c.terminal.fold_lines as usize,
    }
}

/// `#rrggbb`: the only form passed on to CSS.
fn is_hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// The program, arguments, directory and environment of the default profile, if one is set.
fn font_family(c: &Config) -> String {
    let mut css: Vec<String> = font_names(c).iter().map(|n| format!("\"{}\"", n.replace('"', ""))).collect();
    css.push("monospace".into());
    css.join(", ")
}

/// The configured families and their fallbacks, in order, without repeats.
fn font_names(c: &Config) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    if c.font.family.is_empty() {
        names.extend(platform_fonts().iter().map(|s| (*s).to_owned()));
    } else {
        names.extend(c.font.family.iter().cloned());
    }
    match &c.font.cjk_family {
        Auto::Value(f) => names.push(f.clone()),
        Auto::Auto(_) => names.extend(cjk_fonts().iter().map(|s| (*s).to_owned())),
    }
    // Icons in prompts (decision B14): an installed Nerd Font, then the bundled symbols font.
    names.extend(nerd_fonts().iter().cloned());
    names.push("Symbols Nerd Font Mono".into());
    match &c.font.emoji_family {
        Auto::Value(f) => names.push(f.clone()),
        Auto::Auto(_) => names.push(emoji_font().into()),
    }
    let mut seen = std::collections::HashSet::new();
    names.into_iter().filter(|n| seen.insert(n.to_lowercase())).collect()
}

fn platform_fonts() -> &'static [&'static str] {
    if cfg!(windows) {
        &["Cascadia Mono", "Cascadia Code", "Consolas"]
    } else if cfg!(target_os = "macos") {
        &["SF Mono", "Menlo"]
    } else {
        &["DejaVu Sans Mono", "Noto Sans Mono", "Liberation Mono"]
    }
}

/// Decision I8.
fn cjk_fonts() -> &'static [&'static str] {
    if cfg!(windows) {
        &["BIZ UDGothic", "MS Gothic"]
    } else if cfg!(target_os = "macos") {
        &["Hiragino Sans", "Hiragino Kaku Gothic ProN"]
    } else {
        &["Noto Sans Mono CJK JP", "Noto Sans CJK JP"]
    }
}

fn emoji_font() -> &'static str {
    if cfg!(windows) {
        "Segoe UI Emoji"
    } else if cfg!(target_os = "macos") {
        "Apple Color Emoji"
    } else {
        "Noto Color Emoji"
    }
}

/// Installed Nerd Font families, best first: symbol-only and "Mono" variants keep icons one cell
/// wide. Loading the system fonts takes a moment, so it starts early ([`warm_up`]) and is cached.
fn nerd_fonts() -> &'static [String] {
    static FONTS: OnceLock<Vec<String>> = OnceLock::new();
    FONTS.get_or_init(scan_nerd_fonts)
}

/// Start scanning fonts in the background so the first window does not wait for it.
pub fn warm_up() {
    std::thread::spawn(|| {
        nerd_fonts();
    });
}

fn scan_nerd_fonts() -> Vec<String> {
    let db = crate::text::db();
    let mut families: Vec<String> =
        db.faces().flat_map(|f| f.families.iter().map(|(name, _)| name.clone())).filter(|n| is_nerd_font(n)).collect();
    families.sort_by_key(|n| (nerd_rank(n), n.clone()));
    families.dedup();
    families.truncate(2);
    families
}

fn is_nerd_font(name: &str) -> bool {
    name.contains("Nerd Font") || name.ends_with(" NF") || name.ends_with(" NFM") || name.ends_with(" NFP")
}

fn nerd_rank(name: &str) -> u8 {
    if name.starts_with("Symbols Nerd Font") {
        0
    } else if name.contains("Nerd Font Mono") || name.ends_with(" NFM") {
        1
    } else {
        2
    }
}
