import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors `UiConfig` in crates/otterm-app/src/config.rs. */
export interface UiConfig {
  language: "auto" | "ja" | "en";
  font: {
    /** CSS font-family list with the fallbacks already appended. */
    family: string;
    /** The same families as names, in fallback order (for the Rust rasterizer). */
    families: string[];
    size: number;
    lineHeight: number;
    letterSpacing: number;
    weight: number;
    weightBold: number;
    /** `font.ligatures`. */
    ligatures: boolean;
  };
  theme: {
    name: string;
    appearance: "light" | "dark";
    terminal: {
      foreground: string;
      background: string;
      cursor: string;
      selection: string;
      ansi: string[];
      bright: string[];
    };
    ui: Record<string, string>;
    /** Window look the theme brings (already merged into `window` by Rust). */
    window?: Record<string, unknown>;
    /** Style overrides of the theme (docs/04 §2.3). */
    css?: { file?: string; text?: string };
  };
  /** The light-mode theme, used while the OS is light and `followSystem` is on. */
  themeLight: UiConfig["theme"] | null;
  followSystem: boolean;
  /** Text below this contrast with its background is made readable; 1 is off. */
  minimumContrast: number;
  /** `appearance.renderer`; read when a pane opens. */
  renderer: "auto" | "webgl" | "canvas";
  /** Space around the terminal grid in CSS pixels. */
  padding: number;
  /** Tab accent colors (`#rrggbb`) by profile id. */
  profileColors: Record<string, string>;
  /** The profile new tabs run when none is picked; empty for the platform shell. */
  defaultProfile: string;
  /** Where the tab bar is, the layout resolved. */
  tabbar: "top" | "bottom" | "left" | "hidden-when-single";
  /** The layout with its `auto` settings resolved (docs/04 §1.2). */
  layout: Layout;
  /** `appearance.ui_scale`. */
  uiScale: number;
  /** Left and right side panel widths and the bottom panel's height, CSS pixels. */
  panelSizes: [number, number, number];
  window: {
    opacity: number;
    blur: boolean;
    backgroundImage: string | null;
    backgroundFit: "cover" | "contain" | "tile" | "center";
    backgroundImageOpacity: number;
  };
  /** `<config>/user.css` (empty when off or missing). */
  userCss: string;
  accessibility: {
    screenReader: boolean;
    /** `null` follows the OS. */
    reduceMotion: boolean | null;
    /** `null` follows the OS. */
    highContrast: boolean | null;
  };
  themeHighContrast: UiConfig["theme"] | null;
  /** Set by the UI, not Rust: the alpha of the terminal's default background. */
  terminalAlpha?: number;
  /** Automatic tab title templates (decision I10): `{cwd_name}` `{command}` `{profile}` `{title}`. */
  tabTitleIdle: string;
  tabTitleRunning: string;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  copyOnSelect: boolean;
  wordSeparators: string;
  keybindings: Record<string, string[]>;
  /** `[[keybindings.custom]]`: keys with a command, its arguments and a `when` condition. */
  customKeys: { key: string; command: string; args: Record<string, unknown>; when?: string }[];
  /** `.otterm/workspace.toml` above the folder otterm opened in (docs/06 §1). */
  workspace: UiWorkspace | null;
  /** `general.check_updates` (decision K5). */
  checkUpdates: boolean;
  /** `[ai] question_prefix` (decision F1). */
  aiQuestionPrefix: boolean;
  /** `[mascot]`, resolved against the guide level (docs/08 §4.3). */
  mascot: {
    visible: boolean;
    position: "assist-bar" | "statusbar" | "float" | "hidden";
    speech: "always" | "alert-only" | "never";
    speechAuto: boolean;
    moodChanges: boolean;
    happyThresholdMs: number;
    outfit: string;
  };
  altScreenPassthrough: boolean;
  confirmMultilinePaste: boolean;
  rightClick: "context-menu" | "paste" | "copy-or-paste";
  osc52Clipboard: "allow" | "deny" | "ask";
  bell: "none" | "visual" | "sound" | "both";
  confirmCloseRunning: boolean;
  /** When the shell exits: close the pane, keep it with the exit message, or start a new shell. */
  closeBehavior: "close" | "keep" | "restart";
  /** `general.guide_level`, 0 to 3 (docs/03 §11.2). */
  guideLevel: 0 | 1 | 2 | 3;
  /** `[assist]` with `auto` resolved against the guide level. */
  assist: {
    explain: "off" | "danger-only" | "always";
    completion: boolean;
    completionKey: "ctrl-space" | "tab";
    historyKey: "otterm" | "shell";
    dangerGuard: boolean;
    errorHint: boolean;
    learnHints: boolean;
    /** `assist.learn_help`: read `--help` of unknown commands in the background (decision B9). */
    learnHelp: boolean;
  };
  /** Whether the status bar shows, the layout resolved. */
  statusbar: boolean;
  /** `appearance.statusbar.order`: item ids in the order the user dragged them. */
  statusbarOrder: string[];
  /** `[mods] developer_mode`: logs and timings per mod. */
  developerMode: boolean;
  /** Started with `--safe-mode` (docs/04 §2.3): default theme, no CSS overrides, no mods. */
  safeMode: boolean;
  /** Where installed mods live, to tell the user. */
  modsDir: string | null;
  warnings: { key: string; message: string }[];
  configPath: string | null;
}

