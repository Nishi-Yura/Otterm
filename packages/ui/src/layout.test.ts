import { describe, expect, it } from "vitest";
import { layout, leaf, leaves, neighbor, removePane, resizePane, setRatio, splitPane } from "./layout";

// 1 | 2
//   | 3
const tree = () => splitPane(splitPane(leaf(1), 1, 2, "row"), 2, 3, "column");

describe("split layout", () => {
  it("lays panes out side by side and stacked", () => {
    const { panes, dividers } = layout(tree());
    expect(panes.get(1)).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(panes.get(2)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    expect(panes.get(3)).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(dividers).toHaveLength(2);
    expect(leaves(tree())).toEqual([1, 2, 3]);
  });

  it("gives a removed pane's place to its sibling", () => {
    const t = removePane(tree(), 2);
    expect(t && leaves(t)).toEqual([1, 3]);
    expect(t && layout(t).panes.get(3)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(removePane(leaf(1), 1)).toBeUndefined();
  });

  it("finds neighbors only where they are", () => {
    expect(neighbor(tree(), 1, "right")).toBe(2);
    expect(neighbor(tree(), 3, "up")).toBe(2);
    expect(neighbor(tree(), 3, "left")).toBe(1);
    expect(neighbor(tree(), 1, "left")).toBeUndefined();
    expect(neighbor(leaf(1), 1, "right")).toBeUndefined();
  });

  it("moves dividers and keeps ratios in bounds", () => {
    const wider = resizePane(tree(), 1, "right", 0.05);
    expect(layout(wider).panes.get(1)?.w).toBeCloseTo(0.55);
    // Resizing pane 3 up and down moves the divider between 2 and 3.
    const lower = resizePane(tree(), 3, "down", 0.1);
    expect(layout(lower).panes.get(2)?.h).toBeCloseTo(0.6);
    const clamped = setRatio(tree(), [], 5);
    expect(clamped.kind === "split" && clamped.ratio).toBe(0.9);
  });
});
