/**
 * Minimum contrast (`appearance.minimum_contrast`): text whose color is too close to its
 * background is moved toward black or white until it is readable. Programs often pick colors for
 * a dark background; this keeps them legible on a light theme and the other way round.
 */

type Rgb = [number, number, number];

function parse(color: string): Rgb | undefined {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (!m?.[1]) return undefined;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

const hex = (c: Rgb) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** WCAG relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 21;
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Rounded to whole values, so the color written out is the one that was measured. */
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

/** The least change of `fg`, toward black or white, that reaches `min` against `bg`. */
function adjust(fg: Rgb, bg: Rgb, min: number): Rgb {
  const bgLum = luminance(bg);
  const ratio = (c: Rgb) => {
    const l = luminance(c);
    return (Math.max(l, bgLum) + 0.05) / (Math.min(l, bgLum) + 0.05);
  };
  const toward = (target: Rgb): { t: number; color: Rgb } | undefined => {
    if (ratio(target) < min) return undefined;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (ratio(mix(fg, target, mid)) >= min) hi = mid;
      else lo = mid;
    }
    return { t: hi, color: mix(fg, target, hi) };
  };
  const dark = toward([0, 0, 0]);
  const light = toward([255, 255, 255]);
  if (dark && light) return dark.t <= light.t ? dark.color : light.color;
  if (dark) return dark.color;
  if (light) return light.color;
  // Neither end reaches it: take the end with more contrast.
  return ratio([0, 0, 0]) >= ratio([255, 255, 255]) ? [0, 0, 0] : [255, 255, 255];
}

const cache = new Map<string, string>();

/**
 * `fg`, or a color near it with at least `min` contrast against `bg`. A `min` of 1 turns this off;
 * text drawn in its own background color stays invisible, as the program meant.
 */
export function readable(fg: string, bg: string, min: number): string {
  if (min <= 1 || fg === bg) return fg;
  const key = `${fg}${bg}${min}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const f = parse(fg);
  const b = parse(bg);
  const out = !f || !b || contrastRatio(fg, bg) >= min ? fg : hex(adjust(f, b, min));
  if (cache.size > 4096) cache.clear();
  cache.set(key, out);
  return out;
}
