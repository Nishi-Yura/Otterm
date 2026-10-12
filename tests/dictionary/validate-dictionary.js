// Minimal JSON-Schema (2020-12 subset) validator for the otterm dictionary schema.
// Supports: type, required, properties, additionalProperties:false, items, enum, oneOf,
// patternProperties, propertyNames.enum, minItems, minProperties, pattern, $ref (#/$defs/*).
const fs = require("node:fs");
const path = require("node:path");

// Usage: node tests/dictionary/validate-dictionary.js [repo-root]
const root = process.argv[2] ?? path.resolve(__dirname, "../..");
const schema = JSON.parse(fs.readFileSync(path.join(root, "packages/api/schemas/dictionary.schema.json"), "utf8"));

function resolve(s) {
  if (s?.$ref) {
    const key = s.$ref.replace("#/$defs/", "");
    return resolve(schema.$defs[key]);
  }
  return s;
}

function typeOf(v) {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function validate(value, s, p, errs) {
  s = resolve(s);
  if (!s) return;
  if (s.oneOf) {
    const ok = s.oneOf.filter((alt) => {
      const e = [];
      validate(value, alt, p, e);
      return e.length === 0;
    });
    if (ok.length !== 1) errs.push(`${p}: matches ${ok.length} of oneOf alternatives`);
    return;
  }
  if (s.enum && !s.enum.includes(value)) errs.push(`${p}: ${JSON.stringify(value)} not in enum [${s.enum.join(", ")}]`);
  if (s.type) {
    const t = typeOf(value);
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const okType = types.includes(t) || (types.includes("number") && t === "integer");
    if (!okType) {
      errs.push(`${p}: expected ${types.join("|")}, got ${t}`);
      return;
    }
  }
  if (typeOf(value) === "string" && s.pattern && !new RegExp(s.pattern).test(value))
    errs.push(`${p}: "${value}" does not match /${s.pattern}/`);
  if (typeOf(value) === "array") {
    if (s.minItems && value.length < s.minItems) errs.push(`${p}: fewer than ${s.minItems} items`);
    if (s.items)
      value.forEach((v, i) => {
        validate(v, s.items, `${p}[${i}]`, errs);
      });
  }
  if (typeOf(value) === "object") {
    const keys = Object.keys(value);
    if (s.minProperties && keys.length < s.minProperties) errs.push(`${p}: fewer than ${s.minProperties} properties`);
    if (s.required) for (const r of s.required) if (!(r in value)) errs.push(`${p}: missing required "${r}"`);
    if (s.propertyNames?.enum)
      for (const k of keys) if (!s.propertyNames.enum.includes(k)) errs.push(`${p}: key "${k}" not allowed`);
    for (const k of keys) {
      let matched = false;
      if (s.properties && k in s.properties) {
        matched = true;
        validate(value[k], s.properties[k], `${p}.${k}`, errs);
      }
      if (s.patternProperties) {
        for (const [pat, sub] of Object.entries(s.patternProperties)) {
          if (new RegExp(pat).test(k)) {
            matched = true;
            validate(value[k], sub, `${p}.${k}`, errs);
          }
        }
      }
      if (!matched) {
        if (s.additionalProperties === false) errs.push(`${p}: unknown key "${k}"`);
        else if (s.additionalProperties && typeof s.additionalProperties === "object")
          validate(value[k], s.additionalProperties, `${p}.${k}`, errs);
      }
    }
  }
}

// Extra semantic checks beyond the schema.
function semantic(entry, file, errs) {
  if (entry.name !== path.basename(file, ".json")) errs.push(`name "${entry.name}" != filename`);
  const checkErrors = (arr, where) => {
    for (const e of arr || []) {
      try {
        new RegExp(e.pattern, "im");
      } catch (ex) {
        errs.push(`${where} pattern does not compile: ${ex.message}`);
        continue;
      }
      const groups = [...e.pattern.matchAll(/\(\?<([A-Za-z_]\w*)>/g)].map((m) => m[1]);
      const used = new Set();
      for (const text of [JSON.stringify(e.hint), e.fix || ""])
        for (const m of text.matchAll(/\{(\w+)\}/g)) used.add(m[1]);
      for (const u of used)
        if (u !== "args" && !groups.includes(u)) errs.push(`${where} uses {${u}} but pattern has no group "${u}"`);
    }
  };
  const checkLocalized = (v, where) => {
    if (v && typeof v === "object" && !("ja" in v && "en" in v)) errs.push(`${where} must have both ja and en`);
  };
  const walk = (node, where) => {
    for (const k of ["summary", "description", "dangerMessage", "hint", "learn", "label"])
      if (k in node) checkLocalized(node[k], `${where}.${k}`);
    for (const o of node.options || []) {
      walk(o, `${where}.option(${o.flags?.[0]})`);
      if (o.danger && !o.dangerMessage) errs.push(`${where}.option(${o.flags[0]}) has danger without dangerMessage`);
      if (o.valueType && !o.takesValue) errs.push(`${where}.option(${o.flags[0]}) valueType without takesValue`);
      if (o.alternative) walk(o.alternative, `${where}.option(${o.flags[0]}).alternative`);
    }
    for (const a of node.args || []) walk(a, `${where}.arg(${a.name})`);
    for (const ex of node.examples || []) walk(ex, `${where}.example`);
    checkErrors(node.errors, `${where}.errors`);
    for (const sc of node.subcommands || []) walk(sc, `${where}.${sc.name}`);
    if (node.alternative && where.split(".").length <= 2) walk(node.alternative, `${where}.alternative`);
  };
  walk(entry, entry.name);
}

// Every mod that ships a dictionary: the built-in ones and the community ones (issue #23).
const dictionaries = ["mods", "community-mods"].flatMap((base) => {
  const at = path.join(root, base);
  if (!fs.existsSync(at)) return [];
  return fs
    .readdirSync(at)
    .sort()
    .map((m) => path.join(at, m, "dictionary"))
    .filter((d) => fs.existsSync(d));
});
const jsonIn = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => path.join(dir, f))
    : [];
const files = dictionaries.flatMap((d) => jsonIn(path.join(d, "commands")));
const ruleFiles = dictionaries.flatMap((d) => jsonIn(path.join(d, "rules")));
const shown = (full) => path.relative(root, full).replaceAll("\\", "/");
let problems = 0;
const stats = { files: 0, subcommands: 0, options: 0, errors: 0, examples: 0, danger: 0, lines: 0 };
const countDanger = (n) =>
  (n.danger ? 1 : 0) +
  (n.options || []).filter((o) => o.danger).length +
  (n.subcommands || []).reduce((a, s) => a + countDanger(s), 0);
const countOpts = (n) => (n.options || []).length + (n.subcommands || []).reduce((a, s) => a + countOpts(s), 0);
const countErrs = (n) => (n.errors || []).length + (n.subcommands || []).reduce((a, s) => a + countErrs(s), 0);
const countEx = (n) => (n.examples || []).length + (n.subcommands || []).reduce((a, s) => a + countEx(s), 0);

for (const full of files) {
  const f = shown(full);
  const raw = fs.readFileSync(full);
  const errs = [];
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) errs.push("has UTF-8 BOM");
  if (raw.includes("\r\n")) errs.push("has CRLF line endings");
  let entry;
  try {
    entry = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    errs.push(`invalid JSON: ${e.message}`);
  }
  if (entry) {
    validate(entry, schema, entry.name || f, errs);
    semantic(entry, f, errs);
    stats.files++;
    stats.subcommands += (entry.subcommands || []).length;
    stats.options += countOpts(entry);
    stats.errors += countErrs(entry);
    stats.examples += countEx(entry);
    stats.danger += countDanger(entry);
    stats.lines += raw.toString("utf8").split("\n").length;
  }
  if (errs.length) {
    problems += errs.length;
    console.log(`FAIL ${f}`);
    for (const e of errs) console.log(`   - ${e}`);
  }
}

