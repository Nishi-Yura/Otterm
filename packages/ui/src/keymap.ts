/**
 * Configurable window-level key bindings (docs/06 §5): action id → key chords, from the defaults
 * below with `[keybindings.bindings]` on top, and `[[keybindings.custom]]` entries that run a
 * command with arguments under a `when` condition. Chords are written like `ctrl+shift+t`,
 * `alt+arrowleft`, `cmd+1`, or `mod` (Ctrl, or Cmd on macOS); a sequence separates its chords with
 * spaces (`ctrl+k ctrl+s`). An empty list unbinds an action.
 */
import { type AppAction, platform } from "./keys";
import { compileWhen, type WhenContext } from "./when";

type Bindings = Record<string, string[]>;

const DIRS = ["left", "right", "up", "down"] as const;

/** Default chords that only apply when their `when` condition holds, by action id and chord. */
const DEFAULT_WHEN: Record<string, Record<string, string>> = {
  copy: { "ctrl+c": "hasSelection", "ctrl+insert": "hasSelection" },
};

/** The default keys of every action, for the keybindings settings. */
export function defaults(): Bindings {
  const mac = platform === "macos";
  const win = platform === "windows";
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
    "window.fullscreen": [mac ? "ctrl+cmd+f" : "f11"],
    // Blocks of the shell integration (docs/03 §6.3). Cmd+arrow is what Terminal.app uses for marks.
    "block.prev": [mac ? "cmd+arrowup" : "ctrl+arrowup"],
    "block.next": [mac ? "cmd+arrowdown" : "ctrl+arrowdown"],
    "block.collapse": [mac ? "cmd+shift+[" : "ctrl+shift+["],
    settings: [mac ? "cmd+," : "ctrl+,"],
    // Panels (docs/06 §5.2). Plain Ctrl+B / Ctrl+J belong to the shell (readline's back-char,
    // newline), so otterm takes Ctrl+Shift / Ctrl+Alt chords there (decision M12).
    "sidebar.left.toggle": [mac ? "cmd+b" : "ctrl+shift+b"],
    "sidebar.right.toggle": [mac ? "cmd+shift+b" : "ctrl+alt+b"],
    "panel.bottom.toggle": [mac ? "cmd+j" : "ctrl+shift+j"],
    // Move the keyboard between the terminal, the panels and the status bar (docs/04 §5).
    "focus.next_region": ["f6"],
    "focus.prev_region": ["shift+f6"],
    palette: [mac ? "cmd+shift+p" : "ctrl+shift+p"],
    // Taken from the shell at guide level >= 1 only (decision B5); App checks before acting.
    history: ["ctrl+r"],
    "completion.trigger": ["ctrl+space"],
    "multiline.open": ["shift+enter"],
    // Copy and paste (decision B4). Plain Ctrl+C stays SIGINT unless a selection is there.
    copy: mac ? ["cmd+c"] : win ? ["ctrl+shift+c", "ctrl+c", "ctrl+insert"] : ["ctrl+shift+c", "ctrl+insert"],
    paste: mac ? ["cmd+v"] : win ? ["ctrl+v", "shift+insert"] : ["ctrl+shift+v", "shift+insert"],
    search: [mac ? "cmd+f" : "ctrl+shift+f"],
    "font.bigger": mac ? ["cmd+=", "cmd+shift+="] : ["ctrl+=", "ctrl+shift+="],
    "font.smaller": [mac ? "cmd+-" : "ctrl+-"],
    "font.reset": [mac ? "cmd+0" : "ctrl+0"],
    "ai.ask": [mac ? "cmd+shift+space" : "ctrl+shift+space"],
    "mascot.toggle": [mac ? "cmd+shift+m" : "ctrl+shift+m"],
    "guide.help_mode": ["f1"],
    clear: ["ctrl+l"],
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

/** Whether `id` names an action otterm knows. */
export function isAction(id: string): boolean {
  return action(id) !== undefined;
}

function action(id: string): AppAction | undefined {
  if (id === "settings") return { kind: "settings" };
  if (id === "palette") return { kind: "palette" };
  if (id === "history") return { kind: "history" };
  if (id === "completion.trigger") return { kind: "completion" };
  if (id === "multiline.open") return { kind: "multiline" };
  if (id === "sidebar.left.toggle") return { kind: "togglePanel", slot: "sidebar.left" };
  if (id === "sidebar.right.toggle") return { kind: "togglePanel", slot: "sidebar.right" };
  if (id === "panel.bottom.toggle") return { kind: "togglePanel", slot: "panel.bottom" };
  if (id === "focus.next_region") return { kind: "focusRegion", dir: 1 };
  if (id === "focus.prev_region") return { kind: "focusRegion", dir: -1 };
  if (id === "copy") return { kind: "copy" };
  if (id === "paste") return { kind: "paste" };
  if (id === "search") return { kind: "search" };
  if (id === "font.bigger") return { kind: "font", step: 1 };
  if (id === "font.smaller") return { kind: "font", step: -1 };
  if (id === "font.reset") return { kind: "font", step: 0 };
  if (id === "ai.ask") return { kind: "aiAsk" };
  if (id === "mascot.toggle") return { kind: "mascotToggle" };
  if (id === "guide.help_mode") return { kind: "helpMode" };
  if (id === "clear") return { kind: "clear" };
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
    case "window.fullscreen":
      return { kind: "fullscreen" };
    case "block.prev":
      return { kind: "blockJump", dir: -1 };
    case "block.next":
      return { kind: "blockJump", dir: 1 };
    case "block.collapse":
      return { kind: "blockFold" };
    default:
      return undefined;
  }
}

