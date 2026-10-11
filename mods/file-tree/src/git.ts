/**
 * Git status decoration for the file tree (docs/03 §9.1). Pure functions: the process calls live in main.ts.
 */

import { parentOf } from "./paths";

export interface GitChange {
  /** Path relative to the repository root, with "/" separators (git's porcelain form). */
  path: string;
  /** The two-letter XY status code from `git status --porcelain=v1`. */
  code: string;
}

/** Marker for folders that contain a changed file. */
export const FOLDER_MARK = "•";

/**
 * Parses `git status --porcelain=v1 -z`. Entries are `XY path` separated by NUL. A rename or copy
 * is followed by one more NUL-separated entry holding the original path, which is skipped.
 */
export function parsePorcelainZ(output: string): GitChange[] {
  const parts = output.split("\0");
  const changes: GitChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? "";
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    changes.push({ path: entry.slice(3), code });
    if (code[0] === "R" || code[0] === "C" || code[1] === "R" || code[1] === "C") i += 1;
  }
  return changes;
}

/** Badge text for a file's status code, or undefined when the file should not be marked. */
export function badgeFor(code: string): string | undefined {
  if (code === "??") return "U";
  if (code === "!!") return undefined;
  if (code === "AA" || code === "DD" || code.includes("U")) return "!";
  const letter = code[0] !== " " ? code[0] : code[1];
  switch (letter) {
    case "A":
    case "C":
      return "A";
    case "D":
      return "D";
    case "R":
      return "R";
    default:
      return "M";
  }
}

/**
 * Comparison key for a path: "/" separators, no trailing slash, lower case for Windows-style paths
 * (drive letter or backslash). Keys from git and from the tree's listings match through this.
 */
export function pathKey(path: string): string {
  const lower = /^[A-Za-z]:/.test(path) || path.includes("\\");
  const unified = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return lower ? unified.toLowerCase() : unified;
}

/**
 * Builds the badge map keyed by `pathKey`. `repoRoot` is the absolute toplevel from
 * `git rev-parse --show-toplevel`. Every ancestor folder of a changed file (up to, not including,
 * the repository root) gets the folder mark.
 */
export function buildDecorations(repoRoot: string, changes: GitChange[]): Map<string, string> {
  const map = new Map<string, string>();
  const root = repoRoot.replace(/\/+$/, "");
  const rootKey = pathKey(root);
  for (const change of changes) {
    const badge = badgeFor(change.code);
    if (badge === undefined) continue;
    const abs = `${root}/${change.path}`;
    map.set(pathKey(abs), badge);
    let dir = parentOf(abs);
    while (pathKey(dir) !== rootKey) {
      const key = pathKey(dir);
      if (!map.has(key)) map.set(key, FOLDER_MARK);
      const next = parentOf(dir);
      if (next === dir) break;
      dir = next;
    }
  }
  return map;
}

/** Stable text form of a decoration map, used to skip re-renders when nothing changed. */
export function decorationsSignature(map: Map<string, string>): string {
  const lines: string[] = [];
  for (const [key, badge] of map) lines.push(`${key}\t${badge}`);
  return lines.sort().join("\n");
}
