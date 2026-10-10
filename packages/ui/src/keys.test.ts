import { expect, it } from "vitest";
import { isCopyShortcut, isPasteShortcut, terminalKey } from "./keys";
import { keyEvent } from "./test-util";

// Node reports neither Windows nor macOS, so these run with the Linux rules.
it("treats Shift+Insert as paste and Ctrl+Insert as copy", () => {
  const shiftInsert = keyEvent("Insert", { shift: true });
  expect(isPasteShortcut(shiftInsert)).toBe(true);
  expect(isCopyShortcut(keyEvent("Insert", { ctrl: true }), true)).toBe(true);
  expect(isCopyShortcut(keyEvent("Insert", { ctrl: true }), false)).toBe(false);
  // Plain Insert still goes to the program.
  expect(isPasteShortcut(keyEvent("Insert"))).toBe(false);
});

it("leaves Ctrl+Shift+V to the browser's paste on Linux", () => {
  const e = {
    ...keyEvent("V", { ctrl: true, shift: true }),
    getModifierState: () => false,
    isComposing: false,
    keyCode: 86,
  } as unknown as KeyboardEvent;
  expect(terminalKey(e)).toBeUndefined();
});
