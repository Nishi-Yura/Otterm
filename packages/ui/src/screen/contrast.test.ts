import { describe, expect, it } from "vitest";
import { contrastRatio, readable } from "./contrast";

describe("minimum contrast", () => {
  it("measures WCAG contrast", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("leaves readable colors alone", () => {
    expect(readable("#2b2f36", "#fafafa", 3)).toBe("#2b2f36");
    expect(readable("#d8dee9", "#1b1d23", 4.5)).toBe("#d8dee9");
  });

  it("darkens neon colors on a light background just enough", () => {
    const fixed = readable("#36f9f6", "#fafafa", 3);
    expect(contrastRatio(fixed, "#fafafa")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(fixed, "#fafafa")).toBeLessThan(3.2);
  });

  it("lightens dark colors on a dark background", () => {
    const fixed = readable("#202020", "#1b1d23", 3);
    expect(contrastRatio(fixed, "#1b1d23")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(fixed, "#ffffff")).toBeLessThan(contrastRatio("#202020", "#ffffff"));
  });

  it("is off at 1 and keeps text drawn in its background color hidden", () => {
    expect(readable("#36f9f6", "#fafafa", 1)).toBe("#36f9f6");
    expect(readable("#fafafa", "#fafafa", 3)).toBe("#fafafa");
  });

  it("passes colors it cannot read through", () => {
    expect(readable("rgba(0,0,0,0.5)", "#ffffff", 3)).toBe("rgba(0,0,0,0.5)");
  });
});
