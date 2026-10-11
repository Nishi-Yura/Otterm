import { platform } from "./keys";
import type { Link } from "./screen/links";
import type { ScreenModel } from "./screen/model";
import type { Renderer } from "./screen/renderer";
import type { Selection, SelectionMode } from "./screen/selection";
import type { MouseInput, Session } from "./session";

/** Lines per wheel notch (a notch is 100 px of `deltaY` in Chromium). */
const LINES_PER_NOTCH = 3;
/** Most wheel reports sent to an application per event, so a fast flick cannot flood it. */
const MAX_WHEEL_REPORTS = 10;
/** How often the view scrolls while a selection is dragged past the top or bottom edge. */
const AUTOSCROLL_MS = 50;

export interface PointerHost {
  canvas: HTMLCanvasElement;
  renderer: Renderer;
  model: ScreenModel;
  selection: Selection;
  session: () => Session | undefined;
  /** A selection was made (for copy-on-select). */
  onSelect?: () => void;
  /** The link under a cell, if any. */
  linkAt?: (row: number, col: number) => Link | undefined;
  /** Ctrl+click (Cmd+click on macOS) on a link (decision I2). */
  openLink?: (link: Link) => void;
  /** The link under the pointer while the open modifier is held, for the underline. */
  hoverLink?: (link: Link | undefined) => void;
  /** Right-click outside mouse reporting; `x`/`y` are client coordinates. */
  menu?: (x: number, y: number, shift: boolean) => void;
}

/** The modifier that turns a click into "open the link". */
const openModifier = (e: MouseEvent) => (platform === "macos" ? e.metaKey : e.ctrlKey);

const BUTTONS = ["left", "middle", "right"] as const;

/**
 * Mouse handling on the grid (docs/03 §5, decision I5): reports to the application when it asked
 * for the mouse (Shift bypasses that, as in xterm), otherwise selection and scrolling.
 * Returns a function that removes the listeners.
 */
export function attachPointer(h: PointerHost): () => void {
  const { canvas, renderer, model, selection } = h;
  /** DOM button being reported to the application, between press and release. */
  let reportedButton: number | undefined;
  let selecting = false;
  let lastCell = { row: -1, col: -1 };
  let wheelLines = 0;
  let lastAutoscroll = 0;

  const cellOf = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return renderer.cellAt(e.clientX - r.left, e.clientY - r.top);
  };
  const reporting = (e: MouseEvent) => model.mouseMode !== 0 && !e.shiftKey;
  const report = (button: MouseInput["button"], action: MouseInput["action"], e: MouseEvent) => {
    const { row, col } = cellOf(e);
    void h.session()?.mouse({ button, action, row, col, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey });
  };

  const onDown = (e: MouseEvent) => {
    if (e.button > 2) return;
    if (e.button === 0 && openModifier(e)) {
      const { row, col } = cellOf(e);
      const link = h.linkAt?.(row, col);
      if (link) {
        e.preventDefault();
        h.openLink?.(link);
        return;
      }
    }
    if (reporting(e)) {
      e.preventDefault();
      reportedButton = e.button;
      lastCell = cellOf(e);
      report(BUTTONS[e.button] ?? "left", "press", e);
      return;
    }
    if (e.button !== 0) return;
    const { row, col } = cellOf(e);
    const line = model.lineAt(row);
    if (line < 0) return;
    const at = { line, col };
    const mode: SelectionMode = e.detail >= 3 ? "line" : e.detail === 2 ? "word" : e.altKey ? "block" : "char";
    if (e.shiftKey && selection.active && mode === "char") selection.extend(at);
    else selection.start(at, mode);
    selecting = true;
    renderer.invalidate();
  };

  const onMove = (e: MouseEvent) => {
    if (reportedButton !== undefined || (model.mouseMode === 3 && reporting(e) && e.target === canvas)) {
      const cell = cellOf(e);
      if (cell.row === lastCell.row && cell.col === lastCell.col) return;
      lastCell = cell;
      report(reportedButton === undefined ? "none" : (BUTTONS[reportedButton] ?? "left"), "motion", e);
      return;
    }
    if (!selecting) {
      if (e.target === canvas && openModifier(e)) {
        const { row, col } = cellOf(e);
        h.hoverLink?.(h.linkAt?.(row, col));
      } else {
        h.hoverLink?.(undefined);
      }
      return;
    }
    const r = canvas.getBoundingClientRect();
    // Dragging past the edge scrolls the history so the selection can grow beyond the view.
    const edge = e.clientY < r.top ? 1 : e.clientY > r.bottom ? -1 : 0;
    if (edge !== 0 && performance.now() - lastAutoscroll > AUTOSCROLL_MS && !model.altScreen) {
      lastAutoscroll = performance.now();
      void h.session()?.scroll(edge);
    }
    const { row, col } = cellOf(e);
    const line = model.lineAt(row);
    if (line < 0) return;
    selection.extend({ line, col });
    renderer.invalidate();
  };

  const onUp = (e: MouseEvent) => {
    if (reportedButton !== undefined) {
      if (e.button === reportedButton) {
        report(BUTTONS[reportedButton] ?? "left", "release", e);
        reportedButton = undefined;
      }
      return;
    }
    if (!selecting) return;
    selecting = false;
    if (selection.empty) {
      selection.clear();
      renderer.invalidate();
    } else {
      h.onSelect?.();
    }
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const lines =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? e.deltaY
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? e.deltaY * model.rows
          : (e.deltaY * LINES_PER_NOTCH) / 100;
    wheelLines += lines;
    const n = Math.trunc(wheelLines);
    if (n === 0) return;
    wheelLines -= n;
    if (reporting(e)) {
      for (let i = 0; i < Math.min(Math.abs(n), MAX_WHEEL_REPORTS); i++) {
        report(n < 0 ? "wheelUp" : "wheelDown", "press", e);
      }
      return;
    }
    // deltaY > 0 moves toward the newest output, which is scrolling the view down.
    void h.session()?.scroll(-n);
  };

  // otterm's own menu instead of the browser's (decision I1). While the application has the mouse,
  // the right button goes to it; Shift+right-click still opens the menu.
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    if (!reporting(e)) h.menu?.(e.clientX, e.clientY, e.shiftKey);
  };

  // Letting go of the modifier ends the link hover.
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === "Control" || e.key === "Meta") h.hoverLink?.(undefined);
  };

  canvas.addEventListener("mousedown", onDown);
  window.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  return () => {
    canvas.removeEventListener("mousedown", onDown);
    window.removeEventListener("keyup", onKeyUp);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("contextmenu", onContextMenu);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
}
