import type { Attr, Frame } from "./protocol";

export const DEFAULT_ATTR: Attr = Object.freeze({ fg: 0, bg: 0, underline: 0, flags: 0 });

export interface Line {
  codepoints: Uint32Array;
  attrs: Attr[];
  extras: Map<number, string>;
  wrapped: boolean;
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
      this.lines[row.index] = line;
      this.dirty.add(row.index);
    }

    this.cursorRow = Math.min(f.cursorRow, this.rows - 1);
    this.cursorCol = Math.min(f.cursorCol, this.cols - 1);
    this.cursorVisible = f.cursorVisible;
    this.cursorBlink = f.cursorBlink;
    this.cursorShape = f.cursorShape;
    this.dirty.add(this.cursorRow);
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
