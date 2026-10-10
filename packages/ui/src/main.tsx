import { createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import { benchMode, runIpcBench } from "./bench";
import { terminalKey } from "./keys";
import { CanvasRenderer, DEFAULT_FONT } from "./screen/canvasRenderer";
import { ScreenModel } from "./screen/model";
import { connectScreen, createSession, type Session } from "./session";
import "./style.css";

/** PTY resizes are debounced (docs/03 §1.2). */
const RESIZE_DEBOUNCE_MS = 16;

function Terminal() {
  const [status, setStatus] = createSignal<string>();
  /** IME composition in progress (shown at the cursor, not sent to the shell until committed). */
  const [preedit, setPreedit] = createSignal<string>();
  const [anchor, setAnchor] = createSignal({ x: 0, y: 0, height: 0 });
  let host!: HTMLDivElement;
  let viewport!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  let input!: HTMLTextAreaElement;
  let session: Session | undefined;
  let ws: WebSocket | undefined;
  let observer: ResizeObserver | undefined;
  const model = new ScreenModel();
  // Dev builds expose the screen for automated checks (screen text, cursor).
  if (import.meta.env.DEV) Object.assign(window, { __otterm: { model } });

  onMount(async () => {
    if ((await benchMode()) === "ipc") {
      setStatus("ipc bench running…");
      await runIpcBench(setStatus);
      return;
    }

    const renderer = new CanvasRenderer(canvas, model);
    const fit = () => renderer.gridSize(viewport.clientWidth, viewport.clientHeight);

    try {
      ws = await connectScreen((frame) => {
        if (frame.session !== session?.id) return;
        model.apply(frame);
        renderer.schedule();
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
        renderer.measure();
        const next = fit();
        if (next.cols !== last.cols || next.rows !== last.rows) {
          last = next;
          void session?.resize(next.cols, next.rows);
        } else {
          for (let r = 0; r < model.rows; r++) model.dirty.add(r);
          renderer.schedule();
        }
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(viewport);

    const onFocus = (focused: boolean) => () => {
      renderer.focused = focused;
      model.dirty.add(model.cursorRow);
      renderer.schedule();
    };
    input.addEventListener("focus", onFocus(true));
    input.addEventListener("blur", onFocus(false));
    renderer.onDraw = () => placeInput(renderer.cursorRect());
    input.focus();
  });

  // Registered synchronously: cleanups created after an `await` in onMount would never run.
  onCleanup(() => {
    observer?.disconnect();
    void session?.close();
    ws?.close();
  });

  /** Keep the hidden input at the cursor so the IME candidate window opens there (decision I4). */
  const placeInput = (r: { x: number; y: number; height: number }) => {
    input.style.transform = `translate(${r.x}px, ${r.y}px)`;
    input.style.height = `${r.height}px`;
    setAnchor(r);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const key = terminalKey(e);
    if (key === undefined || !session) return;
    e.preventDefault();
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
    <div ref={host} class="terminal" onMouseDown={() => setTimeout(() => input.focus())}>
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
      {status() && <div class="status">{status()}</div>}
    </div>
  );
}

const root = document.getElementById("root");
if (root) render(() => <Terminal />, root);
