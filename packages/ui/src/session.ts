import { Channel, invoke } from "@tauri-apps/api/core";
import type { KeyInput } from "./keys";
import { decodeFrame, type Frame } from "./screen/protocol";

/** Bindings for the commands in crates/otterm-app/src/main.rs. */

export type SessionEvent =
  | { kind: "title"; title: string }
  | { kind: "bell" }
  | { kind: "cwd"; url: string }
  | { kind: "clipboard"; data: string }
  | { kind: "exited"; code: number | null };

export interface Session {
  readonly id: number;
  write(data: string): Promise<void>;
  /** Send a key; Rust encodes it for the terminal's modes. Resolves to false if it has no encoding. */
  key(input: KeyInput): Promise<boolean>;
  paste(text: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  /** Ask for a full frame. */
  redraw(): Promise<void>;
  close(): Promise<void>;
}

export async function createSession(cols: number, rows: number, onEvent: (e: SessionEvent) => void): Promise<Session> {
  const events = new Channel<SessionEvent>();
  events.onmessage = onEvent;
  const id = await invoke<number>("session_create", { cols, rows, events });
  return {
    id,
    write: (data) => invoke("session_write", { id, data }),
    key: (input) => invoke<boolean>("session_key", { id, input }),
    paste: (text) => invoke("session_paste", { id, text }),
    resize: (c, r) => invoke("session_resize", { id, cols: c, rows: r }),
    redraw: () => invoke("session_redraw", { id }),
    close: () => invoke("session_close", { id }),
  };
}

/**
 * Connect to the screen socket (decision M2). Frames for every session arrive here; `onFrame`
 * routes them by `frame.session`. Resolves once the socket is open.
 */
export async function connectScreen(onFrame: (f: Frame) => void): Promise<WebSocket> {
  const { port, token } = await invoke<{ port: number; token: string }>("screen_endpoint");
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    const frame = decodeFrame(e.data);
    if (frame) onFrame(frame);
  };
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("could not connect to the screen socket"));
  });
  return ws;
}
