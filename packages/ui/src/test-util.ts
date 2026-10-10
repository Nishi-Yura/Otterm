/** Helpers for unit tests: a ScreenModel filled from plain text. */
import { DEFAULT_ATTR, ScreenModel } from "./screen/model";
import { type Attr, Flags, type Frame } from "./screen/protocol";

/** East Asian wide enough for tests: CJK and kana. */
const wide = (cp: number) =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xff00 && cp <= 0xff60);

export interface RowSpec {
  text: string;
  wrapped?: boolean;
  /** OSC 8 link id for the columns `[from, to)`. */
  link?: { id: number; from: number; to: number };
}

/** A model showing `rows` (strings or specs), `cols` wide, with `topLine` as line number of row 0. */
export function modelOf(
  rows: (string | RowSpec)[],
  cols: number,
  topLine = 0,
  links: Record<number, string> = {},
): ScreenModel {
  const lines = rows.map((r, index) => {
    const spec = typeof r === "string" ? { text: r } : r;
    const codepoints: number[] = [];
    const attrs: Attr[] = [];
    for (const ch of spec.text) {
      const cp = ch.codePointAt(0) ?? 32;
      if (wide(cp)) {
        codepoints.push(cp, 32);
        attrs.push({ ...DEFAULT_ATTR, flags: Flags.WIDE }, { ...DEFAULT_ATTR, flags: Flags.WIDE_SPACER });
      } else {
        codepoints.push(cp);
        attrs.push(DEFAULT_ATTR);
      }
    }
    if (spec.link) {
      for (let c = spec.link.from; c < spec.link.to; c++)
        attrs[c] = { ...(attrs[c] ?? DEFAULT_ATTR), link: spec.link.id };
      for (let c = attrs.length; c < spec.link.to; c++) {
        codepoints.push(32);
        attrs.push({ ...DEFAULT_ATTR, link: spec.link.id });
      }
    }
    return {
      index,
      wrapped: spec.wrapped ?? false,
      codepoints: Uint32Array.from(codepoints),
      attrs,
      extras: new Map(),
    };
  });
  const frame: Frame = {
    session: 1,
    cols,
    rows: rows.length,
    cursorRow: 0,
    cursorCol: 0,
    cursorVisible: true,
    cursorBlink: false,
    cursorShape: 0,
    full: true,
    altScreen: false,
    mouseMode: 0,
    topLine,
    scrollback: topLine,
    offset: 0,
    lines,
    links: new Map(Object.entries(links).map(([k, v]) => [Number(k), v])),
  };
  const model = new ScreenModel();
  model.apply(frame);
  return model;
}

/** Enough of a KeyboardEvent for the key handling code. */
export function keyEvent(
  key: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean; code?: string } = {},
) {
  return {
    key,
    code: mods.code ?? (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key),
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    metaKey: mods.meta ?? false,
  } as KeyboardEvent;
}
