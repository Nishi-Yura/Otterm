/**
 * Kotsume's sprite (docs/08 §3): the four moods from assets/mascot/src/ (written by
 * scripts/mascot.py), with an outfit's layers on top (§6.4).
 *
 * Outfit SVGs come from mods, so they are never put into the page as they are: only `<rect>`
 * elements with numeric geometry and a plain color (or a `--ot-mascot-*` variable) survive.
 */
import alert from "../../../../assets/mascot/src/alert.svg?raw";
import calm from "../../../../assets/mascot/src/calm.svg?raw";
import happy from "../../../../assets/mascot/src/happy.svg?raw";
import thinking from "../../../../assets/mascot/src/thinking.svg?raw";

export type Mood = "calm" | "thinking" | "alert" | "happy";
export const MOODS: Mood[] = ["calm", "thinking", "alert", "happy"];

/** An installed outfit as `mascot_outfits` returns it (crates/otterm-app/src/mascot.rs). */
export interface OutfitInfo {
  id: string;
  name: string;
  custom: boolean;
  layers: [string, string][];
  moods: Record<string, string>;
  lines: Record<string, Record<string, string>>;
}

const BUILTIN: Record<Mood, string> = { calm, thinking, alert, happy };

/** Slots drawn under the base sprite; the rest go on top, in this order (docs/08 §6.4). */
const UNDER = ["back"];
const OVER = ["shell", "body", "face", "head", "hand", "effect"];

const NUMBER = /^\d{1,3}(\.\d+)?$/;
const COLOR = /^(#[0-9a-f]{3,8}|var\(--ot-mascot-[a-z-]+,\s*#[0-9a-f]{3,8}\))$/i;

/** The rectangles of an SVG, each rebuilt from checked attributes; everything else is dropped. */
export function rects(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const out: string[] = [];
  for (const r of Array.from(doc.getElementsByTagName("rect"))) {
    const geo = ["x", "y", "width", "height"].map((a) => r.getAttribute(a) ?? "");
    const fill = r.getAttribute("fill") ?? "";
    if (!geo.every((v) => NUMBER.test(v)) || !COLOR.test(fill)) continue;
    out.push(`<rect x="${geo[0]}" y="${geo[1]}" width="${geo[2]}" height="${geo[3]}" fill="${fill}"/>`);
  }
  return out.join("");
}

/** The base sprite's groups (`body`, `face`, `hand`), so the pebble can roll on its own. */
function groups(svg: string): { id: string; body: string }[] {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  return Array.from(doc.getElementsByTagName("g")).map((g) => ({
    id: g.getAttribute("id") ?? "",
    body: rects(new XMLSerializer().serializeToString(g)),
  }));
}

const cache = new Map<string, string>();

/** The SVG markup of one mood, with the outfit's layers. Safe to put into the page. */
export function sprite(mood: Mood, outfit?: OutfitInfo): string {
  const key = `${outfit?.id ?? ""}/${mood}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const override = outfit?.moods[mood];
  const base = override ? [{ id: "body", body: rects(override) }] : groups(BUILTIN[mood]);
  const layer = (slots: string[]) =>
    (outfit?.layers ?? [])
      .filter(([slot]) => slots.includes(slot))
      .sort((a, b) => slots.indexOf(a[0]) - slots.indexOf(b[0]))
      .map(([slot, svg]) => `<g class="mascot-${slot}">${rects(svg)}</g>`)
      .join("");
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">' +
    layer(UNDER) +
    base.map((g) => `<g class="mascot-${g.id}">${g.body}</g>`).join("") +
    layer(OVER) +
    "</svg>";
  cache.set(key, svg);
  return svg;
}

/** Outfits changed (installed, removed): rebuild the sprites. */
export function clearSpriteCache(): void {
  cache.clear();
}
