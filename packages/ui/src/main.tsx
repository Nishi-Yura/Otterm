import { createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import { benchMode, runIpcBench } from "./bench";
import { keyToInput } from "./keys";
import { CanvasRenderer } from "./screen/canvasRenderer";
import { ScreenModel } from "./screen/model";
import { connectScreen, createSession, type Session } from "./session";
import "./style.css";

/** PTY resizes are debounced (docs/03 §1.2). */
const RESIZE_DEBOUNCE_MS = 16;

function Terminal() {
  const [status, setStatus] = createSignal<string>();
  let host!: HTMLDivElement;
  let viewport!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
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
    host.addEventListener("focus", onFocus(true));
    host.addEventListener("blur", onFocus(false));
    host.focus();
  });

  // Registered synchronously: cleanups created after an `await` in onMount would never run.
  onCleanup(() => {
    observer?.disconnect();
    void session?.close();
    ws?.close();
  });

  const onKeyDown = (e: KeyboardEvent) => {
    const input = keyToInput(e);
    if (input === undefined || !session) return;
    e.preventDefault();
    void session.write(input);
  };

  const onPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData("text/plain");
    if (!text || !session) return;
    e.preventDefault();
    void session.write(text.replace(/\r?\n/g, "\r"));
  };

  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the terminal surface takes keyboard input; screen reader support is M5.
    <div ref={host} class="terminal" tabIndex={0} onKeyDown={onKeyDown} onPaste={onPaste}>
      <div ref={viewport} class="viewport">
        <canvas ref={canvas} />
      </div>
      {status() && <div class="status">{status()}</div>}
    </div>
  );
}

const root = document.getElementById("root");
if (root) render(() => <Terminal />, root);
