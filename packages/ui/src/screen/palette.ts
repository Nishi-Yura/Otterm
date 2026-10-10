/** Terminal colors. The 16 ANSI colors and the defaults come from the theme (docs/04); 16–255 are xterm's. */

export interface Theme {
  foreground: string;
  background: string;
  cursor: string;
  /** Background of selected cells. */
  selection: string;
  /** ANSI 0–15. */
  ansi: string[];
}

export const DEFAULT_THEME: Theme = {
  foreground: "#d8dee9",
  background: "#1b1d23",
  cursor: "#88c0d0",
  selection: "#3d4b63",
  ansi: [
    "#2e3440",
    "#e06c75",
    "#98c379",
    "#e5c07b",
    "#61afef",
    "#c678dd",
    "#56b6c2",
    "#d8dee9",
    "#5c6370",
    "#ef8891",
    "#a8d68a",
    "#f0d08a",
    "#7cc0ff",
    "#d690ea",
    "#6fcbd6",
    "#ffffff",
  ],
};

const hex = (n: number) => n.toString(16).padStart(2, "0");

/** xterm's 256-color palette above the 16 theme colors. */
function xtermColor(i: number): string {
  if (i < 232) {
    const n = i - 16;
    const level = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `#${hex(level(Math.floor(n / 36)))}${hex(level(Math.floor(n / 6) % 6))}${hex(level(n % 6))}`;
  }
  const g = 8 + (i - 232) * 10;
  return `#${hex(g)}${hex(g)}${hex(g)}`;
}

export class Palette {
  private readonly table: string[];

  constructor(readonly theme: Theme = DEFAULT_THEME) {
    this.table = [...theme.ansi];
    for (let i = 16; i < 256; i++) this.table.push(xtermColor(i));
  }

  /** Resolve a packed color (see protocol.ts). `fallback` is used for the default color. */
  resolve(packed: number, fallback: string): string {
    const kind = packed >>> 24;
    if (kind === 1) return this.table[packed & 0xff] ?? fallback;
    if (kind === 2) return `#${(packed & 0xffffff).toString(16).padStart(6, "0")}`;
    return fallback;
  }
}
