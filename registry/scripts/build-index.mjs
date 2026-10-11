// Builds registry/index.json from registry/mods/*.json.
// Writes nothing when validation reports errors. Warnings are printed.
import { writeFile } from "node:fs/promises";
import { checkMods, INDEX_FILE, needsReview } from "./validate.mjs";

async function main() {
  const results = await checkMods();
  let errorCount = 0;
  for (const { file, errors, warnings } of results) {
    for (const msg of errors) {
      console.error(`error   mods/${file}: ${msg}`);
      errorCount++;
    }
    for (const msg of warnings) console.warn(`warning mods/${file}: ${msg}`);
  }
  if (errorCount > 0) {
    console.error(`index.json not written: ${errorCount} error(s)`);
    process.exitCode = 1;
    return;
  }

  const mods = results
    .map(({ data }) => ({
      ...data,
      // D4: mods with terminal.write or network:* stay hidden until reviewed.
      hidden: data.hidden === true || (needsReview(data.permissions) && data.reviewed !== true),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const index = { schema: 1, generated: new Date().toISOString(), mods };
  await writeFile(INDEX_FILE, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  console.log(`wrote index.json with ${mods.length} mod(s); sign it next: node scripts/sign.mjs`);
}

await main();
