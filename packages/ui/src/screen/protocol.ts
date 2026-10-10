/** Decoder for screen frames. Format: crates/otterm-vt/src/diff.rs. */

export const FRAME = 1;

export interface Attr {
  /** Packed colors: 0 default, 0x01_00_00_nn indexed, 0x02_rr_gg_bb RGB. */
  fg: number;
  bg: number;
  underline: number;
  flags: number;
}

/** Mirrors `otterm_vt::flags`. */
export const Flags = {
  BOLD: 1 << 0,
  DIM: 1 << 1,
  ITALIC: 1 << 2,
  UNDERLINE: 1 << 3,
  DOUBLE_UNDERLINE: 1 << 4,
  CURLY_UNDERLINE: 1 << 5,
  BLINK: 1 << 6,
  INVERSE: 1 << 7,
  HIDDEN: 1 << 8,
  STRIKE: 1 << 9,
  OVERLINE: 1 << 10,
  WIDE: 1 << 11,
  WIDE_SPACER: 1 << 12,
} as const;

export interface FrameRow {
  index: number;
  wrapped: boolean;
  /** Code points of the cells that were sent; cells beyond are blank. */
  codepoints: Uint32Array;
  attrs: Attr[];
  /** Combining characters by column. */
  extras: Map<number, string>;
}

export const CursorShape = { Block: 0, Underline: 1, Bar: 2 } as const;

export interface Frame {
  session: number;
  cols: number;
  rows: number;
  cursorRow: number;
  cursorCol: number;
  cursorVisible: boolean;
  cursorBlink: boolean;
  cursorShape: number;
  /** Every row is in `lines`; otherwise only the changed ones. */
  full: boolean;
  altScreen: boolean;
  /** Mouse tracking the application asked for: 0 off, 1 click, 2 drag, 3 any motion. */
  mouseMode: number;
  /** Line number of row 0. Lines keep their number as they scroll into history. */
  topLine: number;
  /** Scrollback length in lines. */
  scrollback: number;
  /** How many lines the view is scrolled up from the live screen. */
  offset: number;
  lines: FrameRow[];
}

const utf8 = new TextDecoder();

export function decodeFrame(buf: ArrayBuffer): Frame | null {
  const v = new DataView(buf);
  let p = 0;
  const u8 = () => v.getUint8(p++);
  const u16 = () => {
    const x = v.getUint16(p, true);
    p += 2;
    return x;
  };
  const u32 = () => {
    const x = v.getUint32(p, true);
    p += 4;
    return x;
  };

  if (u8() !== FRAME) return null;
  const session = u32();
  const cols = u16();
  const rows = u16();
  const cursorRow = u16();
  const cursorCol = u16();
  const cursor = u8();
  const flags = u8();
  const topLine = Number(v.getBigUint64(p, true));
  p += 8;
  const scrollback = u32();
  const offset = u32();

  const table: Attr[] = [];
  for (let n = u16(); n > 0; n--) {
    table.push({ fg: u32(), bg: u32(), underline: u32(), flags: u16() });
  }

  const lines: FrameRow[] = [];
  for (let n = u16(); n > 0; n--) {
    const index = u16();
    const wrapped = (u8() & 1) === 1;
    const count = u16();
    const codepoints = new Uint32Array(count);
    const attrs: Attr[] = new Array(count);
    for (let i = 0; i < count; i++) {
      codepoints[i] = u32();
      attrs[i] = table[u16()] as Attr;
    }
    const extras = new Map<number, string>();
    for (let e = u16(); e > 0; e--) {
      const col = u16();
      const len = u16();
      extras.set(col, utf8.decode(new Uint8Array(buf, p, len)));
      p += len;
    }
    lines.push({ index, wrapped, codepoints, attrs, extras });
  }

  return {
    session,
    cols,
    rows,
    cursorRow,
    cursorCol,
    cursorVisible: (cursor & 1) !== 0,
    cursorBlink: (cursor & 2) !== 0,
    cursorShape: (cursor >> 2) & 3,
    full: (flags & 1) !== 0,
    altScreen: (flags & 2) !== 0,
    mouseMode: (flags >> 2) & 3,
    topLine,
    scrollback,
    offset,
    lines,
  };
}
