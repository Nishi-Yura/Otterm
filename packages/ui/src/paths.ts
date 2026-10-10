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
