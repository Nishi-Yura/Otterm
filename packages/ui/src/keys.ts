/**
 * Which key presses go to the terminal. The bytes themselves are encoded in Rust for the terminal's
 * current modes (crates/otterm-vt/src/input.rs); this only decides what the UI keeps for itself.
 */

export interface KeyInput {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "NumLock", "ScrollLock", "OS"]);

export const platform = /Mac/.test(navigator.userAgent)
  ? "macos"
  : /Windows/.test(navigator.userAgent)
    ? "windows"
    : "linux";

/** The paste shortcut (decision B4): Ctrl+V on Windows, Cmd+V on macOS, Ctrl+Shift+V on Linux. */
export function isPasteShortcut(e: KeyboardEvent): boolean {
  // Shift+Insert, the old CUA paste key, everywhere but macOS.
  if (platform !== "macos" && e.key === "Insert" && e.shiftKey && !e.ctrlKey && !e.altKey) return true;
  const v = e.key.toLowerCase() === "v";
  if (platform === "macos") return v && e.metaKey && !e.ctrlKey;
  if (platform === "windows") return v && e.ctrlKey && !e.altKey;
  return v && e.ctrlKey && e.shiftKey && !e.altKey;
}

export type Dir = "left" | "right" | "up" | "down";

/** Window-level actions on tabs and panes; keys for them are in keymap.ts. */
export type AppAction =
  | { kind: "newTab" }
  | { kind: "newTabMenu" }
  | { kind: "closeTab" }
  | { kind: "nextTab" }
  | { kind: "prevTab" }
  | { kind: "gotoTab"; index: number }
  | { kind: "split"; dir: "row" | "column" }
  | { kind: "focusPane"; dir: Dir }
  | { kind: "resizePane"; dir: Dir }
  | { kind: "zoomPane" }
  | { kind: "closePane" }
  | { kind: "fullscreen" }
  | { kind: "settings" }
  /** The command palette (docs/03 §7). */
  | { kind: "palette" }
  /** otterm's history UI (docs/03 §8.5, decision B5). */
  | { kind: "history" }
  /** Open or step the completion popup (docs/03 §8.2). */
  | { kind: "completion" }
  /** The multi-line editor (docs/03 §8.6). */
  | { kind: "multiline" }
  /** Scroll to the previous (-1) or next (1) block (docs/03 §6.3). */
  | { kind: "blockJump"; dir: -1 | 1 }
  /** Fold or show the output of the newest finished block. */
  | { kind: "blockFold" }
  /** Show or hide a panel area (docs/06 §5.2). */
  | { kind: "togglePanel"; slot: "sidebar.left" | "sidebar.right" | "panel.bottom" }
  /** Move the keyboard to the next part of the window (F6). */
  | { kind: "focusRegion"; dir: 1 | -1 }
  /** Copy or paste the selection / clipboard (docs/06 §5.2). */
  | { kind: "copy" }
  | { kind: "paste" }
  /** Open the search bar. */
  | { kind: "search" }
  /** Font size: 1 bigger, -1 smaller, 0 reset. */
  | { kind: "font"; step: 1 | -1 | 0 }
  /** Ask the AI mod (docs/06 §5.2). */
  | { kind: "aiAsk" }
  | { kind: "mascotToggle" }
  /** Guide help mode (F1). */
  | { kind: "helpMode" }
  /** Pass Ctrl+L through to the shell and keep the scrollback. */
  | { kind: "clear" };

/** Scrollback keys: Shift+PageUp/PageDown by a page, Ctrl+Shift+Home/End to the top / bottom. */
export function scrollKey(e: KeyboardEvent, rows: number): number | "top" | "bottom" | undefined {
  if (!e.shiftKey || e.altKey || e.metaKey) return undefined;
  if (!e.ctrlKey && e.key === "PageUp") return Math.max(1, rows - 1);
  if (!e.ctrlKey && e.key === "PageDown") return -Math.max(1, rows - 1);
  if (e.ctrlKey && e.key === "Home") return "top";
  if (e.ctrlKey && e.key === "End") return "bottom";
  return undefined;
}

/**
 * The key to send, or `undefined` to leave the event to the browser (IME composition, modifiers on
 * their own, macOS Cmd shortcuts, paste).
 */
export function terminalKey(e: KeyboardEvent): KeyInput | undefined {
  // IME: the composed text arrives through the input event when it is committed (decision I4).
  if (e.isComposing || e.key === "Process" || e.keyCode === 229) return undefined;
  if (MODIFIERS.has(e.key) || e.key === "Unidentified" || e.key === "Dead") return undefined;
  if (e.metaKey) return undefined;
  if (isPasteShortcut(e)) return undefined;
  // AltGr on Windows reports Ctrl+Alt; the character it produced is what the user meant.
  const altGraph = e.getModifierState("AltGraph");
  return {
    key: e.key,
    ctrl: e.ctrlKey && !altGraph,
    alt: e.altKey && !altGraph,
    shift: e.shiftKey,
  };
}
