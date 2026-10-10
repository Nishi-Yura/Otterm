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
  /** Scroll the view up (positive) or down; on the alternate screen this sends arrow keys. */
  scroll(lines: number): Promise<void>;
  /** Report a mouse event; resolves to false if the application did not ask for it. */
  mouse(input: MouseInput): Promise<boolean>;
  /** Text between two cells (line numbers from the frames), inclusive. */
  text(startLine: number, startCol: number, endLine: number, endCol: number): Promise<string>;
  /** Matches as [start line, start col, end line, end col], oldest first. Rejects on a bad regex. */
  search(query: string, opts: SearchOptions): Promise<[number, number, number, number][]>;
  /** Scroll so that a line is in view. */
  reveal(line: number): Promise<void>;
  clearScrollback(): Promise<void>;
  /** The pane gained or lost the keyboard (sent to the program if it asked, mode 1004). */
  focus(focused: boolean): Promise<void>;
  /** Turn off modes a crashed program left on (alternate screen, mouse, Kitty keys, …). */
  resetModes(): Promise<void>;
  close(): Promise<void>;
}

export interface SearchOptions {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface MouseInput {
  button: "left" | "middle" | "right" | "wheelUp" | "wheelDown" | "none";
  action: "press" | "release" | "motion";
  row: number;
  col: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/** The OS clipboard, through Rust (a WebView read would ask the user for permission each time). */
export const clipboard = {
  read: () => invoke<string>("clipboard_read"),
  write: (text: string) => invoke<void>("clipboard_write", { text }),
};

/** Open an http(s) link in the default browser. */
export const openUrl = (url: string) => invoke<void>("open_url", { url });

/** Largest scroll step; the Rust side takes an i32 and treats the extremes as top / bottom. */
export const SCROLL_TOP = 2 ** 31 - 1;
export const SCROLL_BOTTOM = -(2 ** 31);

export async function createSession(
  cols: number,
  rows: number,
  onEvent: (e: SessionEvent) => void,
  /** Start directory: a path or a file:// URL (OSC 7). */
  cwd?: string,
  /** Profile id from the new-tab menu; the default profile when absent. */
  profile?: string,
): Promise<Session> {
  const events = new Channel<SessionEvent>();
  events.onmessage = onEvent;
  const id = await invoke<number>("session_create", { cols, rows, events, cwd: cwd ?? null, profile: profile ?? null });
  return {
    id,
    write: (data) => invoke("session_write", { id, data }),
    key: (input) => invoke<boolean>("session_key", { id, input }),
    paste: (text) => invoke("session_paste", { id, text }),
    resize: (c, r) => invoke("session_resize", { id, cols: c, rows: r }),
    redraw: () => invoke("session_redraw", { id }),
    scroll: (lines) => invoke("session_scroll", { id, lines }),
    mouse: (input) => invoke<boolean>("session_mouse", { id, input }),
    text: (startLine, startCol, endLine, endCol) =>
      invoke<string>("session_text", { id, startLine, startCol, endLine, endCol }),
    search: (query, opts) => invoke("session_search", { id, query, ...opts }),
    reveal: (line) => invoke("session_reveal", { id, line }),
    clearScrollback: () => invoke("session_clear_scrollback", { id }),
    focus: (focused) => invoke("session_focus", { id, focused }),
    resetModes: () => invoke("session_reset_modes", { id }),
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
