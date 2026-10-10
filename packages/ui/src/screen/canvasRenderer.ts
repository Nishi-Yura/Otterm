import { DEFAULT_ATTR, type ScreenModel } from "./model";
import { Palette } from "./palette";
import { CursorShape, Flags } from "./protocol";

export interface FontConfig {
  family: string;
  /** CSS pixels (decision I9). */
  size: number;
  lineHeight: number;
}

export const DEFAULT_FONT: FontConfig = {
  family: '"Cascadia Mono", "SF Mono", Menlo, "DejaVu Sans Mono", "BIZ UDGothic", "Noto Sans Mono CJK JP", monospace',
  size: 14,
  lineHeight: 1.25,
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

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly model: ScreenModel,
    private readonly font: FontConfig = DEFAULT_FONT,
  ) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas is not available");
    this.ctx = ctx;
    this.measure();
  }

  private fontFor(flags: number): string {
    const weight = flags & Flags.BOLD ? "bold " : "";
    const style = flags & Flags.ITALIC ? "italic " : "";
    return `${style}${weight}${this.font.size * this.dpr}px ${this.font.family}`;
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
  }

  private drawRow(row: number): void {
    const line = this.model.lines[row];
    if (!line) return;
    const { ctx, cellWidth: cw, cellHeight: ch } = this;
    const theme = this.palette.theme;
    const y = row * ch;

    ctx.fillStyle = theme.background;
    ctx.fillRect(0, y, this.model.cols * cw, ch);

    for (let col = 0; col < this.model.cols; col++) {
      const attr = line.attrs[col] ?? DEFAULT_ATTR;
      if (attr.flags & Flags.WIDE_SPACER) continue;
      const span = attr.flags & Flags.WIDE ? 2 : 1;
      let fg = this.palette.resolve(attr.fg, theme.foreground);
      let bg = this.palette.resolve(attr.bg, theme.background);
      if (attr.flags & Flags.INVERSE) [fg, bg] = [bg, fg];
      const x = col * cw;

      if (bg !== theme.background) {
        ctx.fillStyle = bg;
        ctx.fillRect(x, y, cw * span, ch);
      }

      const cp = line.codepoints[col] ?? 32;
      if (cp !== 32 && !(attr.flags & Flags.HIDDEN)) {
        ctx.font = this.fontFor(attr.flags);
        ctx.fillStyle = fg;
        ctx.globalAlpha = attr.flags & Flags.DIM ? 0.6 : 1;
        ctx.fillText(String.fromCodePoint(cp) + (line.extras.get(col) ?? ""), x, y + this.baseline);
        ctx.globalAlpha = 1;
      }

      const thickness = Math.max(1, Math.round(this.dpr));
      if (attr.flags & (Flags.UNDERLINE | Flags.DOUBLE_UNDERLINE | Flags.CURLY_UNDERLINE)) {
        ctx.fillStyle = this.palette.resolve(attr.underline, fg);
        ctx.fillRect(x, y + ch - 2 * thickness, cw * span, thickness);
        if (attr.flags & Flags.DOUBLE_UNDERLINE) ctx.fillRect(x, y + ch - 4 * thickness, cw * span, thickness);
      }
      if (attr.flags & Flags.STRIKE) {
        ctx.fillStyle = fg;
        ctx.fillRect(x, y + Math.round(ch / 2), cw * span, thickness);
      }
    }
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
