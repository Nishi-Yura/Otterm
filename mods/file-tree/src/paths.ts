/** Path, file-type and encoding helpers for the file tree. Pure functions: no ctx access. */

export const IMAGE_LIMIT_BYTES = 20 * 1024 * 1024;
export const TEXT_LIMIT_BYTES = 1024 * 1024;

export const IMAGE_MIME = new Map<string, string>([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
]);

/** Text-like extensions (previewable as text) mapped to the Code node language. */
const TEXT_LANGUAGES = new Map<string, string>([
  ["txt", "plaintext"],
  ["log", "plaintext"],
  ["md", "markdown"],
  ["json", "json"],
  ["toml", "toml"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["csv", "csv"],
  ["js", "javascript"],
  ["ts", "typescript"],
  ["py", "python"],
  ["rs", "rust"],
  ["sh", "bash"],
  ["ps1", "powershell"],
  ["css", "css"],
  ["html", "html"],
]);

const CODE_EXTENSIONS = new Set(["js", "ts", "py", "rs", "sh", "ps1", "css", "html", "json", "toml", "yaml", "yml"]);

/** Command prefix for the "run" menu item. The mod only inserts it; the user presses Enter. */
const RUN_PREFIX = new Map<string, string>([
  ["py", "python"],
  ["js", "node"],
  ["ts", "npx tsx"],
  ["sh", "bash"],
  ["ps1", "pwsh -File"],
  ["rb", "ruby"],
]);

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function isTextExt(ext: string): boolean {
  return TEXT_LANGUAGES.has(ext);
}

export function languageOf(ext: string): string {
  return TEXT_LANGUAGES.get(ext) ?? "plaintext";
}

export function runPrefixFor(ext: string): string | undefined {
  return RUN_PREFIX.get(ext);
}

export function iconFor(ext: string): string {
  if (IMAGE_MIME.has(ext)) return "image";
  if (ext === "md" || ext === "txt" || ext === "log" || ext === "csv") return "file-text";
  if (CODE_EXTENSIONS.has(ext)) return "file-code";
  return "file";
}

function sepOf(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

export function joinPath(dir: string, name: string): string {
  if (dir.endsWith("/") || dir.endsWith("\\")) return `${dir}${name}`;
  return `${dir}${sepOf(dir)}${name}`;
}

/** Parent folder. Roots ("/", "C:\") return themselves. */
export function parentOf(path: string): string {
  const trimmed = path.length > 1 && (path.endsWith("/") || path.endsWith("\\")) ? path.slice(0, -1) : path;
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return path;
  if (cut === 0) return trimmed.slice(0, 1);
  if (trimmed[cut - 1] === ":") return trimmed.slice(0, cut + 1);
  return trimmed.slice(0, cut);
}

/** Path relative to root, or the path itself when it is outside root. */
export function relativeTo(root: string, path: string): string {
  if (!root) return path;
  const base = root.endsWith("/") || root.endsWith("\\") ? root : `${root}${sepOf(root)}`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

/** "~ › projects › otterm" style label for the tree header. */
export function breadcrumb(path: string, home: string): string {
  if (!path) return "";
  const normalize = (s: string): string => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = normalize(path);
  const h = home ? normalize(home) : "";
  if (h && (p === h || p.startsWith(`${h}/`))) {
    const rest = p
      .slice(h.length)
      .split("/")
      .filter((s) => s !== "");
    return ["~", ...rest].join(" › ");
  }
  const parts = p.split("/").filter((s) => s !== "");
  if (p.startsWith("/")) parts.unshift("/");
  return parts.length > 0 ? parts.join(" › ") : path;
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((s) => s !== "");
  return parts[parts.length - 1] ?? path;
}

export function isValidName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[\\/]/.test(name);
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 without btoa (not available in the mod sandbox). Chunked to keep QuickJS fast on images up to 20 MB. */
export function base64Encode(bytes: Uint8Array): string {
  const out: string[] = [];
  let chunk = "";
  let groups = 0;
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    chunk +=
      BASE64_ALPHABET.charAt((n >> 18) & 63) +
      BASE64_ALPHABET.charAt((n >> 12) & 63) +
      BASE64_ALPHABET.charAt((n >> 6) & 63) +
      BASE64_ALPHABET.charAt(n & 63);
    groups += 1;
    if (groups === 4096) {
      out.push(chunk);
      chunk = "";
      groups = 0;
    }
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16;
    chunk += `${BASE64_ALPHABET.charAt((n >> 18) & 63)}${BASE64_ALPHABET.charAt((n >> 12) & 63)}==`;
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    chunk += `${BASE64_ALPHABET.charAt((n >> 18) & 63)}${BASE64_ALPHABET.charAt((n >> 12) & 63)}${BASE64_ALPHABET.charAt((n >> 6) & 63)}=`;
  }
  out.push(chunk);
  return out.join("");
}
