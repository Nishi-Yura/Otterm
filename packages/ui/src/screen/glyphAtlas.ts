import { cssFont, type FontConfig, type Metrics } from "./renderer";

/** A glyph in the atlas, positioned relative to the top-left corner of its cell. */
export interface Glyph {
  /** Atlas position and size in texels; a zero size draws nothing (a blank glyph). */
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

/**
 * Glyphs rasterized once by the browser's Canvas 2D and packed into one texture in rows (shelves).
 * When it is full the atlas starts over; the renderer then rebuilds every row. Rasterizing in Rust
 * instead (decision C4) replaces only this class.
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
    this.clear();
    this.padX = Math.ceil(metrics.cellWidth / 2);
    this.padY = Math.ceil(metrics.cellHeight / 3);
    this.scratch.width = metrics.cellWidth * 2 + this.padX * 2;
    this.scratch.height = metrics.cellHeight + this.padY * 2;
  }

  private clear(): void {
    this.glyphs.clear();
    this.shelfX = 0;
    this.shelfY = 0;
    this.shelfHeight = 0;
  }

  /** The glyph for a grapheme cluster in a style (only bold and italic change its shape). */
  get(text: string, style: number, wide: boolean): Glyph {
    const key = `${style}${wide ? "w" : ""}|${text}`;
    let g = this.glyphs.get(key);
    if (!g) {
      g = this.rasterize(text, style);
      this.glyphs.set(key, g);
    }
    return g;
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
    g = this.upload(0, 0, cw, h, Math.round(-amp * 2), false) ?? EMPTY;
    this.glyphs.set(key, g);
    return g;
  }

  private rasterize(text: string, style: number): Glyph {
    const { ctx, scratch, padX, padY } = this;
    ctx.clearRect(0, 0, scratch.width, scratch.height);
    ctx.font = cssFont(this.font, style, this.dpr);
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, padX + this.metrics.glyphOffset, padY + this.metrics.baseline);
    // Only the pixels the glyph touched go to the atlas.
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
    const g = this.upload(x0, y0, x1 - x0 + 1, y1 - y0 + 1, 0, color);
    if (!g) return EMPTY;
    g.x = x0 - padX;
    g.y = y0 - padY;
    return g;
  }

  /** Copy a region of the scratch canvas into the atlas. `y` is the glyph's offset in its cell. */
  private upload(sx: number, sy: number, w: number, h: number, y: number, color: boolean): Glyph | undefined {
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
    const pixels = this.ctx.getImageData(sx, sy, w, h);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, u, v, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return { u, v, w, h, x: 0, y, color };
  }
}
