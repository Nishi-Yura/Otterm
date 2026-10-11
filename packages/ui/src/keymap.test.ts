import { describe, expect, it } from "vitest";
import { Keymap, parseChord } from "./keymap";
import { keyEvent } from "./test-util";

describe("key chords", () => {
  it("parses modifiers, keys and plus", () => {
    expect(parseChord("Ctrl+Shift+T")).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: "t" });
    expect(parseChord("ctrl++")?.key).toBe("+");
    expect(parseChord("cmd+plus")).toEqual({ ctrl: false, shift: false, alt: false, meta: true, key: "+" });
    expect(parseChord("hyper+q")).toBeUndefined();
  });
});

describe("keymap (Windows/Linux defaults)", () => {
  const map = new Keymap();

  it("matches the default tab and pane keys", () => {
    expect(map.match(keyEvent("T", { ctrl: true, shift: true }))?.action).toEqual({ kind: "newTab" });
    expect(map.match(keyEvent("Tab", { ctrl: true }))?.action).toEqual({ kind: "nextTab" });
    expect(map.match(keyEvent("ArrowLeft", { alt: true }))?.action).toEqual({ kind: "focusPane", dir: "left" });
    expect(map.match(keyEvent("3", { ctrl: true, code: "Digit3" }))?.action).toEqual({ kind: "gotoTab", index: 2 });
  });

  it("has F11 for full screen and Ctrl+, for the settings", () => {
    expect(map.match(keyEvent("F11", {}))?.action).toEqual({ kind: "fullscreen" });
    expect(map.match(keyEvent(",", { ctrl: true, code: "Comma" }))?.action).toEqual({ kind: "settings" });
  });

  it("marks Ctrl+Shift chords as kept on the alternate screen", () => {
    expect(map.match(keyEvent("T", { ctrl: true, shift: true }))?.strong).toBe(true);
    expect(map.match(keyEvent("ArrowLeft", { alt: true }))?.strong).toBe(false);
  });

  it("goes by the typed letter, not the key position", () => {
    // Dvorak: the key in QWERTY's T position types "y".
    expect(map.match(keyEvent("Y", { ctrl: true, shift: true, code: "KeyT" }))).toBeUndefined();
    // A non-Latin layout types no ASCII letter: the position decides.
    expect(map.match(keyEvent("Е", { ctrl: true, shift: true, code: "KeyT" }))?.action).toEqual({ kind: "newTab" });
  });

  it("does not match plain typing", () => {
    expect(map.match(keyEvent("t"))).toBeUndefined();
    expect(map.match(keyEvent("c", { ctrl: true }))).toBeUndefined();
  });
});

describe("keymap overrides", () => {
  it("rebinds, unbinds and reports what it could not use", () => {
    const map = new Keymap({
      "tab.new": ["ctrl+alt+n"],
      "pane.zoom": [],
      "tab.bogus": ["x"],
      "tab.close": ["hyper+w"],
    });
    expect(map.match(keyEvent("T", { ctrl: true, shift: true }))).toBeUndefined();
    expect(map.match(keyEvent("n", { ctrl: true, alt: true }))?.action).toEqual({ kind: "newTab" });
    expect(map.match(keyEvent("Z", { ctrl: true, shift: true }))).toBeUndefined();
    expect([...map.problems].sort()).toEqual(["tab.bogus", 'tab.close = "hyper+w"']);
  });

  it("matches Shift+digit chords by position", () => {
    const map = new Keymap({ "tab.goto.1": ["ctrl+shift+1"] });
    expect(map.match(keyEvent("!", { ctrl: true, shift: true, code: "Digit1" }))?.action).toEqual({
      kind: "gotoTab",
      index: 0,
    });
  });
});