// Danger rules: each regex compiles, ids are unique across mods, messages are in both languages.
const ruleIds = new Set();
let ruleCount = 0;
for (const full of ruleFiles) {
  const f = shown(full);
  const raw = fs.readFileSync(full);
  const errs = [];
  if (raw.includes("\r\n")) errs.push("has CRLF line endings");
  let rules = [];
  try {
    rules = JSON.parse(raw.toString("utf8")).rules;
    if (!Array.isArray(rules)) throw new Error("no rules array");
  } catch (e) {
    errs.push(`invalid rules file: ${e.message}`);
    rules = [];
  }
  for (const r of rules) {
    ruleCount++;
    const id = r?.id ?? "(no id)";
    if (typeof r?.id !== "string") errs.push(`${id}: missing id`);
    else if (ruleIds.has(r.id)) errs.push(`${id}: duplicate rule id`);
    else ruleIds.add(r.id);
    if (r?.match?.regex) {
      try {
        new RegExp(r.match.regex, "im");
      } catch (e) {
        errs.push(`${id}: ${e.message}`);
      }
    }
    if (r?.message && typeof r.message === "object" && !("ja" in r.message && "en" in r.message))
      errs.push(`${id}.message must have both ja and en`);
  }
  if (errs.length) {
    problems += errs.length;
    console.log(`FAIL ${f}`);
    for (const e of errs) console.log(`   - ${e}`);
  }
}

console.log(JSON.stringify({ dictionaries: dictionaries.length, ...stats, rules: ruleCount, problems }, null, 2));
process.exit(problems ? 1 : 0);