/** Mirrors `otterm_config::Layout`. */
export interface Layout {
  name: string;
  tabbar: UiConfig["tabbar"];
  sidebar_left: boolean;
  sidebar_right: boolean;
  panel_bottom: boolean;
  statusbar: boolean;
  assist_bar: boolean;
  blocks: "plain" | "cards";
  panels?: Record<string, string>;
}

export const loadConfig = () => invoke<UiConfig>("config_get");

/** Called with the new configuration whenever config.toml changes. */
export const onConfigChanged = (f: (c: UiConfig) => void): Promise<UnlistenFn> =>
  listen<UiConfig>("config-changed", (e) => f(e.payload));

/** `#rrggbb` mixed with another color: `w` of `a`. */
export function mix(a: string, b: string, w: number): string {
  const p = (c: string) => {
    const n = Number.parseInt(c.slice(1, 7), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) return a;
  const [x, y] = [p(a), p(b)];
  return `#${x
    .map((v, i) =>
      Math.round(v * w + (y[i] ?? 0) * (1 - w))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** The UI tokens of docs/04 §2.1 that every theme has; the rest are optional. */
export const UI_TOKENS = [
  "bg",
  "bg-elevated",
  "fg",
  "fg-muted",
  "accent",
  "border",
  "danger",
  "success",
  "warning",
  "radius",
  "shadow",
  "font-ui",
] as const;

/** A theme's UI tokens: its own `[theme.ui]`, and the rest derived from the terminal colors. */
export function uiTokens(theme: UiConfig["theme"]): Record<string, string> {
  const t = theme.terminal;
  const dark = theme.appearance === "dark";
  const derived: Record<string, string> = {
    bg: t.background,
    "bg-elevated": mix(t.foreground, t.background, dark ? 0.08 : 0.05),
    fg: t.foreground,
    "fg-muted": mix(t.foreground, t.background, 0.6),
    accent: t.ansi[4] ?? "#4f8cff",
    border: mix(t.foreground, t.background, 0.14),
    danger: t.ansi[1] ?? "#e06c75",
    success: t.ansi[2] ?? "#98c379",
    warning: t.ansi[3] ?? "#e5c07b",
    radius: "6px",
    shadow: dark ? "0 4px 16px rgb(0 0 0 / 0.4)" : "0 4px 16px rgb(0 0 0 / 0.15)",
    "font-ui": 'system-ui, "Segoe UI", "Noto Sans JP", sans-serif',
  };
  return { ...derived, ...(theme.ui ?? {}) };
}

/** Custom properties set by the last call, to clear the ones a new theme lacks. */
let setKeys = new Set<string>();

/** Expose the theme's colors to CSS (docs/04 §2.2): `--ot-<ui key>` and `--ot-term-*`. */
export function applyThemeCss(theme: UiConfig["theme"]): void {
  const style = document.documentElement.style;
  const t = theme.terminal;
  const next = new Map<string, string>();
  next.set("--ot-term-bg", t.background);
  next.set("--ot-term-fg", t.foreground);
  next.set("--ot-term-cursor", t.cursor);
  next.set("--ot-term-selection", t.selection);
  for (const [i, c] of t.ansi.entries()) next.set(`--ot-term-ansi-${i}`, c);
  for (const [i, c] of t.bright.entries()) next.set(`--ot-term-bright-${i}`, c);
  for (const [k, v] of Object.entries(uiTokens(theme))) next.set(`--ot-${k}`, v);
  for (const k of setKeys) if (!next.has(k)) style.removeProperty(k);
  for (const [k, v] of next) style.setProperty(k, v);
  setKeys = new Set(next.keys());
  style.setProperty("color-scheme", theme.appearance);
  setStyleSheet("ot-theme-css", theme.css?.text ?? "");
}

/** A `<style>` element by id, created at the end of `<head>` so it wins over the bundled CSS. */
export function setStyleSheet(id: string, css: string): void {
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = id;
  }
  // Theme CSS first, the user's after it (docs/04 §2.3).
  if (id === "ot-theme-css") document.head.insertBefore(el, document.getElementById("ot-user-css"));
  else document.head.append(el);
  if (el.textContent !== css) el.textContent = css;
}

let backgroundUrl: { path: string; url: string } | undefined;

/**
 * The window around the UI: translucency, the background image, UI scale and reduced motion.
 * Returns the alpha the terminal's default background should have (0 when the window shows through).
 */
export async function applyWindow(c: UiConfig, osReduceMotion: boolean): Promise<number> {
  const root = document.documentElement;
  const w = c.window;
  const image = w.backgroundImage;
  const translucent = w.opacity < 1 || !!image;
  root.classList.toggle("translucent", translucent);
  root.style.setProperty("--ot-window-alpha", String(w.opacity));
  root.style.setProperty("--ot-ui-scale", String(c.uiScale));
  const [left, right, bottom] = c.panelSizes;
  root.style.setProperty("--ot-sidebar-left-width", `${left}px`);
  root.style.setProperty("--ot-sidebar-right-width", `${right}px`);
  root.style.setProperty("--ot-panel-bottom-height", `${bottom}px`);
  const reduce = c.accessibility.reduceMotion ?? osReduceMotion;
  root.classList.toggle("reduce-motion", reduce);
  root.classList.toggle("allow-motion", c.accessibility.reduceMotion === false);
  setStyleSheet("ot-user-css", c.userCss);
  if (image) {
    if (backgroundUrl?.path !== image) {
      const bytes = await invoke<ArrayBuffer>("background_image_get").catch(() => undefined);
      if (backgroundUrl) URL.revokeObjectURL(backgroundUrl.url);
      backgroundUrl = bytes ? { path: image, url: URL.createObjectURL(new Blob([bytes])) } : undefined;
    }
    const fit = w.backgroundFit;
    root.style.setProperty("--ot-bg-image", backgroundUrl ? `url("${backgroundUrl.url}")` : "none");
    root.style.setProperty("--ot-bg-size", fit === "tile" ? "auto" : fit === "center" ? "auto" : fit);
    root.style.setProperty("--ot-bg-repeat", fit === "tile" ? "repeat" : "no-repeat");
  } else {
    root.style.setProperty("--ot-bg-image", "none");
    if (backgroundUrl) URL.revokeObjectURL(backgroundUrl.url);
    backgroundUrl = undefined;
  }
  // One layer carries the tint: the window's own background (a veil of the theme color over the
  // image, if any). The terminal then draws no default background, or the tint would stack.
  const veil = image ? (1 - w.backgroundImageOpacity) * w.opacity : 0;
  root.style.setProperty("--ot-bg-veil", `${Math.round(veil * 100)}%`);
  return translucent ? 0 : 1;
}

/** A workspace file and its trust (decision K4). */
export interface UiWorkspace {
  name: string;
  root: string;
  /** null until the user answered the trust question. */
  trusted: boolean | null;
  /** It has tab commands, mods or settings that wait for trust. */
  gated: boolean;
  tabs: number;
}
