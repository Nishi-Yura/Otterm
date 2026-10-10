/** A search match: [start line, start col, end line, end col], end inclusive. */
export type MatchRange = [number, number, number, number];

/** Search matches to draw, with one of them current. Lines are frame line numbers. */
export class Highlights {
  matches: MatchRange[] = [];
  current = -1;

  set(matches: MatchRange[], current: number): void {
    this.matches = matches;
    this.current = current;
  }

  clear(): void {
    this.set([], -1);
  }

  /** Column ranges `[from, to)` highlighted on `line`, with whether each is the current match. */
  colsOn(line: number, cols: number): [number, number, boolean][] {
    const out: [number, number, boolean][] = [];
    // Matches are ordered by start; skip those ending before this line.
    let i = lowerBound(this.matches, line);
    for (; i < this.matches.length; i++) {
      const m = this.matches[i] as MatchRange;
      if (m[0] > line) break;
      if (m[2] < line) continue;
      const from = m[0] === line ? m[1] : 0;
      const to = m[2] === line ? m[3] + 1 : cols;
      out.push([from, to, i === this.current]);
    }
    return out;
  }
}

/** First index whose match could reach `line`: matches never span more than a few rows, so start
 * a little before the first match starting on or after it. */
function lowerBound(matches: MatchRange[], line: number): number {
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((matches[mid] as MatchRange)[0] < line) lo = mid + 1;
    else hi = mid;
  }
  // Back up over matches that start earlier but may wrap onto this line.
  while (lo > 0 && (matches[lo - 1] as MatchRange)[2] >= line) lo--;
  return lo;
}
