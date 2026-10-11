import { readable } from "./contrast";
import { type Glyph, GlyphAtlas } from "./glyphAtlas";
import type { Highlights } from "./highlights";
import type { Link } from "./links";
import { DEFAULT_ATTR, type Line, type ScreenModel } from "./model";
import { Palette, type Theme } from "./palette";
import { type Attr, CursorShape, Flags } from "./protocol";
import {
  DEFAULT_FONT,
  type FontConfig,
  inLink,
  type Metrics,
  measureFont,
  metricsFromText,
  type Renderer,
  searchColors,
} from "./renderer";
import type { Selection } from "./selection";
import type { TextMetrics } from "./text";

/** Characters programming fonts make ligatures from (`->`, `=>`, `!=`, `::`, `...`, `</`, `&&`). */
const LIGATURE_CHARS = new Set("-=<>!~|&:+*/#?.%$@^\\".split("").map((c) => c.charCodeAt(0)));

/** A cell that can be part of a shaped run: one column wide, visible, with a character. */
function runnable(cp: number, attr: Attr): boolean {
  return cp !== 32 && !(attr.flags & (Flags.WIDE | Flags.WIDE_SPACER | Flags.HIDDEN));
}

/** Floats per glyph instance: x, y, w, h (pixels), u, v, uw, vh (texels), color (RGBA8), mode. */
const GLYPH_STRIDE = 10;
/** Floats per rectangle instance: x, y, w, h (pixels), color (RGBA8). */
const RECT_STRIDE = 5;

const QUAD_VS = `#version 300 es
// A unit quad from the vertex id (triangle strip), so no vertex buffer is needed.
vec2 corner() { return vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)); }
uniform vec2 u_resolution;
vec4 clip(vec2 px) { vec2 c = px / u_resolution * 2.0 - 1.0; return vec4(c.x, -c.y, 0.0, 1.0); }
`;

/** Cell backgrounds: one instance per cell, placed by its index. */
const BG_VS = `${QUAD_VS}
uniform vec2 u_cell;
uniform int u_cols;
in vec4 a_color;
out vec4 v_color;
void main() {
  vec2 cell = vec2(float(gl_InstanceID % u_cols), float(gl_InstanceID / u_cols));
  gl_Position = clip((cell + corner()) * u_cell);
  v_color = a_color;
}`;

const RECT_VS = `${QUAD_VS}
in vec4 a_rect;
in vec4 a_color;
out vec4 v_color;
void main() {
  gl_Position = clip(a_rect.xy + corner() * a_rect.zw);
  v_color = a_color;
}`;

const COLOR_FS = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 o;
void main() { o = vec4(v_color.rgb * v_color.a, v_color.a); }`;

const GLYPH_VS = `${QUAD_VS}
uniform vec2 u_atlas;
in vec4 a_rect;
in vec4 a_uv;
in vec4 a_color;
in float a_mode;
out vec2 v_uv;
out vec4 v_color;
out float v_mode;
void main() {
  vec2 c = corner();
  gl_Position = clip(a_rect.xy + c * a_rect.zw);
  v_uv = (a_uv.xy + c * a_uv.zw) / u_atlas;
  v_color = a_color;
  v_mode = a_mode;
}`;

/**
 * Atlas texels are premultiplied. Plain glyphs are white coverage tinted with the text color.
 * Blending linear coverage straight in sRGB makes dark text on a light background look heavier
 * than light text on a dark one; the coverage curve bends with the text's lightness so both read
 * at the weight the font was designed for.
 */
const GLYPH_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform vec2 u_gamma;
in vec2 v_uv;
in vec4 v_color;
in float v_mode;
out vec4 o;
void main() {
  vec4 t = texture(u_tex, v_uv);
  if (v_mode > 0.5) { o = t * v_color.a; return; }
  float lum = dot(v_color.rgb, vec3(0.2126, 0.7152, 0.0722));
  float a = pow(t.a, mix(u_gamma.x, u_gamma.y, lum));
  o = vec4(v_color.rgb, 1.0) * a * v_color.a;
}`;

/** Coverage exponents for black and for white text (see GLYPH_FS). */
const GAMMA_DARK = 1.25;
const GAMMA_LIGHT = 0.9;

/** A growable instance list: floats, with colors stored as RGBA8 in float slots. */
class Instances {
  f32: Float32Array;
  u32: Uint32Array;
  count = 0;

  constructor(
    readonly stride: number,
    capacity = 64,
  ) {
    this.f32 = new Float32Array(capacity * stride);
    this.u32 = new Uint32Array(this.f32.buffer);
  }

