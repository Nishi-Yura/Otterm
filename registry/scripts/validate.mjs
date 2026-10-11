// Checks registry/mods/*.json against the format in docs/05-mod-system.md section 7.2.
// D1: namespace owner must be the author. D4: terminal.write and network:* need a review.
// Node built-ins only. Used by the CLI below and by build-index.mjs.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REGISTRY_DIR = resolve(here, "..");
export const MODS_DIR = join(REGISTRY_DIR, "mods");
export const INDEX_FILE = join(REGISTRY_DIR, "index.json");

// The `kind` values of otmod.toml (ModKind in crates/otterm-modhost).
export const KINDS = ["extension", "theme", "layout", "dictionary", "workflows", "outfit", "pack"];
export const CATEGORIES = ["theme", "input", "git", "docker", "language", "workflow", "outfit", "fun", "other"];
export const PLATFORMS = ["windows", "macos", "linux"];
// Compressed size limit enforced by the client (50 MB).
export const MAX_PACKAGE_SIZE = 50 * 1024 * 1024;

const ID_RE = /^[a-z0-9-]+\.[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// The form `otterm mod publish` writes (permission_list in crates/otterm-app/src/registry.rs).
const PERMISSION_RE = /^(clipboard|ai|terminal\.read|terminal\.write|(process|fs\.read|fs\.write|network):\S+)$/;

const MOD_FIELDS = [
  "id",
  "name",
  "description",
  "author",
  "kind",
  "categories",
  "license",
  "repository",
  "permissions",
  "reviewed",
  "hidden",
  "versions",
];
const VERSION_FIELDS = ["version", "otterm", "api", "platforms", "url", "sha256", "size", "published"];

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// D4: these permissions need a human review before the mod is listed.
export function needsReview(permissions) {
  return permissions.some((p) => p === "terminal.write" || p.startsWith("network:"));
}

function checkUnknownFields(obj, known, where, errors) {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) errors.push(`${where} has unknown field "${key}"`);
  }
}

function checkText(value, where, errors) {
  if (typeof value !== "string" || value.trim() === "") errors.push(`${where} must be a non-empty string`);
}

function checkHttps(value, where, errors) {
  let ok = false;
  try {
    ok = new URL(value).protocol === "https:";
  } catch {
    ok = false;
  }
  if (!ok) errors.push(`${where} must be an https URL`);
}

function checkStringList(value, where, errors, { allowed, pattern, required = false }) {
  if (!Array.isArray(value)) {
    errors.push(`${where} must be an array`);
    return;
  }
  if (required && value.length === 0) errors.push(`${where} must not be empty`);
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || (allowed && !allowed.includes(item)) || (pattern && !pattern.test(item))) {
      const hint = allowed ? ` (allowed: ${allowed.join(", ")})` : "";
      errors.push(`${where} has invalid value ${JSON.stringify(item)}${hint}`);
    } else if (seen.has(item)) {
      errors.push(`${where} lists ${JSON.stringify(item)} more than once`);
    }
    seen.add(item);
  }
}

function isRealDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Returns { errors, warnings } for one parsed mod file.
export function validateMod(data, fileName) {
  const errors = [];
  const warnings = [];
  if (!isObject(data)) return { errors: ["must contain a JSON object"], warnings };
  checkUnknownFields(data, MOD_FIELDS, "mod", errors);

  if (typeof data.id !== "string" || !ID_RE.test(data.id)) {
    errors.push(`id ${JSON.stringify(data.id)} must look like <owner>.<name> (lowercase, digits, hyphens)`);
  } else {
    const owner = data.id.split(".")[0];
    if (fileName !== undefined && fileName !== `${data.id}.json`) {
      errors.push(`file name must be "${data.id}.json"`);
    }
    if (data.author !== owner) {
      errors.push(
        owner === "otterm"
          ? `ids under "otterm." are reserved for the official author "otterm" (D1)`
          : `author must be "${owner}" to publish "${data.id}" (D1)`,
      );
    }
  }

  checkText(data.name, "name", errors);
  checkText(data.description, "description", errors);
  checkText(data.author, "author", errors);
  checkText(data.license, "license", errors);
  checkHttps(data.repository, "repository", errors);
  if (!KINDS.includes(data.kind)) errors.push(`kind must be one of: ${KINDS.join(", ")}`);
  checkStringList(data.categories, "categories", errors, { allowed: CATEGORIES, required: true });
  checkStringList(data.permissions, "permissions", errors, { pattern: PERMISSION_RE });
  if (typeof data.reviewed !== "boolean") errors.push("reviewed must be true or false");
  if (typeof data.hidden !== "boolean") errors.push("hidden must be true or false");

  if (!Array.isArray(data.versions) || data.versions.length === 0) {
    errors.push("versions must be a non-empty array");
  } else {
    const seen = new Set();
    for (const [i, v] of data.versions.entries()) {
      const where = `versions[${i}]`;
      if (!isObject(v)) {
        errors.push(`${where} must be an object`);
        continue;
      }
      checkUnknownFields(v, VERSION_FIELDS, where, errors);
      if (typeof v.version !== "string" || !SEMVER_RE.test(v.version)) {
        errors.push(`${where}.version ${JSON.stringify(v.version)} is not a semantic version`);
      } else if (seen.has(v.version)) {
        errors.push(`${where}.version "${v.version}" is listed more than once`);
      } else {
        seen.add(v.version);
      }
      checkText(v.otterm, `${where}.otterm`, errors);
      checkText(v.api, `${where}.api`, errors);
      checkStringList(v.platforms, `${where}.platforms`, errors, { allowed: PLATFORMS, required: true });
      checkHttps(v.url, `${where}.url`, errors);
      if (typeof v.sha256 !== "string" || !SHA256_RE.test(v.sha256)) {
        errors.push(`${where}.sha256 must be 64 lowercase hex characters`);
      }
      if (!Number.isInteger(v.size) || v.size <= 0 || v.size > MAX_PACKAGE_SIZE) {
        errors.push(`${where}.size must be a byte count from 1 to ${MAX_PACKAGE_SIZE}`);
      }
      if (!isRealDate(v.published)) errors.push(`${where}.published must be a real date (YYYY-MM-DD)`);
    }
  }

  if (Array.isArray(data.permissions) && needsReview(data.permissions) && data.reviewed !== true) {
    warnings.push("has terminal.write or a network:* permission, so it is hidden until reviewed is true (D4)");
  }
  return { errors, warnings };
}

// Reads and validates every mods/*.json file. Returns one result per file.
export async function checkMods(modsDir = MODS_DIR) {
  const names = (await readdir(modsDir)).filter((name) => name.endsWith(".json")).sort();
  const results = [];
  for (const file of names) {
    let data;
    try {
      data = JSON.parse(await readFile(join(modsDir, file), "utf8"));
    } catch (err) {
      results.push({ file, data: null, errors: [`not valid JSON: ${err.message}`], warnings: [] });
      continue;
    }
    results.push({ file, data, ...validateMod(data, file) });
  }
  return results;
}

async function main() {
  const results = await checkMods();
  let errorCount = 0;
  let warningCount = 0;
  for (const { file, errors, warnings } of results) {
    for (const msg of errors) {
      console.error(`error   mods/${file}: ${msg}`);
      errorCount++;
    }
    for (const msg of warnings) {
      console.warn(`warning mods/${file}: ${msg}`);
      warningCount++;
    }
  }
  console.log(`${results.length} mod file(s) checked, ${errorCount} error(s), ${warningCount} warning(s)`);
  if (errorCount > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
