import { describe, expect, it } from "vitest";
import { modelOf } from "../test-util";
import { linkAt } from "./links";

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
