//! Layout presets (docs/04 §1.2): which parts of the window are shown, resolved against the
//! `auto` settings under `[appearance]`.
//!
//! The five presets are built in. Saved layouts live in `<config>/layouts/*.toml` as
//! `[layout]` tables and may replace a preset of the same name.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::schema::{Appearance, Auto, BlockStyle, TabbarPosition};

/// A layout: the starting point the `auto` settings take their values from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Layout {
    pub name: String,
    pub tabbar: TabbarPosition,
    pub sidebar_left: bool,
    pub sidebar_right: bool,
    pub panel_bottom: bool,
    pub statusbar: bool,
    pub assist_bar: bool,
    pub blocks: BlockStyle,
    /// Panel id → slot, as `appearance.panels`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub panels: BTreeMap<String, String>,
}

/// Where a panel can go.
pub const PANEL_SLOTS: &[&str] = &["sidebar.left", "sidebar.right", "panel.bottom"];

pub const PRESET_NAMES: &[&str] = &["minimal", "classic", "guided", "ide", "cards"];

/// A built-in preset by name.
pub fn preset(name: &str) -> Option<Layout> {
    let base = |name: &str| Layout {
        name: name.into(),
        tabbar: TabbarPosition::Top,
        sidebar_left: false,
        sidebar_right: false,
        panel_bottom: false,
        statusbar: true,
        assist_bar: false,
        blocks: BlockStyle::Plain,
        panels: BTreeMap::new(),
    };
    Some(match name {
        "minimal" => Layout { tabbar: TabbarPosition::HiddenWhenSingle, statusbar: false, ..base(name) },
        "classic" => base(name),
        "guided" => Layout { sidebar_left: true, assist_bar: true, ..base(name) },
        "ide" => Layout { sidebar_left: true, sidebar_right: true, panel_bottom: true, assist_bar: true, ..base(name) },
        "cards" => Layout { sidebar_left: true, assist_bar: true, blocks: BlockStyle::Cards, ..base(name) },
        _ => return None,
    })
}

#[derive(Deserialize)]
struct LayoutFile {
    layout: Layout,
}

/// Saved layouts in `dir`; files that do not parse are reported.
pub fn saved_layouts(dir: Option<&Path>) -> (Vec<Layout>, Vec<crate::Warning>) {
    let mut out = Vec::new();
    let mut warnings = Vec::new();
    let Some(entries) = dir.and_then(|d| std::fs::read_dir(d).ok()) else { return (out, warnings) };
    let mut paths: Vec<_> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "toml"))
        .collect();
    paths.sort();
    for path in paths {
        let parsed = std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|t| toml::from_str::<LayoutFile>(&t).map_err(|e| e.message().to_owned()));
        match parsed {
            Ok(f) if !f.layout.name.trim().is_empty() => out.push(f.layout),
            Ok(_) => warnings.push(crate::Warning {
                key: format!("layouts/{}", path.display()),
                message: "the layout has no name".into(),
            }),
            Err(message) => warnings.push(crate::Warning { key: format!("layouts/{}", path.display()), message }),
        }
    }
    (out, warnings)
}

/// A layout as a file for `<config>/layouts/`.
pub fn layout_to_toml(layout: &Layout) -> String {
    #[derive(Serialize)]
    struct Out<'a> {
        layout: &'a Layout,
    }
    toml::to_string(&Out { layout }).unwrap_or_default()
}

/// The layout named by `appearance.layout`: a saved one first, then a preset, else `guided`.
pub fn find_layout(name: &str, saved: &[Layout]) -> Layout {
    saved
        .iter()
        .find(|l| l.name.eq_ignore_ascii_case(name))
        .cloned()
        .or_else(|| preset(&name.to_lowercase()))
        .unwrap_or_else(|| preset("guided").expect("guided is a preset"))
}

/// What the window shows: the layout with explicit `[appearance]` values on top.
pub fn resolve_layout(a: &Appearance, layout: &Layout) -> Layout {
    let pick = |v: &Auto<bool>, d: bool| match v {
        Auto::Value(b) => *b,
        Auto::Auto(_) => d,
    };
    let mut panels = layout.panels.clone();
    panels.extend(
        a.panels.iter().filter(|(_, s)| PANEL_SLOTS.contains(&s.as_str())).map(|(k, v)| (k.clone(), v.clone())),
    );
    Layout {
        name: layout.name.clone(),
        tabbar: match a.tabbar.position {
            Auto::Value(p) => p,
            Auto::Auto(_) => layout.tabbar,
        },
        sidebar_left: pick(&a.sidebar.left.visible, layout.sidebar_left),
        sidebar_right: pick(&a.sidebar.right.visible, layout.sidebar_right),
        panel_bottom: pick(&a.panel.bottom.visible, layout.panel_bottom),
        statusbar: pick(&a.statusbar.visible, layout.statusbar),
        assist_bar: pick(&a.assist_bar, layout.assist_bar),
        blocks: match a.blocks {
            Auto::Value(b) => b,
            Auto::Auto(_) => layout.blocks,
        },
        panels,
    }
}
