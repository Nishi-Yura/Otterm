// Bundles a bundled mod (mods/<name>/src/main.ts) into mods/<name>/dist/main.js: one ESM file,
// the same shape create-otterm-mod produces (docs/05 §3). Run from the mod's folder:
//   node ../../scripts/build-mod.mjs [--watch]
import path from "node:path";
import process from "node:process";
import * as esbuild from "esbuild";

const root = process.cwd();
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
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
