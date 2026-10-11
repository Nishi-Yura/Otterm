/** A local path from a `file://` URL (OSC 7), decoded; `file:///C:/x` is `C:/x`. Other text as is. */
export function urlToPath(url: string): string {
  if (!url.startsWith("file://")) return url;
  try {
    const u = new URL(url);
    let path = decodeURIComponent(u.pathname);
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
    // file://server/share is a UNC path on Windows.
    if (u.hostname && u.hostname !== "localhost" && !/^[A-Za-z]:/.test(path))
      return `\\${u.hostname}${path.replaceAll("/", "\\")}`;
    return path;
  } catch {
    return url;
  }
}

/** The last folder of a file:// URL ("C:" for a drive root, "/" for the root). */
export function folderName(url: string): string {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    path = url;
  }
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "/";
}