  /** Index of the first float of a new instance. */
  push(): number {
    if ((this.count + 1) * this.stride > this.f32.length) {
      const next = new Float32Array(this.f32.length * 2);
      next.set(this.f32);
      this.f32 = next;
      this.u32 = new Uint32Array(next.buffer);
    }
    return this.count++ * this.stride;
  }

  append(other: Instances): void {
    while ((this.count + other.count) * this.stride > this.f32.length) {
      const next = new Float32Array(this.f32.length * 2);
      next.set(this.f32);
      this.f32 = next;
      this.u32 = new Uint32Array(next.buffer);
    }
    this.f32.set(other.f32.subarray(0, other.count * other.stride), this.count * this.stride);
    this.count += other.count;
  }

  get data(): Float32Array {
    return this.f32.subarray(0, this.count * this.stride);
  }
}

/** What one row draws, kept until the row changes. */
interface RowCache {
  glyphs: Instances;
  /** Column of each glyph, to recolor the one under a block cursor. */
  glyphCols: number[];
  /** Decorations drawn over the text: underlines, strikethrough, overline. */
  rects: Instances;
}

interface Program {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

/**
 * WebGL2 renderer, the primary backend of docs/02 §1.2. Rows are turned into instance lists only
 * when they change; every frame then draws the whole grid in four instanced passes: cell
 * backgrounds, the block cursor, glyphs from the atlas, and decorations.
 */
export class WebGLRenderer implements Renderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly palette = new Palette();
  private readonly measureCtx: CanvasRenderingContext2D;
  private dpr = 1;
  private metrics: Metrics = { cellWidth: 1, cellHeight: 1, baseline: 0, glyphOffset: 0 };
  minimumContrast = 1;
  private scheduled = false;
  private lost = false;
  focused = true;
  selection: Selection | undefined;
  highlights: Highlights | undefined;
  link: Link | undefined;
  onDraw: (() => void) | undefined;
  afterDraw: (() => void) | undefined;
  onRemeasure: (() => void) | undefined;
  /** Rust's metrics for the current font and scale; Canvas 2D measurements until they arrive. */
  private text: TextMetrics | undefined;
  /** The atlas was asked for printable ASCII (after the first draw, so startup does not wait). */
  private warmed = false;

  private bgProgram!: Program;
  private rectProgram!: Program;
  private glyphProgram!: Program;
  private texture!: WebGLTexture;
  private atlas!: GlyphAtlas;
  /** Background of every cell, RGBA8, row by row. */
  private bg = new Uint32Array(0);
  private rows: RowCache[] = [];
  private readonly frameGlyphs = new Instances(GLYPH_STRIDE, 4096);
  private readonly frameRects = new Instances(RECT_STRIDE, 256);
  private readonly cursorRects = new Instances(RECT_STRIDE, 4);
  private readonly colors = new Map<string, number>();

