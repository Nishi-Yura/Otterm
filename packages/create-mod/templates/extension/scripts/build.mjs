// Bundles src/main.ts into dist/main.js (one ESM file).
// `--watch` rebuilds on every change and links the mod into otterm once at start.

import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: [path.join(root, "src", "main.ts")],
  outfile: path.join(root, "dist", "main.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "neutral",
  mainFields: ["module", "main"],
  minify: false,
  sourcemap: false,
  external: [],
  logLevel: "info",
};

if (!watch) {
  await esbuild.build(options);
} else {
  const ctx = await esbuild.context(options);
  await ctx.watch();

  // Linking is best effort: a missing otterm data folder must not stop the build watch.
  try {
    execFileSync(process.execPath, [path.join(root, "scripts", "link.mjs")], { stdio: "inherit" });
  } catch {
    console.warn("[dev] link skipped (run `pnpm link` after fixing the error above)");
  }

  const stop = async () => {
    await ctx.dispose();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log("[dev] watching src/ (Ctrl+C to stop)");
}
