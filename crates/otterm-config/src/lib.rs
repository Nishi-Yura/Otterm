//! otterm configuration: the Rust model of `config.toml` and `workspace.toml`, loading with
//! per-key fallback, and themes. Spec: docs/06-config-keybind.md, docs/04-ui-theme.md §2.

mod load;
pub mod schema;
mod theme;

pub use load::{Warning, config_dir, config_path, load, parse};
pub use schema::*;
pub use theme::{TerminalColors, Theme, ThemeAppearance, all_themes, bundled_themes, find_theme, parse_theme};
