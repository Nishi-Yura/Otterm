import { Channel, invoke } from "@tauri-apps/api/core";
import { createSignal } from "solid-js";
import type { ScreenModel } from "./screen/model";
import type { Renderer } from "./screen/renderer";

/** Bench builds expose the active pane on `window.__otterm` (dev builds always do). */
export const [exposeInternals, setExposeInternals] = createSignal(false);

/** `"ipc"` or `"typing"` in a bench build started with OTTERM_BENCH; null otherwise (normal builds lack the command). */
export async function benchMode(): Promise<string | null> {
  try {
    return await invoke<string | null>("bench_mode");
  } catch {
    return null;
  }
}

/** Same clock as Rust's `SystemTime` (Unix epoch, ms). */
const now = () => performance.timeOrigin + performance.now();

/** Counterpart of crates/otterm-app/src/bench.rs: answer every payload with its seq and our receive time. */
export async function runIpcBench(log: (line: string) => void): Promise<void> {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (buf) => {
    const receivedAt = now();
    const seq = new DataView(buf).getUint32(0, true);
    void invoke("bench_ipc_ack", { seq, receivedAt });
  };
  const port = await invoke<number>("bench_ipc_start", { channel });

  // Rust calibrates the clocks over this socket, then runs the Tauri round, then the WebSocket round.
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => log("ipc bench: running…");
  ws.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    const receivedAt = now();
    const seq = new DataView(e.data).getUint32(0, true);
    const ack = new DataView(new ArrayBuffer(12));
    ack.setUint32(0, seq, true);
    ack.setFloat64(4, receivedAt, true);
    ws.send(ack.buffer);
  };
}

/** Keystrokes measured, after the warm-up ones. */
const TYPING_SAMPLES = 1000;
const TYPING_WARMUP = 50;
/** Pause between keystrokes, so each one is measured on an idle terminal. */
const TYPING_GAP_MS = 20;
/** Characters per line before Enter (not measured) starts a new one. */
const LINE_LENGTH = 60;

interface Exposed {
  model: ScreenModel;
  renderer: Renderer;
  input: HTMLTextAreaElement;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * docs/09 §4.1 `typing-latency`: dispatch a keydown on the active terminal's input (the same path
 * a real key takes from there on) and time it until the draw that shows the character ends.
 * The child (`otterm-bench pong`, set up by Rust) only reads, so the PTY echoes the key.
 */
export async function runTypingBench(log: (line: string) => void): Promise<void> {
  const exposed = () => (window as unknown as { __otterm?: Exposed }).__otterm;
  for (let i = 0; i < 200 && !exposed()?.renderer; i++) await sleep(50);
  const pane = exposed();
  if (!pane) throw new Error("no terminal to type into");
  const { model, renderer, input } = pane;
  await sleep(1000);

  const key = (k: string) =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  /** Resolves with the time of the first draw after which `done()` holds. */
  const drawn = (done: () => boolean) =>
    new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no echo within 2 s")), 2000);
      renderer.afterDraw = () => {
        if (!done()) return;
        clearTimeout(timeout);
        renderer.afterDraw = undefined;
        resolve(performance.now());
      };
    });

  const samples: number[] = [];
  for (let i = 0; i < TYPING_WARMUP + TYPING_SAMPLES; i++) {
    if (i > 0 && i % LINE_LENGTH === 0) {
      const row = model.cursorRow;
      const next = drawn(() => model.cursorCol === 0 && model.cursorRow !== row);
      key("Enter");
      await next.catch(() => undefined);
    }
    const ch = String.fromCharCode(97 + (i % 26));
    const { cursorRow: row, cursorCol: col } = model;
    const echoed = drawn(() => model.lines[row]?.codepoints[col] === ch.charCodeAt(0));
    const start = performance.now();
    key(ch);
    const end = await echoed;
    if (i >= TYPING_WARMUP) samples.push(end - start);
    if (i % 100 === 0) log(`typing bench: ${i}/${TYPING_WARMUP + TYPING_SAMPLES}`);
    await sleep(TYPING_GAP_MS);
  }
  await invoke("bench_typing_done", { samples, warmup: TYPING_WARMUP, gapMs: TYPING_GAP_MS });
}

const startupMarks: Record<string, number> = {};

/** Record a startup milestone (Unix epoch ms) for the startup bench's breakdown. */
export function startupMark(name: string, at: number = performance.now()): void {
  startupMarks[name] = performance.timeOrigin + at;
}

/** docs/09 §4.1 `startup`: tell Rust when the first prompt has been drawn; it measures from the
 * start of the process. */
export async function runStartupBench(): Promise<void> {
  const exposed = () => (window as unknown as { __otterm?: Exposed }).__otterm;
  for (let i = 0; i < 400 && !exposed()?.renderer; i++) await sleep(5);
  const pane = exposed();
  if (!pane) throw new Error("no terminal");
  const { model, renderer } = pane;
  const shown = () => model.lines.some((_, r) => model.text(r).includes("ready>"));
  if (!shown()) {
    await new Promise<void>((resolve) => {
      renderer.afterDraw = () => {
        if (!shown()) return;
        renderer.afterDraw = undefined;
        resolve();
      };
    });
  }
  startupMark("prompt drawn");
  await invoke("bench_startup_done", { marks: startupMarks });
}
