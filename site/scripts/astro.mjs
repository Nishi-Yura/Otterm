// Runs the Astro CLI with telemetry disabled. Works the same on Windows, macOS and Linux
// because it sets the variable in the child's environment instead of relying on shell syntax.
import { spawnSync } from "node:child_process";
import process from "node:process";

const result = spawnSync("astro", process.argv.slice(2), {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
});

if (result.error) {
  console.error(result.error);
}
process.exit(result.status ?? 1);