/** One key press: its modifiers and the key name (lowercase: "a", "1", "space", "arrowup"). */
export interface Chord {
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
    // `mod` is the platform's command modifier: Ctrl, or Cmd on macOS.
    if (p === "mod") {
      chord[platform === "macos" ? "meta" : "ctrl"] = true;
      continue;
    }
    const m = MODS[p];
    if (!m) return undefined;
    chord[m] = true;
  }
  return chord;
}

/** A key sequence: chords separated by spaces, like `ctrl+k ctrl+s`. */
export function parseKeys(text: string): Chord[] | undefined {
  const out: Chord[] = [];
  for (const part of text.trim().split(/\s+/)) {
    const chord = parseChord(part);
    if (!chord) return undefined;
    out.push(chord);
  }
  return out;
}

/** Punctuation keys by their US-layout name: Shift changes `e.key` ("[" becomes "{"), not the code. */
const PUNCTUATION: Record<string, string> = {
  "[": "BracketLeft",
  "]": "BracketRight",
  ";": "Semicolon",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "\\": "Backslash",
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
};

/** What Shift makes of a punctuation key on US and JIS layouts alike, for chords like ctrl+shift+[. */
const SHIFTED: Record<string, string> = {
  "[": "{",
  "]": "}",
  ";": ":",
  "'": '"',
  ",": "<",
  ".": ">",
  "/": "?",
  "`": "~",
  "-": "_",
  "=": "+",
  "\\": "|",
};

export function matches(c: Chord, e: KeyboardEvent): boolean {
  if (c.ctrl !== e.ctrlKey || c.shift !== e.shiftKey || c.alt !== e.altKey || c.meta !== e.metaKey) return false;
  const key = e.key.toLowerCase();
  if (key === c.key) return true;
  // Chords write the space bar as "space"; the event says " ".
  if (c.key === "space" && key === " ") return true;
  if (e.shiftKey && c.key in SHIFTED && e.key === SHIFTED[c.key]) return true;
  // A letter or digit key means what it says (Dvorak's "k" is not "t").
  if (/^[a-z0-9]$/.test(key)) return false;
  // Otherwise (Shift+digit gives a symbol, non-Latin layouts give other letters) go by position.
  if (/^[a-z]$/.test(c.key)) return e.code === `Key${c.key.toUpperCase()}`;
  if (/^[0-9]$/.test(c.key)) return e.code === `Digit${c.key}`;
  if (c.key in PUNCTUATION) return e.code === PUNCTUATION[c.key];
  return false;
}

/** What a binding does: an app action, or a command with its arguments (custom bindings). */
export type KeyTarget =
  | { kind: "action"; action: AppAction }
  | { kind: "command"; id: string; args: Record<string, unknown> };

/** The result of a key press: a binding completed, a sequence is under way, or it was broken off. */
export type KeyResult = { kind: "hit"; target: KeyTarget; strong: boolean } | { kind: "pending" } | { kind: "cancel" };

/** A `[[keybindings.custom]]` entry. */
export interface CustomKey {
  key: string;
  command: string;
  args?: Record<string, unknown>;
  when?: string;
}

interface Binding {
  steps: Chord[];
  target: KeyTarget;
  when?: (ctx: WhenContext) => boolean;
  custom: boolean;
}

