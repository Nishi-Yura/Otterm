// Checks packages/ui/locales/*.ftl: every file parses without errors and defines the same message
// ids as the Japanese source (decision C7). Run: node tests/i18n/check-locales.mjs
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "packages/ui/package.json"));
const { FluentResource } = require("@fluent/bundle");

const dir = path.join(root, "packages/ui/locales");
const ids = (file) => {
  const text = fs.readFileSync(path.join(dir, file), "utf8");
  // FluentResource skips broken entries silently; Junk shows up as missing ids, and the parser
  // reports nothing, so also look for lines it could not attach to a message.
  const res = new FluentResource(text);
  const parsed = new Set(res.body.map((m) => m.id));
  const declared = [...text.matchAll(/^(-?[a-zA-Z][\w-]*)\s*=/gm)].map((m) => m[1]);
  const broken = declared.filter((id) => !parsed.has(id));
  return { parsed, broken };
};

let failed = false;
const reference = ids("ja.ftl");
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ftl"))) {
  const { parsed, broken } = ids(file);
  if (broken.length) {
    failed = true;
    console.error(`${file}: could not parse ${broken.join(", ")}`);
  }
  const missing = [...reference.parsed].filter((id) => !parsed.has(id));
  const extra = [...parsed].filter((id) => !reference.parsed.has(id));
  if (missing.length || extra.length) {
    failed = true;
    if (missing.length) console.error(`${file}: missing ${missing.join(", ")}`);
    if (extra.length) console.error(`${file}: not in ja.ftl: ${extra.join(", ")}`);
  }
}
if (failed) process.exit(1);
console.log(`locales OK (${reference.parsed.size} messages)`);
