/**
 * Split layouts (docs/03 §3.2) as an immutable tree. Leaves are panes, identified by number; a
 * split holds two subtrees side by side (`row`) or stacked (`column`).
 */
export type PaneNode =
  | { kind: "leaf"; id: number }
  | { kind: "split"; dir: "row" | "column"; ratio: number; a: PaneNode; b: PaneNode };

/** A rectangle as fractions of the tab area. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A divider between the two sides of a split, for dragging. `path` locates the split. */
export interface Divider {
  path: ("a" | "b")[];
  dir: "row" | "column";
  rect: Rect;
  /** The split's own rectangle, to turn a drag position into a ratio. */
  parent: Rect;
}

const MIN_RATIO = 0.1;

export const leaf = (id: number): PaneNode => ({ kind: "leaf", id });

export function leaves(node: PaneNode): number[] {
  return node.kind === "leaf" ? [node.id] : [...leaves(node.a), ...leaves(node.b)];
}

/** Replace pane `target` with a split of it and `added` (placed after it). */
export function splitPane(node: PaneNode, target: number, added: number, dir: "row" | "column"): PaneNode {
  if (node.kind === "leaf") {
    return node.id === target ? { kind: "split", dir, ratio: 0.5, a: node, b: leaf(added) } : node;
  }
  return { ...node, a: splitPane(node.a, target, added, dir), b: splitPane(node.b, target, added, dir) };
}

/** Give pane `from` the id `to`, keeping its place. */
export function renamePane(node: PaneNode, from: number, to: number): PaneNode {
  if (node.kind === "leaf") return node.id === from ? leaf(to) : node;
  return { ...node, a: renamePane(node.a, from, to), b: renamePane(node.b, from, to) };
}

/** Remove a pane; its sibling takes the parent's place. `undefined` when the last pane goes. */
export function removePane(node: PaneNode, target: number): PaneNode | undefined {
  if (node.kind === "leaf") return node.id === target ? undefined : node;
  const a = removePane(node.a, target);
  const b = removePane(node.b, target);
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

/** Each pane's rectangle, and the dividers between them. */
export function layout(node: PaneNode, rect: Rect = { x: 0, y: 0, w: 1, h: 1 }) {
  const panes = new Map<number, Rect>();
  const dividers: Divider[] = [];
  const walk = (n: PaneNode, r: Rect, path: ("a" | "b")[]) => {
    if (n.kind === "leaf") {
      panes.set(n.id, r);
      return;
    }
    if (n.dir === "row") {
      const wa = r.w * n.ratio;
      walk(n.a, { ...r, w: wa }, [...path, "a"]);
      walk(n.b, { ...r, x: r.x + wa, w: r.w - wa }, [...path, "b"]);
      dividers.push({ path, dir: n.dir, rect: { x: r.x + wa, y: r.y, w: 0, h: r.h }, parent: r });
    } else {
      const ha = r.h * n.ratio;
      walk(n.a, { ...r, h: ha }, [...path, "a"]);
      walk(n.b, { ...r, y: r.y + ha, h: r.h - ha }, [...path, "b"]);
      dividers.push({ path, dir: n.dir, rect: { x: r.x, y: r.y + ha, w: r.w, h: 0 }, parent: r });
    }
  };
  walk(node, rect, []);
  return { panes, dividers };
}

/** Set the ratio of the split at `path`. */
export function setRatio(node: PaneNode, path: ("a" | "b")[], ratio: number): PaneNode {
  if (node.kind === "leaf") return node;
  const [head, ...rest] = path;
  if (head === undefined) return { ...node, ratio: Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio)) };
  return head === "a" ? { ...node, a: setRatio(node.a, rest, ratio) } : { ...node, b: setRatio(node.b, rest, ratio) };
}

export type Direction = "left" | "right" | "up" | "down";

/** The pane next to `from` in a direction: the nearest one beside it that overlaps it. */
export function neighbor(node: PaneNode, from: number, dir: Direction): number | undefined {
  const { panes } = layout(node);
  const r = panes.get(from);
  if (!r) return undefined;
  const eps = 1e-6;
  let best: { id: number; dist: number } | undefined;
  for (const [id, o] of panes) {
    if (id === from) continue;
    const horizontal = dir === "left" || dir === "right";
    const overlaps = horizontal
      ? o.y < r.y + r.h - eps && o.y + o.h > r.y + eps
      : o.x < r.x + r.w - eps && o.x + o.w > r.x + eps;
    if (!overlaps) continue;
    const dist =
      dir === "left"
        ? r.x - (o.x + o.w)
        : dir === "right"
          ? o.x - (r.x + r.w)
          : dir === "up"
            ? r.y - (o.y + o.h)
            : o.y - (r.y + r.h);
    if (dist < -eps) continue;
    if (!best || dist < best.dist) best = { id, dist };
  }
  return best?.id;
}

/**
 * Move the divider nearest to pane `target` on the arrow's axis by `amount`, in the arrow's
 * direction (as in Windows Terminal): Alt+Shift+Right moves it right whichever side `target` is on.
 */
export function resizePane(node: PaneNode, target: number, dir: Direction, amount: number): PaneNode {
  const axis = dir === "left" || dir === "right" ? "row" : "column";
  // The deepest split on the axis that contains the target decides.
  const find = (n: PaneNode, path: ("a" | "b")[]): { path: ("a" | "b")[]; side: "a" | "b" } | undefined => {
    if (n.kind === "leaf") return undefined;
    const side = leaves(n.a).includes(target) ? "a" : leaves(n.b).includes(target) ? "b" : undefined;
    if (!side) return undefined;
    const deeper = find(side === "a" ? n.a : n.b, [...path, side]);
    if (deeper) return deeper;
    return n.dir === axis ? { path, side } : undefined;
  };
  const hit = find(node, []);
  if (!hit) return node;
  let split: PaneNode = node;
  for (const step of hit.path) if (split.kind === "split") split = split[step];
  if (split.kind !== "split") return node;
  // Moving the divider right/down grows side a; left/up grows side b.
  const towardB = dir === "right" || dir === "down";
  const delta = (towardB ? 1 : -1) * Math.abs(amount);
  return setRatio(node, hit.path, split.ratio + delta);
}
