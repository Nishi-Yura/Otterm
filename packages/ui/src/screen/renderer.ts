import type { Highlights } from "./highlights";
import type { Link } from "./links";
import type { Theme } from "./palette";
import { Flags } from "./protocol";
import type { Selection } from "./selection";

export interface FontConfig {
  family: string;
  /** CSS pixels (decision I9). */
  size: number;
  lineHeight: number;
  /** Extra space between cells in CSS pixels (may be negative). */
  letterSpacing: number;
  weight: number;
  weightBold: number;
}

/** Used until the configuration arrives. */
export const DEFAULT_FONT: FontConfig = {
  family: '"Cascadia Mono", "SF Mono", Menlo, "DejaVu Sans Mono", "BIZ UDGothic", "Noto Sans Mono CJK JP", monospace',
  size: 14,
  lineHeight: 1.2,
  letterSpacing: 0,
  weight: 400,
  weightBold: 700,
};

/**
 * What the terminal view needs from a renderer backend (docs/02 §1.2): WebGL2 first, Canvas 2D
 * as the fallback. Both draw the rows the model marks dirty, at most once per animation frame.
 */
export interface Renderer {
  /** Cell size in device pixels. */
  readonly cellWidth: number;
  readonly cellHeight: number;
  /** Cell height in CSS pixels. */
  readonly lineHeightCss: number;
  readonly currentFont: FontConfig;
  /** `appearance.minimum_contrast`; 1 draws colors exactly as the program asked. */
  minimumContrast: number;
  focused: boolean;
  selection: Selection | undefined;
  highlights: Highlights | undefined;
  /** The link under the pointer while Ctrl is held: underlined. */
  link: Link | undefined;
  /** Called after each draw, e.g. to move the IME anchor to the cursor. */
  onDraw: (() => void) | undefined;
  /** Also called after each draw; for measurements (the typing bench). */
  afterDraw: (() => void) | undefined;
  /** Change the font; the caller refits the grid since the cell size changes. */
  setFont(font: FontConfig): void;
  setTheme(theme: Theme): void;
  /** Recompute the cell size for the current font and display scale. */
  measure(): void;
  /** How many cells fit in a box of CSS pixels. */
  gridSize(cssWidth: number, cssHeight: number): { cols: number; rows: number };
  /** The cell under a point in CSS pixels relative to the canvas, clamped to the grid. */
  cellAt(cssX: number, cssY: number): { row: number; col: number };
  /** Redraw every row, e.g. after the selection changed. */
  invalidate(): void;
  /** Draw the dirty rows on the next animation frame. */
  schedule(): void;
  /** The cursor cell in CSS pixels, relative to the canvas. */
  cursorRect(): { x: number; y: number; width: number; height: number };
  /** Release GPU resources when the view goes away. */
  dispose(): void;
}

/** Cell metrics for a font at a display scale, in device pixels. */
export interface Metrics {
  cellWidth: number;
  cellHeight: number;
  baseline: number;
  /** Device pixels from a cell's left edge to its glyph (half the letter spacing). */
  glyphOffset: number;
}

/** The CSS font for text with these SGR flags, sized in device pixels. */
export function cssFont(font: FontConfig, flags: number, dpr: number): string {
  const weight = flags & Flags.BOLD ? font.weightBold : font.weight;
  const style = flags & Flags.ITALIC ? "italic " : "";
  return `${style}${weight} ${font.size * dpr}px ${font.family}`;
}

/** Cells are whole device pixels so glyphs stay sharp (docs/03 §2.3). */
export function measureFont(ctx: CanvasRenderingContext2D, font: FontConfig, dpr: number): Metrics {
  ctx.font = cssFont(font, 0, dpr);
  const m = ctx.measureText("M");
  const spacing = font.letterSpacing * dpr;
  const cellWidth = Math.max(1, Math.round(m.width + spacing));
  const cellHeight = Math.max(1, Math.round(font.size * font.lineHeight * dpr));
  const ascent = m.fontBoundingBoxAscent || font.size * dpr * 0.8;
  const descent = m.fontBoundingBoxDescent || font.size * dpr * 0.2;
  return {
    cellWidth,
    cellHeight,
    baseline: Math.round((cellHeight - (ascent + descent)) / 2 + ascent),
    // Glyphs sit in the middle of the space they gained or lost.
    glyphOffset: spacing === 0 ? 0 : Math.round((cellWidth - m.width) / 2),
  };
}

/** Search highlight colors that stand out on dark and on light backgrounds. */
export function searchColors(background: string): { match: string; current: string; currentText: string } {
  const n = Number.parseInt(background.slice(1), 16);
  const luma = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return luma < 128
    ? { match: "#5a4a12", current: "#f0c674", currentText: "#1b1d23" }
    : { match: "#fff0a8", current: "#f5a623", currentText: "#000000" };
}

/** Whether (row, col) is inside the hovered link. */
export function inLink(l: Link | undefined, row: number, col: number): boolean {
  if (!l) return false;
  const afterStart = row > l.start.row || (row === l.start.row && col >= l.start.col);
  const beforeEnd = row < l.end.row || (row === l.end.row && col <= l.end.col);
  return afterStart && beforeEnd;
}
