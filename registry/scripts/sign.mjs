// Signs registry/index.json (writes index.json.sig) with the registry key, then checks the result.
//
//   node registry/scripts/sign.mjs
//
// The private key stays on the maintainer's machine: OTTERM_REGISTRY_KEY names it (default
// ~/.tauri/otterm-registry.key) and OTTERM_REGISTRY_KEY_PASSWORD holds its password, if it has one.
// Never commit the key. The matching public key is registry/registry-key.pub, built into otterm.
import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { verifyFile } from "./minisign.mjs";
import { INDEX_FILE, REGISTRY_DIR } from "./validate.mjs";

const key = process.env.OTTERM_REGISTRY_KEY ?? join(homedir(), ".tauri", "otterm-registry.key");
if (!existsSync(key)) {
  console.error(`no registry key at ${key} (set OTTERM_REGISTRY_KEY)`);
  process.exit(1);
}
// pnpm is a .cmd shim on Windows and needs a shell, which joins the arguments: quote them, or an
// empty password would disappear and the next argument would take its place.
const shell = process.platform === "win32";
const q = (s) => (shell ? `"${s}"` : s);
const args = [
  "tauri",
  "signer",
  "sign",
  "-f",
  q(key),
  "-p",
  q(process.env.OTTERM_REGISTRY_KEY_PASSWORD ?? ""),
  q(INDEX_FILE),
];
// The output is not shown: it is only paths.
const opts = {
  cwd: join(REGISTRY_DIR, ".."),
  stdio: ["ignore", "ignore", "inherit"],
  env: { ...process.env, CI: "true" },
};
if (shell) execSync(`pnpm ${args.join(" ")}`, opts);
else execFileSync("pnpm", args, opts);
await verifyFile(INDEX_FILE);
console.log("index.json.sig written and verified");
