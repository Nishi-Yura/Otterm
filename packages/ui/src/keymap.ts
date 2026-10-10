/**
 * Configurable window-level key bindings (docs/06 §5): action id → key chords, from the defaults
 * below with `[keybindings.bindings]` on top. Chords are written like `ctrl+shift+t`,
 * `alt+arrowleft`, `cmd+1`; an empty list unbinds an action.
 */
import { type AppAction, platform } from "./keys";

type Bindings = Record<string, string[]>;

const DIRS = ["left", "right", "up", "down"] as const;

function defaults(): Bindings {
  const mac = platform === "macos";
  const b: Bindings = {
    "tab.new": [mac ? "cmd+t" : "ctrl+shift+t"],
    "tab.new.profile": [mac ? "cmd+n" : "ctrl+shift+n"],
    "tab.close": [mac ? "cmd+w" : "ctrl+shift+w"],
    "tab.next": ["ctrl+tab"],
    "tab.prev": ["ctrl+shift+tab"],
    "pane.split.vertical": [mac ? "cmd+d" : "ctrl+shift+d"],
    "pane.split.horizontal": [mac ? "cmd+shift+d" : "ctrl+shift+e"],
    "pane.zoom": [mac ? "cmd+shift+enter" : "ctrl+shift+z"],
    "pane.close": [mac ? "cmd+shift+w" : "ctrl+shift+q"],
  };
  for (let i = 1; i <= 9; i++) b[`tab.goto.${i}`] = [mac ? `cmd+${i}` : `ctrl+${i}`];
  for (const d of DIRS) {
    const arrow = `arrow${d}`;
    // macOS keeps Option+arrow for word motion in the shell (decision I14).
    b[`pane.focus.${d}`] = [mac ? `cmd+alt+${arrow}` : `alt+${arrow}`];
    b[`pane.resize.${d}`] = [mac ? `cmd+alt+shift+${arrow}` : `alt+shift+${arrow}`];
  }
  return b;
}

function action(id: string): AppAction | undefined {
  const [group, verb, arg] = id.split(".");
  const dir = DIRS.find((d) => d === arg);
  switch (`${group}.${verb}`) {
    case "tab.new":
      return arg === "profile" ? { kind: "newTabMenu" } : arg === undefined ? { kind: "newTab" } : undefined;
    case "tab.close":
      return { kind: "closeTab" };
    case "tab.next":
      return { kind: "nextTab" };
    case "tab.prev":
      return { kind: "prevTab" };
    case "tab.goto": {
      const n = Number(arg);
      return n >= 1 && n <= 9 ? { kind: "gotoTab", index: n - 1 } : undefined;
    }
    case "pane.split":
      return arg === "vertical" || arg === "horizontal"
        ? { kind: "split", dir: arg === "vertical" ? "row" : "column" }
        : undefined;
    case "pane.focus":
      return dir ? { kind: "focusPane", dir } : undefined;
    case "pane.resize":
      return dir ? { kind: "resizePane", dir } : undefined;
    case "pane.zoom":
      return { kind: "zoomPane" };
    case "pane.close":
      return { kind: "closePane" };
    default:
      return undefined;
  }
}

interface Chord {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string;
}

const MODS: Record<string, keyof Omit<Chord, "key">> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  cmd: "meta",
  meta: "meta",
  super: "meta",
  win: "meta",
};

export function parseChord(text: string): Chord | undefined {
  const parts = text.toLowerCase().trim().split("+");
  // "ctrl++" ends with an empty part: the key is "+".
  if (parts.length > 1 && parts[parts.length - 1] === "" && parts[parts.length - 2] === "") {
    parts.splice(-2, 2, "+");
  }
  const key = parts.pop();
  if (!key) return undefined;
  const chord: Chord = { ctrl: false, shift: false, alt: false, meta: false, key: key === "plus" ? "+" : key };
  for (const p of parts) {
    const m = MODS[p];
    if (!m) return undefined;
    chord[m] = true;
  }
  return chord;
}

function matches(c: Chord, e: KeyboardEvent): boolean {
  if (c.ctrl !== e.ctrlKey || c.shift !== e.shiftKey || c.alt !== e.altKey || c.meta !== e.metaKey) return false;
  const key = e.key.toLowerCase();
  if (key === c.key) return true;
  // A letter or digit key means what it says (Dvorak's "k" is not "t").
  if (/^[a-z0-9]$/.test(key)) return false;
  // Otherwise (Shift+digit gives a symbol, non-Latin layouts give other letters) go by position.
  if (/^[a-z]$/.test(c.key)) return e.code === `Key${c.key.toUpperCase()}`;
  if (/^[0-9]$/.test(c.key)) return e.code === `Digit${c.key}`;
  return false;
}

export interface KeyHit {
  action: AppAction;
  /** Ctrl+Shift or Cmd chords; TUI applications rarely use these, so otterm keeps them even on
   * the alternate screen. */
  strong: boolean;
}

export class Keymap {
  private entries: { chord: Chord; action: AppAction }[] = [];
  /** Action ids or chords in the config that could not be used. */
  readonly problems: string[] = [];

  constructor(overrides: Record<string, string[]> = {}) {
    const all = { ...defaults(), ...overrides };
    for (const [id, chords] of Object.entries(all)) {
      const a = action(id);
      if (!a) {
        if (id in overrides) this.problems.push(id);
        continue;
      }
      for (const text of chords) {
        const chord = parseChord(text);
        if (chord) this.entries.push({ chord, action: a });
        else this.problems.push(`${id} = "${text}"`);
      }
    }
  }

  match(e: KeyboardEvent): KeyHit | undefined {
    const hit = this.entries.find((x) => matches(x.chord, e));
    if (!hit) return undefined;
    const c = hit.chord;
    return { action: hit.action, strong: c.meta || (c.ctrl && c.shift) };
  }
}
