import type { Attr, Frame, RowBlock } from "./protocol";

export const DEFAULT_ATTR: Attr = Object.freeze({ fg: 0, bg: 0, underline: 0, flags: 0, link: 0 });

export interface Line {
  codepoints: Uint32Array;
  attrs: Attr[];
  extras: Map<number, string>;
  wrapped: boolean;
  block?: RowBlock;
}

/** The UI's copy of one session's screen, kept up to date by applying frames. */
export class ScreenModel {
  cols = 0;
  rows = 0;
  lines: Line[] = [];
  cursorRow = 0;
  cursorCol = 0;
  cursorVisible = true;
  cursorBlink = true;
  cursorShape = 0;
  altScreen = false;
  mouseMode = 0;
  /** Line number of row 0 (see Frame.topLine). */
  topLine = 0;
  scrollback = 0;
  /** Lines the view is scrolled up; 0 is the live screen. */
  offset = 0;
  /** The block row 0 is in (see Frame.topBlock). */
  topBlock = 0;
  /** OSC 8 hyperlink targets seen so far, by id (ids are stable for the session). */
  readonly links = new Map<number, string>();
  /** Rows changed since the renderer last drew. */
  readonly dirty = new Set<number>();

  /** Apply a frame and mark the rows to redraw, including the old and the new cursor row. */
  apply(f: Frame): void {
    if (f.cols !== this.cols || f.rows !== this.rows) {
      this.cols = f.cols;
      this.rows = f.rows;
      this.lines = Array.from({ length: f.rows }, () => blankLine(f.cols));
      for (let r = 0; r < f.rows; r++) this.dirty.add(r);
    }
    this.dirty.add(this.cursorRow);

    for (const row of f.lines) {
      if (row.index >= this.rows) continue;
      const line = blankLine(this.cols);
      const n = Math.min(row.codepoints.length, this.cols);
      line.codepoints.set(row.codepoints.subarray(0, n));
      for (let c = 0; c < n; c++) line.attrs[c] = row.attrs[c] ?? DEFAULT_ATTR;
      line.extras = row.extras;
      line.wrapped = row.wrapped;
      line.block = row.block;
      this.lines[row.index] = line;
      this.dirty.add(row.index);
    }

    this.cursorRow = Math.min(f.cursorRow, this.rows - 1);
    this.cursorCol = Math.min(f.cursorCol, this.cols - 1);
    this.cursorVisible = f.cursorVisible;
    this.cursorBlink = f.cursorBlink;
    this.cursorShape = f.cursorShape;
    this.altScreen = f.altScreen;
    this.mouseMode = f.mouseMode;
    this.topLine = f.topLine;
    this.scrollback = f.scrollback;
    this.offset = f.offset;
    this.topBlock = f.topBlock;
    for (const [id, uri] of f.links) this.links.set(id, uri);
    this.dirty.add(this.cursorRow);
  }

  /** Row of a line number in the view, or -1 when it is not visible. */
  rowOf(line: number): number {
    const row = line - this.topLine;
    return row >= 0 && row < this.rows ? row : -1;
  }

  /** Visible text of one row (for tests and copy). */
  text(row: number): string {
    const line = this.lines[row];
    if (!line) return "";
    let s = "";
    for (let c = 0; c < this.cols; c++) {
      const attr = line.attrs[c] ?? DEFAULT_ATTR;
      if (attr.flags & (1 << 12)) continue;
      s += String.fromCodePoint(line.codepoints[c] || 32) + (line.extras.get(c) ?? "");
    }
    return s.trimEnd();
  }
}

function blankLine(cols: number): Line {
  return {
    codepoints: new Uint32Array(cols).fill(32),
    attrs: new Array<Attr>(cols).fill(DEFAULT_ATTR),
    extras: new Map(),
    wrapped: false,
  };
}