/** Modifier keys on their own neither start nor end a sequence. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);

/** Ctrl+Shift or Cmd on every step: TUI applications rarely use these, so otterm keeps them even
 * on the alternate screen. */
export function strongSteps(steps: Chord[]): boolean {
  return steps.every((c) => c.meta || (c.ctrl && c.shift));
}

export class Keymap {
  /** Custom bindings first, so they win over defaults and overrides. */
  private all: Binding[] = [];
  /** The bindings that the keys pressed so far still match, while a sequence is under way. */
  private cands: Binding[] | undefined;
  /** How many steps of the current sequence have been pressed. */
  private depth = 0;
  /** Action ids, custom entries or chords in the config that could not be used. */
  readonly problems: string[] = [];

  constructor(overrides: Bindings = {}, custom: CustomKey[] = []) {
    const customs: Binding[] = [];
    for (const [i, c] of custom.entries()) {
      const steps = parseKeys(c.key);
      if (!steps) {
        this.problems.push(`custom[${i}].key = "${c.key}"`);
        continue;
      }
      if (!c.command) {
        this.problems.push(`custom[${i}].command`);
        continue;
      }
      const when = c.when === undefined ? undefined : compileWhen(c.when);
      if (c.when !== undefined && !when) {
        this.problems.push(`custom[${i}].when = "${c.when}"`);
        continue;
      }
      const a = action(c.command);
      const target: KeyTarget = a
        ? { kind: "action", action: a }
        : { kind: "command", id: c.command, args: c.args ?? {} };
      customs.push({ steps, target, when, custom: true });
    }

    const bindings: Binding[] = [];
    const defs = defaults();
    for (const [id, chords] of Object.entries({ ...defs, ...overrides })) {
      const a = action(id);
      if (!a) {
        if (id in overrides) this.problems.push(id);
        continue;
      }
      // An override replaces the defaults of its action, conditions included.
      const whens: Record<string, string> = id in overrides ? {} : (DEFAULT_WHEN[id] ?? {});
      for (const text of chords) {
        const steps = parseKeys(text);
        if (!steps) {
          this.problems.push(`${id} = "${text}"`);
          continue;
        }
        const w = whens[text];
        const when = w === undefined ? undefined : (compileWhen(w) ?? (() => false));
        bindings.push({ steps, target: { kind: "action", action: a }, when, custom: false });
      }
    }
    this.all = [...customs, ...bindings];
  }

  /** Whether a sequence has started and waits for more keys. */
  get pending(): boolean {
    return this.cands !== undefined;
  }

  /** The sequence under way started with a Ctrl+Shift or Cmd chord (see `strongSteps`). */
  get pendingStrong(): boolean {
    return (this.cands ?? []).every((b) => strongSteps(b.steps.slice(0, 1)));
  }

  /** Forget a sequence in progress. */
  reset(): void {
    this.cands = undefined;
    this.depth = 0;
  }

  /** Feeds one key press; `ctx` is the state that `when` conditions read. */
  feed(e: KeyboardEvent, ctx: WhenContext): KeyResult | undefined {
    if (MODIFIER_KEYS.has(e.key)) return undefined;
    const started = this.cands !== undefined;
    const depth = this.depth;
    const next = (this.cands ?? this.all).filter((b) => {
      const step = b.steps[depth];
      if (!step || !matches(step, e)) return false;
      // Conditions are read when a sequence starts; the ones that follow stay as they were.
      return started || !b.when || b.when(ctx);
    });
    if (next.length === 0) {
      this.reset();
      return started ? { kind: "cancel" } : undefined;
    }
    const done = next.filter((b) => b.steps.length === depth + 1);
    if (done.length > 0) {
      const hit = done.find((b) => b.custom) ?? done[0];
      if (hit) {
        this.reset();
        return { kind: "hit", target: hit.target, strong: strongSteps(hit.steps) };
      }
    }
    this.cands = next;
    this.depth = depth + 1;
    return { kind: "pending" };
  }

  /** Whether a binding of otterm or the user starts with this chord (a mod's suggestion then loses). */
  claims(chord: Chord): boolean {
    return this.all.some((b) => {
      const c = b.steps[0];
      return (
        !!c &&
        c.key === chord.key &&
        c.ctrl === chord.ctrl &&
        c.shift === chord.shift &&
        c.alt === chord.alt &&
        c.meta === chord.meta
      );
    });
  }
}
