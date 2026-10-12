//! otterm configuration model.
//!
//! Source of truth for config.toml and workspace.toml; the JSON Schema for the settings UI is generated from it.
//! Spec: docs/06-config-keybind.md. Decisions: C6 (schema from Rust types), H4 (no telemetry),
//! B3/B5 (`Auto<T>` settings), I6 (opaque window), K1 (history DB), K4 (workspace trust).
//!
//! Every struct derives `Serialize`, `Deserialize`, `JsonSchema` and `Default`.
//! Doc comments become the `description` in the generated JSON Schema, which the
//! settings UI renders. Attributes:
//!   - `#[schemars(extend("x-restart" = true))]`  — change needs a restart
//!   - `#[schemars(extend("x-i18n" = "key"))]`    — Fluent id for the label (defaults to the path)
//!   - `#[schemars(extend("x-advanced" = true))]` — hidden behind "Advanced" in the UI
//!   - `#[schemars(extend("x-hidden" = true))]`   — not in the UI: accepted, but nothing reads it yet
//!
//! TOML round-trips through `toml_edit` so comments and ordering survive GUI edits.

#![allow(dead_code)]

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// A setting that is either `"auto"` (derived from guide level / platform) or an explicit value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Auto<T> {
    Auto(AutoTag),
    Value(T),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AutoTag {
    Auto,
}

impl<T> Default for Auto<T> {
    fn default() -> Self {
        Auto::Auto(AutoTag::Auto)
    }
}

/// One key or several alternatives for the same action.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum OneOrMany<T> {
    One(T),
    Many(Vec<T>),
}

/// Key chord in otterm notation, e.g. `ctrl+shift+t`, `cmd+k cmd+s`.
pub type KeyChord = String;

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

/// User configuration (`config.toml`). Workspace files use [`WorkspaceConfig`].
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// Settings schema version, used for migrations. Do not edit by hand.
    #[schemars(extend("x-advanced" = true))]
    pub schema: u32,
    pub general: General,
    pub appearance: Appearance,
    pub font: Font,
    pub terminal: Terminal,
    pub shell: Shell,
    pub profiles: Vec<Profile>,
    pub mascot: Mascot,
    pub assist: Assist,
    pub open: Open,
    pub history: History,
    pub keybindings: Keybindings,
    pub mods: Mods,
    pub ai: Ai,
    pub accessibility: Accessibility,
}

pub const CURRENT_SCHEMA: u32 = 1;

// ---------------------------------------------------------------------------
// [general]
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct General {
    /// UI language. `auto` follows the OS.
    pub language: Language,
    /// How much otterm helps: 0 = off, 1 = light, 2 = standard, 3 = full.
    #[schemars(range(min = 0, max = 3))]
    pub guide_level: u8,
    /// Check for updates on startup. Asked during onboarding. The only network access
    /// otterm initiates on its own (decision H4; there is no telemetry setting because there is no telemetry).
    pub check_updates: bool,
    /// Update channel.
    pub update_channel: UpdateChannel,
    /// Reopen the tabs of the last run in their folders, with new shells. Splits are not restored.
    /// Shells the session daemon kept come back without this (`keep_sessions`).
    pub restore_session: bool,
    /// Keep the shells running in a background process (decision M26): `on-crash` keeps them when
    /// the window crashes or restarts for an update or a setting, `always` also when you close it,
    /// and the next window picks them up. `never` runs them inside the window, as before.
    #[schemars(extend("x-restart" = true))]
    pub keep_sessions: KeepSessions,
    /// Ask before closing a tab whose process is still running.
    pub confirm_close_running: bool,
    /// Remember window size and position per monitor (decision I7).
    pub remember_window: bool,
}

/// When the shells outlive the window (`general.keep_sessions`, decision M26).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum KeepSessions {
    /// Inside the window: closing or losing it ends the shells.
    Never,
    /// A crash or a restart (an update, a setting) keeps them; closing the window ends them.
    OnCrash,
    /// Closing the window keeps them too; the next window opens them again.
    Always,
}

