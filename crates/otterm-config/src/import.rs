//! Import of terminal color schemes from other tools (`otterm theme import`, docs/04 §2.4).
//!
//! Supported: iTerm2 `.itermcolors`, Windows Terminal schemes (a single scheme or a settings.json
//! with `schemes`), VS Code color themes (JSON or JSONC), Alacritty (TOML and legacy YAML) and
//! WezTerm TOML color schemes. Missing values are filled in: the cursor takes the foreground, the
//! selection is a 25% mix of the background towards the foreground, and missing ANSI colors come
//! from the xterm defaults.

use std::array::from_fn;
use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value as Json;

use crate::theme::{TerminalColors, Theme, ThemeAppearance};

/// xterm's default 16-color palette, used for ANSI colors a scheme does not define.
const XTERM: [&str; 16] = [
    "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5", //
    "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
];
const DEFAULT_FOREGROUND: &str = "#e5e5e5";
const DEFAULT_BACKGROUND: &str = "#000000";
const ALACRITTY_NAMES: [&str; 8] = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const WINDOWS_TERMINAL_NAMES: [&str; 8] = ["black", "red", "green", "yellow", "blue", "purple", "cyan", "white"];
const WINDOWS_TERMINAL_BRIGHT_NAMES: [&str; 8] = [
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightPurple",
    "brightCyan",
    "brightWhite",
];
const VSCODE_NAMES: [&str; 8] = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"];

#[derive(Clone, Copy)]
enum Format {
    ITerm,
    Json,
    Toml,
    Yaml,
}

/// Parse every color scheme in `text`. `file_name` decides the format by extension, falling back
/// to the content, and supplies the name when the file does not have one.
pub fn import_theme(text: &str, file_name: &str) -> Result<Vec<Theme>, String> {
    let stem = stem_of(file_name);
    let body = text.trim_start_matches('\u{feff}');
    let format = match extension_of(file_name).as_str() {
        "itermcolors" => Format::ITerm,
        "json" | "jsonc" => Format::Json,
        "toml" => Format::Toml,
        "yml" | "yaml" => Format::Yaml,
        _ => sniff(body)?,
    };
    match format {
        Format::ITerm => Ok(vec![iterm(body, &stem)?]),
        Format::Json => json_import(body, &stem),
        Format::Toml => toml_import(body, &stem),
        Format::Yaml => Ok(vec![alacritty(&yaml_flatten(body), &stem)?]),
    }
}

/// Serialize a theme as a theme file (`[theme]` and `[theme.terminal]`, see `themes/*.toml`).
pub fn theme_to_toml(theme: &Theme) -> String {
    #[derive(Serialize)]
    struct ThemeFile<'a> {
        theme: &'a Theme,
    }
    toml::to_string(&ThemeFile { theme }).expect("a theme always serializes to TOML")
}

