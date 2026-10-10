# Benchmarks

Measurements behind [docs/09-performance.md](../../docs/09-performance.md) §4. Results recorded so far are in [docs/bench/](../../docs/bench/baseline.md).

```sh
just bench                                   # all suites → tests/bench/results/latest.json
node tests/bench/run.js --suite pty --quick  # one suite, fewer iterations (CI smoke run)
node tests/bench/compare.js old.json new.json --threshold 10
```

`tests/bench/results/` is git-ignored. Copy a result into `docs/bench/` when it becomes a baseline.

## Suites

| Suite | Bench | Measures | Where |
| --- | --- | --- | --- |
| `pty` | `pty-throughput` | MiB/s drained from a child writing as fast as it can (like `cat` on a large file), through `SessionManager` | `crates/otterm-bench` |
| `pty` | `pty-roundtrip` | Write `ping N` to the PTY until `pong N` is read back. Stages 2–3 of 09 §2, without VT parsing | `crates/otterm-bench` |
| `ipc` | `ipc-transfer` | Rust → WebView transfer of grid-diff-sized payloads (64 B, 2 KiB, 96 KiB, 1 MiB) over Tauri's raw channel and a local WebSocket. Stage 4 of 09 §2, decision C13 | `crates/otterm-app/src/bench.rs` (feature `bench`), `packages/ui/src/bench.ts` |

Not yet possible, waiting for the VT grid and renderer (M1): `typing-latency`, `startup` (to the first drawn prompt), `memory`, `mod-overhead`, `resize`.

### Notes

- The child process in the `pty` suite is `otterm-bench` itself (hidden modes `emit` and `pong`), so the suite needs no shell or coreutils.
- On Windows, ConPTY holds all output until its cursor position query (`ESC[6n`) is answered; the bench answers it.
- On Windows, ConPTY sends a line's text immediately but the following line end (a cursor move) about one frame (16 ms) later. `pty-roundtrip` waits for the text. Typing latency in M1 must decide which of the two counts as "drawn".
- `ipc-transfer` one-way times compare Rust's `SystemTime` with `performance.timeOrigin + performance.now()` in JS. The two clocks can differ by a millisecond or more (seen on macOS and Linux), and the offset drifts during a run, so before every round the bench estimates it NTP-style over the WebSocket (shortest of 520 round trips, assumed symmetric) and subtracts it. `params.clocks` records each estimate with its uncertainty; one-way values smaller than the uncertainty are noise. WebViews also coarsen the JS clock to about 0.1 ms.
- The `ipc` suite builds the app with `--features bench` into `target/bench/`. Normal builds have no bench commands.

## Result format

`run.js` writes one file per run:

```json
{
  "date": "2026-10-11T03:00:00.000Z",
  "commit": "4c7f6ed",
  "platform": "win32-x64",
  "machine": { "cpu": "…", "cores": 16, "memoryGiB": 16 },
  "quick": false,
  "results": [
    {
      "suite": "pty",
      "bench": "pty-roundtrip",
      "platform": "windows-x86_64",
      "params": { "samples": 1000, "warmup": 20 },
      "metrics": { "p99": { "value": 0.215, "unit": "ms", "better": "lower" } },
      "samples": [0.104, …]
    }
  ]
}
```

`compare.js` keys metrics as `<bench>/<metric>` and fails when one moves in its worse direction by more than `--threshold` percent and, for `ms` metrics, by more than `--floor-ms` (default 0.1 ms).