impl Default for General {
    fn default() -> Self {
        Self {
            language: Language::Auto,
            guide_level: 2,
            check_updates: true,
            update_channel: UpdateChannel::Stable,
            restore_session: false,
            keep_sessions: KeepSessions::OnCrash,
            confirm_close_running: true,
            remember_window: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Auto,
    Ja,
    En,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Stable,
    Beta,
}

// ---------------------------------------------------------------------------
// [appearance]
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Appearance {
    /// Theme used in dark mode (or always, when `follow_system` is false).
    pub theme: String,
    /// Theme used in light mode when following the system.
    pub theme_light: String,
    /// Switch between `theme` and `theme_light` with the OS appearance.
    pub follow_system: bool,
    /// Text closer to its background than this WCAG contrast ratio is moved toward black or white
    /// until it reaches it (1 = off, 21 = black or white only). Keeps colors that programs chose for
    /// a dark background readable on a light theme, and the other way round.
    #[schemars(range(min = 1.0, max = 21.0))]
    pub minimum_contrast: f32,
    /// How the terminal grid is drawn (docs/02 §1.2). `auto` uses WebGL2 and falls back to Canvas 2D.
    /// Takes effect for panes opened after the change.
    pub renderer: RendererKind,
    /// Layout preset (`minimal`, `classic`, `guided`, `ide`, `cards`) or the name of a saved layout
    /// (`<config>/layouts/*.toml`). Settings below that are `auto` follow it (docs/04 §1.2).
    pub layout: String,
    /// UI scale factor (0.8–2.0) for tabs, panels and dialogs. The terminal text uses `font.size`.
    #[schemars(range(min = 0.8, max = 2.0))]
    pub ui_scale: f32,
    pub tabbar: Tabbar,
    pub sidebar: Sidebars,
    pub panel: Panels,
    pub statusbar: Statusbar,
    /// The input assist bar under the terminal (explanations, warnings). `auto` follows the layout.
    pub assist_bar: Auto<bool>,
    /// How command blocks look: `plain` (a gutter line) or `cards` (a framed card per block). `auto` follows the layout.
    pub blocks: Auto<BlockStyle>,
    /// Where each panel goes, by panel id: `sidebar.left`, `sidebar.right` or `panel.bottom`
    /// (set by dragging a panel's tab; docs/04 §1.1).
    pub panels: BTreeMap<String, String>,
    /// Load `<config>/user.css` after the theme (docs/04 §2.3).
    pub custom_css: bool,
    pub window: Window,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum BlockStyle {
    Plain,
    Cards,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum RendererKind {
    Auto,
    Webgl,
    Canvas,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            theme: "otterm Dark".into(),
            theme_light: "otterm Light".into(),
            follow_system: true,
            minimum_contrast: 1.0,
            renderer: RendererKind::Auto,
            layout: "guided".into(),
            ui_scale: 1.0,
            tabbar: Tabbar::default(),
            sidebar: Sidebars::default(),
            panel: Panels::default(),
            statusbar: Statusbar::default(),
            assist_bar: Auto::default(),
            blocks: Auto::default(),
            panels: BTreeMap::new(),
            custom_css: true,
            window: Window::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Tabbar {
    /// `auto` follows the layout.
    pub position: Auto<TabbarPosition>,
    /// Template for automatic tab titles. Variables: {cwd_name} {command} {profile} {title} (decision I10).
    pub title_idle: String,
    pub title_running: String,
}

impl Default for Tabbar {
    fn default() -> Self {
        Self {
            position: Auto::default(),
            title_idle: "{cwd_name}".into(),
            title_running: "{command} · {cwd_name}".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum TabbarPosition {
    Top,
    Bottom,
    Left,
    HiddenWhenSingle,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Sidebars {
    pub left: Sidebar,
    pub right: Sidebar,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Sidebar {
    /// `auto` follows the layout preset.
    pub visible: Auto<bool>,
    #[schemars(range(min = 160, max = 800))]
    pub width: u32,
}

impl Default for Sidebar {
    fn default() -> Self {
        Self { visible: Auto::default(), width: 260 }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Panels {
    pub bottom: Panel,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Panel {
    pub visible: Auto<bool>,
    #[schemars(range(min = 100, max = 800))]
    pub height: u32,
}

impl Default for Panel {
    fn default() -> Self {
        Self { visible: Auto::default(), height: 220 }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Statusbar {
    /// `auto` follows the layout.
    pub visible: Auto<bool>,
    /// Order of the items, by id (`otterm.folder`, `otterm.guide`, `otterm.exit`, `otterm.mods`,
    /// `<mod id>#<n>`). Set by dragging an item; items not listed keep their place after these.
    pub order: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Window {
    /// Window opacity. Default is fully opaque for readability and rendering performance (decision I6).
    #[schemars(range(min = 0.3, max = 1.0))]
    pub opacity: f32,
    /// Background blur behind a translucent window. Only meaningful when opacity < 1.
    pub blur: bool,
    /// Local image path. Themes may override.
    pub background_image: Option<String>,
    pub background_fit: BackgroundFit,
    /// How strongly the background image shows through the terminal background (0.05–1).
    #[schemars(range(min = 0.05, max = 1.0))]
    pub background_image_opacity: f32,
    /// Padding around the terminal grid, in CSS pixels.
    #[schemars(range(min = 0, max = 64))]
    pub padding: u32,
}

impl Default for Window {
    fn default() -> Self {
        Self {
            opacity: 1.0,
            blur: false,
            background_image: None,
            background_fit: BackgroundFit::Cover,
            background_image_opacity: 0.25,
            padding: 12,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum BackgroundFit {
    Cover,
    Contain,
    Tile,
    Center,
}

// ---------------------------------------------------------------------------
// [font]
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Font {
    /// Font families in fallback order. The bundled "Symbols Nerd Font Mono" is always appended (decision B14).
    pub family: Vec<String>,
    /// Size in CSS pixels; follows OS display scale (decision I9).
    #[schemars(range(min = 6.0, max = 72.0))]
    pub size: f32,
    #[schemars(range(min = 100, max = 900))]
    pub weight: u16,
    #[schemars(range(min = 100, max = 900))]
    pub weight_bold: u16,
    #[schemars(range(min = 0.8, max = 2.0))]
    pub line_height: f32,
    #[schemars(range(min = -2.0, max = 4.0))]
    pub letter_spacing: f32,
    pub ligatures: bool,
    /// CJK font family. `auto` picks the OS font (BIZ UDGothic / Hiragino / Noto Sans CJK; decision I8).
    pub cjk_family: Auto<String>,
    pub emoji_family: Auto<String>,
}

impl Default for Font {
    fn default() -> Self {
        Self {
            family: vec![], // empty = platform default (Cascadia Code / SF Mono / DejaVu Sans Mono)
            size: 14.0,
            weight: 400,
            weight_bold: 700,
            line_height: 1.2,
            letter_spacing: 0.0,
            ligatures: true,
            cjk_family: Auto::default(),
            emoji_family: Auto::default(),
        }
    }
}

// ---------------------------------------------------------------------------
// [terminal]
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Terminal {
    /// Lines kept per session. 0 = unlimited with disk spill.
    pub scrollback: u32,
    /// Total size cap for spilled scrollback (MB). Oldest is deleted first. Spill is removed on exit (decision K3).
    pub scrollback_spill_limit_mb: u32,
    pub cursor: Cursor,
    pub bell: Bell,
    pub copy_on_select: bool,
    pub trim_trailing_whitespace: bool,
    /// Confirm pastes containing a newline. `auto` = on at guide level >= 1 (decision B16).
    pub confirm_multiline_paste: Auto<bool>,
    /// Characters that break a word on double-click.
    pub word_separators: String,
    /// Width of East Asian Ambiguous characters.
    pub ambiguous_width: AmbiguousWidth,
    /// Allow applications to write the clipboard via OSC 52.
    pub osc52_clipboard: Permission,
    /// Inline images (Sixel / iTerm2 / Kitty). Not drawn yet.
    #[schemars(extend("x-hidden" = true))]
    pub images: bool,
    /// What happens when the shell exits.
    pub close_behavior: CloseBehavior,
    /// Right-click action. `auto` = context menu, except paste at guide level 0 (decision I1).
    pub right_click: Auto<RightClick>,
    /// Convert mouse wheel to arrow keys in the alternate screen when the app does not track the mouse (decision I5).
    pub wheel_to_arrows_in_alt_screen: bool,
    /// Enable the Kitty keyboard protocol when an application requests it (decision I3).
    pub kitty_keyboard: bool,
    /// Fold the middle of a command's output when it is longer than this many rows (docs/03 §6.3). 0 = never.
    pub fold_lines: u32,
}

impl Default for Terminal {
    fn default() -> Self {
        Self {
            scrollback: 10_000,
            scrollback_spill_limit_mb: 1024,
            cursor: Cursor::default(),
            bell: Bell::Visual,
            copy_on_select: false,
            trim_trailing_whitespace: true,
            confirm_multiline_paste: Auto::default(),
            word_separators: " \t\"'`()[]{}<>|&;".into(),
            ambiguous_width: AmbiguousWidth::Narrow,
            osc52_clipboard: Permission::Ask,
            images: true,
            close_behavior: CloseBehavior::Close,
            right_click: Auto::default(),
            wheel_to_arrows_in_alt_screen: true,
            kitty_keyboard: true,
            fold_lines: 200,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Cursor {
    pub style: CursorStyle,
    pub blink: bool,
    /// Animate cursor movement. Disabled automatically under OS "reduce motion".
    #[schemars(extend("x-hidden" = true))]
    pub smooth: bool,
}

impl Default for Cursor {
    fn default() -> Self {
        Self { style: CursorStyle::Block, blink: true, smooth: true }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum CursorStyle {
    Block,
    Underline,
    Bar,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Bell {
    None,
    Visual,
    Sound,
    Both,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AmbiguousWidth {
    Narrow,
    Wide,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Permission {
    Allow,
    Deny,
    Ask,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum CloseBehavior {
    Close,
    Keep,
    Restart,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RightClick {
    ContextMenu,
    Paste,
    CopyOrPaste,
}

// ---------------------------------------------------------------------------
// [accessibility]  (docs/04 §4, §5)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Accessibility {
    /// Read new terminal output aloud through a screen reader (an ARIA live region).
    pub screen_reader: bool,
    /// Turn off animations and transitions. `auto` follows the OS "reduce motion" setting.
    pub reduce_motion: Auto<bool>,
    /// Use the High Contrast theme. `auto` switches while the OS high-contrast mode is on (decision I15).
    pub high_contrast: Auto<bool>,
}

// ---------------------------------------------------------------------------
// [shell] and [[profiles]]
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Shell {
    /// Profile id used for new tabs. Empty = platform recommendation.
    pub default_profile: String,
    /// Enable shell integration (blocks, cwd tracking, input line).
    pub integration: bool,
    /// How integration hooks are loaded (decision B6). `args` touches no user files.
    #[schemars(extend("x-hidden" = true))]
    pub integration_install: IntegrationInstall,
    /// Who draws the prompt (decision M4). Needs `integration`.
    pub prompt: PromptStyle,
    /// Load the shell's own startup files: the PowerShell profile, ~/.bashrc, ~/.zshrc,
    /// config.fish, cmd's AutoRun (decision M24, on by default since 1.2.0). Off: the shell starts as
    /// installed, without your aliases, prompt theme or PATH changes.
    pub user_startup_files: bool,
}

impl Default for Shell {
    fn default() -> Self {
        Self {
            default_profile: String::new(),
            integration: true,
            integration_install: IntegrationInstall::Args,
            prompt: PromptStyle::Otterm,
            user_startup_files: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PromptStyle {
    /// otterm draws a bar with the folder and the Git branch; the shell prints only `❯`.
    Otterm,
    /// The shell's own prompt (oh-my-posh, starship and the like).
    Shell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum IntegrationInstall {
    /// Inject via shell startup arguments (default).
    Args,
    /// One-line include appended to the user's rc file (opt-in).
    Rc,
    /// User manages it.
    Manual,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Profile {
    /// Stable identifier referenced by `shell.default_profile` and workspaces.
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    /// Starting directory. Empty = inherit / home.
    pub cwd: Option<String>,
    pub env: BTreeMap<String, String>,
    pub icon: Option<String>,
    /// Tab accent color (#rrggbb).
    #[schemars(regex(pattern = r"^#[0-9a-fA-F]{6}$"))]
    pub color: Option<String>,
    /// Detected automatically when omitted.
    pub shell_kind: Option<ShellKind>,
    /// Hide from the new-tab menu without deleting.
    pub hidden: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ShellKind {
    Bash,
    Zsh,
    Fish,
    Pwsh,
    Powershell,
    Cmd,
    Nushell,
    Other,
}

// ---------------------------------------------------------------------------
// [mascot]
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Mascot {
    /// Show Kotsume / Pebble. `auto` follows guide level (hidden at 0).
    pub visible: Auto<bool>,
    /// Where the mascot lives (decision E4). Falls back to the status bar when the layout has no assist bar.
    pub position: MascotPosition,
    /// Speech bubbles. `auto` follows guide level.
    pub speech: Auto<Speech>,
    pub mood_changes: bool,
    /// Celebrate only when a successful command took at least this long (ms).
    pub happy_threshold_ms: u32,
    /// Outfit id from installed outfit mods.
    pub outfit: String,
}

impl Default for Mascot {
    fn default() -> Self {
        Self {
            visible: Auto::default(),
            position: MascotPosition::AssistBar,
            speech: Auto::default(),
            mood_changes: true,
            happy_threshold_ms: 10_000,
            outfit: "default".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum MascotPosition {
    AssistBar,
    Statusbar,
    Float,
    Hidden,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Speech {
    Always,
    AlertOnly,
    Never,
}

// ---------------------------------------------------------------------------
// [assist]
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Assist {
    /// Command explanation bar. `auto` follows guide level.
    pub explain: Auto<Explain>,
    pub completion: bool,
    /// Key that accepts otterm completions. `auto` = ctrl+space, or tab at guide level 3 (decision B3).
    pub completion_key: Auto<CompletionKey>,
    /// Who handles Ctrl+R. `auto` = otterm at guide level >= 1 (decision B5).
    pub history_key: Auto<HistoryKey>,
    pub danger_guard: bool,
    pub error_hint: bool,
    /// Show "this did the same as `cmd`" hints after GUI file operations. `auto` follows guide level.
    pub learn_hints: Auto<bool>,
    /// After a command the dictionary does not know ran, run `<command> --help` once in the
    /// background and keep its options for the explanations (decision B9). Only while the
    /// explanation mod (`otterm.cmd-explain`) is on; off, otterm never starts a program by itself.
    pub learn_help: bool,
    /// Send `cd` to the shell when a folder is opened in the file tree. `auto` = on at guide level >= 2 (decision B10).
    /// The file tree mod has its own `cd_on_open` setting for now.
    #[schemars(extend("x-hidden" = true))]
    pub file_tree_cd: Auto<bool>,
}

impl Default for Assist {
    fn default() -> Self {
        Self {
            explain: Auto::default(),
            completion: true,
            completion_key: Auto::default(),
            history_key: Auto::default(),
            danger_guard: true,
            error_hint: true,
            learn_hints: Auto::default(),
            learn_help: true,
            file_tree_cd: Auto::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Explain {
    Off,
    DangerOnly,
    Always,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum CompletionKey {
    CtrlSpace,
    Tab,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum HistoryKey {
    Otterm,
    Shell,
}

// ---------------------------------------------------------------------------
// [open]
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Open {
    /// Editor preset id (`code`, `cursor`, `zed`, `nvim`, ...) or `custom`. Empty = auto-detect (decision I16).
    pub editor: String,
    /// Used when `editor = "custom"`. Variables: {path} {line} {col}.
    pub editor_template: Option<String>,
    /// Extension → action. Actions: `editor`, `preview`, `system`.
    pub rules: BTreeMap<String, OpenAction>,
    /// Preview size limits in MB (decision G4).
    #[schemars(extend("x-hidden" = true))]
    pub preview_text_limit_mb: u32,
    #[schemars(extend("x-hidden" = true))]
    pub preview_image_limit_mb: u32,
}

impl Default for Open {
    fn default() -> Self {
        let mut rules = BTreeMap::new();
        rules.insert(".md".into(), OpenAction::Preview);
        rules.insert(".png".into(), OpenAction::Preview);
        rules.insert(".jpg".into(), OpenAction::Preview);
        rules.insert(".pdf".into(), OpenAction::System);
        Self {
            editor: String::new(),
            editor_template: None,
            rules,
            preview_text_limit_mb: 1,
            preview_image_limit_mb: 20,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum OpenAction {
    Editor,
    Preview,
    System,
}

// ---------------------------------------------------------------------------
// [history]  (decision K1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct History {
    /// Record executed commands (command, cwd, exit code, timing) in a local SQLite database.
    pub enabled: bool,
    /// Days to keep. 0 = forever.
    pub retention_days: u32,
    /// Redact secret-looking arguments before storing (same patterns as AI redaction).
    pub redact_secrets: bool,
}

impl Default for History {
    fn default() -> Self {
        Self { enabled: true, retention_days: 90, redact_secrets: true }
    }
}

// ---------------------------------------------------------------------------
// [keybindings]
// ---------------------------------------------------------------------------

/// `bindings` overrides default keys per action id; `custom` adds bindings with args and `when` clauses.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Keybindings {
    /// Action id → key(s). An empty array unbinds the action.
    pub bindings: BTreeMap<String, OneOrMany<KeyChord>>,
    pub custom: Vec<CustomBinding>,
    /// Let TUI apps receive keys that otterm would otherwise handle while the alternate screen is active.
    pub alt_screen_passthrough: bool,
}

impl Default for Keybindings {
    fn default() -> Self {
        Self { bindings: BTreeMap::new(), custom: Vec::new(), alt_screen_passthrough: true }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct CustomBinding {
    pub key: KeyChord,
    pub command: String,
    #[schemars(with = "BTreeMap<String, serde_json::Value>")]
    pub args: BTreeMap<String, toml::Value>,
    /// e.g. `terminalFocus && !altScreen`
    pub when: Option<String>,
}

// ---------------------------------------------------------------------------
// [mods]
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Mods {
    pub enabled: Vec<String>,
    pub disabled: Vec<String>,
    /// Install updates without asking.
    #[schemars(extend("x-hidden" = true))]
    pub auto_update: bool,
    /// Show per-mod logs, timings and API calls in Settings.
    pub developer_mode: bool,
    /// The registry index (docs/05 §7.2): an https URL, or a local path for a registry checkout.
    /// Unset means the official registry.
    #[schemars(extend("x-advanced" = true))]
    pub registry: Option<String>,
    /// Per-mod settings, validated against each mod's `[settings.schema]` at load time.
    #[schemars(with = "BTreeMap<String, BTreeMap<String, serde_json::Value>>")]
    pub settings: BTreeMap<String, BTreeMap<String, toml::Value>>,
}

// ---------------------------------------------------------------------------
// [ai]  (official mod otterm.ai-assist; stored here so the settings UI can show it even when the mod is off)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Ai {
    /// Master switch. Off by default; asked at the end of onboarding.
    pub enabled: bool,
    pub provider: AiProvider,
    /// Base URL for `local` (Ollama) or `openai-compatible`.
    pub endpoint: Option<String>,
    /// Model id for the chosen provider.
    pub model: Option<String>,
    /// API keys are stored in the OS keychain, never in this file. This holds only the keychain entry name.
    #[schemars(extend("x-advanced" = true))]
    pub key_ref: Option<String>,
    /// Show the full request before sending: every time with 0 (the default), or only for the
    /// first N requests and then as a link (docs/10 §4.3).
    pub preview_first_n: u32,
    pub redact_secrets: bool,
    /// Keep a local log of requests and responses (days). 0 = off.
    pub log_retention_days: u32,
    /// Include the last 5 command strings as context.
    #[schemars(extend("x-hidden" = true))]
    pub include_recent_commands: bool,
    /// Allow the `?` prefix in the input line to ask (off: dedicated key / mascot click only; decision F1).
    pub question_prefix: bool,
}

impl Default for Ai {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: AiProvider::Local,
            endpoint: None,
            model: None,
            key_ref: None,
            preview_first_n: 0,
            redact_secrets: true,
            log_retention_days: 30,
            include_recent_commands: true,
            question_prefix: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum AiProvider {
    Local,
    Claude,
    Openai,
    Gemini,
    OpenaiCompatible,
}

// ---------------------------------------------------------------------------
// Workspace file (.otterm/workspace.toml)  — separate from user config (decision K4 for trust)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct WorkspaceConfig {
    pub name: Option<String>,
    /// Root relative to the workspace file. Default ".".
    pub cwd: Option<String>,
    /// Tabs to open. `command` runs only after the user trusts the workspace.
    pub tabs: Vec<WorkspaceTab>,
    /// Mods to enable for this workspace (never `terminal.write` mods). Enabled only after trust.
    pub mods: Vec<String>,
    /// Theme name override.
    pub theme: Option<String>,
    /// Mascot outfit override.
    pub outfit: Option<String>,
    /// Settings overrides. Keys are dotted paths into [`Config`]; unknown or forbidden keys are ignored with a warning.
    #[schemars(with = "BTreeMap<String, serde_json::Value>")]
    pub settings: BTreeMap<String, toml::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct WorkspaceTab {
    pub name: Option<String>,
    pub profile: Option<String>,
    pub cwd: Option<String>,
    /// Command typed into the tab after the shell starts. Requires workspace trust.
    pub command: Option<String>,
}

// ---------------------------------------------------------------------------
// Resolution of `Auto<T>` against guide level / platform
// ---------------------------------------------------------------------------

/// Effective values derived from [`Config`] plus runtime facts. The UI and mods read these, never raw `Auto`.
pub struct Effective {
    pub completion_key: CompletionKey,
    pub history_key: HistoryKey,
    pub confirm_multiline_paste: bool,
    pub right_click: RightClick,
    pub mascot_visible: bool,
    pub speech: Speech,
    pub explain: Explain,
    pub learn_hints: bool,
    pub file_tree_cd: bool,
}

fn pick<T: Copy>(a: &Auto<T>, auto: T) -> T {
    match a {
        Auto::Value(v) => *v,
        Auto::Auto(_) => auto,
    }
}

impl Effective {
    pub fn resolve(cfg: &Config) -> Self {
        let lv = cfg.general.guide_level;
        Self {
            completion_key: pick(
                &cfg.assist.completion_key,
                if lv >= 3 { CompletionKey::Tab } else { CompletionKey::CtrlSpace },
            ),
            history_key: pick(&cfg.assist.history_key, if lv >= 1 { HistoryKey::Otterm } else { HistoryKey::Shell }),
            confirm_multiline_paste: pick(&cfg.terminal.confirm_multiline_paste, lv >= 1),
            right_click: pick(
                &cfg.terminal.right_click,
                if lv == 0 { RightClick::Paste } else { RightClick::ContextMenu },
            ),
            mascot_visible: pick(&cfg.mascot.visible, lv >= 1),
            speech: pick(
                &cfg.mascot.speech,
                match lv {
                    0 => Speech::Never,
                    1 => Speech::AlertOnly,
                    _ => Speech::Always,
                },
            ),
            explain: pick(
                &cfg.assist.explain,
                match lv {
                    0 => Explain::Off,
                    1 => Explain::DangerOnly,
                    _ => Explain::Always,
                },
            ),
            learn_hints: pick(&cfg.assist.learn_hints, lv >= 2),
            file_tree_cd: pick(&cfg.assist.file_tree_cd, lv >= 2),
        }
    }
}
