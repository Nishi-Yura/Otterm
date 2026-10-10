import type { ScreenModel } from "./model";
import { Flags } from "./protocol";

/** A cell by line number (see Frame.topLine) and column. */
export interface Point {
  line: number;
  col: number;
}

/** char: drag; word: double-click; line: triple-click; block: Alt+drag (docs/03 §5). */
export type SelectionMode = "char" | "word" | "line" | "block";

/** Characters that end a word for double-click selection (`terminal.word_separators`). */
const DEFAULT_SEPARATORS = " \t\"'`()[]{}<>|&;";

const before = (a: Point, b: Point) => a.line < b.line || (a.line === b.line && a.col < b.col);

/**
 * The selection, in line numbers so that it stays on the same text while the view scrolls and
 * output arrives. The text itself is read from Rust (`session_text`), which also has the lines
 * outside the view.
 */
export class Selection {
  private anchor: Point | undefined;
  private head: Point | undefined;
  mode: SelectionMode = "char";
  private separators = new Set(DEFAULT_SEPARATORS);

  setWordSeparators(chars: string): void {
    this.separators = new Set(chars);
  }

  get active(): boolean {
    return this.anchor !== undefined && this.head !== undefined;
  }

  clear(): void {
    this.anchor = undefined;
    this.head = undefined;
  }

  start(at: Point, mode: SelectionMode): void {
    this.mode = mode;
    this.anchor = at;
    this.head = at;
  }

  extend(to: Point): void {
    if (this.anchor) this.head = to;
  }

  /** Start and end, in order, expanded to whole words or lines for those modes. */
  range(model: ScreenModel): { start: Point; end: Point } | undefined {
    if (!this.anchor || !this.head) return undefined;
    let [start, end] = before(this.head, this.anchor) ? [this.head, this.anchor] : [this.anchor, this.head];
    if (this.mode === "word") {
      start = { line: start.line, col: wordEdge(model, start, -1, this.separators) };
      end = { line: end.line, col: wordEdge(model, end, 1, this.separators) };
    } else if (this.mode === "line") {
      start = { line: start.line, col: 0 };
      end = { line: end.line, col: Math.max(0, model.cols - 1) };
    }
    return { start, end };
  }

  /** A plain click without a drag selects nothing. */
  get empty(): boolean {
    return (
      this.mode === "char" &&
      this.anchor !== undefined &&
      this.head !== undefined &&
      this.anchor.line === this.head.line &&
      this.anchor.col === this.head.col
    );
  }

  /** Columns `[from, to)` selected on `line`, or undefined. */
  colsOn(model: ScreenModel, line: number): [number, number] | undefined {
    if (this.empty) return undefined;
    const r = this.range(model);
    if (!r || line < r.start.line || line > r.end.line) return undefined;
    if (this.mode === "block") {
      const a = this.anchor as Point;
      const h = this.head as Point;
      return [Math.min(a.col, h.col), Math.max(a.col, h.col) + 1];
    }
    const from = line === r.start.line ? r.start.col : 0;
    const to = line === r.end.line ? r.end.col + 1 : model.cols;
    return [from, to];
  }
}

/** Column of the first (`dir` -1) or last (`dir` 1) cell of the word at `p`, within the visible line. */
function wordEdge(model: ScreenModel, p: Point, dir: -1 | 1, separators: Set<string>): number {
  const row = model.rowOf(p.line);
  const line = row >= 0 ? model.lines[row] : undefined;
  if (!line) return p.col;
  const isWordChar = (cp: number) => cp !== 0 && !separators.has(String.fromCodePoint(cp));
  const isWord = (col: number) => {
    const cp = line.codepoints[col] ?? 32;
    if ((line.attrs[col]?.flags ?? 0) & Flags.WIDE_SPACER) return isWordChar(line.codepoints[col - 1] ?? 32);
    return isWordChar(cp);
  };
  if (!isWord(p.col)) return p.col;
  let col = p.col;
  while (col + dir >= 0 && col + dir < model.cols && isWord(col + dir)) col += dir;
  return col;
}
