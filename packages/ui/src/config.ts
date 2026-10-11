import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Mirrors `UiConfig` in crates/otterm-app/src/config.rs. */
export interface UiConfig {
  language: "auto" | "ja" | "en";
  font: {
    /** CSS font-family list with the fallbacks already appended. */
    family: string;
    size: number;
    lineHeight: number;
    letterSpacing: number;
    weight: number;
    weightBold: number;
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
  };
  /** The light-mode theme, used while the OS is light and `followSystem` is on. */
  themeLight: UiConfig["theme"] | null;
  followSystem: boolean;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  copyOnSelect: boolean;
  wordSeparators: string;
  keybindings: Record<string, string[]>;
  altScreenPassthrough: boolean;
  confirmMultilinePaste: boolean;
  rightClick: "context-menu" | "paste" | "copy-or-paste";
  osc52Clipboard: "allow" | "deny" | "ask";
  bell: "none" | "visual" | "sound" | "both";
  confirmCloseRunning: boolean;
  /** When the shell exits: close the pane, keep it with the exit message, or start a new shell. */
  closeBehavior: "close" | "keep" | "restart";
  warnings: { key: string; message: string }[];
  configPath: string | null;
}

export const loadConfig = () => invoke<UiConfig>("config_get");

/** Called with the new configuration whenever config.toml changes. */
export const onConfigChanged = (f: (c: UiConfig) => void): Promise<UnlistenFn> =>
  listen<UiConfig>("config-changed", (e) => f(e.payload));

/** Expose the theme's colors to CSS (docs/04 §2.2): `--ot-<ui key>` and `--ot-term-*`. */
export function applyThemeCss(theme: UiConfig["theme"]): void {
  const style = document.documentElement.style;
  const t = theme.terminal;
  style.setProperty("--bg", t.background);
  style.setProperty("--fg", t.foreground);
  style.setProperty("color-scheme", theme.appearance);
  for (const [i, c] of t.ansi.entries()) style.setProperty(`--ot-term-ansi-${i}`, c);
  for (const [i, c] of t.bright.entries()) style.setProperty(`--ot-term-bright-${i}`, c);
  for (const [k, v] of Object.entries(theme.ui)) style.setProperty(`--ot-${k}`, v);
}
