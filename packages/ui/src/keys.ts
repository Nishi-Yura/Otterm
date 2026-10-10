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
  const v = e.key.toLowerCase() === "v";
  if (platform === "macos") return v && e.metaKey && !e.ctrlKey;
  if (platform === "windows") return v && e.ctrlKey && !e.altKey;
  return v && e.ctrlKey && e.shiftKey && !e.altKey;
}

/**
 * The copy shortcut (decision B4): Cmd+C on macOS, Ctrl+Shift+C on Linux and Windows, and on
 * Windows also Ctrl+C while there is a selection (without one, Ctrl+C stays SIGINT).
 */
export function isCopyShortcut(e: KeyboardEvent, hasSelection: boolean): boolean {
  if (e.key.toLowerCase() !== "c" || e.altKey) return false;
  if (platform === "macos") return e.metaKey && !e.ctrlKey;
  if (e.ctrlKey && e.shiftKey) return true;
  return platform === "windows" && e.ctrlKey && hasSelection;
}

/** Open the search bar (docs/06 §5.2): Ctrl+Shift+F, Cmd+F on macOS. */
export function isSearchShortcut(e: KeyboardEvent): boolean {
  if (e.key.toLowerCase() !== "f" || e.altKey) return false;
  return platform === "macos" ? e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey && !e.metaKey;
}

export type Dir = "left" | "right" | "up" | "down";

/** Window-level actions on tabs and panes. */
export type AppAction =
  | { kind: "newTab" }
  | { kind: "closeTab" }
  | { kind: "nextTab" }
  | { kind: "prevTab" }
  | { kind: "gotoTab"; index: number }
  | { kind: "split"; dir: "row" | "column" }
  | { kind: "focusPane"; dir: Dir }
  | { kind: "resizePane"; dir: Dir }
  | { kind: "zoomPane" }
  | { kind: "closePane" };

const ARROWS: Record<string, Dir> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

/**
 * Tab and pane shortcuts (docs/03 §3.2, docs/06 §5.2; macOS per decision I14). Splits: "vertical"
 * (Ctrl+Shift+D) puts the new pane beside the current one, "horizontal" (Ctrl+Shift+E) below it.
 */
export function appAction(e: KeyboardEvent): AppAction | undefined {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const arrow = ARROWS[e.key];
  if (e.ctrlKey && !e.altKey && !e.metaKey && key === "Tab") return { kind: e.shiftKey ? "prevTab" : "nextTab" };
  if (platform === "macos") {
    if (!e.metaKey || e.ctrlKey) return undefined;
    if (arrow && e.altKey && !e.shiftKey) return { kind: "focusPane", dir: arrow };
    if (e.altKey) return undefined;
    if (key === "t" && !e.shiftKey) return { kind: "newTab" };
    if (key === "w" && !e.shiftKey) return { kind: "closePane" };
    if (key === "d") return { kind: "split", dir: e.shiftKey ? "column" : "row" };
    if (/^[1-9]$/.test(key) && !e.shiftKey) return { kind: "gotoTab", index: Number(key) - 1 };
    return undefined;
  }
  if (arrow && e.altKey && !e.ctrlKey && !e.metaKey) {
    return e.shiftKey ? { kind: "resizePane", dir: arrow } : { kind: "focusPane", dir: arrow };
  }
  if (!e.ctrlKey || e.altKey || e.metaKey) return undefined;
  if (/^[1-9]$/.test(key) && !e.shiftKey) return { kind: "gotoTab", index: Number(key) - 1 };
  if (!e.shiftKey) return undefined;
  // With Shift, e.key is upper case ("T"); `key` is lowered above.
  switch (key) {
    case "t":
      return { kind: "newTab" };
    case "w":
      return { kind: "closeTab" };
    case "d":
      return { kind: "split", dir: "row" };
    case "e":
      return { kind: "split", dir: "column" };
    case "z":
      return { kind: "zoomPane" };
    case "q":
      return { kind: "closePane" };
    default:
      return undefined;
  }
}

/** Font size keys (docs/06 §5.2): Ctrl (Cmd on macOS) with `=` / `+` bigger, `-` smaller, `0` reset. */
export function zoomKey(e: KeyboardEvent): 1 | -1 | 0 | undefined {
  const mod = platform === "macos" ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey) return undefined;
  if (e.key === "=" || e.key === "+" || e.code === "NumpadAdd") return 1;
  if ((e.key === "-" && !e.shiftKey) || e.code === "NumpadSubtract") return -1;
  if (e.key === "0" && !e.shiftKey) return 0;
  return undefined;
}

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
