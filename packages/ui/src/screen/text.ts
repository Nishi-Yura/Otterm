import { invoke } from "@tauri-apps/api/core";

/** Bindings for the text commands in crates/otterm-app/src/text.rs (decisions C3, C4). */

/** Grid metrics of the primary font at a pixel size, from Rust. */
export interface TextMetrics {
  /** Advance of `M` in device pixels. */
  advance: number;
  ascent: number;
  descent: number;
}

export const textMetrics = (families: string[], sizePx: number) =>
  invoke<TextMetrics>("text_metrics", { req: { families, sizePx } });

export interface GlyphItem {
  text: string;
  bold: boolean;
  italic: boolean;
}

/** A rasterized cluster: straight-alpha RGBA, white where the text color goes unless `color`. */
export interface GlyphBitmap {
  width: number;
  height: number;
  /** Offset from the pen at the baseline, x right, y down. */
  left: number;
  top: number;
  color: boolean;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** Bitmaps for `items`, in order; null for a cluster with nothing to draw. */
export async function textGlyphs(
  families: string[],
  sizePx: number,
  items: GlyphItem[],
): Promise<(GlyphBitmap | null)[]> {
  const buf = await invoke<ArrayBuffer>("text_glyphs", { req: { families, sizePx, items } });
  const v = new DataView(buf);
  const out: (GlyphBitmap | null)[] = [];
  let p = 0;
  for (let i = 0; i < items.length && p + 10 <= buf.byteLength; i++) {
    const width = v.getUint16(p, true);
    const height = v.getUint16(p + 2, true);
    const left = v.getInt16(p + 4, true);
    const top = v.getInt16(p + 6, true);
    const color = v.getUint8(p + 8) !== 0;
    p += 10;
    if (width === 0 || height === 0) {
      out.push(null);
      continue;
    }
    const n = width * height * 4;
    out.push({ width, height, left, top, color, data: new Uint8ClampedArray(buf.slice(p, p + n)) });
    p += n;
  }
  while (out.length < items.length) out.push(null);
  return out;
}
