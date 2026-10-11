import { cssFont, type FontConfig, type Metrics } from "./renderer";
import { type GlyphBitmap, type GlyphItem, type RunGroup, textGlyphs, textRuns } from "./text";

/** A glyph in the atlas, positioned relative to the top-left corner of its cell. */
export interface Glyph {
  /** Atlas position and size in texels; a zero size draws nothing (a blank glyph, or one still
   * being rasterized). */
  u: number;
  v: number;
  w: number;
  h: number;
  /** Offset of the bitmap from the cell's top-left corner, in device pixels. */
  x: number;
  y: number;
  /** Emoji and other color glyphs keep their own colors; the rest are tinted with the text color. */
  color: boolean;
}

const EMPTY: Glyph = { u: 0, v: 0, w: 0, h: 0, x: 0, y: 0, color: false };

/** How a run of cells is drawn once shaped: one glyph per group of characters. */
export interface RunLayout {
  groups: { start: number; len: number; glyph: Glyph }[];
}
/** Requested from Rust, not back yet. */
const PENDING: Glyph = { ...EMPTY };

/** Printable ASCII is rasterized ahead, so typing never waits for a glyph. */
const PREWARM = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i));

/**
 * Glyphs rasterized by Rust (decision C4) and packed into one texture in rows (shelves). Missing
 * glyphs are requested in batches and drawn once they arrive; until then their cells are blank.
 * When the texture is full the atlas starts over and the renderer rebuilds every row. If Rust
 * cannot rasterize (no font installed), the browser's Canvas 2D draws the glyphs instead.
 */
