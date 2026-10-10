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
