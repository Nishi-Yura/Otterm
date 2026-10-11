// Runs otterm's benchmarks and writes one combined result file.
//
//   node tests/bench/run.js [--suite pty,ipc,typing,startup,mod-overhead] [--quick] [--out tests/bench/results/latest.json]
//
// Result format: tests/bench/README.md. Compare two files with tests/bench/compare.js.
const { execFileSync, execSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const suites = value("--suite", "pty,ipc,typing,startup").split(",");
const quick = flag("--quick");
const outFile = path.resolve(root, value("--out", "tests/bench/results/latest.json"));
const exe = (name) => (process.platform === "win32" ? `${name}.exe` : name);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "otterm-bench-"));

function run(cmd, cmdArgs, opts = {}) {
  console.error(`$ ${cmd} ${cmdArgs.join(" ")}`);
  const o = { cwd: root, stdio: ["ignore", "inherit", "inherit"], ...opts };
  // pnpm is a .cmd shim on Windows and needs a shell; the arguments here are fixed strings.
  if (cmd === "pnpm" && process.platform === "win32") execSync(`pnpm ${cmdArgs.join(" ")}`, o);
  else execFileSync(cmd, cmdArgs, o);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const results = [];

/** Build otterm-bench (release) next to the bundled ConPTY; returns its path. */
let benchBin;
function buildBenchBin() {
  if (benchBin) return benchBin;
  run("cargo", ["build", "--release", "-p", "otterm-bench"]);
  benchBin = path.join(root, "target", "release", exe("otterm-bench"));
  // Measure the PTY the app ships: the bundled ConPTY on Windows (decision M3), when fetched.
  const conpty = path.join(
    root,
    "crates",
    "otterm-app",
    "resources",
    "windows",
    process.arch === "arm64" ? "arm64" : "x64",
  );
  if (process.platform === "win32" && fs.existsSync(conpty)) {
    for (const f of ["conpty.dll", "OpenConsole.exe"])
      fs.copyFileSync(path.join(conpty, f), path.join(path.dirname(benchBin), f));
  }
  return benchBin;
}

/** Build the app with the bench commands into target/bench; returns the executable. */
let benchApp;
function buildBenchApp() {
  if (benchApp) return benchApp;
  // A separate target dir keeps the bench build (with the bench commands) apart from normal builds.
  const targetDir = path.join(root, "target", "bench");
  run("pnpm", ["--filter", "@otterm/ui", "build"]);
  run("cargo", ["build", "--release", "-p", "otterm-app", "--features", "bench"], {
    env: { ...process.env, CARGO_TARGET_DIR: targetDir },
  });
  benchApp = path.join(targetDir, "release", exe("otterm"));
  return benchApp;
}

/** Run the bench app in one mode; it writes its result to OTTERM_BENCH_OUT and exits. */
function runApp(mode, env = {}) {
  const out = path.join(tmp, `${mode}.json`);
  console.error(`$ otterm (OTTERM_BENCH=${mode})`);
  const r = spawnSync(buildBenchApp(), [], {
    cwd: root,
    stdio: "inherit",
    timeout: 300_000,
    env: { ...process.env, ...env, OTTERM_BENCH: mode, OTTERM_BENCH_OUT: out },
  });
  if (r.error || !fs.existsSync(out)) throw new Error(`${mode} bench did not finish: ${r.error ?? `exit ${r.status}`}`);
  const result = readJson(out);
  if (result.error) throw new Error(`${mode} bench failed: ${result.error}`);
  return result;
}

if (suites.includes("pty")) {
  const bin = buildBenchBin();
  const benches = [
    ["pty-throughput", ...(quick ? ["--mib", "10", "--runs", "2"] : [])],
    ["pty-roundtrip", ...(quick ? ["--samples", "100"] : [])],
    ["vt-throughput", ...(quick ? ["--mib", "10", "--runs", "2"] : [])],
  ];
  for (const [name, ...rest] of benches) {
    const out = path.join(tmp, `${name}.json`);
    run(bin, [name, ...rest, "--out", out], { stdio: ["ignore", "ignore", "inherit"] });
    results.push(readJson(out));
  }
}

if (suites.includes("ipc")) results.push(runApp("ipc"));

// The app types into `otterm-bench pong`, so the echo comes from the PTY, not a shell.
if (suites.includes("typing")) results.push(runApp("typing", { OTTERM_BENCH_CHILD: buildBenchBin() }));

// Mod overhead (09 §4.1): typing latency with every bundled mod off, then with every one on at guide
// level 3, each with its own config and data folder so the user's setup is not involved.
if (suites.includes("mod-overhead")) {
  const bundled = fs
    .readdirSync(path.join(root, "mods"))
    .map((d) => path.join(root, "mods", d, "otmod.toml"))
    .filter((f) => fs.existsSync(f))
    .map((f) => /^id\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(f, "utf8"))?.[1])
    .filter(Boolean);
  const list = (ids) => `[${ids.map((id) => JSON.stringify(id)).join(", ")}]`;
  const variants = {
    off: `schema = 1
[general]
guide_level = 0
[mods]
enabled = []
disabled = ${list(bundled)}
developer_mode = true
`,
    on: `schema = 1
[general]
guide_level = 3
[mods]
enabled = ${list(bundled)}
disabled = []
developer_mode = true
[ai]
enabled = true
`,
  };
  const p99 = {};
  const p50 = {};
  for (const [name, config] of Object.entries(variants)) {
    const dir = fs.mkdtempSync(path.join(tmp, `mods-${name}-`));
    fs.writeFileSync(path.join(dir, "config.toml"), config);
    const r = runApp("typing", {
      OTTERM_BENCH_CHILD: buildBenchBin(),
      OTTERM_CONFIG: path.join(dir, "config.toml"),
      OTTERM_DATA_DIR: path.join(dir, "data"),
    });
    p99[name] = r.metrics["keystroke_to_draw.p99"].value;
    p50[name] = r.metrics["keystroke_to_draw.p50"].value;
  }
  const metric = (value) => ({ value, unit: "ms", better: "lower" });
  results.push({
    suite: "mod-overhead",
    bench: "mod-overhead",
    platform: `${process.platform}-${process.arch}`,
    params: { mods: bundled, off: "guide level 0, bundled mods disabled", on: "guide level 3, bundled mods enabled" },
    metrics: {
      "p50.off": metric(p50.off),
      "p50.on": metric(p50.on),
      "p99.off": metric(p99.off),
      "p99.on": metric(p99.on),
      "p99.added": metric(Math.round((p99.on - p99.off) * 100) / 100),
    },
    samples: [],
  });
}

