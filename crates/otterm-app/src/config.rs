//! The configuration as the app uses it: `config.toml`, the chosen theme and the resolved font
//! list, reloaded when the file changes (docs/06 §3).

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use otterm_config::{AmbiguousWidth, Auto, Config, CursorStyle, Language, Theme, Warning};
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
    pub cursor_style: CursorStyle,
    pub cursor_blink: bool,
    pub copy_on_select: bool,
    pub word_separators: String,
    /// Keys that were ignored, to show once.
    pub warnings: Vec<UiWarning>,
    pub config_path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiFont {
    /// A CSS `font-family` list: the configured fonts, then CJK, Nerd Font and emoji fallbacks.
    pub family: String,
    pub size: f32,
    pub line_height: f32,
    pub weight: u16,
    pub weight_bold: u16,
}

#[derive(Clone, Serialize)]
pub struct UiWarning {
    pub key: String,
    pub message: String,
}

impl ConfigState {
    pub fn load() -> Self {
        let path = otterm_config::config_path();
        Self { loaded: Mutex::new(read(path.as_ref())), path }
    }

    pub fn config(&self) -> Config {
        self.loaded.lock().unwrap().config.clone()
    }

    pub fn ui(&self) -> UiConfig {
        let l = self.loaded.lock().unwrap();
        let c = &l.config;
        let theme = otterm_config::find_theme(&l.themes, &c.appearance.theme)
            .or_else(|| otterm_config::find_theme(&l.themes, "otterm Dark"))
            .cloned()
            .expect("the default theme is bundled");
        let mut warnings: Vec<UiWarning> =
            l.warnings.iter().map(|w| UiWarning { key: w.key.clone(), message: w.message.clone() }).collect();
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
                size: c.font.size.clamp(6.0, 72.0),
                line_height: c.font.line_height.clamp(0.8, 2.0),
                weight: c.font.weight,
                weight_bold: c.font.weight_bold,
            },
            theme,
            cursor_style: c.terminal.cursor.style,
            cursor_blink: c.terminal.cursor.blink,
            copy_on_select: c.terminal.copy_on_select,
            word_separators: c.terminal.word_separators.clone(),
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
    }
}

/// The program, arguments, directory and environment of the default profile, if one is set.
pub fn default_profile(c: &Config) -> Option<&otterm_config::Profile> {
    let id = &c.shell.default_profile;
    if id.is_empty() { None } else { c.profiles.iter().find(|p| &p.id == id) }
}

fn font_family(c: &Config) -> String {
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
    let mut css: Vec<String> = names
        .into_iter()
        .filter(|n| seen.insert(n.to_lowercase()))
        .map(|n| format!("\"{}\"", n.replace('"', "")))
        .collect();
    css.push("monospace".into());
    css.join(", ")
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
/// wide. Scanning the system fonts takes a moment, so it starts early ([`warm_up`]) and is cached.
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
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nerd_font_names() {
        assert!(is_nerd_font("JetBrainsMono Nerd Font"));
        assert!(is_nerd_font("JetBrainsMono NF"));
        assert!(!is_nerd_font("Cascadia Mono"));
        let mut v =
            ["JetBrainsMono Nerd Font".to_owned(), "JetBrainsMono Nerd Font Mono".into(), "Symbols Nerd Font".into()];
        v.sort_by_key(|n| (nerd_rank(n), n.clone()));
        assert_eq!(v[0], "Symbols Nerd Font");
        assert_eq!(v[1], "JetBrainsMono Nerd Font Mono");
    }

    #[test]
    fn font_list_puts_configured_fonts_first_and_ends_with_monospace() {
        let mut c = Config::default();
        c.font.family = vec!["Iosevka".into()];
        let css = font_family(&c);
        assert!(css.starts_with("\"Iosevka\", "), "{css}");
        assert!(css.contains("\"Symbols Nerd Font Mono\""));
        assert!(css.ends_with(", monospace"));
    }
}
