/*
 * Glyph atlas (docs/09 §3.7: LRU, 64 MB).
 *
 * The atlas is one RGBA8 texture of at most 4096 x 4096 texels (64 MB). It is split into PAGES
 * horizontal bands of equal height, and each band is a page: glyphs are packed into the page's
 * shelves (rows), so the texture stays one bound texture and the shader needs no change. When the
 * current page is full, the page that was used least recently is emptied and reused; only its
 * glyphs go, the others stay. A page records the frame it was last drawn in, and a page hit in the
 * current frame is never chosen while another page is older. Evicting a page drops the cached
 * ligature layouts (they may point into it) and sets `overflowed`, so the renderer rebuilds the
 * rows that were drawn from the old contents. No per-glyph allocation is added in the hot path.
 */
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

/** Bands of the atlas texture; each is evicted on its own (4 x 16 MB at 4096 px). */
const PAGES = 4;

/** Printable ASCII is rasterized ahead, so typing never waits for a glyph. */
const PREWARM = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) => String.fromCharCode(0x21 + i));

/**
 * Glyphs rasterized by Rust (decision C4) and packed into one texture in rows (shelves), split into
 * LRU pages (see the comment at the top of this file). Missing glyphs are requested in batches and
 * drawn once they arrive; until then their cells are blank. If Rust cannot rasterize (no font
 * installed), the browser's Canvas 2D draws the glyphs instead.
 */
export class GlyphAtlas {
  readonly size: number;
  /** Height of one page (band) in texels. */
  private readonly pageHeight: number;
  /** Per page: the cache keys whose glyphs it holds, and the frame it was last drawn in. */
  private readonly pages: { keys: string[]; used: number }[] = Array.from({ length: PAGES }, () => ({
    keys: [],
    used: -1,
  }));
  /** The page being filled. */
  private page = 0;
  /** Incremented by `beginFrame`; pages are stamped with it. */
  private frame = 0;
  /** Incremented on every eviction; a run layout built across one is not kept. */
  private epoch = 0;
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
    this.pageHeight = Math.floor(this.size / PAGES);
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

  /** Called at the start of each draw: glyphs drawn from now on count as used in this frame. */
  beginFrame(): void {
    this.frame++;
  }

  /** Mark the page a glyph lives in as used in this frame. */
  private touch(g: Glyph): void {
    if (g.w > 0) this.pageAt((g.v / this.pageHeight) | 0).used = this.frame;
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
    for (const p of this.pages) {
      p.keys.length = 0;
      p.used = -1;
    }
    this.page = 0;
    this.startPage();
  }

  private pageAt(i: number): { keys: string[]; used: number } {
    return this.pages[i] as { keys: string[]; used: number };
  }

  /** Put the shelf cursor at the top-left of the current page. */
  private startPage(): void {
    this.shelfX = 0;
    this.shelfY = this.page * this.pageHeight;
    this.shelfHeight = 0;
  }

  /** Move to the page used least recently (an unused one first) and empty it. */
  private nextPage(): void {
    // Start after the current page so ties go round in order; the current page comes last.
    let pick = -1;
    for (let i = 1; i <= PAGES; i++) {
      const p = (this.page + i) % PAGES;
      if (pick < 0 || this.pageAt(p).used < this.pageAt(pick).used) pick = p;
    }
    const old = this.pageAt(pick);
    if (old.keys.length > 0) {
      for (const key of old.keys) this.glyphs.delete(key);
      old.keys.length = 0;
      this.runs.clear();
      this.epoch++;
      // Rows drawn from the evicted glyphs must be built again.
      this.overflowed = true;
    }
    this.page = pick;
    this.startPage();
  }

  /** The glyph for a grapheme cluster in a style (bit 0 bold, bit 2 italic, as `Flags`). */
  get(text: string, style: number): Glyph {
    const key = `${style}|${text}`;
    let g = this.glyphs.get(key);
    if (g) {
      this.touch(g);
      return g;
    }
    if (this.local) {
      g = this.rasterize(text, style, key);
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
    if (layout !== undefined) {
      for (const group of layout.groups) this.touch(group.glyph);
      return layout;
    }
    if (this.runs.has(key)) return layout;
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
      const epoch = this.epoch;
      for (const g of groups) {
        // Fonts draw a ligature from its first character and leave the others blank, so a group
        // depends on its run, not only on its own characters.
        const key = `g${style}|${b.item.text}|${g.start}`;
        let glyph = this.glyphs.get(key);
        if (!glyph) {
          glyph = EMPTY;
          if (g.bitmap) {
            const up = this.upload(new ImageData(g.bitmap.data, g.bitmap.width, g.bitmap.height), g.bitmap.color, key);
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
      // An eviction while building this layout may have emptied one of its glyphs' pages.
      if (epoch === this.epoch) this.runs.set(b.key, layout);
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
        this.glyphs.set(b.key, this.rasterize(b.item.text, (b.item.bold ? 1 : 0) | (b.item.italic ? 4 : 0), b.key));
      this.onReady?.();
      return;
    }
    if (generation !== this.generation) return;
    for (const [i, b] of batch.entries()) {
      const bitmap = bitmaps[i];
      let g = EMPTY;
      if (bitmap) {
        const uploaded = this.upload(new ImageData(bitmap.data, bitmap.width, bitmap.height), bitmap.color, b.key);
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
    const cached = this.glyphs.get(key);
    if (cached) {
      this.touch(cached);
      return cached;
    }
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
    const up = this.upload(ctx.getImageData(0, 0, cw, h), false, key);
    if (!up) {
      this.glyphs.set(key, EMPTY);
      return EMPTY;
    }
    up.y = Math.round(-amp * 2);
    this.glyphs.set(key, up);
    return up;
  }

  /** The Canvas 2D fallback: the browser draws the cluster and the pixels it touched go up. */
  private rasterize(text: string, style: number, key: string): Glyph {
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
    const g = this.upload(ctx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1), color, key);
    if (!g) return EMPTY;
    g.x = x0 - padX;
    g.y = y0 - padY;
    return g;
  }

  /** Copy a bitmap into the atlas under a cache key. The caller sets the glyph's offset in its cell. */
  private upload(pixels: ImageData, color: boolean, key: string): Glyph | undefined {
    const { width: w, height: h } = pixels;
    if (w > this.size || h > this.pageHeight) return undefined;
    if (this.shelfX + w > this.size) {
      this.shelfY += this.shelfHeight + 1;
      this.shelfX = 0;
      this.shelfHeight = 0;
    }
    // The page is full: move on to the least recently used one. Its old glyphs are dropped.
    if (this.shelfY + h > (this.page + 1) * this.pageHeight) this.nextPage();
    const u = this.shelfX;
    const v = this.shelfY;
    this.shelfX += w + 1;
    this.shelfHeight = Math.max(this.shelfHeight, h);
    const page = this.pageAt(this.page);
    page.used = this.frame;
    page.keys.push(key);
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, u, v, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return { u, v, w, h, x: 0, y: 0, color };
  }
}
