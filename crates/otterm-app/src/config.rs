//! The configuration as the app uses it: `config.toml`, the chosen theme and the resolved font
//! list, reloaded when the file changes (docs/06 §3).

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use otterm_config::{
    AmbiguousWidth, Auto, Bell, Config, CursorStyle, Effective, Language, Permission, RightClick, TabbarPosition,
    Theme, Warning,
};
use serde::Serialize;

/// How often the config file is checked for changes.
const WATCH_INTERVAL: Duration = Duration::from_secs(1);

pub struct ConfigState {
    path: Option<PathBuf>,
    loaded: Mutex<Loaded>,
}

struct Loaded {
    config: Config,
    themes: Vec<Theme>,
    warnings: Vec<Warning>,
    modified: Option<SystemTime>,
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
    /// Where the tab bar is: top, bottom, left, or hidden-when-single.
    pub tabbar: TabbarPosition,
    pub cursor_style: CursorStyle,
    pub cursor_blink: bool,
    pub copy_on_select: bool,
    pub word_separators: String,
    /// `[keybindings.bindings]`: action id → key chords (an empty list unbinds).
    pub keybindings: std::collections::BTreeMap<String, Vec<String>>,
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
    /// Keys that were ignored, to show once.
    pub warnings: Vec<UiWarning>,
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
}

#[derive(Clone, Serialize)]
pub struct UiWarning {
    pub key: String,
    pub message: String,
}

impl ConfigState {
    /// Read `path`, or the usual config.toml when it is `None`.
    pub fn load(path: Option<PathBuf>) -> Self {
        let path = path.or_else(otterm_config::config_path);
        Self { loaded: Mutex::new(read(path.as_ref())), path }
    }

    /// Where config.toml is (it may not exist yet).
    pub fn path(&self) -> Option<PathBuf> {
        self.path.clone()
    }

    pub fn config(&self) -> Config {
        self.loaded.lock().unwrap().config.clone()
    }

    pub fn ui(&self) -> UiConfig {
        let l = self.loaded.lock().unwrap();
        let c = &l.config;
        let effective = Effective::resolve(c);
        let theme = otterm_config::find_theme(&l.themes, &c.appearance.theme)
            .or_else(|| otterm_config::find_theme(&l.themes, "otterm Dark"))
            .cloned()
            .expect("the default theme is bundled");
        let mut warnings: Vec<UiWarning> =
            l.warnings.iter().map(|w| UiWarning { key: w.key.clone(), message: w.message.clone() }).collect();
        let theme_light = otterm_config::find_theme(&l.themes, &c.appearance.theme_light).cloned();
        if c.appearance.follow_system && theme_light.is_none() {
            warnings.push(UiWarning {
                key: "appearance.theme_light".into(),
                message: format!("no theme named \"{}\"", c.appearance.theme_light),
            });
        }
        if otterm_config::find_theme(&l.themes, &c.appearance.theme).is_none() {
            warnings.push(UiWarning {
                key: "appearance.theme".into(),
                message: format!("no theme named \"{}\"", c.appearance.theme),
            });
        }
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
            },
            theme,
            theme_light,
            follow_system: c.appearance.follow_system,
            minimum_contrast: c.appearance.minimum_contrast.clamp(1.0, 21.0),
            renderer: c.appearance.renderer,
            padding: c.appearance.window.padding.min(64),
            profile_colors: c
                .profiles
                .iter()
                .filter_map(|p| Some((p.id.clone(), p.color.clone().filter(|c| is_hex_color(c))?)))
                .collect(),
            default_profile: c.shell.default_profile.clone(),
            tabbar: c.appearance.tabbar.position,
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
            alt_screen_passthrough: c.keybindings.alt_screen_passthrough,
            confirm_multiline_paste: effective.confirm_multiline_paste,
            right_click: effective.right_click,
            osc52_clipboard: c.terminal.osc52_clipboard,
            bell: c.terminal.bell,
            confirm_close_running: c.general.confirm_close_running,
            close_behavior: c.terminal.close_behavior,
            warnings,
            config_path: self.path.as_ref().map(|p| p.display().to_string()),
        }
    }

    /// Reload if the file changed since the last read. Returns whether it did.
    pub fn reload_if_changed(&self) -> bool {
        let modified = self.path.as_ref().and_then(|p| std::fs::metadata(p).ok()?.modified().ok());
        if modified == self.loaded.lock().unwrap().modified {
            return false;
        }
        *self.loaded.lock().unwrap() = read(self.path.as_ref());
        true
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

fn read(path: Option<&PathBuf>) -> Loaded {
    let (config, mut warnings) = match path {
        Some(p) => otterm_config::load(p),
        None => (Config::default(), Vec::new()),
    };
    let dir = path.and_then(|p| p.parent()).map(|d| d.join("themes"));
    let (themes, theme_warnings) = otterm_config::all_themes(dir.as_deref());
    warnings.extend(theme_warnings);
    let modified = path.and_then(|p| std::fs::metadata(p).ok()?.modified().ok());
    Loaded { config, themes, warnings, modified }
}

/// Settings for new terminals.
pub fn terminal_options(c: &Config) -> otterm_session::TerminalOptions {
    otterm_session::TerminalOptions {
        // 0 means unlimited with disk spill (docs/06), which is not built yet; keep a large cap.
        scrollback: if c.terminal.scrollback == 0 { 100_000 } else { c.terminal.scrollback as usize },
        ambiguous_wide: c.terminal.ambiguous_width == AmbiguousWidth::Wide,
        cursor_shape: match c.terminal.cursor.style {
            CursorStyle::Block => otterm_session::CursorShape::Block,
            CursorStyle::Underline => otterm_session::CursorShape::Underline,
            CursorStyle::Bar => otterm_session::CursorShape::Bar,
        },
        cursor_blink: c.terminal.cursor.blink,
        kitty_keyboard: c.terminal.kitty_keyboard,
        wheel_arrows: c.terminal.wheel_to_arrows_in_alt_screen,
    }
}

/// `#rrggbb`: the only form passed on to CSS.
fn is_hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// The program, arguments, directory and environment of the default profile, if one is set.
pub fn default_profile(c: &Config) -> Option<&otterm_config::Profile> {
    let id = &c.shell.default_profile;
    if id.is_empty() { None } else { c.profiles.iter().find(|p| &p.id == id) }
}

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
