//! otterm configuration: the Rust model of `config.toml` and `workspace.toml`, loading with
//! per-key fallback, and themes. Spec: docs/06-config-keybind.md, docs/04-ui-theme.md §2.

mod import;
mod layout;
mod load;
pub mod schema;
mod theme;

pub use import::{import_theme, theme_file_name, theme_to_toml};
pub use layout::{
    Layout, PANEL_SLOTS, PRESET_NAMES, find_layout, layout_to_toml, preset, resolve_layout, saved_layouts,
};
pub use load::{Warning, config_dir, config_path, data_dir, load, parse};
pub use schema::*;
pub use theme::{
    TerminalColors, Theme, ThemeAppearance, ThemeCss, ThemeWindow, all_themes, bundled_themes, find_theme,
    load_theme_file, merge_themes, parse_theme,
};
