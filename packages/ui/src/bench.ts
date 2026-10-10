import { Channel, invoke } from "@tauri-apps/api/core";

/** `"ipc"` in a bench build started with OTTERM_BENCH=ipc; null otherwise (normal builds lack the command). */
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
  log("ipc bench: Tauri raw channel…");
  const port = await invoke<number>("bench_ipc_start", { channel });

  // Rust accepts the socket after the Tauri round; connecting early just waits in the backlog.
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => log("ipc bench: WebSocket…");
  ws.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    const receivedAt = now();
    const seq = new DataView(e.data).getUint32(0, true);
    const ack = new DataView(new ArrayBuffer(12));
    ack.setUint32(0, seq, true);
    ack.setFloat64(4, receivedAt, true);
    ws.send(ack.buffer);
  };
}
