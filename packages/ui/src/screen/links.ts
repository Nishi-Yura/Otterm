import type { ScreenModel } from "./model";
import { Flags } from "./protocol";

/** A link on screen: rows and columns of its first and last cell (inclusive), in view rows. */
export interface Link {
  url: string;
  start: { row: number; col: number };
  end: { row: number; col: number };
}

/**
 * http(s) URLs, ASCII only: in Japanese output a link is usually followed directly by text such as
 * 「を参照」 with no space. Trailing punctuation that usually ends a sentence is trimmed afterwards.
 */
const URL_RE = /\bhttps?:\/\/[!#-&(-;=?-[\]_a-z~]+/gi;
const TRAILING = /[.,;:!?)\]}'"]+$/;

/**
 * The URL under a cell, looking across rows joined by autowrap. Only what is in view is searched;
 * a link that continues off screen is cut at the edge.
 */
export function linkAt(model: ScreenModel, row: number, col: number): Link | undefined {
  return hyperlinkAt(model, row, col) ?? urlAt(model, row, col);
}

/** An OSC 8 hyperlink under a cell: the run of cells, across rows, with the same link id. */
function hyperlinkAt(model: ScreenModel, row: number, col: number): Link | undefined {
  const id = model.lines[row]?.attrs[col]?.link ?? 0;
  const url = id ? model.links.get(id) : undefined;
  if (!url) return undefined;
  const at = (r: number, c: number) => model.lines[r]?.attrs[c]?.link === id;
  let start = { row, col };
  for (;;) {
    const prev = start.col > 0 ? { row: start.row, col: start.col - 1 } : { row: start.row - 1, col: model.cols - 1 };
    if (prev.row < 0 || !at(prev.row, prev.col)) break;
    start = prev;
  }
  let end = { row, col };
  for (;;) {
    const next = end.col < model.cols - 1 ? { row: end.row, col: end.col + 1 } : { row: end.row + 1, col: 0 };
    if (next.row >= model.rows || !at(next.row, next.col)) break;
    end = next;
  }
  return { url, start, end };
}

/** A URL written out in the text. */
function urlAt(model: ScreenModel, row: number, col: number): Link | undefined {
  // The visible logical line around `row`.
  let first = row;
  while (first > 0 && model.lines[first - 1]?.wrapped) first--;
  let last = row;
  while (last < model.rows - 1 && model.lines[last]?.wrapped) last++;

  let text = "";
  /** For each UTF-16 index of `text`: the cell it came from. */
  const cells: { row: number; col: number }[] = [];
  for (let r = first; r <= last; r++) {
    const line = model.lines[r];
    if (!line) continue;
    for (let c = 0; c < model.cols; c++) {
      if ((line.attrs[c]?.flags ?? 0) & Flags.WIDE_SPACER) continue;
      const s = String.fromCodePoint(line.codepoints[c] ?? 32) + (line.extras.get(c) ?? "");
      for (let i = 0; i < s.length; i++) cells.push({ row: r, col: c });
      text += s;
    }
  }

  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(TRAILING, (tail) => keepBalancedParens(m[0], tail));
    const from = m.index;
    const to = from + url.length - 1;
    const a = cells[from];
    const b = cells[to];
    if (!a || !b) continue;
    const inside = (row > a.row || (row === a.row && col >= a.col)) && (row < b.row || (row === b.row && col <= b.col));
    if (inside) {
      const endCell = model.lines[b.row]?.attrs[b.col]?.flags ?? 0;
      return { url, start: a, end: { row: b.row, col: endCell & Flags.WIDE ? b.col + 1 : b.col } };
    }
  }
  return undefined;
}

/** Keep a closing parenthesis that matches one inside the URL (Wikipedia-style links). */
function keepBalancedParens(url: string, tail: string): string {
  const open = (url.match(/\(/g) ?? []).length;
  const close = (url.slice(0, url.length - tail.length).match(/\)/g) ?? []).length;
  return tail.startsWith(")") && open > close ? ")" : "";
}