export class GlyphAtlas {
  readonly size: number;
  private readonly glyphs = new Map<string, Glyph>();
  private readonly scratch: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** Room around a cell's box for glyphs that reach outside it (italics, tall symbols, emoji). */
  private padX = 0;
  private padY = 0;
  private shelfX = 0;
  private shelfY = 0;
  private shelfHeight = 0;
  /** Set when the atlas filled up and started over; the renderer clears it after rebuilding. */
  overflowed = false;
  /** Called when requested glyphs arrived, so the rows showing them are drawn again. */
  onReady: (() => void) | undefined;
  private queue: { key: string; item: GlyphItem }[] = [];
  private readonly runs = new Map<string, RunLayout | undefined>();
  private runQueue: { key: string; item: GlyphItem }[] = [];
  private flushing = false;
  /** Bumped by `reset`; replies from before a reset are dropped. */
  private generation = 0;
  /** Rust could not rasterize this font list; glyphs come from Canvas 2D. */
  private local = false;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly texture: WebGLTexture,
    private font: FontConfig,
    private metrics: Metrics,
    private dpr: number,
  ) {
    this.size = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    this.scratch = document.createElement("canvas");
    const ctx = this.scratch.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas is not available");
    this.ctx = ctx;
    this.allocate();
    this.reset(font, metrics, dpr);
  }

  private allocate(): void {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.size, this.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Forget every glyph, for a new font or display scale. */
  reset(font: FontConfig, metrics: Metrics, dpr: number): void {
    this.font = font;
    this.metrics = metrics;
    this.dpr = dpr;
    this.generation++;
    this.queue = [];
    this.runQueue = [];
    this.local = false;
    this.clear();
    this.padX = Math.ceil(metrics.cellWidth / 2);
    this.padY = Math.ceil(metrics.cellHeight / 3);
    this.scratch.width = metrics.cellWidth * 2 + this.padX * 2;
    this.scratch.height = metrics.cellHeight + this.padY * 2;
  }

  /** Request printable ASCII ahead of use; the renderer calls this after its first draw. */
  prewarm(): void {
    for (const style of [0, 1]) for (const ch of PREWARM) this.get(ch, style);
  }

  private clear(): void {
    this.glyphs.clear();
    this.runs.clear();
    this.shelfX = 0;
    this.shelfY = 0;
    this.shelfHeight = 0;
  }

  /** The glyph for a grapheme cluster in a style (bit 0 bold, bit 2 italic, as `Flags`). */
  get(text: string, style: number): Glyph {
    const key = `${style}|${text}`;
    let g = this.glyphs.get(key);
    if (g) return g;
    if (this.local) {
      g = this.rasterize(text, style);
      this.glyphs.set(key, g);
      return g;
    }
    this.glyphs.set(key, PENDING);
    this.queue.push({ key, item: { text, bold: (style & 1) !== 0, italic: (style & 4) !== 0 } });
    this.scheduleFlush();
    return PENDING;
  }

  /**
   * The layout of a run of cells shaped as one piece (ligatures), or undefined while Rust is
   * still shaping it; the caller then draws the cells one by one.
   */
  run(text: string, style: number): RunLayout | undefined {
    const key = `${style}|${text}`;
    if (this.local) return undefined;
    const layout = this.runs.get(key);
    if (layout !== undefined || this.runs.has(key)) return layout;
    this.runs.set(key, undefined);
    this.runQueue.push({ key, item: { text, bold: (style & 1) !== 0, italic: (style & 4) !== 0 } });
    this.scheduleFlush();
    return undefined;
  }

  private scheduleFlush(): void {
    if (this.flushing) return;
    this.flushing = true;
    // Collect everything a row build asks for into one request.
    queueMicrotask(() => {
      this.flushing = false;
      void this.flush();
      void this.flushRuns();
    });
  }

  private async flushRuns(): Promise<void> {
    const batch = this.runQueue;
    this.runQueue = [];
    if (batch.length === 0) return;
    const generation = this.generation;
    let runs: RunGroup[][];
    try {
      runs = await textRuns(
        this.font.families,
        this.font.size * this.dpr,
        batch.map((b) => b.item),
      );
    } catch (e) {
      if (generation !== this.generation) return;
      console.warn("run shaping unavailable:", e);
      for (const b of batch) this.runs.delete(b.key);
      return;
    }
    if (generation !== this.generation) return;
    for (const [i, b] of batch.entries()) {
      const groups = runs[i] ?? [];
      const style = (b.item.bold ? 1 : 0) | (b.item.italic ? 4 : 0);
      const layout: RunLayout = { groups: [] };
      for (const g of groups) {
        // Fonts draw a ligature from its first character and leave the others blank, so a group
        // depends on its run, not only on its own characters.
        const key = `g${style}|${b.item.text}|${g.start}`;
        let glyph = this.glyphs.get(key);
        if (!glyph) {
          glyph = EMPTY;
          if (g.bitmap) {
            const up = this.upload(new ImageData(g.bitmap.data, g.bitmap.width, g.bitmap.height), g.bitmap.color);
            if (up) {
              up.x = g.bitmap.left + this.metrics.glyphOffset;
              up.y = this.metrics.baseline + g.bitmap.top;
              glyph = up;
            }
          }
          this.glyphs.set(key, glyph);
        }
        layout.groups.push({ start: g.start, len: g.len, glyph });
      }
      this.runs.set(b.key, layout);
    }
    this.onReady?.();
  }

  private async flush(): Promise<void> {
    const batch = this.queue;
    this.queue = [];
    if (batch.length === 0) return;
    const generation = this.generation;
    let bitmaps: (GlyphBitmap | null)[];
    try {
      bitmaps = await textGlyphs(
        this.font.families,
        this.font.size * this.dpr,
        batch.map((b) => b.item),
      );
    } catch (e) {
      if (generation !== this.generation) return;
      console.warn("glyphs from Rust unavailable, using Canvas 2D:", e);
      this.local = true;
      for (const b of batch)
        this.glyphs.set(b.key, this.rasterize(b.item.text, (b.item.bold ? 1 : 0) | (b.item.italic ? 4 : 0)));
      this.onReady?.();
      return;
    }
    if (generation !== this.generation) return;
    for (const [i, b] of batch.entries()) {
      const bitmap = bitmaps[i];
      let g = EMPTY;
      if (bitmap) {
        const uploaded = this.upload(new ImageData(bitmap.data, bitmap.width, bitmap.height), bitmap.color);
        if (uploaded) {
          uploaded.x = bitmap.left + this.metrics.glyphOffset;
          uploaded.y = this.metrics.baseline + bitmap.top;
          g = uploaded;
        }
      }
      if (this.glyphs.get(b.key) === PENDING) this.glyphs.set(b.key, g);
    }
    this.onReady?.();
  }

  /** One period of the curly underline across one cell, drawn so neighbouring cells join. */
  wave(thickness: number): Glyph {
    const key = `~wave${thickness}`;
    let g = this.glyphs.get(key);
    if (g) return g;
    const { ctx, scratch } = this;
    const cw = this.metrics.cellWidth;
    const amp = thickness * 1.5;
    const h = Math.ceil(amp * 4 + thickness);
    ctx.clearRect(0, 0, scratch.width, scratch.height);
    ctx.beginPath();
    const period = Math.max(4, cw / 2);
    for (let px = 0; px <= cw; px++) {
      const py = amp * 2 - amp * Math.sin(((px % (2 * period)) / period) * Math.PI);
      if (px === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = thickness;
    ctx.stroke();
    g = this.upload(ctx.getImageData(0, 0, cw, h), false) ?? EMPTY;
    g.y = Math.round(-amp * 2);
    this.glyphs.set(key, g);
    return g;
  }

  /** The Canvas 2D fallback: the browser draws the cluster and the pixels it touched go up. */
  private rasterize(text: string, style: number): Glyph {
    const { ctx, scratch, padX, padY } = this;
    ctx.clearRect(0, 0, scratch.width, scratch.height);
    ctx.font = cssFont(this.font, style, this.dpr);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, padX + this.metrics.glyphOffset, padY + this.metrics.baseline);
    const data = ctx.getImageData(0, 0, scratch.width, scratch.height).data;
    let x0 = scratch.width;
    let y0 = scratch.height;
    let x1 = -1;
    let y1 = -1;
    let color = false;
    for (let y = 0; y < scratch.height; y++) {
      for (let x = 0; x < scratch.width; x++) {
        const i = (y * scratch.width + x) * 4;
        if (data[i + 3] === 0) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        // White text stays gray at its edges; anything else is a color glyph (emoji).
        if (!color && (data[i] !== data[i + 1] || data[i + 1] !== data[i + 2])) color = true;
      }
    }
    if (x1 < 0) return EMPTY;
    const g = this.upload(ctx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1), color);
    if (!g) return EMPTY;
    g.x = x0 - padX;
    g.y = y0 - padY;
    return g;
  }

  /** Copy a bitmap into the atlas. The caller sets the glyph's offset in its cell. */
  private upload(pixels: ImageData, color: boolean): Glyph | undefined {
    const { width: w, height: h } = pixels;
    if (w > this.size || h > this.size) return undefined;
    if (this.shelfX + w > this.size) {
      this.shelfY += this.shelfHeight + 1;
      this.shelfX = 0;
      this.shelfHeight = 0;
    }
    if (this.shelfY + h > this.size) {
      // Full: start over. Glyphs handed out so far point at texels about to be reused, so the
      // renderer rebuilds every row once this draw ends.
      this.clear();
      this.overflowed = true;
    }
    const u = this.shelfX;
    const v = this.shelfY;
    this.shelfX += w + 1;
    this.shelfHeight = Math.max(this.shelfHeight, h);
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, u, v, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return { u, v, w, h, x: 0, y: 0, color };
  }
}