/// A safe file name for a theme called `name`, such as `catppuccin-mocha.toml`.
pub fn theme_file_name(name: &str) -> String {
    let mut slug = String::new();
    for c in name.chars() {
        let c = fold_accent(c.to_lowercase().next().unwrap_or(c));
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let capped: String = slug.trim_matches('-').chars().take(64).collect();
    let capped = capped.trim_matches('-');
    if capped.is_empty() { "theme.toml".to_owned() } else { format!("{capped}.toml") }
}

fn fold_accent(c: char) -> char {
    match c {
        'à' | 'á' | 'â' | 'ä' | 'ã' | 'å' => 'a',
        'ç' => 'c',
        'è' | 'é' | 'ê' | 'ë' => 'e',
        'ì' | 'í' | 'î' | 'ï' => 'i',
        'ñ' => 'n',
        'ò' | 'ó' | 'ô' | 'ö' | 'õ' => 'o',
        'ù' | 'ú' | 'û' | 'ü' => 'u',
        _ => c,
    }
}

/// Guess the format from the content when the extension says nothing useful.
fn sniff(body: &str) -> Result<Format, String> {
    if body.trim_start().starts_with('<') {
        Ok(Format::ITerm)
    } else if strip_jsonc(body).trim_start().starts_with('{') {
        Ok(Format::Json)
    } else if toml::from_str::<toml::Table>(body).is_ok() {
        Ok(Format::Toml)
    } else if body.lines().any(|line| line.starts_with("colors:")) {
        Ok(Format::Yaml)
    } else {
        Err("unrecognized theme file: expected iTerm2, Windows Terminal, VS Code, Alacritty or WezTerm".to_owned())
    }
}

/// The collected pieces of a scheme, before fallbacks are applied.
struct Parts {
    name: String,
    appearance: Option<ThemeAppearance>,
    foreground: Option<String>,
    background: Option<String>,
    cursor: Option<String>,
    selection: Option<String>,
    ansi: [Option<String>; 8],
    bright: [Option<String>; 8],
}

impl Parts {
    fn new(name: &str) -> Self {
        Self {
            name: name.to_owned(),
            appearance: None,
            foreground: None,
            background: None,
            cursor: None,
            selection: None,
            ansi: Default::default(),
            bright: Default::default(),
        }
    }

    fn finish(self) -> Result<Theme, String> {
        let any_color = [&self.foreground, &self.background, &self.cursor, &self.selection].iter().any(|c| c.is_some())
            || self.ansi.iter().chain(&self.bright).any(|c| c.is_some());
        if !any_color {
            return Err("no colors found in the file".to_owned());
        }
        let name = self.name.trim();
        let name = if name.is_empty() { "Imported theme".to_owned() } else { name.to_owned() };
        let foreground = self.foreground.unwrap_or_else(|| DEFAULT_FOREGROUND.to_owned());
        let background = self.background.unwrap_or_else(|| DEFAULT_BACKGROUND.to_owned());
        let appearance = self.appearance.unwrap_or_else(|| {
            if luminance(&background) < 0.5 { ThemeAppearance::Dark } else { ThemeAppearance::Light }
        });
        let cursor = self.cursor.unwrap_or_else(|| foreground.clone());
        let selection = self.selection.unwrap_or_else(|| mix(&background, &foreground, 0.25));
        let ansi = from_fn(|i| self.ansi[i].clone().unwrap_or_else(|| XTERM[i].to_owned()));
        let bright = from_fn(|i| self.bright[i].clone().unwrap_or_else(|| XTERM[8 + i].to_owned()));
        Ok(Theme {
            name,
            appearance,
            terminal: TerminalColors { foreground, background, cursor, selection, ansi, bright },
            ui: BTreeMap::new(),
            window: None,
            css: None,
        })
    }
}

/// iTerm2 `.itermcolors`: a plist whose color entries are dicts of 0..1 Red/Green/Blue reals.
fn iterm(xml: &str, stem: &str) -> Result<Theme, String> {
    let color = |key: &str| plist_color(xml, key);
    let mut p = Parts::new(stem);
    p.foreground = color("Foreground Color");
    p.background = color("Background Color");
    p.cursor = color("Cursor Color");
    p.selection = color("Selection Color");
    p.ansi = from_fn(|i| color(&format!("Ansi {i} Color")));
    p.bright = from_fn(|i| color(&format!("Ansi {} Color", i + 8)));
    p.finish()
}

fn plist_color(xml: &str, key: &str) -> Option<String> {
    let block = dict_after_key(xml, key)?;
    let channel = |name: &str| plist_real(block, name).map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8);
    Some(to_hex((channel("Red Component")?, channel("Green Component")?, channel("Blue Component")?)))
}

/// The `<dict>...</dict>` that is the value of `<key>key</key>`.
fn dict_after_key<'a>(xml: &'a str, key: &str) -> Option<&'a str> {
    let rest = after_key(xml, key)?;
    let open = rest.find("<dict>")?;
    if rest[..open].contains("<key>") {
        return None;
    }
    let body = &rest[open..];
    let close = body.find("</dict>")?;
    Some(&body[..close])
}

fn plist_real(block: &str, key: &str) -> Option<f64> {
    let rest = after_key(block, key)?;
    let open = rest.find("<real>")?;
    if rest[..open].contains("<key>") {
        return None;
    }
    let value = &rest[open + "<real>".len()..];
    let close = value.find("</real>")?;
    value[..close].trim().parse::<f64>().ok()
}

fn after_key<'a>(xml: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("<key>{key}</key>");
    let start = xml.find(&needle)? + needle.len();
    Some(&xml[start..])
}

/// A JSON document: VS Code theme, Windows Terminal scheme, or settings.json with `schemes`.
fn json_import(text: &str, stem: &str) -> Result<Vec<Theme>, String> {
    let value: Json = serde_json::from_str(&strip_jsonc(text)).map_err(|e| format!("invalid JSON: {e}"))?;
    if let Some(colors) = value.get("colors") {
        return Ok(vec![vscode(&value, colors, stem)?]);
    }
    if let Some(schemes) = value.get("schemes").and_then(Json::as_array) {
        let themes = schemes.iter().map(|s| windows_terminal(s, stem)).collect::<Result<Vec<_>, _>>()?;
        if themes.is_empty() {
            return Err("the file has an empty \"schemes\" list".to_owned());
        }
        return Ok(themes);
    }
    if value.get("foreground").is_some() || value.get("black").is_some() {
        return Ok(vec![windows_terminal(&value, stem)?]);
    }
    Err("unrecognized JSON: expected a VS Code theme or a Windows Terminal scheme".to_owned())
}

