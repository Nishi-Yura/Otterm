//! Benchmarks for the PTY path: shell output → `SessionManager` (stages 2–3 in docs/09 §2, without VT parsing).
//!
//!   otterm-bench pty-throughput [--mib 100] [--runs 5] [--out FILE]
//!   otterm-bench pty-roundtrip  [--samples 1000] [--out FILE]
//!   otterm-bench vt-throughput  [--mib 100] [--runs 5] [--out FILE]
//!
//! Each command prints one result as JSON (format: tests/bench/README.md). The child process is this
//! binary itself in a hidden mode (`emit`, `pong`), so no shell or coreutils are needed on any OS.

use std::io::{BufRead, BufWriter, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use otterm_session::{LocalSessionManager, SessionEvent, SessionId, SessionManager, SpawnOptions};
use serde_json::{Value, json};

const CURSOR_POSITION_QUERY: &[u8] = b"\x1b[6n";

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("");
    let opt = |name: &str, default: u64| -> Result<u64> {
        match args.iter().position(|a| a == name) {
            Some(i) => args.get(i + 1).context(format!("{name} needs a value"))?.parse().context(name.to_owned()),
            None => Ok(default),
        }
    };
    let out = args.iter().position(|a| a == "--out").and_then(|i| args.get(i + 1)).cloned();

    let result = match cmd {
        "pty-throughput" => pty_throughput(opt("--mib", 100)?, opt("--runs", 5)?)?,
        "pty-roundtrip" => pty_roundtrip(opt("--samples", 1000)?)?,
        "vt-throughput" => vt_throughput(opt("--mib", 100)?, opt("--runs", 5)?),
        // Child modes.
        "emit" => return emit(opt("--bytes", 0)?),
        "pong" => return pong(),
        _ => bail!("usage: otterm-bench <pty-throughput|pty-roundtrip> [options] [--out FILE]"),
    };

    let text = serde_json::to_string_pretty(&result)?;
    println!("{text}");
    if let Some(path) = out {
        std::fs::write(&path, text + "\n").with_context(|| format!("write {path}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

/// How fast the PTY path drains a child that writes as fast as it can (like `cat` on a big file).
fn pty_throughput(mib: u64, runs: u64) -> Result<Value> {
    let bytes = mib * 1024 * 1024;
    let mut samples = Vec::new();
    for _ in 0..runs {
        let mut s = Session::start(&["emit", "--bytes", &bytes.to_string()])?;
        let start = Instant::now();
        s.drain_until_exit(Duration::from_secs(300))?;
        samples.push(bytes as f64 / (1024.0 * 1024.0) / start.elapsed().as_secs_f64());
    }
    Ok(report(
        "pty-throughput",
        json!({ "mib": mib, "runs": runs }),
        json!({ "throughput_median": metric(median(&mut samples), "MiB/s", "higher") }),
        &samples,
    ))
}

/// Time from writing a line to the PTY until the child's answer is read back.
fn pty_roundtrip(samples: u64) -> Result<Value> {
    let mut s = Session::start(&["pong"])?;
    let mut ms = Vec::new();
    for i in 0..samples + 20 {
        let start = Instant::now();
        s.mgr.write(s.id, format!("ping {i}\r").as_bytes())?;
        // Wait for the answer text, which is what the user sees. On Windows, ConPTY sends the line
        // end (a cursor move) about one frame later; waiting for it would measure ConPTY's frame timer.
        // Answers arrive in order, so "pong 1" cannot be confused with a later "pong 12".
        let seen = s.wait_for(format!("pong {i}").as_bytes(), Duration::from_secs(5))?;
        if i >= 20 {
            ms.push(seen.duration_since(start).as_secs_f64() * 1000.0);
        }
    }
    s.mgr.close(s.id)?;
    let mut sorted = ms.clone();
    sorted.sort_by(f64::total_cmp);
    Ok(report(
        "pty-roundtrip",
        json!({ "samples": samples, "warmup": 20 }),
        json!({
            "p50": metric(percentile(&sorted, 0.50), "ms", "lower"),
            "p99": metric(percentile(&sorted, 0.99), "ms", "lower"),
        }),
        &ms,
    ))
}

/// How fast `otterm-vt` parses typical colored output into the grid (stage 3 in docs/09 §2), in-process.
fn vt_throughput(mib: u64, runs: u64) -> Value {
    // `ls --color`-like lines: SGR changes, a wide-character name, plain text.
    let line = "[0m[01;34mdirectory[0m  [01;32mscript.sh[0m  ファイル.txt  README.md  [38;5;208mnotes[0m  src
";
    let chunk = line.repeat(64 * 1024 / line.len());
    let bytes = mib * 1024 * 1024;
    let mut samples = Vec::new();
    for _ in 0..runs {
        let mut term = otterm_vt::Terminal::new(120, 40);
        let start = Instant::now();
        let mut fed = 0;
        while fed < bytes {
            term.advance(chunk.as_bytes());
            let _ = term.take_damage();
            fed += chunk.len() as u64;
        }
        samples.push(fed as f64 / (1024.0 * 1024.0) / start.elapsed().as_secs_f64());
    }
    report(
        "vt-throughput",
        json!({ "mib": mib, "runs": runs, "size": "120x40" }),
        json!({ "throughput_median": metric(median(&mut samples), "MiB/s", "higher") }),
        &samples,
    )
}

// ---------------------------------------------------------------------------
// Session helper
// ---------------------------------------------------------------------------

struct Session {
    mgr: LocalSessionManager,
    id: SessionId,
    rx: mpsc::Receiver<(Instant, SessionEvent)>,
    buf: Vec<u8>,
}

impl Session {
    fn start(child_args: &[&str]) -> Result<Self> {
        let mgr = LocalSessionManager::raw();
        let (tx, rx) = mpsc::channel();
        let exe = std::env::current_exe()?.to_string_lossy().into_owned();
        let opts = SpawnOptions {
            program: Some(exe),
            args: child_args.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        };
        // Timestamp on the reader thread, before the hop to the bench thread.
        let id = mgr.create(
            opts,
            Box::new(move |ev| {
                let _ = tx.send((Instant::now(), ev));
            }),
        )?;
        Ok(Self { mgr, id, rx, buf: Vec::new() })
    }

    /// Next event. Answers ConPTY's cursor position query, which otherwise blocks all output.
    fn next(&mut self, timeout: Duration) -> Result<(Instant, SessionEvent)> {
        let (at, ev) = self.rx.recv_timeout(timeout).context("timed out waiting for the child")?;
        if let SessionEvent::Output(bytes) = &ev
            && contains(bytes, CURSOR_POSITION_QUERY)
        {
            self.mgr.write(self.id, b"\x1b[1;1R")?;
        }
        Ok((at, ev))
    }

    fn drain_until_exit(&mut self, timeout: Duration) -> Result<()> {
        loop {
            if let (_, SessionEvent::Exited { .. }) = self.next(timeout)? {
                return Ok(());
            }
        }
    }

    /// Wait until `needle` has appeared in the output; returns when its last chunk arrived.
    fn wait_for(&mut self, needle: &[u8], timeout: Duration) -> Result<Instant> {
        loop {
            match self.next(timeout)? {
                (at, SessionEvent::Output(bytes)) => {
                    self.buf.extend(bytes);
                    if let Some(pos) = find(&self.buf, needle) {
                        self.buf.drain(..pos + needle.len());
                        return Ok(at);
                    }
                }
                (_, SessionEvent::Exited { code }) => bail!("child exited early ({code:?})"),
                // A raw-mode session sends nothing else.
                _ => {}
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Child modes
// ---------------------------------------------------------------------------

/// Write `bytes` of printable text in 100-byte lines, as fast as possible.
fn emit(bytes: u64) -> Result<()> {
    let line: Vec<u8> = (b'0'..=b'9').chain(b'a'..=b'z').cycle().take(99).collect();
    let mut out = BufWriter::with_capacity(64 * 1024, std::io::stdout().lock());
    let mut left = bytes;
    while left > 0 {
        let n = left.min(100) as usize;
        out.write_all(&line[..n - 1])?;
        out.write_all(b"\n")?;
        left -= n as u64;
    }
    out.flush()?;
    Ok(())
}

/// Answer every `ping N` line with `pong N`.
fn pong() -> Result<()> {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if let Some(n) = line.trim().strip_prefix("ping ") {
            writeln!(out, "pong {n}")?;
            out.flush()?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

fn report(bench: &str, params: Value, metrics: Value, samples: &[f64]) -> Value {
    json!({
        "suite": "pty",
        "bench": bench,
        "platform": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        "params": params,
        "metrics": metrics,
        "samples": samples.iter().map(|v| (v * 1000.0).round() / 1000.0).collect::<Vec<_>>(),
    })
}

fn metric(value: f64, unit: &str, better: &str) -> Value {
    json!({ "value": (value * 1000.0).round() / 1000.0, "unit": unit, "better": better })
}

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(f64::total_cmp);
    percentile(v, 0.5)
}

/// Nearest-rank percentile of sorted data.
fn percentile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let rank = (q * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    find(haystack, needle).is_some()
}

#[cfg(test)]
mod tests {
    use super::percentile;

    #[test]
    fn nearest_rank_percentiles() {
        let v: Vec<f64> = (1..=100).map(f64::from).collect();
        assert_eq!(percentile(&v, 0.5), 50.0);
        assert_eq!(percentile(&v, 0.99), 99.0);
        assert_eq!(percentile(&v, 1.0), 100.0);
        assert_eq!(percentile(&[7.0], 0.99), 7.0);
    }
}
