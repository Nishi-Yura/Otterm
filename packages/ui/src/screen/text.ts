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

/** One glyph of a shaped run and the characters `start..start + len` it covers. */
export interface RunGroup {
  start: number;
  len: number;
  bitmap: GlyphBitmap | null;
}

/** Runs of cells shaped as one piece each (ligatures). Bitmaps are relative to the group's first cell. */
export async function textRuns(
  families: string[],
  sizePx: number,
  cellWidth: number,
  items: GlyphItem[],
): Promise<RunGroup[][]> {
  const buf = await invoke<ArrayBuffer>("text_runs", { req: { families, sizePx, cellWidth, items } });
  const v = new DataView(buf);
  const out: RunGroup[][] = [];
  let p = 0;
  for (let i = 0; i < items.length && p + 2 <= buf.byteLength; i++) {
    const groups: RunGroup[] = [];
    let n = v.getUint16(p, true);
    p += 2;
    for (; n > 0 && p + 14 <= buf.byteLength; n--) {
      const start = v.getUint16(p, true);
      const len = v.getUint16(p + 2, true);
      p += 4;
      const bitmap = readBitmap(v, buf, p);
      p = bitmap.next;
      groups.push({ start, len, bitmap: bitmap.value });
    }
    out.push(groups);
  }
  while (out.length < items.length) out.push([]);
  return out;
}

function readBitmap(v: DataView, buf: ArrayBuffer, p: number): { value: GlyphBitmap | null; next: number } {
  const width = v.getUint16(p, true);
  const height = v.getUint16(p + 2, true);
  const left = v.getInt16(p + 4, true);
  const top = v.getInt16(p + 6, true);
  const color = v.getUint8(p + 8) !== 0;
  p += 10;
  if (width === 0 || height === 0) return { value: null, next: p };
  const n = width * height * 4;
  return { value: { width, height, left, top, color, data: new Uint8ClampedArray(buf.slice(p, p + n)) }, next: p + n };
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
    const bitmap = readBitmap(v, buf, p);
    p = bitmap.next;
    out.push(bitmap.value);
  }
  while (out.length < items.length) out.push(null);
  return out;
}
