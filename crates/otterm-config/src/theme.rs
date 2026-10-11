//! Themes (docs/04 §2): terminal colors, UI tokens and optional CSS.
//!
//! The bundled themes live in `themes/*.toml` and are compiled in; user themes are read from
//! `<config dir>/themes/*.toml` and win over a bundled theme of the same name.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeAppearance {
    Light,
    Dark,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Theme {
    pub name: String,
    pub appearance: ThemeAppearance,
    pub terminal: TerminalColors,
    /// UI tokens, exposed to CSS as `--ot-<key>` (docs/04 §2.2).
    #[serde(default)]
    pub ui: BTreeMap<String, String>,
}

/// Colors as CSS hex strings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalColors {
    pub foreground: String,
    pub background: String,
    pub cursor: String,
    pub selection: String,
    /// ANSI 0–7.
    pub ansi: [String; 8],
    /// ANSI 8–15.
    pub bright: [String; 8],
}

#[derive(Deserialize)]
struct ThemeFile {
    theme: Theme,
}

const BUNDLED: &[&str] = &[
    include_str!("../themes/otterm-dark.toml"),
    include_str!("../themes/otterm-light.toml"),
    include_str!("../themes/high-contrast.toml"),
    include_str!("../themes/catppuccin-mocha.toml"),
    include_str!("../themes/catppuccin-latte.toml"),
    include_str!("../themes/dracula.toml"),
    include_str!("../themes/nord.toml"),
    include_str!("../themes/tokyo-night.toml"),
    include_str!("../themes/one-dark.toml"),
    include_str!("../themes/solarized-dark.toml"),
    include_str!("../themes/solarized-light.toml"),
    include_str!("../themes/gruvbox-dark.toml"),
    include_str!("../themes/gruvbox-light.toml"),
];

/// Parse a theme file.
pub fn parse_theme(text: &str) -> Result<Theme, String> {
    let file: ThemeFile = toml::from_str(text).map_err(|e| e.message().to_owned())?;
    let t = file.theme;
    let colors = [&t.terminal.foreground, &t.terminal.background, &t.terminal.cursor, &t.terminal.selection]
        .into_iter()
        .chain(&t.terminal.ansi)
        .chain(&t.terminal.bright);
    for c in colors {
        if !is_hex_color(c) {
            return Err(format!("not a #rrggbb color: {c}"));
        }
    }
    Ok(t)
}

fn is_hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// The bundled themes, in display order.
pub fn bundled_themes() -> Vec<Theme> {
    BUNDLED.iter().map(|t| parse_theme(t).expect("bundled themes are valid")).collect()
}

/// Bundled themes plus the user's from `dir` (a user theme replaces a bundled one of the same
/// name). Files that do not parse are reported and skipped.
pub fn all_themes(dir: Option<&Path>) -> (Vec<Theme>, Vec<crate::Warning>) {
    let mut themes = bundled_themes();
    let mut warnings = Vec::new();
    let Some(entries) = dir.and_then(|d| std::fs::read_dir(d).ok()) else { return (themes, warnings) };
    let mut paths: Vec<_> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "toml"))
        .collect();
    paths.sort();
    for path in paths {
        let parsed = std::fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|t| parse_theme(&t));
        match parsed {
            Ok(theme) => match themes.iter_mut().find(|t| t.name.eq_ignore_ascii_case(&theme.name)) {
                Some(existing) => *existing = theme,
                None => themes.push(theme),
            },
            Err(message) => warnings.push(crate::Warning { key: format!("themes/{}", file_name(&path)), message }),
        }
    }
    (themes, warnings)
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Find a theme by name, ignoring case.
pub fn find_theme<'a>(themes: &'a [Theme], name: &str) -> Option<&'a Theme> {
    themes.iter().find(|t| t.name.eq_ignore_ascii_case(name))
}
