import { describe, expect, it } from "vitest";
import { modelOf } from "../test-util";
import { linkAt, pathAt } from "./links";

describe("links in text", () => {
  it("finds a URL under a cell and trims sentence punctuation", () => {
    const m = modelOf(["see https://example.com/a?b=1. ok"], 40);
    expect(linkAt(m, 0, 10)?.url).toBe("https://example.com/a?b=1");
    expect(linkAt(m, 0, 10)?.start).toEqual({ row: 0, col: 4 });
    expect(linkAt(m, 0, 1)).toBeUndefined();
  });

  it("keeps balanced parentheses and stops at quotes and Japanese text", () => {
    expect(linkAt(modelOf(["(https://w.org/A_(b))."], 40), 0, 5)?.url).toBe("https://w.org/A_(b)");
    expect(linkAt(modelOf(["'https://e.com/x'"], 40), 0, 5)?.url).toBe("https://e.com/x");
    expect(linkAt(modelOf(["https://e.com/docs参照"], 40), 0, 3)?.url).toBe("https://e.com/docs");
  });

  it("follows a URL across a wrapped row", () => {
    const m = modelOf([{ text: "go https://exa", wrapped: true }, "mple.com/x now"], 14);
    const l = linkAt(m, 1, 2);
    expect(l?.url).toBe("https://example.com/x");
    expect(l?.start).toEqual({ row: 0, col: 3 });
    expect(l?.end).toEqual({ row: 1, col: 9 });
  });
});

describe("OSC 8 hyperlinks", () => {
  it("use the target, not the text, over the linked cells", () => {
    const m = modelOf([{ text: "see click here ok", link: { id: 1, from: 4, to: 14 } }], 30, 0, {
      1: "https://t.example/",
    });
    const l = linkAt(m, 0, 8);
    expect(l).toEqual({ url: "https://t.example/", start: { row: 0, col: 4 }, end: { row: 0, col: 13 } });
    expect(linkAt(m, 0, 15)).toBeUndefined();
  });
});

describe("paths in text", () => {
  it("finds a relative path with a line and column, without the trailing colon", () => {
    const m = modelOf(["src/app.ts:42:7: error TS2304"], 40);
    const l = pathAt(m, 0, 3);
    expect(l?.url).toBe("src/app.ts:42:7:");
    expect(l?.path).toBe(true);
    expect(l?.start).toEqual({ row: 0, col: 0 });
    expect(pathAt(m, 0, 20)).toBeUndefined();
  });

  it("takes Windows paths inside quotes and drops sentence punctuation", () => {
    const m = modelOf(['  File "C:\\x\\y.py", line 3'], 40);
    expect(pathAt(m, 0, 10)?.url).toBe("C:\\x\\y.py");
    expect(pathAt(modelOf(["see notes.txt."], 20), 0, 6)?.url).toBe("notes.txt");
    expect(pathAt(modelOf(["~/x and more"], 20), 0, 0)?.url).toBe("~/x");
  });

  it("leaves plain words, numbers and URLs alone", () => {
    expect(pathAt(modelOf(["hello world"], 20), 0, 2)).toBeUndefined();
    expect(pathAt(modelOf(["v 1.2.3"], 20), 0, 3)).toBeUndefined();
    expect(pathAt(modelOf(["https://e.com/a"], 20), 0, 3)).toBeUndefined();
  });

  it("covers both halves of a wide character at the end", () => {
    const l = pathAt(modelOf(["資料/メモ"], 20), 0, 0);
    expect(l?.url).toBe("資料/メモ");
    expect(l?.end).toEqual({ row: 0, col: 8 });
  });
});
