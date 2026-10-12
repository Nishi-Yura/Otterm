import { type Attr, Flags, type Frame, type RowBlock } from "./protocol";

export const DEFAULT_ATTR: Attr = Object.freeze({ fg: 0, bg: 0, underline: 0, flags: 0, link: 0 });

export interface Line {
  /** Line number, or -1 for a blank row below the last line in view. */
  line: number;
  codepoints: Uint32Array;
  attrs: Attr[];
  extras: Map<number, string>;
  wrapped: boolean;
  block?: RowBlock;
  /** Lines folded away after this row; it stands in for them (docs/03 §6.3). */
  folded?: number;
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
  /** The oldest line kept and the last line of the live screen. */
  firstLine = 0;
  lastLine = 0;
  /** OSC 8 hyperlink targets seen so far, by id (ids are stable for the session). */
  readonly links = new Map<number, string>();
  /** Rows changed since the renderer last drew. */
  readonly dirty = new Set<number>();

  /**
   * Where the IME should compose: the cursor, or, while a program hides it, the cursor it draws
   * itself. TUIs built on Ink (Claude Code and others) hide the real cursor and paint one cell in
   * reverse video where you type; the real cursor then sits somewhere else, and the candidate window
   * would open there. One lone reverse-video cell is taken as that drawn cursor; anything less
   * clear (none, or several, as in htop's header) leaves the real cursor.
   */
  imeCursor(): { row: number; col: number } {
    const real = { row: this.cursorRow, col: this.cursorCol };
    if (this.cursorVisible) return real;
    let found: { row: number; col: number } | undefined;
    for (let row = this.rows - 1; row >= 0; row--) {
      const attrs = this.lines[row]?.attrs;
      if (!attrs) continue;
      for (let col = 0; col < attrs.length; col++) {
        if (!((attrs[col]?.flags ?? 0) & Flags.INVERSE)) continue;
        const before = col > 0 && ((attrs[col - 1]?.flags ?? 0) & Flags.INVERSE) !== 0;
        const after = ((attrs[col + 1]?.flags ?? 0) & Flags.INVERSE) !== 0;
        // A wide character's spacer belongs to the cell before it.
        const spacer = ((attrs[col + 1]?.flags ?? 0) & Flags.WIDE_SPACER) !== 0;
        if (before || (after && !spacer)) return real;
        if (found) return real;
        found = { row, col };
        if (spacer) col++;
      }
    }
    return found ?? real;
  }

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
      line.line = row.line;
      line.folded = row.folded;
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
    this.firstLine = f.firstLine;
    this.lastLine = f.lastLine;
    for (const [id, uri] of f.links) this.links.set(id, uri);
    this.dirty.add(this.cursorRow);
  }

  /** Line number of a row, or -1 for a blank row below the last line in view. */
  lineAt(row: number): number {
    return this.lines[row]?.line ?? -1;
  }

  /** Row of a line number in the view, or -1 when it is not visible (scrolled away or folded). */
  rowOf(line: number): number {
    return this.lines.findIndex((l) => l.line === line);
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
    line: -1,
    codepoints: new Uint32Array(cols).fill(32),
    attrs: new Array<Attr>(cols).fill(DEFAULT_ATTR),
    extras: new Map(),
    wrapped: false,
  };
}