// Startup: the first run is the coldest this machine allows (files may still be cached), the
// rest are warm.
if (suites.includes("startup")) {
  const runs = [];
  for (let i = 0; i < (quick ? 3 : 6); i++) {
    runs.push(runApp("startup", { OTTERM_BENCH_CHILD: buildBenchBin() }).metrics.to_prompt.value);
  }
  const warm = runs.slice(1).sort((a, b) => a - b);
  const metric = (value) => ({ value, unit: "ms", better: "lower" });
  results.push({
    suite: "startup",
    bench: "startup",
    platform: `${process.platform}-${process.arch}`,
    params: { runs: runs.length, child: "otterm-bench prompt", to: "end of the first draw showing the prompt" },
    metrics: { "to_prompt.first": metric(runs[0]), "to_prompt.warm_median": metric(warm[Math.floor(warm.length / 2)]) },
    samples: runs,
  });
}

let commit = "unknown";
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch {}

const report = {
  date: new Date().toISOString(),
  commit,
  platform: `${process.platform}-${process.arch}`,
  machine: {
    cpu: os.cpus()[0]?.model.trim() ?? "unknown",
    cores: os.cpus().length,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
  },
  quick,
  results,
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
console.error(`\nwrote ${path.relative(root, outFile)}`);
for (const r of results) {
  for (const [k, m] of Object.entries(r.metrics))
    console.log(`${r.bench.padEnd(15)} ${k.padEnd(36)} ${m.value} ${m.unit}`);
}

// In GitHub Actions, also show the numbers on the run's summary page.
if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [
    `### Bench: ${report.platform} (${report.machine.cpu})`,
    "",
    "| bench | metric | value |",
    "| --- | --- | --- |",
  ];
  for (const r of results)
    for (const [k, m] of Object.entries(r.metrics)) lines.push(`| ${r.bench} | ${k} | ${m.value} ${m.unit} |`);
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n\n`);
}
