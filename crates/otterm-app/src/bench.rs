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

    // The UI connects as soon as it learns the port. The WebSocket goes first because the clock
    // calibration below needs a fast, symmetric path.
    let (stream, _) = listener.accept().map_err(|e| e.to_string())?;
    stream.set_nodelay(true).map_err(|e| e.to_string())?;
    let mut ws = tungstenite::accept(stream).map_err(|e| e.to_string())?;
    let mut ws_send = |payload: Vec<u8>| -> Result<(u32, f64, Instant), String> {
        ws.send(Message::Binary(payload.into())).map_err(|e| e.to_string())?;
        loop {
            if let Message::Binary(b) = ws.read().map_err(|e| e.to_string())?
                && b.len() >= 12
            {
                let at = Instant::now();
                let seq = u32::from_le_bytes(b[0..4].try_into().unwrap());
                let js = f64::from_le_bytes(b[4..12].try_into().unwrap());
                return Ok((seq, js, at));
            }
        }
    };

    let clock = calibrate(&mut ws_send)?;

    for &(name, size) in SIZES {
        let r = measure(size, |payload| {
            channel.send(InvokeResponseBody::Raw(payload)).map_err(|e| e.to_string())?;
            let ack = acks.recv_timeout(Duration::from_secs(5)).map_err(|_| "no ack from the UI within 5 s")?;
            Ok((ack.seq, ack.js_received_at, ack.at))
        })?;
        add(&mut metrics, "tauri", name, r, clock.offset_ms);
    }
    for &(name, size) in SIZES {
        let r = measure(size, &mut ws_send)?;
        add(&mut metrics, "websocket", name, r, clock.offset_ms);
    }

    Ok(json!({
        "suite": "ipc",
        "bench": "ipc-transfer",
        "platform": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        "params": {
            "iterations": ITERATIONS,
            "warmup": WARMUP,
            "clock_offset_ms": round3(clock.offset_ms),
            "clock_uncertainty_ms": round3(clock.uncertainty_ms),
            "sizes": SIZES.iter().map(|(n, s)| json!({ "name": n, "bytes": s })).collect::<Vec<_>>(),
        },
        "metrics": metrics,
    }))
}

/// How far the JS clock is ahead of Rust's `SystemTime`. `performance.timeOrigin` can be off by
/// a millisecond or more on macOS and Linux, which made raw one-way times negative.
struct Clock {
    offset_ms: f64,
    /// Half the round trip of the sample the offset came from: the most the offset can be off by.
    uncertainty_ms: f64,
}

/// NTP-style: send small payloads and take the offset from the one with the shortest round trip,
/// assuming its two legs took equally long.
fn calibrate(send: &mut impl FnMut(Vec<u8>) -> Result<(u32, f64, Instant), String>) -> Result<Clock, String> {
    let r = measure(12, send)?;
    let best = (0..r.round_trip.len()).min_by(|&a, &b| r.round_trip[a].total_cmp(&r.round_trip[b])).unwrap();
    let half = r.round_trip[best] / 2.0;
    Ok(Clock { offset_ms: r.one_way[best] - half, uncertainty_ms: half })
}

struct Round {
    /// Rust send → JS receive (ms), before clock correction. JS clocks are coarsened to ~0.1 ms.
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

fn add(metrics: &mut serde_json::Map<String, Value>, transport: &str, size: &str, mut r: Round, clock_offset_ms: f64) {
    for v in &mut r.one_way {
        *v -= clock_offset_ms;
    }
    r.one_way.sort_by(f64::total_cmp);
    r.round_trip.sort_by(f64::total_cmp);
    for (kind, v) in [("one_way", &r.one_way), ("round_trip", &r.round_trip)] {
        for (q, label) in [(0.5, "p50"), (0.99, "p99")] {
            let value = round3(percentile(v, q));
            metrics.insert(
                format!("{transport}.{size}.{kind}.{label}"),
                json!({ "value": value, "unit": "ms", "better": "lower" }),
            );
        }
    }
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

fn percentile(sorted: &[f64], q: f64) -> f64 {
    let rank = (q * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

fn epoch_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0
}