fn windows_terminal(scheme: &Json, stem: &str) -> Result<Theme, String> {
    let mut p = Parts::new(&name_of(scheme, stem));
    p.foreground = color_field(scheme, "foreground");
    p.background = color_field(scheme, "background");
    p.cursor = color_field(scheme, "cursorColor");
    p.selection = color_field(scheme, "selectionBackground");
    p.ansi = from_fn(|i| color_field(scheme, WINDOWS_TERMINAL_NAMES[i]));
    p.bright = from_fn(|i| color_field(scheme, WINDOWS_TERMINAL_BRIGHT_NAMES[i]));
    p.finish()
}

fn vscode(theme: &Json, colors: &Json, stem: &str) -> Result<Theme, String> {
    let mut p = Parts::new(&name_of(theme, stem));
    p.appearance = match theme.get("type").and_then(Json::as_str) {
        Some("light" | "hc-light") => Some(ThemeAppearance::Light),
        Some("dark" | "hc-black") => Some(ThemeAppearance::Dark),
        _ => None,
    };
    p.foreground = color_field(colors, "terminal.foreground").or_else(|| color_field(colors, "editor.foreground"));
    p.background = color_field(colors, "terminal.background").or_else(|| color_field(colors, "editor.background"));
    p.cursor = color_field(colors, "terminalCursor.foreground");
    p.selection = color_field(colors, "terminal.selectionBackground");
    p.ansi = from_fn(|i| color_field(colors, &format!("terminal.ansi{}", VSCODE_NAMES[i])));
    p.bright = from_fn(|i| color_field(colors, &format!("terminal.ansiBright{}", VSCODE_NAMES[i])));
    p.finish()
}

fn name_of(obj: &Json, stem: &str) -> String {
    obj.get("name").and_then(Json::as_str).map(str::trim).filter(|n| !n.is_empty()).unwrap_or(stem).to_owned()
}

fn color_field(obj: &Json, key: &str) -> Option<String> {
    obj.get(key).and_then(Json::as_str).and_then(parse_color)
}

/// TOML: Alacritty (`[colors.primary]` ...) or WezTerm (`[colors]` with `ansi` and `brights`).
fn toml_import(text: &str, stem: &str) -> Result<Vec<Theme>, String> {
    let table: toml::Table = toml::from_str(text).map_err(|e| format!("invalid TOML: {}", e.message()))?;
    let colors = table.get("colors").and_then(toml::Value::as_table).ok_or("no [colors] table in the file")?;
    if colors.contains_key("primary") {
        let mut flat = BTreeMap::new();
        flatten("", &table, &mut flat);
        return Ok(vec![alacritty(&flat, stem)?]);
    }
    let name = table
        .get("metadata")
        .and_then(toml::Value::as_table)
        .and_then(|m| m.get("name"))
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(stem);
    let mut p = Parts::new(name);
    p.foreground = toml_color(colors, "foreground");
    p.background = toml_color(colors, "background");
    p.cursor = toml_color(colors, "cursor_bg");
    p.selection = toml_color(colors, "selection_bg");
    p.ansi = toml_palette(colors.get("ansi"));
    p.bright = toml_palette(colors.get("brights"));
    Ok(vec![p.finish()?])
}

fn toml_color(table: &toml::Table, key: &str) -> Option<String> {
    table.get(key).and_then(toml::Value::as_str).and_then(parse_color)
}

fn toml_palette(value: Option<&toml::Value>) -> [Option<String>; 8] {
    let list = value.and_then(toml::Value::as_array);
    from_fn(|i| list.and_then(|l| l.get(i)).and_then(toml::Value::as_str).and_then(parse_color))
}

fn flatten(prefix: &str, table: &toml::Table, out: &mut BTreeMap<String, String>) {
    for (key, value) in table {
        let path = if prefix.is_empty() { key.to_string() } else { format!("{prefix}.{key}") };
        match value {
            toml::Value::String(s) => {
                out.insert(path, s.to_string());
            }
            toml::Value::Table(t) => flatten(&path, t, out),
            _ => {}
        }
    }
}

/// Alacritty colors from a flat map of dotted keys (`colors.primary.background`, ...).
fn alacritty(map: &BTreeMap<String, String>, stem: &str) -> Result<Theme, String> {
    let get = |key: &str| map.get(key).map(String::as_str).and_then(parse_color);
    let mut p = Parts::new(stem);
    p.foreground = get("colors.primary.foreground");
    p.background = get("colors.primary.background");
    p.cursor = get("colors.cursor.cursor");
    p.selection = get("colors.selection.background");
    p.ansi = from_fn(|i| get(&format!("colors.normal.{}", ALACRITTY_NAMES[i])));
    p.bright = from_fn(|i| get(&format!("colors.bright.{}", ALACRITTY_NAMES[i])));
    p.finish()
}

