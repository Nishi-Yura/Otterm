import { describe, expect, it } from "vitest";
import { modelOf } from "../test-util";
import { Selection } from "./selection";

describe("selection", () => {
  const m = modelOf(["echo foo-bar (baz)", "日本語 text"], 30, 100);

  it("selects a word by the configured separators", () => {
    const s = new Selection();
    s.start({ line: 100, col: 6 }, "word");
    expect(s.range(m)).toEqual({ start: { line: 100, col: 5 }, end: { line: 100, col: 11 } });
    s.setWordSeparators(" -()");
    expect(s.range(m)).toEqual({ start: { line: 100, col: 5 }, end: { line: 100, col: 7 } });
    s.start({ line: 100, col: 15 }, "word");
    expect(s.range(m)).toEqual({ start: { line: 100, col: 14 }, end: { line: 100, col: 16 } });
  });

  it("treats a wide character's right half as the character", () => {
    const s = new Selection();
    // Column 3 is the spacer of 本 (columns 2-3).
    s.start({ line: 101, col: 3 }, "char");
    s.extend({ line: 101, col: 5 });
    expect(s.range(m)?.start).toEqual({ line: 101, col: 2 });
  });

  it("is empty after a click, in char and block modes", () => {
    const s = new Selection();
    s.start({ line: 100, col: 2 }, "char");
    expect(s.empty).toBe(true);
    s.start({ line: 100, col: 2 }, "block");
    expect(s.empty).toBe(true);
    s.extend({ line: 101, col: 4 });
    expect(s.empty).toBe(false);
    expect(s.colsOn(m, 101)).toEqual([2, 5]);
  });

  it("selects whole lines in line mode", () => {
    const s = new Selection();
    s.start({ line: 101, col: 4 }, "line");
    s.extend({ line: 100, col: 9 });
    expect(s.range(m)).toEqual({ start: { line: 100, col: 0 }, end: { line: 101, col: 29 } });
  });
});
