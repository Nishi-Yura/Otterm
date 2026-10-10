// Runs otterm's benchmarks and writes one combined result file.
//
//   node tests/bench/run.js [--suite pty,ipc,typing] [--quick] [--out tests/bench/results/latest.json]
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
const suites = value("--suite", "pty,ipc,typing").split(",");
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
