#!/usr/bin/env node
// create-otterm-mod: scaffold an otterm mod from templates/<kind>/.
//
//   create-otterm-mod [dir] [--kind extension|theme] [--id <namespace.name>] [--name "<display name>"] [--yes]
//
// Asks for whatever is missing when stdin and stdout are terminals. Otherwise uses the defaults.
// OTTERM_API_LOCAL=<path> makes an extension depend on a local @otterm/api checkout (for otterm contributors).

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const templatesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "templates");
const KINDS = ["extension", "theme"];
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
// Template files whose output name differs. npm strips .gitignore from packages, hence _gitignore.
const OUTPUT_NAMES = { _gitignore: ".gitignore", "tsconfig.template.json": "tsconfig.json" };

const USAGE = `Usage: create-otterm-mod [dir] [--kind extension|theme] [--id <namespace.name>] [--name "<display name>"] [--yes]

  dir           directory to create (must be empty or missing)
  --kind        extension (TypeScript + esbuild) or theme (TOML only)
  --id          mod id, e.g. example.my-mod (default: example.<dir name>)
  --name        display name (default: derived from the id)
  --yes, -y     use the defaults for anything not given, and do not ask questions

Environment:
  OTTERM_API_LOCAL=<path>   depend on a local @otterm/api checkout instead of the npm package (extension only)`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { dir: undefined, kind: undefined, id: undefined, name: undefined, yes: false, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const isLong = arg.startsWith("--") && eq > 0;
    const flag = isLong ? arg.slice(0, eq) : arg;
    // A value comes from `--flag=value` or from the next argument.
    const takeValue = () => {
      if (isLong) return arg.slice(eq + 1);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError(`${flag} needs a value`);
      i++;
      return next;
    };
    switch (flag) {
      case "--kind":
        opts.kind = takeValue();
        break;
      case "--id":
        opts.id = takeValue();
        break;
      case "--name":
        opts.name = takeValue();
        break;
      case "--yes":
      case "-y":
        opts.yes = true;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        if (arg.startsWith("-")) throw new UsageError(`unknown option: ${arg}`);
        positional.push(arg);
    }
  }
  if (positional.length > 1) throw new UsageError("only one directory can be given");
  opts.dir = positional[0];
  return opts;
}

function checkKind(kind) {
  return KINDS.includes(kind) ? undefined : `kind must be one of: ${KINDS.join(", ")}`;
}

function checkId(id) {
  if (!ID_PATTERN.test(id)) {
    return "id must be <namespace>.<name> with lowercase letters, digits and -, e.g. example.my-mod";
  }
  if (id.startsWith("otterm.")) return "the otterm. namespace is reserved for official mods";
  return undefined;
}

function checkName(name) {
  if (name.trim() === "") return "name must not be empty";
  if (name.length > 80) return "name must be 80 characters or fewer";
  if (/\p{Cc}/u.test(name)) return "name must not contain control characters";
  return undefined;
}

// "My Project!" -> "my-project"
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// "my-mod" -> "My Mod"
function titleFromSlug(slug) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

// "example.my-mod" -> "my-mod"
function shortName(id) {
  return id.slice(id.indexOf(".") + 1);
}

// Escapes a value for a double-quoted string in TOML, JSON or TypeScript.
function quoted(value) {
  return value.replace(/[\\"]/g, "\\$&");
}

async function ask(rl, question, fallback, validate) {
  for (;;) {
    const answer = (await rl.question(`${question} [${fallback}]: `)).trim() || fallback;
    const problem = validate(answer);
    if (!problem) return answer;
    console.log(`  ${problem}`);
  }
}

function copyTemplate(from, to, values) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    // The repo's tsconfig.json extends the monorepo base. The generated one comes from tsconfig.template.json.
    if (entry.name === "tsconfig.json") continue;
    const src = path.join(from, entry.name);
    if (entry.isDirectory()) {
      copyTemplate(src, path.join(to, entry.name), values);
      continue;
    }
    const dest = path.join(to, OUTPUT_NAMES[entry.name] ?? entry.name);
    const bytes = fs.readFileSync(src);
    if (bytes.includes(0)) {
      fs.writeFileSync(dest, bytes); // binary: copied as it is
      continue;
    }
    // Markdown is shown as written; everywhere else the name is escaped for the quoted strings it sits in.
    const isMarkdown = entry.name.endsWith(".md");
    const text = bytes.toString("utf8").replace(/__(ID|NAME|NAMESPACE|SHORT)__/g, (_, key) => {
      const value = values[key];
      return key === "NAME" && !isMarkdown ? quoted(value) : value;
    });
    fs.writeFileSync(dest, text);
  }
}

