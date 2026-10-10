//! IPC benchmark (feature `bench`): how long a binary payload takes from Rust to JS, the way grid
//! diffs will travel (stage 4 in docs/09 §2). Compares Tauri's raw-payload channel with a local
//! WebSocket (decision C13). Started with `OTTERM_BENCH=ipc`; driven by tests/bench/run.js.
//!
//! Payload layout: `seq: u32 LE`, `sent_at: f64 LE` (Unix epoch ms), then filler.
//! JS answers each payload with `seq` and its own receive time on the same clock.

use std::net::TcpListener;
use std::sync::{Mutex, mpsc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, State};
use tungstenite::Message;

/// Payload sizes, named after what a grid diff of that size would carry.
const SIZES: &[(&str, usize)] = &[
    ("cell", 64),           // one changed cell, e.g. an echoed keystroke
    ("line", 2 * 1024),     // one full 200-column line with attributes
    ("screen", 96 * 1024),  // a full 200×60 screen at 8 bytes per cell
    ("burst", 1024 * 1024), // a frame during a large `cat`
];
const WARMUP: usize = 20;
const ITERATIONS: usize = 500;

struct Ack {
    seq: u32,
    js_received_at: f64,
    at: Instant,
}

#[derive(Default)]
pub struct BenchState {
    acks: Mutex<Option<mpsc::Sender<Ack>>>,
}

pub fn mode() -> Option<String> {
    std::env::var("OTTERM_BENCH").ok().filter(|m| !m.is_empty())
}

/// The UI asks this at startup; `None` means a normal session.
#[tauri::command]
pub fn bench_mode() -> Option<String> {
    mode()
}

#[tauri::command]
pub fn bench_ipc_ack(state: State<'_, BenchState>, seq: u32, received_at: f64) {
    let at = Instant::now();
    if let Some(tx) = state.acks.lock().unwrap().as_ref() {
        let _ = tx.send(Ack { seq, js_received_at: received_at, at });
    }
}

/// Start the benchmark. Returns the WebSocket port the UI must connect to after the Tauri round.
#[tauri::command]
pub fn bench_ipc_start(
    app: AppHandle,
    state: State<'_, BenchState>,
    channel: Channel<InvokeResponseBody>,
) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let (tx, rx) = mpsc::channel();
    *state.acks.lock().unwrap() = Some(tx);

    std::thread::spawn(move || {
        let result = run(&channel, &rx, listener);
        let text = match result {
            Ok(v) => serde_json::to_string_pretty(&v).unwrap(),
            Err(e) => serde_json::to_string_pretty(&json!({ "suite": "ipc", "error": e })).unwrap(),
        };
        match std::env::var("OTTERM_BENCH_OUT") {
            Ok(path) => std::fs::write(path, text + "\n").expect("write OTTERM_BENCH_OUT"),
            Err(_) => println!("{text}"),
        }
        app.exit(0);
    });
    Ok(port)
}

fn run(
    channel: &Channel<InvokeResponseBody>,
    acks: &mpsc::Receiver<Ack>,
    listener: TcpListener,
) -> Result<Value, String> {
    let mut metrics = serde_json::Map::new();

    for &(name, size) in SIZES {
        let r = measure(size, |payload| {
            channel.send(InvokeResponseBody::Raw(payload)).map_err(|e| e.to_string())?;
            let ack = acks.recv_timeout(Duration::from_secs(5)).map_err(|_| "no ack from the UI within 5 s")?;
            Ok((ack.seq, ack.js_received_at, ack.at))
        })?;
        add(&mut metrics, "tauri", name, r);
    }

    let (stream, _) = listener.accept().map_err(|e| e.to_string())?;
    stream.set_nodelay(true).map_err(|e| e.to_string())?;
    let mut ws = tungstenite::accept(stream).map_err(|e| e.to_string())?;
    for &(name, size) in SIZES {
        let r = measure(size, |payload| {
            ws.send(Message::Binary(payload.into())).map_err(|e| e.to_string())?;
            loop {
                match ws.read().map_err(|e| e.to_string())? {
                    Message::Binary(b) if b.len() >= 12 => {
                        let at = Instant::now();
                        let seq = u32::from_le_bytes(b[0..4].try_into().unwrap());
                        let js = f64::from_le_bytes(b[4..12].try_into().unwrap());
                        return Ok((seq, js, at));
                    }
                    _ => continue,
                }
            }
        })?;
        add(&mut metrics, "websocket", name, r);
    }

    Ok(json!({
        "suite": "ipc",
        "bench": "ipc-transfer",
        "platform": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        "params": { "iterations": ITERATIONS, "warmup": WARMUP, "sizes": SIZES.iter().map(|(n, s)| json!({ "name": n, "bytes": s })).collect::<Vec<_>>() },
        "metrics": metrics,
    }))
}

struct Round {
    /// Rust send → JS receive, from the shared wall clock (ms). JS clocks are coarsened to ~0.1 ms.
    one_way: Vec<f64>,
    /// Rust send → ack back in Rust (ms).
    round_trip: Vec<f64>,
}

fn measure(size: usize, mut send: impl FnMut(Vec<u8>) -> Result<(u32, f64, Instant), String>) -> Result<Round, String> {
    let mut r = Round { one_way: Vec::new(), round_trip: Vec::new() };
    for i in 0..WARMUP + ITERATIONS {
        let seq = i as u32;
        let mut payload = vec![0x5a; size.max(12)];
        let sent_at = epoch_ms();
        payload[0..4].copy_from_slice(&seq.to_le_bytes());
        payload[4..12].copy_from_slice(&sent_at.to_le_bytes());
        let start = Instant::now();
        let (ack_seq, js_received_at, at) = send(payload)?;
        if ack_seq != seq {
            return Err(format!("ack {ack_seq} for payload {seq}"));
        }
        if i >= WARMUP {
            r.one_way.push(js_received_at - sent_at);
            r.round_trip.push(at.duration_since(start).as_secs_f64() * 1000.0);
        }
    }
    Ok(r)
}

fn add(metrics: &mut serde_json::Map<String, Value>, transport: &str, size: &str, mut r: Round) {
    r.one_way.sort_by(f64::total_cmp);
    r.round_trip.sort_by(f64::total_cmp);
    for (kind, v) in [("one_way", &r.one_way), ("round_trip", &r.round_trip)] {
        for (q, label) in [(0.5, "p50"), (0.99, "p99")] {
            let value = (percentile(v, q) * 1000.0).round() / 1000.0;
            metrics.insert(
                format!("{transport}.{size}.{kind}.{label}"),
                json!({ "value": value, "unit": "ms", "better": "lower" }),
            );
        }
    }
}

fn percentile(sorted: &[f64], q: f64) -> f64 {
    let rank = (q * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

fn epoch_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0
}
