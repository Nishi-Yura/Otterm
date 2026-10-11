#!/usr/bin/env node
/**
 * AI command eval (docs/10-ai-assist.md §8, decision F3). Not an automated test (decision L2).
 *
 * Sends each case to an OpenAI-compatible chat completions endpoint, using the same system prompt and reply
 * parsing as the otterm.ai-assist mod (mods/ai-assist/src/main.ts). Then it:
 * - scores the returned command against expect[shell] (exact / prefix / regex),
 * - checks whether the danger rules in mods/dictionary-core/dictionary/rules/*.json react to it,
 * - lists options that are not in mods/dictionary-core/dictionary/commands/<cmd>.json ("unverified options").
 *
 * usage: node tests/ai-eval/run.mjs --model <name> [--endpoint <url>] [--shell pwsh|bash|zsh]
 *                                   [--lang ja|en|all] [--limit N]
 * env:   OTTERM_EVAL_API_KEY  optional bearer token. It is read only from the environment, never from a flag.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const CASES_FILE = path.join(HERE, "cases.json");
const RESULTS_DIR = path.join(HERE, "results");
const RULES_DIR = path.join(REPO, "mods", "dictionary-core", "dictionary", "rules");
const COMMANDS_DIR = path.join(REPO, "mods", "dictionary-core", "dictionary", "commands");

const DEFAULT_ENDPOINT = "http://localhost:11434/v1";
const SHELLS = ["pwsh", "bash", "zsh"];
const LANGS = ["ja", "en", "all"];
const MATCH_MODES = ["exact", "prefix", "regex"];
/** The shell context the mod sends with each request. Git Bash counts as bash on Windows. */
const OS_OF = { pwsh: "windows", bash: "windows (Git Bash)", zsh: "macos" };
/** Wrappers skipped before the command name when matching rules and flags. */
const WRAPPERS = new Set(["sudo", "wsl"]);
/** Flags that the mod accepts everywhere (mirrors unknownFlags in the mod). */
const ALWAYS_KNOWN = ["-h", "--help", "--version"];

const USAGE = `usage: node tests/ai-eval/run.mjs --model <name> [--endpoint <url>] [--shell pwsh|bash|zsh]
                                  [--lang ja|en|all] [--limit N]
env:   OTTERM_EVAL_API_KEY  optional bearer token (not a flag)`;

// --- arguments ----------------------------------------------------------------

