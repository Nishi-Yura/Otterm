#!/usr/bin/env node
// Build a release of otterm on this machine (docs/release.md). Nothing is uploaded: the result is
// a folder `dist-release/<version>/` with the installer, SHA256SUMS.txt, latest.json for the
// updater (decision C10) and the winget / Homebrew manifests filled in, ready to publish by hand.
//
//   node scripts/release.mjs [--notes <file>] [--skip-build] [--unsigned]
//
// Run it once per OS (Windows: NSIS installer; macOS: .app + .dmg; Linux: AppImage). Each run
// merges its platform into the same latest.json. Updater signing needs the private key in
// TAURI_SIGNING_PRIVATE_KEY (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD) and the public key in
// packaging/updater.pub; without them the build works but cannot update itself.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath decodes %-escapes: a checkout under a path with spaces or non-ASCII works too.
const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const platform = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform];
if (!platform) throw new Error(`unsupported platform ${process.platform}`);
const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch] ?? process.arch;

const tauriConf = JSON.parse(readFileSync(join(root, "crates/otterm-app/tauri.conf.json"), "utf8"));
const cargoToml = readFileSync(join(root, "Cargo.toml"), "utf8");
const cargoVersion = /\[workspace\.package\][^[]*?version\s*=\s*"([^"]+)"/s.exec(cargoToml)?.[1];
const repository = /\[workspace\.package\][^[]*?repository\s*=\s*"([^"]+)"/s.exec(cargoToml)?.[1];
const version = tauriConf.version;
if (version !== cargoVersion) {
  throw new Error(`tauri.conf.json says ${version}, Cargo.toml says ${cargoVersion}: set both to the release version`);
}
if (version === "0.0.0")
  console.warn("warning: version 0.0.0 is the development version; set the release version first");

const run = (cmd, cmdArgs, env = {}) => {
  console.log(`> ${cmd} ${cmdArgs.join(" ")}`);
  execFileSync(cmd, cmdArgs, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  });
};

// Updater signing (decision C10): both halves of the key, or neither.
const pubFile = join(root, "packaging/updater.pub");
const pubkey = existsSync(pubFile) ? readFileSync(pubFile, "utf8").trim() : "";
const canSign = pubkey !== "" && !!process.env.TAURI_SIGNING_PRIVATE_KEY;
if (!canSign) {
  const message =
    "no updater key (packaging/updater.pub and TAURI_SIGNING_PRIVATE_KEY); this build cannot update itself";
  // A release that cannot update strands its users on it: stop, unless asked for on purpose.
  // Environment variables belong to one terminal, so set them in the one that runs this script.
  if (version !== "0.0.0" && !flag("--unsigned")) {
    console.error(`error: ${message}.
Set TAURI_SIGNING_PRIVATE_KEY (and its password) in this terminal, or pass --unsigned.`);
    process.exit(1);
  }
  console.warn(`warning: ${message}`);
}

const targets = { windows: ["nsis"], macos: ["app", "dmg"], linux: ["appimage"] }[platform];
const overlay = {
  version,
  bundle: {
    active: true,
    targets,
    createUpdaterArtifacts: canSign,
    publisher: "otterm",
    homepage: repository,
    shortDescription: "A terminal that is easy for beginners and fast for everyone",
    ...(platform === "windows"
      ? {
          // otterm.com prints for the subcommands (docs/06 §4); next to otterm.exe in the install folder.
          resources: {
            "resources/windows/x64/conpty.dll": "conpty.dll",
            "resources/windows/x64/OpenConsole.exe": "OpenConsole.exe",
            "../../target/release/otterm.com": "otterm.com",
          },
          windows: {
            nsis: {
              installMode: "currentUser",
              installerHooks: "windows/hooks.nsh",
              // Tauri's template with the per-user folder moved to %LOCALAPPDATA%\Programs\otterm.
              template: "windows/installer.nsi",
              languages: ["Japanese", "English"],
              displayLanguageSelector: true,
            },
          },
        }
      : {}),
  },
  // The bundler reads the public key from the config when it signs the update artifacts (the app
  // itself gets it from OTTERM_UPDATER_PUBKEY at build time, update.rs). Same key in both places.
  ...(canSign ? { plugins: { updater: { pubkey } } } : {}),
};
mkdirSync(join(root, "target"), { recursive: true });
const overlayFile = join(root, "target/release-tauri.json");
writeFileSync(overlayFile, `${JSON.stringify(overlay, null, 2)}\n`);

