/** biome-ignore-all lint/suspicious/noControlCharactersInRegex: this file exists to match terminal control sequences. */
/**
 * M0 stand-in for the VT layer: turns PTY output into plain text so a shell is usable
 * at all. otterm-vt (M1) replaces this with a real grid; nothing else should depend on it.
 */

// CSI with a final byte, OSC terminated by BEL or ST, and the remaining two-byte escapes.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()*+][0-9A-Za-z]|\x1b[=>78DEHMNOc]/g;
// Cursor positioning. ConPTY repaints with these instead of newlines, so they become line breaks.
const CURSOR_TO_ROW = /\x1b\[\d*;?\d*H/g;
/** Device status report: "where is the cursor?". ConPTY waits for the answer before printing anything. */
export const CURSOR_POSITION_QUERY = "\x1b[6n";

export function toPlainText(chunk: string): string {
  return chunk
    .replace(CURSOR_TO_ROW, "\n")
    .replace(ESCAPES, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "")
    .replace(/[\x00-\x07\x0b\x0c\x0e-\x1f]/g, "");
}

/** Apply backspaces (BS) from the shell to text already on screen. */
export function appendWithBackspace(screen: string, text: string): string {
  let out = screen;
  for (const part of text.split(/(\x08)/)) {
    out = part === "\x08" ? out.slice(0, -1) : out + part;
  }
  return out;
}
