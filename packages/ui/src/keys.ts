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