if (!flag("--skip-build")) {
  run("pnpm", ["-r", "--filter", "./mods/*", "build"]);
  if (platform === "windows") {
    run("cargo", ["build", "--release", "-p", "otterm-console"]);
    copyFileSync(join(root, "target/release/otterm-console.exe"), join(root, "target/release/otterm.com"));
  }
  run("pnpm", ["tauri", "build", "--config", overlayFile], canSign ? { OTTERM_UPDATER_PUBKEY: pubkey } : {});
}

// Collect what the bundler made.
const bundle = join(root, "target/release/bundle");
const wanted = {
  windows: [["nsis", /\.exe$/]],
  macos: [
    ["dmg", /\.dmg$/],
    ["macos", /\.app\.tar\.gz$/],
  ],
  linux: [["appimage", /\.AppImage$/]],
}[platform];
const out = join(root, "dist-release", version);
mkdirSync(out, { recursive: true });
const files = [];
for (const [dir, pattern] of wanted) {
  const d = join(bundle, dir);
  if (!existsSync(d)) continue;
  for (const name of readdirSync(d)) {
    if (!pattern.test(name) || !name.includes(version)) continue;
    copyFileSync(join(d, name), join(out, name));
    if (existsSync(join(d, `${name}.sig`))) copyFileSync(join(d, `${name}.sig`), join(out, `${name}.sig`));
    files.push(name);
  }
}
if (files.length === 0) throw new Error(`no installer for ${version} in ${bundle}`);

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const sums = join(out, "SHA256SUMS.txt");
const known = new Map(
  existsSync(sums)
    ? readFileSync(sums, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => [l.slice(66), l.slice(0, 64)])
    : [],
);
for (const name of files) known.set(name, sha256(join(out, name)));
writeFileSync(sums, `${[...known].map(([n, h]) => `${h}  ${n}`).join("\n")}\n`);

const downloadUrl = (name) => `${repository}/releases/download/v${version}/${name}`;

// latest.json for the updater: one entry per platform, merged across the runs on each OS.
if (canSign) {
  const latestFile = join(out, "latest.json");
  const latest = existsSync(latestFile)
    ? JSON.parse(readFileSync(latestFile, "utf8"))
    : { version, notes: "", pub_date: new Date().toISOString(), platforms: {} };
  const notes = option("--notes");
  if (notes) latest.notes = readFileSync(notes, "utf8").trim();
  // The updater installs the NSIS setup on Windows, the .app.tar.gz on macOS, the AppImage on Linux.
  const updaterFile = files.find((n) => /\.exe$|\.app\.tar\.gz$|\.AppImage$/.test(n));
  if (updaterFile && existsSync(join(out, `${updaterFile}.sig`))) {
    latest.platforms[`${platform === "macos" ? "darwin" : platform}-${arch}`] = {
      signature: readFileSync(join(out, `${updaterFile}.sig`), "utf8").trim(),
      url: downloadUrl(updaterFile),
    };
  }
  writeFileSync(latestFile, `${JSON.stringify(latest, null, 2)}\n`);
}

// The package manager manifests (decision A9), filled in from packaging/.
const fill = (template, values) => template.replace(/\{\{(\w+)\}\}/g, (_, k) => values[k] ?? `{{${k}}}`);
const values = { version, repository, date: new Date().toISOString().slice(0, 10) };
const exe = files.find((n) => n.endsWith(".exe"));
if (exe) {
  Object.assign(values, { installerUrl: downloadUrl(exe), installerSha256: known.get(exe).toUpperCase() });
  const dir = join(out, "winget", version);
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(join(root, "packaging/winget"))) {
    if (!name.endsWith(".yaml")) continue;
    writeFileSync(join(dir, name), fill(readFileSync(join(root, "packaging/winget", name), "utf8"), values));
  }
}
const dmg = files.find((n) => n.endsWith(".dmg"));
if (dmg) {
  Object.assign(values, { dmgUrl: downloadUrl(dmg), dmgSha256: known.get(dmg), dmgName: basename(dmg) });
  writeFileSync(join(out, "otterm.rb"), fill(readFileSync(join(root, "packaging/homebrew/otterm.rb"), "utf8"), values));
}

console.log(`\n${out}`);
for (const name of readdirSync(out)) {
  const p = join(out, name);
  if (statSync(p).isFile()) console.log(`  ${name}  ${(statSync(p).size / 1048576).toFixed(1)} MB`);
}
console.log("\nNothing was uploaded. docs/release.md has the publishing steps.");