/// Minimal indentation-based reader for Alacritty's legacy YAML color section. Produces the same
/// dotted keys as the TOML flattening, so both go through `alacritty`.
fn yaml_flatten(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut stack: Vec<(usize, String)> = Vec::new();
    for line in text.lines() {
        let content = line.trim_start();
        if content.is_empty() || content.starts_with('#') {
            continue;
        }
        let indent = line.len() - content.len();
        let Some((key, raw_value)) = content.split_once(':') else { continue };
        let key = key.trim();
        while stack.last().is_some_and(|(i, _)| *i >= indent) {
            stack.pop();
        }
        let value = strip_yaml_value(raw_value);
        if value.is_empty() {
            stack.push((indent, key.to_owned()));
        } else {
            let path: Vec<&str> = stack.iter().map(|(_, k)| k.as_str()).chain([key]).collect();
            out.insert(path.join("."), value);
        }
    }
    out
}

fn strip_yaml_value(raw: &str) -> String {
    let v = raw.trim();
    for quote in ['\'', '"'] {
        if let Some((inner, _)) = v.strip_prefix(quote).and_then(|rest| rest.split_once(quote)) {
            return inner.to_owned();
        }
    }
    v.split(" #").next().unwrap_or("").trim().to_owned()
}

/// Remove `//` and `/* */` comments and trailing commas, leaving string contents alone.
fn strip_jsonc(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut plain = String::with_capacity(text.len());
    let (mut in_string, mut escaped) = (false, false);
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if in_string {
            plain.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
        } else if c == '"' {
            in_string = true;
            plain.push(c);
            i += 1;
        } else if c == '/' && next == Some('/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && next == Some('*') {
            i += 2;
            while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 2;
        } else {
            plain.push(c);
            i += 1;
        }
    }

    let chars: Vec<char> = plain.chars().collect();
    let mut out = String::with_capacity(plain.len());
    let (mut in_string, mut escaped) = (false, false);
    for (i, &c) in chars.iter().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            out.push(c);
        } else if c == '"' {
            in_string = true;
            out.push(c);
        } else {
            let trailing_comma =
                c == ',' && chars[i + 1..].iter().find(|n| !n.is_whitespace()).is_some_and(|&n| n == '}' || n == ']');
            if !trailing_comma {
                out.push(c);
            }
        }
    }
    out
}

fn basename(file_name: &str) -> &str {
    file_name.rsplit(['/', '\\']).next().unwrap_or(file_name)
}

fn stem_of(file_name: &str) -> String {
    let base = basename(file_name);
    match base.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem.to_owned(),
        _ => base.to_owned(),
    }
}

fn extension_of(file_name: &str) -> String {
    let base = basename(file_name);
    match base.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => ext.to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` or `0xrrggbb` to a lowercase `#rrggbb`. The alpha
/// channel is dropped. Anything else (such as Alacritty's `CellForeground`) is `None`.
fn parse_color(s: &str) -> Option<String> {
    let s = s.trim();
    let hex = s.strip_prefix('#').or_else(|| s.strip_prefix("0x")).or_else(|| s.strip_prefix("0X"))?;
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let full: String = match hex.len() {
        3 | 4 => hex.chars().take(3).flat_map(|c| [c, c]).collect(),
        6 | 8 => hex[..6].to_owned(),
        _ => return None,
    };
    Some(format!("#{}", full.to_ascii_lowercase()))
}

fn rgb(hex: &str) -> (u8, u8, u8) {
    let channel = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap_or(0);
    (channel(1), channel(3), channel(5))
}

fn to_hex((r, g, b): (u8, u8, u8)) -> String {
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// WCAG relative luminance of a `#rrggbb` color.
fn luminance(hex: &str) -> f64 {
    let (r, g, b) = rgb(hex);
    let linear = |c: u8| {
        let c = f64::from(c) / 255.0;
        if c <= 0.03928 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/// `a` moved `t` of the way towards `b`.
fn mix(a: &str, b: &str, t: f64) -> String {
    let (a, b) = (rgb(a), rgb(b));
    let blend = |x: u8, y: u8| (f64::from(x) + (f64::from(y) - f64::from(x)) * t).round() as u8;
    to_hex((blend(a.0, b.0), blend(a.1, b.1), blend(a.2, b.2)))
}
