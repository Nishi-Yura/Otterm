// Compares two result files from tests/bench/run.js and fails on regressions.
//
//   node tests/bench/compare.js <baseline.json> <current.json> [--threshold 10] [--floor-ms 0.1] [--markdown]
//
// A metric regresses when it moves in its "worse" direction by more than the threshold (percent)
// and, for millisecond metrics, by more than --floor-ms in absolute terms. Sub-millisecond timings
// jitter by tens of percent between runs, so a pure percentage gate would fail on noise.
// Metrics present in only one file are listed but never fail the run.
const fs = require("node:fs");

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith("--") && !["--threshold", "--floor-ms"].includes(args[i - 1]));
const [baseFile, curFile] = positional;
if (!baseFile || !curFile) {
  console.error(
    "usage: node tests/bench/compare.js <baseline.json> <current.json> [--threshold 10] [--floor-ms 0.1] [--markdown]",
  );
  process.exit(2);
}
const ti = args.indexOf("--threshold");
const threshold = ti >= 0 ? Number(args[ti + 1]) : 10;
const fi = args.indexOf("--floor-ms");
const floorMs = fi >= 0 ? Number(args[fi + 1]) : 0.1;
const markdown = args.includes("--markdown");

/** Flatten a report into "bench/metric" → metric. */
function metrics(file) {
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  const out = new Map();
  for (const r of report.results) for (const [k, m] of Object.entries(r.metrics)) out.set(`${r.bench}/${k}`, m);
  return { report, out };
}

const base = metrics(baseFile);
const cur = metrics(curFile);
if (base.report.platform !== cur.report.platform) {
  console.error(`warning: comparing ${base.report.platform} with ${cur.report.platform}`);
}

const rows = [];
let regressions = 0;
for (const key of new Set([...base.out.keys(), ...cur.out.keys()])) {
  const b = base.out.get(key);
  const c = cur.out.get(key);
  if (!b || !c) {
    rows.push([key, b?.value ?? "–", c?.value ?? "–", "", b ? "removed" : "new"]);
    continue;
  }
  const change = b.value === 0 ? 0 : ((c.value - b.value) / b.value) * 100;
  const worse = c.better === "higher" ? -change : change;
  const belowFloor = c.unit === "ms" && Math.abs(c.value - b.value) < floorMs;
  const status = belowFloor ? "ok" : worse > threshold ? "REGRESSION" : worse < -threshold ? "improved" : "ok";
  if (status === "REGRESSION") regressions++;
  rows.push([
    key,
    `${b.value} ${b.unit}`,
    `${c.value} ${c.unit}`,
    `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`,
    status,
  ]);
}

const header = ["metric", "baseline", "current", "change", "status"];
if (markdown) {
  console.log(`| ${header.join(" | ")} |\n| ${header.map(() => "---").join(" | ")} |`);
  for (const r of rows) console.log(`| ${r.join(" | ")} |`);
} else {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((v, i) => String(v).padEnd(widths[i])).join("  ");
  console.log(line(header));
  for (const r of rows) console.log(line(r));
}
console.log(
  `\n${regressions} regression(s) beyond ${threshold}% (baseline ${base.report.commit}, current ${cur.report.commit})`,
);
process.exit(regressions ? 1 : 0);
