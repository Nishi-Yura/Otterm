// Links this mod folder into otterm's mods folder, so a running otterm picks it up.
//
//   node scripts/link.mjs            link (replaces an existing link or folder at the target)
//   node scripts/link.mjs --unlink   remove the link (a real folder is left alone)
//
// OTTERM_DATA_DIR overrides otterm's data folder. The otterm app honors the same variable,
// so it is also how the link can be tested against a temporary folder.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const unlink = process.argv.includes("--unlink");

function otermDataDir() {
  if (process.env.OTTERM_DATA_DIR) return process.env.OTTERM_DATA_DIR;
  if (process.platform === "win32") {
    if (!process.env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is not set");
    return path.join(process.env.LOCALAPPDATA, "otterm");
  }
  const home = process.env.HOME || os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "otterm");
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "otterm");
}

function modId() {
  const toml = fs.readFileSync(path.join(root, "otmod.toml"), "utf8");
  const match = /^id\s*=\s*"([^"]+)"/m.exec(toml);
  if (!match || !/^[a-z0-9-]+\.[a-z0-9-]+$/.test(match[1])) {
    throw new Error('otmod.toml needs a line like id = "example.my-mod" in [mod]');
  }
  return match[1];
}

function lstatOrUndefined(p) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err.code === "ENOENT") return undefined;
    throw err;
  }
}

// Removes the link itself. On Windows a junction is removed with rmdir, which never touches its target.
function removeLink(p) {
  if (process.platform === "win32") fs.rmdirSync(p);
  else fs.unlinkSync(p);
}

const target = path.join(otermDataDir(), "mods", modId());
const current = lstatOrUndefined(target);

if (unlink) {
  if (!current) console.log(`not linked: ${target}`);
  else if (current.isSymbolicLink()) {
    removeLink(target);
    console.log(`unlinked: ${target}`);
  } else console.log(`${target} is a folder, not a link; left it alone`);
} else {
  if (current?.isSymbolicLink()) removeLink(target);
  else if (current) {
    console.log(`replacing the existing folder at ${target}`);
    fs.rmSync(target, { recursive: true, force: true });
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(root, target, process.platform === "win32" ? "junction" : "dir");
  console.log(`linked: ${target} -> ${root}`);
  console.log("otterm reloads a linked mod when dist/main.js changes.");
}
