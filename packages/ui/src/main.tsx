import { createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import { benchMode, runIpcBench } from "./bench";
import { isCopyShortcut, scrollKey, terminalKey } from "./keys";
import { attachPointer } from "./pointer";
import { CanvasRenderer, DEFAULT_FONT } from "./screen/canvasRenderer";
import { ScreenModel } from "./screen/model";
import { Selection } from "./screen/selection";
import { connectScreen, createSession, SCROLL_BOTTOM, SCROLL_TOP, type Session } from "./session";
import "./style.css";

/** PTY resizes are debounced (docs/03 §1.2). */
const RESIZE_DEBOUNCE_MS = 16;

function Terminal() {
  const [status, setStatus] = createSignal<string>();
  /** IME composition in progress (shown at the cursor, not sent to the shell until committed). */
  const [preedit, setPreedit] = createSignal<string>();
  const [anchor, setAnchor] = createSignal({ x: 0, y: 0, height: 0 });
  /** Scrollbar thumb as fractions of the view height; shown while the view is scrolled up. */
  const [thumb, setThumb] = createSignal<{ top: number; height: number }>();
  let host!: HTMLDivElement;
  let viewport!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  let input!: HTMLTextAreaElement;
  let session: Session | undefined;
  let ws: WebSocket | undefined;
  let observer: ResizeObserver | undefined;
  let detachPointer: (() => void) | undefined;
  let renderer: CanvasRenderer | undefined;
  const model = new ScreenModel();
  const selection = new Selection();
  // Dev builds expose the screen for automated checks (screen text, cursor).
  if (import.meta.env.DEV) Object.assign(window, { __otterm: { model, selection } });

  onMount(async () => {
    if ((await benchMode()) === "ipc") {
      setStatus("ipc bench running…");
      await runIpcBench(setStatus);
      return;
    }

    const r = new CanvasRenderer(canvas, model);
    renderer = r;
    r.selection = selection;
    const fit = () => r.gridSize(viewport.clientWidth, viewport.clientHeight);

    try {
      ws = await connectScreen((frame) => {
        if (frame.session !== session?.id) return;
        model.apply(frame);
        updateThumb();
        r.schedule();
      });
      const { cols, rows } = fit();
      session = await createSession(cols, rows, (e) => {
        if (e.kind === "title") document.title = e.title || "otterm";
        if (e.kind === "exited") setStatus(`[process exited${e.code === null ? "" : ` with code ${e.code}`}]`);
      });
      // Frames sent before we knew the session id were dropped above; ask for the whole screen.
      await session.redraw();
    } catch (e) {
      setStatus(`[failed to start: ${String(e)}]`);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = fit();
    observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // The display scale may have changed (window moved to another monitor).
        r.measure();
        const next = fit();
        if (next.cols !== last.cols || next.rows !== last.rows) {
          last = next;
          void session?.resize(next.cols, next.rows);
        } else {
          for (let r = 0; r < model.rows; r++) model.dirty.add(r);
          r.schedule();
        }
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(viewport);

    const onFocus = (focused: boolean) => () => {
      r.focused = focused;
      model.dirty.add(model.cursorRow);
      r.schedule();
    };
    input.addEventListener("focus", onFocus(true));
    input.addEventListener("blur", onFocus(false));
    r.onDraw = () => placeInput(r.cursorRect());
    detachPointer = attachPointer({ canvas, renderer: r, model, selection, session: () => session });
    input.focus();
  });

  // Registered synchronously: cleanups created after an `await` in onMount would never run.
  onCleanup(() => {
    observer?.disconnect();
    detachPointer?.();
    void session?.close();
    ws?.close();
  });

  /** Keep the hidden input at the cursor so the IME candidate window opens there (decision I4). */
  const placeInput = (r: { x: number; y: number; height: number }) => {
    input.style.transform = `translate(${r.x}px, ${r.y}px)`;
    input.style.height = `${r.height}px`;
    setAnchor(r);
  };

  const updateThumb = () => {
    if (model.offset === 0) return setThumb(undefined);
    const total = model.scrollback + model.rows;
    setThumb({ top: (model.scrollback - model.offset) / total, height: model.rows / total });
  };

  const clearSelection = () => {
    if (!selection.active) return;
    selection.clear();
    renderer?.invalidate();
  };

  /** Copy the selection to the clipboard. Block selections are copied line by line. */
  const copySelection = async () => {
    const range = selection.range(model);
    if (!range || !session || selection.empty) return;
    let text: string;
    if (selection.mode === "block") {
      const lines: string[] = [];
      for (let line = range.start.line; line <= range.end.line; line++) {
        const cols = selection.colsOn(model, line);
        if (cols) lines.push(await session.text(line, cols[0], line, cols[1] - 1));
      }
      text = lines.join("\n");
    } else {
      text = await session.text(range.start.line, range.start.col, range.end.line, range.end.col);
    }
    await navigator.clipboard.writeText(text);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!session) return;
    const hasSelection = selection.active && !selection.empty;
    if (isCopyShortcut(e, hasSelection)) {
      e.preventDefault();
      void copySelection().then(clearSelection);
      return;
    }
    const scroll = model.altScreen ? undefined : scrollKey(e, model.rows);
    if (scroll !== undefined) {
      e.preventDefault();
      void session.scroll(scroll === "top" ? SCROLL_TOP : scroll === "bottom" ? SCROLL_BOTTOM : scroll);
      return;
    }
    const key = terminalKey(e);
    if (key === undefined) return;
    e.preventDefault();
    clearSelection();
    void session.key(key);
  };

  // Text that did not come as a key press: committed IME compositions, some input methods.
  const onCompositionStart = () => setPreedit("");
  const onCompositionUpdate = (e: CompositionEvent) => setPreedit(e.data);
  const onCompositionEnd = (e: CompositionEvent) => {
    setPreedit(undefined);
    if (e.data && session) void session.write(e.data);
    input.value = "";
  };
  const onInput = (e: Event) => {
    const ev = e as InputEvent;
    if (ev.isComposing || preedit() !== undefined) return;
    if (ev.data && session) void session.write(ev.data);
    input.value = "";
  };

  const onPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData("text/plain");
    e.preventDefault();
    if (text && session) void session.paste(text);
  };

  return (
    // A terminal is an application region: it takes its own keyboard and mouse input.
    <div
      ref={host}
      class="terminal"
      role="application"
      aria-label="Terminal"
      onMouseDown={() => setTimeout(() => input.focus())}
    >
      <div ref={viewport} class="viewport">
        <canvas ref={canvas} />
        <textarea
          ref={input}
          class="input"
          aria-label="Terminal input"
          autocapitalize="off"
          autocomplete="off"
          spellcheck={false}
          onKeyDown={onKeyDown}
          onInput={onInput}
          onCompositionStart={onCompositionStart}
          onCompositionUpdate={onCompositionUpdate}
          onCompositionEnd={onCompositionEnd}
          onPaste={onPaste}
        />
        {preedit() && (
          <span
            class="preedit"
            style={{
              transform: `translate(${anchor().x}px, ${anchor().y}px)`,
              "line-height": `${anchor().height}px`,
              "font-family": DEFAULT_FONT.family,
              "font-size": `${DEFAULT_FONT.size}px`,
            }}
          >
            {preedit()}
          </span>
        )}
      </div>
      {thumb() && (
        <div
          class="scrollbar"
          style={{ top: `${(thumb()?.top ?? 0) * 100}%`, height: `${(thumb()?.height ?? 0) * 100}%` }}
        />
      )}
      {status() && <div class="status">{status()}</div>}
    </div>
  );
}

const root = document.getElementById("root");
if (root) render(() => <Terminal />, root);
