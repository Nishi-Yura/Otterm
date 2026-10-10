import type { Highlights } from "./highlights";
import type { Link } from "./links";
import { DEFAULT_ATTR, type ScreenModel } from "./model";
import { Palette, type Theme } from "./palette";
import { CursorShape, Flags } from "./protocol";
import type { Selection } from "./selection";

export interface FontConfig {
  family: string;
  /** CSS pixels (decision I9). */
  size: number;
  lineHeight: number;
  weight: number;
  weightBold: number;
}

/** Used until the configuration arrives. */
export const DEFAULT_FONT: FontConfig = {
  family: '"Cascadia Mono", "SF Mono", Menlo, "DejaVu Sans Mono", "BIZ UDGothic", "Noto Sans Mono CJK JP", monospace',
  size: 14,
  lineHeight: 1.2,
  weight: 400,
  weightBold: 700,
};

/**
 * Canvas 2D renderer: the fallback backend of docs/02 §1.2 and the first one built. Draws only the
 * rows the model marks dirty, at most once per animation frame. Cells are whole device pixels so
 * glyphs stay sharp (docs/03 §2.3).
 */
export class CanvasRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly palette = new Palette();
  private dpr = 1;
  /** Cell size in device pixels. */
  cellWidth = 0;
  cellHeight = 0;
  private baseline = 0;
  private scheduled = false;
  focused = true;
  selection: Selection | undefined;
  highlights: Highlights | undefined;
  /** The link under the pointer while Ctrl is held: underlined. */
  link: Link | undefined;
  /** Called after each draw, e.g. to move the IME anchor to the cursor. */
  onDraw: (() => void) | undefined;
  /** Also called after each draw; for measurements (the typing bench). */
  afterDraw: (() => void) | undefined;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly model: ScreenModel,
    private font: FontConfig = DEFAULT_FONT,
  ) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas is not available");
    this.ctx = ctx;
    this.measure();
  }

  private fontFor(flags: number): string {
    const weight = flags & Flags.BOLD ? this.font.weightBold : this.font.weight;
    const style = flags & Flags.ITALIC ? "italic " : "";
    return `${style}${weight} ${this.font.size * this.dpr}px ${this.font.family}`;
  }

  get currentFont(): FontConfig {
    return this.font;
  }

  /** Change the font; the caller refits the grid since the cell size changes. */
  setFont(font: FontConfig): void {
    this.font = font;
    this.measure();
    this.invalidate();
  }

  setTheme(theme: Theme): void {
    this.palette.setTheme(theme);
    this.invalidate();
  }

  /** Recompute the cell size for the current font and display scale. */
  measure(): void {
    this.dpr = window.devicePixelRatio || 1;
    this.ctx.font = this.fontFor(0);
    const m = this.ctx.measureText("M");
    this.cellWidth = Math.max(1, Math.round(m.width));
    this.cellHeight = Math.max(1, Math.round(this.font.size * this.font.lineHeight * this.dpr));
    const ascent = m.fontBoundingBoxAscent || this.font.size * this.dpr * 0.8;
    const descent = m.fontBoundingBoxDescent || this.font.size * this.dpr * 0.2;
    this.baseline = Math.round((this.cellHeight - (ascent + descent)) / 2 + ascent);
  }

  /** How many cells fit in a box of CSS pixels. */
  gridSize(cssWidth: number, cssHeight: number): { cols: number; rows: number } {
    return {
      cols: Math.max(2, Math.floor((cssWidth * this.dpr) / this.cellWidth)),
      rows: Math.max(1, Math.floor((cssHeight * this.dpr) / this.cellHeight)),
    };
  }

  /** The cell under a point in CSS pixels relative to the canvas, clamped to the grid. */
  cellAt(cssX: number, cssY: number): { row: number; col: number } {
    const col = Math.floor((cssX * this.dpr) / this.cellWidth);
    const row = Math.floor((cssY * this.dpr) / this.cellHeight);
    return {
      row: Math.min(Math.max(row, 0), Math.max(0, this.model.rows - 1)),
      col: Math.min(Math.max(col, 0), Math.max(0, this.model.cols - 1)),
    };
  }

  /** Cell height in CSS pixels. */
  get lineHeightCss(): number {
    return this.cellHeight / this.dpr;
  }

  /** Redraw every row, e.g. after the selection changed. */
  invalidate(): void {
    for (let r = 0; r < this.model.rows; r++) this.model.dirty.add(r);
    this.schedule();
  }

  /** Size the canvas for the model's grid. */
  resizeCanvas(): void {
    const w = this.model.cols * this.cellWidth;
    const h = this.model.rows * this.cellHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.style.width = `${w / this.dpr}px`;
      this.canvas.style.height = `${h / this.dpr}px`;
      for (let r = 0; r < this.model.rows; r++) this.model.dirty.add(r);
    }
  }

  /** Draw the dirty rows on the next animation frame. */
  schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.draw();
    });
  }

  draw(): void {
    this.resizeCanvas();
    for (const row of this.model.dirty) this.drawRow(row);
    this.model.dirty.clear();
    this.drawCursor();
    this.onDraw?.();
    this.afterDraw?.();
  }

  /** The cursor cell in CSS pixels, relative to the canvas. */
  cursorRect(): { x: number; y: number; width: number; height: number } {
    return {
      x: (this.model.cursorCol * this.cellWidth) / this.dpr,
      y: (this.model.cursorRow * this.cellHeight) / this.dpr,
      width: this.cellWidth / this.dpr,
      height: this.cellHeight / this.dpr,
    };
  }

  private drawRow(row: number): void {
    const line = this.model.lines[row];
    if (!line) return;
    const { ctx, cellWidth: cw, cellHeight: ch } = this;
    const theme = this.palette.theme;
    const y = row * ch;

    ctx.fillStyle = theme.background;
    ctx.fillRect(0, y, this.model.cols * cw, ch);
    const lineNo = this.model.topLine + row;
    const selected = this.selection?.colsOn(this.model, lineNo);
    const found = this.highlights?.colsOn(lineNo, this.model.cols) ?? [];
    const findColors = searchColors(theme.background);

    /** A cell already drawn as the second half of a flag. */
    let skip = -1;
    for (let col = 0; col < this.model.cols; col++) {
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
      const x = col * cw;

      if (bg !== theme.background) {
        ctx.fillStyle = bg;
        ctx.fillRect(x, y, cw * span, ch);
      }

      const cp = line.codepoints[col] ?? 32;
      if (cp !== 32 && !(attr.flags & Flags.HIDDEN)) {
        let text = String.fromCodePoint(cp) + (line.extras.get(col) ?? "");
        // A flag is two regional indicators in two cells; drawn together they make one glyph
        // across both (issue #7). The second one is then skipped.
        if (isRegionalIndicator(cp) && pairedWithNext(line.codepoints, col)) {
          text += String.fromCodePoint(line.codepoints[col + 1] ?? 32);
          skip = col + 1;
        } else if (skip === col) {
          continue;
        }
        ctx.font = this.fontFor(attr.flags);
        ctx.fillStyle = fg;
        ctx.globalAlpha = attr.flags & Flags.DIM ? 0.6 : 1;
        ctx.fillText(text, x, y + this.baseline);
        ctx.globalAlpha = 1;
      }

      const thickness = Math.max(1, Math.round(this.dpr));
      const w = cw * span;
      const under = y + ch - 2 * thickness;
      if (this.inLink(row, col)) {
        ctx.fillStyle = fg;
        ctx.fillRect(x, under, w, thickness);
      } else if (attr.flags & Flags.CURLY_UNDERLINE) {
        this.wave(x, under, w, thickness, this.palette.resolve(attr.underline, fg));
      } else if (attr.flags & Flags.DOUBLE_UNDERLINE) {
        ctx.fillStyle = this.palette.resolve(attr.underline, fg);
        // Two lines with a gap as wide as a line, so they read as two at any size.
        ctx.fillRect(x, y + ch - thickness, w, thickness);
        ctx.fillRect(x, y + ch - 3 * thickness, w, thickness);
      } else if (attr.flags & Flags.UNDERLINE) {
        ctx.fillStyle = this.palette.resolve(attr.underline, fg);
        ctx.fillRect(x, under, w, thickness);
      }
      if (attr.flags & Flags.OVERLINE) {
        ctx.fillStyle = fg;
        ctx.fillRect(x, y, w, thickness);
      }
      if (attr.flags & Flags.STRIKE) {
        ctx.fillStyle = fg;
        ctx.fillRect(x, y + Math.round(ch / 2), w, thickness);
      }
    }
  }

  /** Curly underline (SGR 4:3), as used by editors for spelling and diagnostics. The phase follows
   * the column so neighbouring cells join into one wave. */
  private wave(x: number, baseline: number, width: number, thickness: number, color: string): void {
    const { ctx } = this;
    const amp = thickness * 1.5;
    const period = Math.max(4, this.cellWidth / 2);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, baseline - amp * 2, width, amp * 4 + thickness);
    ctx.clip();
    ctx.beginPath();
    const start = Math.floor(x / period) * period;
    for (let px = start; px <= x + width + period; px += 1) {
      const py = baseline - amp * Math.sin(((px % (2 * period)) / period) * Math.PI);
      if (px === start) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;
    ctx.stroke();
    ctx.restore();
  }

  private inLink(row: number, col: number): boolean {
    const l = this.link;
    if (!l) return false;
    const afterStart = row > l.start.row || (row === l.start.row && col >= l.start.col);
    const beforeEnd = row < l.end.row || (row === l.end.row && col <= l.end.col);
    return afterStart && beforeEnd;
  }

  private drawCursor(): void {
    const m = this.model;
    if (!m.cursorVisible || m.rows === 0) return;
    const { ctx, cellWidth: cw, cellHeight: ch } = this;
    const x = m.cursorCol * cw;
    const y = m.cursorRow * ch;
    const attr = m.lines[m.cursorRow]?.attrs[m.cursorCol] ?? DEFAULT_ATTR;
    const w = attr.flags & Flags.WIDE ? cw * 2 : cw;
    ctx.fillStyle = this.palette.theme.cursor;
    if (!this.focused) {
      ctx.strokeStyle = this.palette.theme.cursor;
      ctx.lineWidth = Math.max(1, Math.round(this.dpr));
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, ch - 1);
      return;
    }
    if (m.cursorShape === CursorShape.Bar) {
      ctx.fillRect(x, y, Math.max(2, Math.round(2 * this.dpr)), ch);
    } else if (m.cursorShape === CursorShape.Underline) {
      ctx.fillRect(x, y + ch - Math.round(2 * this.dpr), w, Math.round(2 * this.dpr));
    } else {
      ctx.fillRect(x, y, w, ch);
      const line = m.lines[m.cursorRow];
      const cp = line?.codepoints[m.cursorCol] ?? 32;
      if (cp !== 32) {
        ctx.font = this.fontFor(attr.flags);
        ctx.fillStyle = this.palette.theme.background;
        ctx.fillText(String.fromCodePoint(cp) + (line?.extras.get(m.cursorCol) ?? ""), x, y + this.baseline);
      }
    }
  }
}

/** Search highlight colors that stand out on dark and on light backgrounds. */
function searchColors(background: string): { match: string; current: string; currentText: string } {
  const n = Number.parseInt(background.slice(1), 16);
  const luma = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return luma < 128
    ? { match: "#5a4a12", current: "#f0c674", currentText: "#1b1d23" }
    : { match: "#fff0a8", current: "#f5a623", currentText: "#000000" };
}

const isRegionalIndicator = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff;

/** Regional indicators pair from the left: the one at `col` starts a flag when an even number of
 * indicators come before it in the run. */
function pairedWithNext(codepoints: Uint32Array, col: number): boolean {
  if (!isRegionalIndicator(codepoints[col + 1] ?? 0)) return false;
  let before = 0;
  for (let c = col - 1; c >= 0 && isRegionalIndicator(codepoints[c] ?? 0); c--) before++;
  return before % 2 === 0;
}
