import { Channel, invoke } from "@tauri-apps/api/core";

/** Bindings for the session commands in crates/otterm-app/src/main.rs. */
export interface SessionHandlers {
  /** Raw PTY bytes. */
  onOutput(bytes: Uint8Array): void;
  /** Last event. `code` is null when the exit code was unavailable. */
  onExit(code: number | null): void;
}

export interface Session {
  readonly id: number;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}

export async function createSession(cols: number, rows: number, handlers: SessionHandlers): Promise<Session> {
  // Output arrives as a raw binary payload (decision C13), so no JSON encoding of bytes.
  const output = new Channel<ArrayBuffer>();
  output.onmessage = (buf) => handlers.onOutput(new Uint8Array(buf));
  const exit = new Channel<number | null>();
  exit.onmessage = (code) => handlers.onExit(code);

  const id = await invoke<number>("session_create", { cols, rows, output, exit });
  return {
    id,
    write: (data) => invoke("session_write", { id, data }),
    resize: (c, r) => invoke("session_resize", { id, cols: c, rows: r }),
    close: () => invoke("session_close", { id }),
  };
}
