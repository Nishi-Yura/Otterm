#!/usr/bin/env node
// Put the mods in community-mods/ into the registry (registry/, docs/05 §7.2): build each one,
// pack it with `otterm mod publish` (the same tool mod authors use), copy the package to
// registry/packages/ and its entry to registry/mods/, then rebuild registry/index.json.
//
//   node scripts/publish-community-mods.mjs [--otterm <path to otterm.exe>]
//
// The packages are served from this public repository, so a push is the whole release; nothing
// here uploads anything by itself.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const args = process.argv.slice(2);
const i = args.indexOf("--otterm");
const otterm =
  i >= 0 ? args[i + 1] : join(root, "target/debug", process.platform === "win32" ? "otterm.exe" : "otterm");
if (!existsSync(otterm)) throw new Error(`${otterm} not found: run \`cargo build -p otterm-app\` first`);

/** Where a package is downloaded from: this repository's main branch. */
const PACKAGES_URL = "https://raw.githubusercontent.com/Nishi-Yura/Otterm/main/registry/packages";
/** Store categories (docs/05 §7.2) by mod folder. */
const CATEGORIES = {
  "theme-sakura": ["theme"],
  "theme-kawauso-night": ["theme"],
  "theme-matcha": ["theme"],
  "dict-containers": ["input", "docker"],
  "dict-js-tools": ["input", "language"],
  "dict-python-tools": ["input", "language"],
  "git-status-bar": ["git"],
  clock: ["fun"],
  pomodoro: ["fun", "workflow"],
  "done-notify": ["workflow"],
  cheatsheet: ["input"],
  "theme-yuki": ["theme"],
  "theme-yuyake": ["theme"],
  "theme-shinkai": ["theme"],
  "outfit-winter": ["outfit"],
  "dict-net-tools": ["input"],
  "dict-db-tools": ["input"],
  "dict-modern-cli": ["input"],
  "dict-media-tools": ["input"],
  "exit-status": ["workflow"],
  "command-stats": ["fun", "workflow"],
  "project-scripts": ["workflow", "language"],
  bookmarks: ["workflow"],
  "daily-tip": ["fun", "input"],
};

const run = (cmd, cmdArgs, cwd = root) =>
  execFileSync(cmd, cmdArgs, { cwd, stdio: ["ignore", "pipe", "inherit"], shell: process.platform === "win32" })
    .toString()
    .trim();

const mods = join(root, "community-mods");
const packages = join(root, "registry/packages");
const entries = join(root, "registry/mods");
mkdirSync(packages, { recursive: true });
mkdirSync(entries, { recursive: true });

for (const folder of readdirSync(mods).sort()) {
  const dir = join(mods, folder);
  if (!existsSync(join(dir, "otmod.toml"))) continue;
  if (existsSync(join(dir, "package.json"))) run("pnpm", ["run", "build"], dir);
  const out = join(dir, "dist-otmod");
  // Start from the published entry, so earlier versions stay listed.
  const manifest = readFileSync(join(dir, "otmod.toml"), "utf8");
  const id = /^id\s*=\s*"([^"]+)"/m.exec(manifest)?.[1];
  mkdirSync(out, { recursive: true });
  if (existsSync(join(entries, `${id}.json`))) copyFileSync(join(entries, `${id}.json`), join(out, `${id}.json`));
  run(otterm, ["mod", "publish", dir]);
  const entry = JSON.parse(readFileSync(join(out, `${id}.json`), "utf8"));
  const release = entry.versions[0];
  const file = `${id}-${release.version}.otmod`;
  copyFileSync(join(out, file), join(packages, file));
  release.url = `${PACKAGES_URL}/${file}`;
  entry.categories = CATEGORIES[folder] ?? entry.categories;
  // Written by the maintainer and read before publishing (D4).
  entry.reviewed = true;
  writeFileSync(join(entries, `${id}.json`), `${JSON.stringify(entry, null, 2)}\n`);
  console.log(`${id} ${release.version}`);
}

execFileSync("node", ["scripts/build-index.mjs"], { cwd: join(root, "registry"), stdio: "inherit" });
