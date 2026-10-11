/**
 * `ctx.assist.parse` (docs/05 §5.2): a command line as pipeline segments, each with its name,
 * subcommand, options and arguments. Shell-agnostic and deliberately simple: quotes group words,
 * `|`, `&&`, `||` and `;` split segments, `--opt=value` and `-x value` are options. Good enough
 * for explanations, completion and danger rules; not a shell parser.
 */

export interface ParsedOption {
  flag: string;
  value?: string;
}

export interface ParsedSegment {
  name: string;
  subcommand?: string;
  options: ParsedOption[];
  args: string[];
  /** Character range in `raw`. */
  range: [number, number];
}

export interface ParsedCommand {
  raw: string;
  segments: ParsedSegment[];
  cwd: string;
  shellKind: string;
}

interface Word {
  text: string;
  start: number;
  end: number;
  quoted: boolean;
}

/** Words with their positions; quotes are removed from the text but keep a word together. */
export function words(line: string): Word[] {
  const out: Word[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i] as string)) i++;
    if (i >= line.length) break;
    const start = i;
    let text = "";
    let quoted = false;
    let quote: string | undefined;
    while (i < line.length) {
      const c = line[i] as string;
      if (quote) {
        if (c === quote) {
          quote = undefined;
        } else if (c === "\\" && quote === '"' && i + 1 < line.length) {
          text += line[i + 1];
          i++;
        } else text += c;
      } else if (c === '"' || c === "'") {
        quote = c;
        quoted = true;
      } else if (c === "\\" && i + 1 < line.length && !/\s/.test(line[i + 1] as string)) {
        text += line[i + 1];
        i++;
      } else if (/\s/.test(c)) {
        break;
      } else if (c === "|" || c === ";" || c === "&") {
        // Separators are words of their own, unless glued inside a word like "a|b" (rare; treated as separators).
        if (text === "") {
          const two = line.slice(i, i + 2);
          const sep = two === "||" || two === "&&" ? two : c;
          out.push({ text: sep, start: i, end: i + sep.length, quoted: false });
          i += sep.length;
          continue;
        }
        break;
      } else text += c;
      i++;
    }
    if (text !== "" || quoted) out.push({ text, start, end: i, quoted });
  }
  return out;
}

const SEPARATORS = new Set(["|", "||", "&&", ";", "&"]);

/** Words that start a pipeline segment without being the command: `sudo`, `time`, env assignments. */
const PREFIXES = new Set(["sudo", "doas", "time", "nohup", "exec", "command", "builtin", "nice", "env"]);

/** Commands whose first word after the name is a subcommand (`git push`, `npm install`). */
const SUBCOMMAND_COMMANDS = new Set([
  "git",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "conda",
  "cargo",
  "rustup",
  "docker",
  "kubectl",
  "helm",
  "terraform",
  "gh",
  "brew",
  "winget",
  "scoop",
  "choco",
  "apt",
  "apt-get",
  "dnf",
  "pacman",
  "nix",
  "gem",
  "composer",
  "nvm",
  "mise",
  "dotnet",
  "go",
  "deno",
  "systemctl",
  "ssh-keygen",
  "openssl",
  "tmux",
  "reg",
  "netsh",
  "wsl",
]);

export function parseCommand(line: string, cwd = "", shellKind = "other"): ParsedCommand {
  const all = words(line);
  const segments: ParsedSegment[] = [];
  let current: Word[] = [];
  const flush = () => {
    if (current.length > 0) segments.push(segment(current));
    current = [];
  };
  for (const w of all) {
    if (SEPARATORS.has(w.text) && !w.quoted) flush();
    else current.push(w);
  }
  flush();
  return { raw: line, segments, cwd, shellKind };
}

function segment(ws: Word[]): ParsedSegment {
  const first = ws[0] as Word;
  const last = ws[ws.length - 1] as Word;
  let i = 0;
  // `sudo rm`, `FOO=1 cmd`: the command is the first plain word after them.
  while (
    i < ws.length &&
    (PREFIXES.has((ws[i] as Word).text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test((ws[i] as Word).text))
  ) {
    i++;
  }
  if (i >= ws.length) i = 0;
  const name = basename((ws[i] as Word).text);
  i++;
  const seg: ParsedSegment = { name, options: [], args: [], range: [first.start, last.end] };
  const takesSub = SUBCOMMAND_COMMANDS.has(name.toLowerCase());
  for (; i < ws.length; i++) {
    const w = ws[i] as Word;
    const t = w.text;
    if (!w.quoted && t.startsWith("--") && t.length > 2) {
      const eq = t.indexOf("=");
      if (eq > 0) seg.options.push({ flag: t.slice(0, eq), value: t.slice(eq + 1) });
      else seg.options.push({ flag: t });
    } else if (!w.quoted && /^-[A-Za-z]/.test(t)) {
      // `-rf` is `-r` and `-f`; `-p 8080` keeps a value only for single letters followed by a non-option.
      if (t.length === 2) {
        const next = ws[i + 1];
        const value =
          next && !next.text.startsWith("-") && !next.quoted && /^-[pPoOfFnNtTuUhHcCeE]$/.test(t)
            ? next.text
            : undefined;
        seg.options.push(value === undefined ? { flag: t } : { flag: t, value });
        if (value !== undefined) i++;
      } else {
        for (const ch of t.slice(1)) seg.options.push({ flag: `-${ch}` });
      }
    } else if (!w.quoted && /^\/[A-Za-z?]/.test(t) && name.toLowerCase().endsWith(".exe")) {
      seg.options.push({ flag: t });
    } else if (!w.quoted && /^-[A-Za-z]{2,}$/i.test(t) && /^[A-Z][a-z]+-[A-Z]/.test(name)) {
      // PowerShell: `-Recurse`, `-Force` are one option each.
      seg.options.push({ flag: t });
    } else if (
      takesSub &&
      seg.subcommand === undefined &&
      seg.args.length === 0 &&
      !w.quoted &&
      /^[a-z][a-z0-9-]*$/i.test(t)
    ) {
      seg.subcommand = t;
    } else {
      seg.args.push(t);
    }
  }
  return seg;
}

/** `C:\\Program Files\\Git\\bin\\git.exe` → `git`; `python3` stays. */
function basename(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.replace(/\.(exe|cmd|bat|com)$/i, "");
}

/** The word under the cursor and where it starts, for completion. */
export function wordAt(line: string, cursor: number): { word: string; start: number } {
  const before = line.slice(0, cursor);
  let start = 0;
  let quote: string | undefined;
  // Walk back to the last unquoted space.
  for (let i = 0; i < before.length; i++) {
    const c = before[i] as string;
    if (quote) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (/\s/.test(c)) start = i + 1;
  }
  if (quote) {
    // Inside quotes: the word begins at the quote.
    start = before.lastIndexOf(quote);
  }
  return { word: before.slice(start), start };
}