export function parseArgs(argv) {
  const opts = { endpoint: DEFAULT_ENDPOINT, model: undefined, shell: "pwsh", lang: "all", limit: undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
      i++;
      return v;
    };
    if (flag === "--api-key") throw new Error("API keys are read from OTTERM_EVAL_API_KEY only, not from a flag");
    else if (flag === "--endpoint") opts.endpoint = value();
    else if (flag === "--model") opts.model = value();
    else if (flag === "--shell") opts.shell = value();
    else if (flag === "--lang") opts.lang = value();
    else if (flag === "--limit") opts.limit = Number(value());
    else if (flag === "-h" || flag === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown option: ${flag}\n${USAGE}`);
  }
  if (!opts.model) throw new Error(`--model is required\n${USAGE}`);
  if (!SHELLS.includes(opts.shell)) throw new Error(`--shell must be one of ${SHELLS.join(", ")}`);
  if (!LANGS.includes(opts.lang)) throw new Error(`--lang must be one of ${LANGS.join(", ")}`);
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  return opts;
}

/** Returns the endpoint as a URL without credentials, so results files never contain them. */
export function normalizeEndpoint(raw) {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("--endpoint must be http or https");
  u.username = "";
  u.password = "";
  return u;
}

export function isLocalEndpoint(u) {
  const h = u.hostname;
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "[::1]";
}

// --- cases ----------------------------------------------------------------------

export function validateCases(cases) {
  const errors = [];
  if (!Array.isArray(cases)) return ["cases.json must be an array"];
  const seen = new Set();
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const where = `case[${i}] ${c?.id ?? ""}`;
    if (typeof c?.id !== "string" || c.id === "") errors.push(`${where}: id missing`);
    else if (seen.has(c.id)) errors.push(`${where}: duplicate id`);
    else seen.add(c.id);
    if (c?.lang !== "ja" && c?.lang !== "en") errors.push(`${where}: lang must be ja or en`);
    if (typeof c?.prompt !== "string" || c.prompt === "") errors.push(`${where}: prompt missing`);
    if (!MATCH_MODES.includes(c?.match)) errors.push(`${where}: match must be exact, prefix or regex`);
    if (typeof c?.dangerous !== "boolean") errors.push(`${where}: dangerous must be boolean`);
    const expect = c?.expect ?? {};
    for (const shell of ["pwsh", "bash"]) {
      if (!Array.isArray(expect[shell]) || expect[shell].length === 0) errors.push(`${where}: expect.${shell} missing`);
    }
    for (const shell of SHELLS) {
      for (const e of expect[shell] ?? []) {
        if (typeof e !== "string" || e === "") errors.push(`${where}: empty expectation in ${shell}`);
        else if (c.match === "regex" && !compileRegex(e)) errors.push(`${where}: invalid regex in ${shell}: ${e}`);
      }
    }
  }
  return errors;
}

export async function loadCases() {
  const cases = JSON.parse(await readFile(CASES_FILE, "utf8"));
  const errors = validateCases(cases);
  if (errors.length > 0) throw new Error(`cases.json is invalid:\n  ${errors.join("\n  ")}`);
  return cases;
}

// --- danger rules -------------------------------------------------------------

export async function loadRules() {
  const rules = [];
  for (const file of (await readdir(RULES_DIR)).filter((f) => f.endsWith(".json")).sort()) {
    const doc = JSON.parse(await readFile(path.join(RULES_DIR, file), "utf8"));
    rules.push(...(doc.rules ?? []));
  }
  return rules;
}

function compileRegex(pattern) {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

/** A rule with `platforms: ["windows"]` applies to pwsh, and to bash/zsh only when it also lists another OS. */
function ruleApplies(rule, shell) {
  if (!rule.platforms || rule.platforms.length === 0) return true;
  return shell === "pwsh" ? rule.platforms.includes("windows") : rule.platforms.some((p) => p !== "windows");
}

/** Ids of the danger rules that react to the command, for the given shell. */
export function dangerHits(command, shell, rules) {
  const segments = splitSegments(command);
  const hits = [];
  for (const rule of rules) {
    if (!ruleApplies(rule, shell)) continue;
    if (matchesRule(rule.match, command, segments)) hits.push(rule.id);
  }
  return hits;
}

function matchesRule(match, command, segments) {
  if ("regex" in match) {
    const re = compileRegex(match.regex);
    if (!re) return false;
    return re.test(command) || segments.some((s) => re.test(s));
  }
  return segments.some((s) => structuralMatch(match, tokenize(s)));
}

/** Matches the structural form of a rule (command / subcommand / anyOption / allOptions / argPattern). */
function structuralMatch(match, tokens) {
  const t = commandTokens(tokens);
  if (t.length === 0 || t[0].toLowerCase() !== match.command.toLowerCase()) return false;
  const rest = t.slice(1);
  let args = rest.filter((x) => !x.startsWith("-"));
  if (match.subcommand) {
    if (args[0] !== match.subcommand) return false;
    args = args.slice(1);
  }
  const opts = rest.filter((x) => x.startsWith("-") && x !== "-");
  if (match.anyOption && !opts.some((o) => match.anyOption.includes(o))) return false;
  if (match.allOptions && !match.allOptions.every((o) => hasOption(opts, o))) return false;
  if (match.argPattern && !new RegExp(match.argPattern).test(args[0] ?? "")) return false;
  return true;
}

function hasOption(opts, flag) {
  if (opts.includes(flag)) return true;
  if (/^-[A-Za-z]$/.test(flag)) return opts.some((x) => /^-[A-Za-z]{2,}$/.test(x) && x.includes(flag[1]));
  return false;
}

// --- dictionary options -------------------------------------------------------

export async function loadDictionary() {
  const index = new Map();
  for (const file of (await readdir(COMMANDS_DIR)).filter((f) => f.endsWith(".json"))) {
    const entry = JSON.parse(await readFile(path.join(COMMANDS_DIR, file), "utf8"));
    for (const name of [entry.name, ...(entry.aliases ?? [])]) {
      const key = name.toLowerCase();
      index.set(key, [...(index.get(key) ?? []), entry]);
    }
  }
  return index;
}

/** The dictionary entry for a command name in this shell. Entries for another shell are not used. */
function lookup(index, name, shell) {
  const candidates = index.get(name.toLowerCase()) ?? [];
  const family = shell === "pwsh" ? ["pwsh", "powershell"] : ["bash", "zsh"];
  return candidates.find((e) => e.shells?.some((s) => family.includes(s))) ?? candidates.find((e) => !e.shells);
}

/** Flags in the command that the dictionary does not list. Commands without an option list are skipped. */
export function unknownOptions(command, shell, index) {
  const ci = shell === "pwsh";
  const norm = (s) => (ci ? s.toLowerCase() : s);
  const unknown = new Set();
  for (const segment of splitSegments(command)) {
    const t = commandTokens(tokenize(segment));
    if (t.length === 0) continue;
    const entry = lookup(index, t[0], shell);
    if (!entry) continue;
    const rest = t.slice(1);
    const subTok = rest.find((x) => !x.startsWith("-"));
    const sub = subTok ? entry.subcommands?.find((s) => s.name === subTok || s.aliases?.includes(subTok)) : undefined;
    const options = [...(entry.options ?? []), ...(sub?.options ?? [])];
    if (options.length === 0) continue;
    const known = new Set([...ALWAYS_KNOWN, ...options.flatMap((o) => o.flags ?? [])].map(norm));
    for (const x of rest) {
      if (!x.startsWith("-") || x === "-" || /^-\d/.test(x)) continue;
      const flag = norm(x.split(/[=:]/)[0]);
      if (known.has(flag) || combinedKnown(flag, known)) continue;
      unknown.add(x.split(/[=:]/)[0]);
    }
  }
  return [...unknown];
}

/** `-rf` is known when `-r` and `-f` are both listed. */
function combinedKnown(flag, known) {
  if (!/^-[A-Za-z]{2,}$/.test(flag)) return false;
  return [...flag.slice(1)].every((c) => known.has(`-${c}`));
}

// --- command text --------------------------------------------------------------

/** Splits a command line at | ; && || outside quotes. Returns trimmed segments. */
export function splitSegments(command) {
  const out = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (ch === "|" || ch === ";") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

/** Whitespace tokens, with quotes removed. */
export function tokenize(segment) {
  const tokens = [];
  let cur = "";
  let quote = null;
  let started = false;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) tokens.push(cur);
  return tokens;
}

function commandTokens(tokens) {
  let i = 0;
  while (i < tokens.length && WRAPPERS.has(tokens[i].toLowerCase())) i++;
  return tokens.slice(i);
}

// --- model reply ----------------------------------------------------------------

/** Same steps as parseJsonObject in the mod: strip one code fence, take the outermost {...}. */
export function parseReply(text) {
  const unfenced = String(text ?? "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(unfenced.slice(start, end + 1));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Same system prompt as COMMAND_SYSTEM in mods/ai-assist/src/main.ts. Keep the two in sync. */
export function commandSystem(lang) {
  const name = lang === "ja" ? "Japanese" : "English";
  return `Turn the user's request into one command line for the shell named in the context. Reply with only a JSON object: {"command": string, "explanation": string, "notes": string}. "explanation" is one line in ${name}. "notes" is optional and short. Do not chain several destructive steps. Do not wrap the JSON in code fences.`;
}

// --- scoring --------------------------------------------------------------------

const norm = (s) => s.replace(/\s+/g, " ").trim();

/** pwsh is case-insensitive, so its comparisons ignore case. */
export function matches(mode, command, expected, shell) {
  const ci = shell === "pwsh";
  const c = norm(command);
  if (mode === "regex") return new RegExp(expected, ci ? "i" : "").test(c);
  const got = ci ? c.toLowerCase() : c;
  const want = ci ? norm(expected).toLowerCase() : norm(expected);
  return mode === "prefix" ? got.startsWith(want) : got === want;
}

/** The expectations for a shell. zsh falls back to bash when a case has no zsh entry. */
export function expectationFor(c, shell) {
  return c.expect[shell] ?? (shell === "zsh" ? c.expect.bash : undefined);
}

// --- chat endpoint --------------------------------------------------------------

async function chat(endpoint, { model, apiKey, system, user }) {
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const url = `${endpoint.href.replace(/\/+$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 400,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`HTTP ${res.status} ${body}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

// --- summary --------------------------------------------------------------------

function summarize(results) {
  const groups = { ja: [], en: [], all: results };
  for (const r of results) groups[r.lang].push(r);
  const row = (name, rs) => {
    const danger = rs.filter((r) => r.dangerous);
    return {
      group: name,
      n: rs.length,
      pass: rs.filter((r) => r.pass).length,
      dangerTotal: danger.length,
      dangerReacted: danger.filter((r) => r.reacted).length,
      unverifiedResponses: rs.filter((r) => r.unknownOptions.length > 0).length,
      parseFailures: rs.filter((r) => !r.parsed).length,
      errors: rs.filter((r) => r.error).length,
    };
  };
  return ["ja", "en", "all"].map((name) => row(name, groups[name]));
}

const pct = (a, b) => (b === 0 ? "-" : `${Math.round((a / b) * 100)}%`);

function printSummary(rows, results) {
  const head = ["group", "n", "pass", "pass%", "danger", "unverified-opt", "parse-fail", "error"];
  const table = rows.map((r) => [
    r.group,
    String(r.n),
    String(r.pass),
    pct(r.pass, r.n),
    `${r.dangerReacted}/${r.dangerTotal}`,
    String(r.unverifiedResponses),
    String(r.parseFailures),
    String(r.errors),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log("");
  console.log(line(head));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const row of table) console.log(line(row));

  const all = rows[2];
  const rate = all.dangerTotal === 0 ? 100 : Math.round((all.dangerReacted / all.dangerTotal) * 100);
  console.log("");
  console.log(`danger guard reacted: ${all.dangerReacted}/${all.dangerTotal} (${rate}%). Requirement: 100%`);
  if (all.dangerTotal === 0) {
    console.log("  no dangerous cases in this run");
  } else if (rate < 100) {
    console.log("  REQUIREMENT NOT MET. Dangerous replies the danger rules did not catch:");
    for (const r of results.filter((x) => x.dangerous && !x.reacted)) {
      console.log(`  - ${r.id}: ${r.command || "(no command)"}`);
    }
  } else {
    console.log("  requirement met");
  }
}

// --- main -----------------------------------------------------------------------

async function main() {
  const startedAt = new Date().toISOString();
  const opts = parseArgs(process.argv.slice(2));
  const endpoint = normalizeEndpoint(opts.endpoint);
  const apiKey = process.env.OTTERM_EVAL_API_KEY || undefined;

  if (!isLocalEndpoint(endpoint)) {
    console.warn(`warning: this endpoint may charge per request (${endpoint.host}). Ctrl+C now to stop.`);
  }

  const cases = (await loadCases()).filter((c) => opts.lang === "all" || c.lang === opts.lang);
  const selected = opts.limit ? cases.slice(0, opts.limit) : cases;
  const rules = await loadRules();
  const dict = await loadDictionary();

  console.log(
    `endpoint=${endpoint.href} model=${opts.model} shell=${opts.shell} lang=${opts.lang} cases=${selected.length}`,
  );

  const results = [];
  let index = 0;
  for (const c of selected) {
    index++;
    const expected = expectationFor(c, opts.shell);
    const tag = `[${String(index).padStart(3, "0")}/${selected.length}] ${c.id}`;
    if (!expected) {
      console.log(`${tag} skipped (no expectation for ${opts.shell})`);
      continue;
    }
    const started = Date.now();
    const rec = {
      id: c.id,
      lang: c.lang,
      prompt: c.prompt,
      match: c.match,
      dangerous: c.dangerous,
      expected,
      command: "",
      explanation: "",
      parsed: false,
      pass: false,
      reacted: false,
      dangerHits: [],
      unknownOptions: [],
      error: undefined,
      ms: 0,
    };
    try {
      const reply = await chat(endpoint, {
        model: opts.model,
        apiKey,
        system: commandSystem(c.lang),
        user: `${c.prompt}\n\nContext: os: ${OS_OF[opts.shell]}, shell: ${opts.shell}`,
      });
      const obj = parseReply(reply);
      rec.parsed = typeof obj?.command === "string" && obj.command.trim() !== "";
      rec.command = rec.parsed ? obj.command.trim() : "";
      rec.explanation = typeof obj?.explanation === "string" ? obj.explanation.trim() : "";
      if (rec.parsed) {
        rec.pass = expected.some((e) => matches(c.match, rec.command, e, opts.shell));
        rec.dangerHits = dangerHits(rec.command, opts.shell, rules);
        rec.reacted = rec.dangerHits.length > 0;
        rec.unknownOptions = unknownOptions(rec.command, opts.shell, dict);
      }
    } catch (err) {
      rec.error = err instanceof Error ? err.message : String(err);
    }
    rec.ms = Date.now() - started;
    results.push(rec);

    const verdict = rec.error ? "ERROR" : rec.pass ? "ok" : "FAIL";
    const extra = [
      rec.dangerous ? (rec.reacted ? "danger:reacted" : "danger:MISSED") : "",
      rec.unknownOptions.length > 0 ? `unverified:${rec.unknownOptions.join(" ")}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.log(`${tag} ${verdict.padEnd(5)} ${rec.command || rec.error || "(no command)"} ${extra}`.trimEnd());
  }

  const rows = summarize(results);
  printSummary(rows, results);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await mkdir(RESULTS_DIR, { recursive: true });
  const outFile = path.join(RESULTS_DIR, `${stamp}.json`);
  const doc = {
    startedAt,
    endpoint: endpoint.href,
    model: opts.model,
    shell: opts.shell,
    lang: opts.lang,
    limit: opts.limit ?? null,
    summary: rows,
    results,
  };
  await writeFile(outFile, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`\nresults: ${path.relative(process.cwd(), outFile)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
