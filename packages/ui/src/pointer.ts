import type { CanvasRenderer } from "./screen/canvasRenderer";
import type { ScreenModel } from "./screen/model";
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
  renderer: CanvasRenderer;
  model: ScreenModel;
  selection: Selection;
  session: () => Session | undefined;
  /** A selection was made (for copy-on-select). */
  onSelect?: () => void;
}

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
    if (reporting(e)) {
      e.preventDefault();
      reportedButton = e.button;
      lastCell = cellOf(e);
      report(BUTTONS[e.button] ?? "left", "press", e);
      return;
    }
    if (e.button !== 0) return;
    const { row, col } = cellOf(e);
    const at = { line: model.topLine + row, col };
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
    if (!selecting) return;
    const r = canvas.getBoundingClientRect();
    // Dragging past the edge scrolls the history so the selection can grow beyond the view.
    const edge = e.clientY < r.top ? 1 : e.clientY > r.bottom ? -1 : 0;
    if (edge !== 0 && performance.now() - lastAutoscroll > AUTOSCROLL_MS && !model.altScreen) {
      lastAutoscroll = performance.now();
      void h.session()?.scroll(edge);
    }
    const { row, col } = cellOf(e);
    selection.extend({ line: model.topLine + row, col });
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

  // No browser context menu on the grid; otterm's own menu comes with decision I1.
  const onContextMenu = (e: MouseEvent) => e.preventDefault();

  canvas.addEventListener("mousedown", onDown);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  return () => {
    canvas.removeEventListener("mousedown", onDown);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("contextmenu", onContextMenu);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
}
