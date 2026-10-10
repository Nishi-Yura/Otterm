/** Minimal key → byte mapping for M0. M1 moves key handling into Rust (docs/07-roadmap.md M1). */
const NAMED: Record<string, string> = {
  Enter: "\r",
  Backspace: "\x7f",
  Tab: "\t",
  Escape: "\x1b",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  Delete: "\x1b[3~",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
};

export function keyToInput(e: KeyboardEvent): string | undefined {
  if (e.isComposing || e.metaKey) return undefined;
  const named = NAMED[e.key];
  if (named) return named;
  if (e.ctrlKey && !e.altKey && e.key.length === 1) {
    const code = e.key.toUpperCase().charCodeAt(0);
    // Ctrl+@ … Ctrl+_ map to 0x00–0x1f.
    if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code - 0x40);
    return undefined;
  }
  if (e.key.length === 1) return e.altKey ? `\x1b${e.key}` : e.key;
  return undefined;
}