  /** Throws when WebGL2 is not available; the caller then uses the Canvas 2D renderer. */
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly model: ScreenModel,
    private font: FontConfig = DEFAULT_FONT,
  ) {
    const gl = canvas.getContext("webgl2", {
      // A translucent default background (window opacity, a background image) needs the alpha.
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) throw new Error("2D canvas is not available");
    this.measureCtx = ctx;
    this.dpr = window.devicePixelRatio || 1;
    this.metrics = measureFont(ctx, font, this.dpr);
    this.setup();
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.onRestored);
  }

  private readonly onLost = (e: Event) => {
    // Lets the browser restore the context; until then nothing is drawn.
    e.preventDefault();
    this.lost = true;
  };

  private readonly onRestored = () => {
    this.lost = false;
    this.setup();
    this.invalidate();
  };

  private setup(): void {
    const { gl } = this;
    this.bgProgram = this.program(BG_VS, COLOR_FS, ["u_resolution", "u_cell", "u_cols"], () => {
      this.attrib("a_color", 4, gl.UNSIGNED_BYTE, true, 4, 0);
    });
    this.rectProgram = this.program(RECT_VS, COLOR_FS, ["u_resolution"], () => {
      const stride = RECT_STRIDE * 4;
      this.attrib("a_rect", 4, gl.FLOAT, false, stride, 0);
      this.attrib("a_color", 4, gl.UNSIGNED_BYTE, true, stride, 16);
    });
    this.glyphProgram = this.program(GLYPH_VS, GLYPH_FS, ["u_resolution", "u_atlas", "u_tex", "u_gamma"], () => {
      const stride = GLYPH_STRIDE * 4;
      this.attrib("a_rect", 4, gl.FLOAT, false, stride, 0);
      this.attrib("a_uv", 4, gl.FLOAT, false, stride, 16);
      this.attrib("a_color", 4, gl.UNSIGNED_BYTE, true, stride, 32);
      this.attrib("a_mode", 1, gl.FLOAT, false, stride, 36);
    });
    const texture = gl.createTexture();
    if (!texture) throw new Error("no texture");
    this.texture = texture;
    this.atlas = new GlyphAtlas(gl, texture, this.font, this.metrics, this.dpr);
    this.atlas.onReady = () => this.invalidate();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** The attribute being set up belongs to this program (set by `program`). */
  private current: WebGLProgram | undefined;

  private program(vs: string, fs: string, uniforms: string[], layout: () => void): Program {
    const { gl } = this;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type);
      if (!s) throw new Error("no shader");
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const program = gl.createProgram();
    if (!program) throw new Error("no program");
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link");
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    if (!vao || !buffer) throw new Error("no buffer");
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    this.current = program;
    layout();
    gl.bindVertexArray(null);
    const locations: Record<string, WebGLUniformLocation | null> = {};
    for (const u of uniforms) locations[u] = gl.getUniformLocation(program, u);
    return { program, vao, buffer, uniforms: locations };
  }

  private attrib(name: string, size: number, type: number, normalized: boolean, stride: number, offset: number): void {
    const { gl } = this;
    if (!this.current) return;
    const loc = gl.getAttribLocation(this.current, name);
    if (loc < 0) return;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, type, normalized, stride, offset);
    gl.vertexAttribDivisor(loc, 1);
  }

  get cellWidth(): number {
    return this.metrics.cellWidth;
  }

  get cellHeight(): number {
    return this.metrics.cellHeight;
  }

  get lineHeightCss(): number {
    return this.metrics.cellHeight / this.dpr;
  }

  get currentFont(): FontConfig {
    return this.font;
  }

  setFont(font: FontConfig, text?: TextMetrics): void {
    this.font = font;
    this.text = text;
    this.measure();
    this.invalidate();
  }

  setTheme(theme: Theme): void {
    this.palette.setTheme(theme);
    this.invalidate();
  }

  measure(): void {
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== this.dpr && this.text) {
      // Rust's metrics are for the old scale; ask for new ones (setFont follows).
      this.text = undefined;
      this.onRemeasure?.();
    }
    this.dpr = dpr;
    this.metrics = this.text
      ? metricsFromText(this.font, this.text, dpr)
      : measureFont(this.measureCtx, this.font, dpr);
    if (!this.lost) this.atlas.reset(this.font, this.metrics, dpr);
    this.warmed = false;
    this.rows = [];
  }

  gridSize(cssWidth: number, cssHeight: number): { cols: number; rows: number } {
    return {
      cols: Math.max(2, Math.floor((cssWidth * this.dpr) / this.cellWidth)),
      rows: Math.max(1, Math.floor((cssHeight * this.dpr) / this.cellHeight)),
    };
  }

  cellAt(cssX: number, cssY: number): { row: number; col: number } {
    const col = Math.floor((cssX * this.dpr) / this.cellWidth);
    const row = Math.floor((cssY * this.dpr) / this.cellHeight);
    return {
      row: Math.min(Math.max(row, 0), Math.max(0, this.model.rows - 1)),
      col: Math.min(Math.max(col, 0), Math.max(0, this.model.cols - 1)),
    };
  }

  invalidate(): void {
    for (let r = 0; r < this.model.rows; r++) this.model.dirty.add(r);
    this.schedule();
  }

  schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.draw();
    });
  }

  cursorRect(): { x: number; y: number; width: number; height: number } {
    return {
      x: (this.model.cursorCol * this.cellWidth) / this.dpr,
      y: (this.model.cursorRow * this.cellHeight) / this.dpr,
      width: this.cellWidth / this.dpr,
      height: this.cellHeight / this.dpr,
    };
  }

  dispose(): void {
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    // Browsers keep only a few WebGL contexts alive; give this one back now.
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  /** Size the canvas and the per-cell buffers for the model's grid. */
  private resize(): void {
    const { cols, rows } = this.model;
    const w = cols * this.cellWidth;
    const h = rows * this.cellHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.style.width = `${w / this.dpr}px`;
      this.canvas.style.height = `${h / this.dpr}px`;
    }
    if (this.bg.length !== cols * rows || this.rows.length !== rows) {
      this.bg = new Uint32Array(cols * rows);
      this.rows = Array.from({ length: rows }, () => ({
        glyphs: new Instances(GLYPH_STRIDE),
        glyphCols: [],
        rects: new Instances(RECT_STRIDE),
      }));
      for (let r = 0; r < rows; r++) this.model.dirty.add(r);
    }
  }

  draw(): void {
    if (this.lost || this.model.rows === 0) return;
    this.resize();
    for (const row of this.model.dirty) this.buildRow(row);
    if (this.atlas.overflowed) {
      // Rows built before the atlas started over point at reused texels.
      this.atlas.overflowed = false;
      for (let r = 0; r < this.model.rows; r++) this.buildRow(r);
    }
    this.model.dirty.clear();
    this.render();
    this.onDraw?.();
    this.afterDraw?.();
    if (!this.warmed) {
      this.warmed = true;
      setTimeout(() => this.atlas.prewarm(), 0);
    }
  }

  /** The default background's alpha, 0–255. */
  private backgroundAlpha(): number {
    return Math.round(Math.min(1, Math.max(0, this.palette.theme.backgroundAlpha ?? 1)) * 255);
  }

  /** `#rrggbb` as RGBA8 in memory order (little-endian u32), with an alpha. */
  private rgba(color: string, alpha = 255): number {
    let c = this.colors.get(color);
    if (c === undefined) {
      const n = Number.parseInt(color.slice(1), 16);
      c = ((n >> 16) & 255) | (((n >> 8) & 255) << 8) | ((n & 255) << 16);
      if (this.colors.size > 4096) this.colors.clear();
      this.colors.set(color, c);
    }
    return (c | (alpha << 24)) >>> 0;
  }

  private buildRow(row: number): void {
    const cache = this.rows[row];
    const line = this.model.lines[row];
    if (!cache) return;
    cache.glyphs.count = 0;
    cache.glyphCols.length = 0;
    cache.rects.count = 0;
    const { cols } = this.model;
    const { cellWidth: cw, cellHeight: ch } = this.metrics;
    const theme = this.palette.theme;
    const base = row * cols;
    const background = this.rgba(theme.background, this.backgroundAlpha());
    if (!line) {
      this.bg.fill(background, base, base + cols);
      return;
    }
    const y = row * ch;
    const lineNo = this.model.lineAt(row);
    const selected = this.selection?.colsOn(this.model, lineNo);
    const found = this.highlights?.colsOn(lineNo, cols) ?? [];
    const findColors = searchColors(theme.background);
    const thickness = Math.max(1, Math.round(this.dpr));
    const under = y + ch - 2 * thickness;
    const shaped = this.font.ligatures ? this.shapeRuns(line, cols) : undefined;

    for (let col = 0; col < cols; col++) {
      const attr = line.attrs[col] ?? DEFAULT_ATTR;
      if (attr.flags & Flags.WIDE_SPACER) continue;
      const span = attr.flags & Flags.WIDE ? 2 : 1;
      let fg = this.palette.resolve(attr.fg, theme.foreground);
      let bg = this.palette.resolve(attr.bg, theme.background);
      if (attr.flags & Flags.INVERSE) [fg, bg] = [bg, fg];
      for (const [from, to, current] of found) {
        if (col >= from && col < to) {
          bg = current ? findColors.current : findColors.match;
          if (current) fg = findColors.currentText;
        }
      }
      if (selected && col >= selected[0] && col < selected[1]) bg = theme.selection;
      const bgColor = bg === theme.background ? background : this.rgba(bg);
      this.bg[base + col] = bgColor;
      if (span === 2 && col + 1 < cols) this.bg[base + col + 1] = bgColor;
      const x = col * cw;

      const cp = line.codepoints[col] ?? 32;
      const run = shaped?.get(col);
      if (run === null) {
        // Covered by a ligature drawn from an earlier cell.
      } else if (cp !== 32 && !(attr.flags & Flags.HIDDEN)) {
        const g =
          run ??
          this.atlas.get(
            String.fromCodePoint(cp) + (line.extras.get(col) ?? ""),
            attr.flags & (Flags.BOLD | Flags.ITALIC),
          );
        if (g.w > 0) {
          const color = this.rgba(readable(fg, bg, this.minimumContrast), attr.flags & Flags.DIM ? 153 : 255);
          this.pushGlyph(cache.glyphs, x + g.x, y + g.y, g.w, g.h, g.u, g.v, color, g.color);
          cache.glyphCols.push(col);
        }
      }

      const w = cw * span;
      const fgColor = this.rgba(fg);
      if (inLink(this.link, row, col)) {
        this.pushRect(cache.rects, x, under, w, thickness, fgColor);
      } else if (attr.flags & Flags.CURLY_UNDERLINE) {
        const g = this.atlas.wave(thickness);
        const color = this.rgba(this.palette.resolve(attr.underline, fg));
        for (let i = 0; i < span; i++) {
          this.pushGlyph(cache.glyphs, x + i * cw, under + g.y, g.w, g.h, g.u, g.v, color, false);
          cache.glyphCols.push(-1);
        }
      } else if (attr.flags & Flags.DOUBLE_UNDERLINE) {
        const color = this.rgba(this.palette.resolve(attr.underline, fg));
        // Two lines with a gap as wide as a line, so they read as two at any size.
        this.pushRect(cache.rects, x, y + ch - thickness, w, thickness, color);
        this.pushRect(cache.rects, x, y + ch - 3 * thickness, w, thickness, color);
      } else if (attr.flags & Flags.UNDERLINE) {
        this.pushRect(cache.rects, x, under, w, thickness, this.rgba(this.palette.resolve(attr.underline, fg)));
      }
      if (attr.flags & Flags.OVERLINE) this.pushRect(cache.rects, x, y, w, thickness, fgColor);
      if (attr.flags & Flags.STRIKE) this.pushRect(cache.rects, x, y + Math.round(ch / 2), w, thickness, fgColor);
    }
  }

  /**
   * Runs of cells the font may join into ligatures (`font.ligatures`): neighbours with the same
   * style, not blank, holding at least one of the characters ligatures are made of. Returns the
   * glyph to draw at each cell of a shaped run, null for cells a ligature covers; cells of runs
   * still being shaped are absent and drawn one by one.
   */
  private shapeRuns(line: Line, cols: number): Map<number, Glyph | null> | undefined {
    let out: Map<number, Glyph | null> | undefined;
    let col = 0;
    while (col < cols) {
      const attr = line.attrs[col] ?? DEFAULT_ATTR;
      const cp = line.codepoints[col] ?? 32;
      if (!runnable(cp, attr)) {
        col++;
        continue;
      }
      let end = col + 1;
      while (end < cols && (line.attrs[end] ?? DEFAULT_ATTR) === attr && runnable(line.codepoints[end] ?? 32, attr))
        end++;
      if (end - col >= 2) {
        let text = "";
        let joins = false;
        const cellAt: number[] = [];
        for (let c = col; c < end; c++) {
          const cp = line.codepoints[c] ?? 32;
          joins ||= LIGATURE_CHARS.has(cp);
          const cell = String.fromCodePoint(cp) + (line.extras.get(c) ?? "");
          for (let i = 0; i < [...cell].length; i++) cellAt.push(c);
          text += cell;
        }
        if (joins) {
          const layout = this.atlas.run(text, attr.flags & (Flags.BOLD | Flags.ITALIC));
          if (layout) {
            out ??= new Map();
            for (const g of layout.groups) {
              const first = cellAt[g.start];
              if (first === undefined) continue;
              out.set(first, g.glyph);
              const last = cellAt[g.start + g.len - 1] ?? first;
              for (let c = first + 1; c <= last; c++) out.set(c, null);
            }
          }
        }
      }
      col = end;
    }
    return out;
  }

  private pushGlyph(
    list: Instances,
    x: number,
    y: number,
    w: number,
    h: number,
    u: number,
    v: number,
    color: number,
    colored: boolean,
  ): void {
    const i = list.push();
    const f = list.f32;
    f[i] = x;
    f[i + 1] = y;
    f[i + 2] = w;
    f[i + 3] = h;
    f[i + 4] = u;
    f[i + 5] = v;
    f[i + 6] = w;
    f[i + 7] = h;
    list.u32[i + 8] = color;
    f[i + 9] = colored ? 1 : 0;
  }

  private pushRect(list: Instances, x: number, y: number, w: number, h: number, color: number): void {
    const i = list.push();
    const f = list.f32;
    f[i] = x;
    f[i + 1] = y;
    f[i + 2] = w;
    f[i + 3] = h;
    list.u32[i + 4] = color;
  }

  private render(): void {
    const { gl, model } = this;
    const { cellWidth: cw, cellHeight: ch } = this.metrics;
    const theme = this.palette.theme;
    const width = this.canvas.width;
    const height = this.canvas.height;
    gl.viewport(0, 0, width, height);
    const bgc = this.rgba(theme.background);
    const a = this.backgroundAlpha() / 255;
    gl.clearColor(((bgc & 255) / 255) * a, (((bgc >> 8) & 255) / 255) * a, (((bgc >> 16) & 255) / 255) * a, a);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Gather the rows; the glyph under a block cursor takes the background color.
    const cursor = this.cursorShape();
    const glyphs = this.frameGlyphs;
    const rects = this.frameRects;
    glyphs.count = 0;
    rects.count = 0;
    for (let r = 0; r < this.rows.length; r++) {
      const row = this.rows[r] as RowCache;
      const start = glyphs.count;
      glyphs.append(row.glyphs);
      rects.append(row.rects);
      if (cursor === "block" && r === model.cursorRow) {
        const k = row.glyphCols.indexOf(model.cursorCol);
        if (k >= 0) glyphs.u32[(start + k) * GLYPH_STRIDE + 8] = this.rgba(theme.background);
      }
    }
    this.buildCursor(cursor);

    // 1. Cell backgrounds.
    let p = this.bgProgram;
    gl.useProgram(p.program);
    gl.uniform2f(p.uniforms.u_resolution ?? null, width, height);
    gl.uniform2f(p.uniforms.u_cell ?? null, cw, ch);
    gl.uniform1i(p.uniforms.u_cols ?? null, model.cols);
    gl.bindVertexArray(p.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, p.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.bg, gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, model.cols * model.rows);

    // 2. A block cursor, under its glyph.
    p = this.rectProgram;
    gl.useProgram(p.program);
    gl.uniform2f(p.uniforms.u_resolution ?? null, width, height);
    if (cursor === "block") this.drawRects(this.cursorRects);

    // 3. Glyphs.
    p = this.glyphProgram;
    gl.useProgram(p.program);
    gl.uniform2f(p.uniforms.u_resolution ?? null, width, height);
    gl.uniform2f(p.uniforms.u_atlas ?? null, this.atlas.size, this.atlas.size);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(p.uniforms.u_tex ?? null, 0);
    gl.uniform2f(p.uniforms.u_gamma ?? null, GAMMA_DARK, GAMMA_LIGHT);
    if (glyphs.count > 0) {
      gl.bindVertexArray(p.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, p.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, glyphs.data, gl.STREAM_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, glyphs.count);
    }

    // 4. Decorations, and the other cursor shapes over the text.
    p = this.rectProgram;
    gl.useProgram(p.program);
    if (cursor !== "block") rects.append(this.cursorRects);
    this.drawRects(rects);
    gl.bindVertexArray(null);
  }

  private drawRects(list: Instances): void {
    if (list.count === 0) return;
    const { gl } = this;
    gl.bindVertexArray(this.rectProgram.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rectProgram.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, list.data, gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, list.count);
  }

  private cursorShape(): "none" | "block" | "bar" | "underline" | "hollow" {
    const m = this.model;
    if (!m.cursorVisible || m.rows === 0) return "none";
    if (!this.focused) return "hollow";
    if (m.cursorShape === CursorShape.Bar) return "bar";
    if (m.cursorShape === CursorShape.Underline) return "underline";
    return "block";
  }

  private buildCursor(shape: ReturnType<WebGLRenderer["cursorShape"]>): void {
    const list = this.cursorRects;
    list.count = 0;
    if (shape === "none") return;
    const m = this.model;
    const { cellWidth: cw, cellHeight: ch } = this.metrics;
    const x = m.cursorCol * cw;
    const y = m.cursorRow * ch;
    const attr = m.lines[m.cursorRow]?.attrs[m.cursorCol] ?? DEFAULT_ATTR;
    const w = attr.flags & Flags.WIDE ? cw * 2 : cw;
    const color = this.rgba(this.palette.theme.cursor);
    const t = Math.max(1, Math.round(this.dpr));
    const t2 = Math.max(2, Math.round(2 * this.dpr));
    if (shape === "block") this.pushRect(list, x, y, w, ch, color);
    else if (shape === "bar") this.pushRect(list, x, y, t2, ch, color);
    else if (shape === "underline") this.pushRect(list, x, y + ch - t2, w, t2, color);
    else {
      this.pushRect(list, x, y, w, t, color);
      this.pushRect(list, x, y + ch - t, w, t, color);
      this.pushRect(list, x, y, t, ch, color);
      this.pushRect(list, x + w - t, y, t, ch, color);
    }
  }
}