// Points the generated extension at a local @otterm/api checkout instead of the npm version.
function useLocalApi(target, apiPath) {
  const resolved = path.resolve(apiPath);
  if (!fs.existsSync(path.join(resolved, "package.json"))) {
    throw new Error(`OTTERM_API_LOCAL has no package.json: ${resolved}`);
  }
  const pkgPath = path.join(target, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.devDependencies["@otterm/api"] = `file:${resolved.replaceAll("\\", "/")}`;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function nextSteps(kind, dir) {
  if (kind === "theme") return [`  cd ${dir}`, "  edit theme.toml", "  otterm mod install --link ."];
  return [`  cd ${dir}`, "  pnpm install", "  pnpm dev"];
}

async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const interactive = !opts.yes && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  // Ctrl+C or Ctrl+D at a prompt closes the interface while a question is still pending.
  let finished = false;
  rl?.on("SIGINT", () => rl.close());
  rl?.on("close", () => {
    if (finished) return;
    console.error("\ncancelled");
    process.exit(130);
  });

  try {
    const dirArg = opts.dir ?? (rl ? await ask(rl, "Directory", "my-mod", () => undefined) : "my-mod");
    const target = path.resolve(dirArg);
    if (fs.existsSync(target)) {
      if (!fs.statSync(target).isDirectory()) throw new Error(`${dirArg} exists and is not a directory`);
      if (fs.readdirSync(target).length > 0) throw new Error(`${dirArg} is not empty; choose another directory`);
    }
    const dirSlug = slugify(path.basename(target)) || "my-mod";

    let kind = "extension";
    if (opts.kind !== undefined) {
      const problem = checkKind(opts.kind);
      if (problem) throw new UsageError(problem);
      kind = opts.kind;
    } else if (rl) {
      kind = await ask(rl, `Kind (${KINDS.join("/")})`, kind, checkKind);
    }

    const defaultId = `example.${dirSlug}`;
    let id = defaultId;
    if (opts.id !== undefined) {
      const problem = checkId(opts.id);
      if (problem) throw new UsageError(problem);
      id = opts.id;
    } else if (rl) {
      id = await ask(rl, "Mod id (<namespace>.<name>)", defaultId, checkId);
    }

    let name = titleFromSlug(shortName(id));
    if (opts.name !== undefined) {
      const problem = checkName(opts.name);
      if (problem) throw new UsageError(problem);
      name = opts.name;
    } else if (rl) {
      name = await ask(rl, "Display name", name, checkName);
    }

    const values = { ID: id, NAME: name, NAMESPACE: id.slice(0, id.indexOf(".")), SHORT: shortName(id) };
    copyTemplate(path.join(templatesDir, kind), target, values);

    if (kind === "extension" && process.env.OTTERM_API_LOCAL) {
      useLocalApi(target, process.env.OTTERM_API_LOCAL);
    }

    const shownDir = path.relative(process.cwd(), target) || ".";
    console.log(`\nCreated ${kind} mod ${id} in ${shownDir}\n\nNext:`);
    for (const line of nextSteps(kind, shownDir.includes(" ") ? `"${shownDir}"` : shownDir)) console.log(line);
    return 0;
  } finally {
    finished = true;
    rl?.close();
  }
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    if (err instanceof UsageError) {
      console.error(`create-otterm-mod: ${err.message}\n\n${USAGE}`);
      process.exitCode = 2;
    } else {
      console.error(`create-otterm-mod: ${err.message}`);
      process.exitCode = 1;
    }
  },
);
