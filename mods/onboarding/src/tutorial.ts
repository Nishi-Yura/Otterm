/**
 * Chapters of the first-terminal tutorial (docs/03 §11.3, decision G3).
 *
 * Pure data and judging helpers. main.ts drives the panel, the events and the saved progress.
 * Every user-visible line is a Fluent id in locales/*.ftl; `{ $command }` is the step's command text.
 */

import type { Block } from "@otterm/api";

export const FOLDER_NAME = "otterm-tutorial";
export const INSIDE_NAME = "inside";
export const TXT_FILE = "hello.txt";
export const PY_FILE = "hello.py";
export const JS_FILE = "hello.js";

/** bash, zsh and fish use the posix spelling; pwsh, powershell and cmd use the PowerShell one. */
export type ShellFamily = "posix" | "pwsh";

/** What a judge can look at besides the finished block. */
export interface JudgeState {
  /** Absolute path of the tutorial folder. */
  readonly folder: string;
  readonly family: ShellFamily;
  /** Wraps ctx.fs.exists; false when the file cannot be checked. */
  exists(path: string): Promise<boolean>;
  /** A judge sets "alt" when the failed block says the program is missing. */
  hint: "none" | "alt";
}

export interface StepDef {
  /** Fluent ids of Kotsume's lines, shown as markdown in order. */
  readonly lines: readonly string[];
  /** block: judged by a finished block. cwd: judged by a cwd-changed event. manual: the user clicks "できた". */
  readonly kind: "block" | "cwd" | "manual";
  /** The exact text to type, per shell family. Shown in a code block and insertable. */
  readonly command?: Readonly<Record<ShellFamily, string>>;
  /** Alternatives offered after a "not found" failure. */
  readonly alt?: Readonly<Record<ShellFamily, readonly string[]>>;
  /** Block steps: a finished block is judged only when its command matches. Both spellings are accepted. */
  readonly pattern?: RegExp;
  /** Block steps: true when the finished block completes the step. */
  readonly judge?: (block: Block, state: JudgeState) => boolean | Promise<boolean>;
  /** cwd steps: the folder the shell must reach. */
  readonly expectCwd?: (folder: string) => string;
  /** cwd steps: the folder the shell must have come from. Keeps the mod's own `cd` on start from counting. */
  readonly fromCwd?: (folder: string) => string;
}

export interface ChapterDef {
  /** Fluent id of the chapter title. */
  readonly title: string;
  /** Writes hello.py and hello.js into the folder when the chapter starts. */
  readonly prepare?: boolean;
  readonly steps: readonly StepDef[];
}

/** "Not found" wording of bash, cmd, PowerShell and the Windows Store Python stub, in English and Japanese. */
const NOT_FOUND = /not found|not recognized|見つかりません|認識されません/i;

export const ok = (b: Block): boolean => b.exitCode === 0;
export const failed = (b: Block): boolean => b.exitCode !== undefined && b.exitCode !== 0;
export const outputOf = (b: Block): string => b.output ?? "";
export const isNotFound = (b: Block): boolean => failed(b) && NOT_FOUND.test(outputOf(b));

export function join(folder: string, name: string): string {
  return `${folder.replace(/[\\/]+$/, "")}/${name}`;
}

/** Folds case and slashes, and turns Git Bash's /c/... into c:/... so that the same folder compares equal. */
export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, "/");
  const drive = /^\/([a-zA-Z])(\/.*)?$/.exec(s);
  if (drive) s = `${(drive[1] ?? "").toLowerCase()}:${drive[2] ?? "/"}`;
  return s.replace(/\/+$/, "").toLowerCase();
}

export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

export const CHAPTERS: readonly ChapterDef[] = [
  {
    title: "tutorial-ch1-title",
    steps: [
      {
        lines: ["tutorial-ch1-intro"],
        kind: "block",
        command: { posix: "pwd", pwsh: "Get-Location" },
        pattern: /^\s*(pwd|get-location|gl)\s*$/i,
        judge: (b) => ok(b) && outputOf(b).includes(FOLDER_NAME),
      },
      {
        lines: ["tutorial-ch1-ls"],
        kind: "block",
        command: { posix: "ls", pwsh: "Get-ChildItem" },
        pattern: /^\s*(ls|dir|gci|get-childitem)\b/i,
        judge: (b) => ok(b),
      },
    ],
  },
  {
    title: "tutorial-ch2-title",
    steps: [
      {
        lines: ["tutorial-ch2-intro"],
        kind: "cwd",
        command: { posix: "cd inside", pwsh: "cd inside" },
        expectCwd: (folder) => join(folder, INSIDE_NAME),
      },
      {
        lines: ["tutorial-ch2-up"],
        kind: "cwd",
        command: { posix: "cd ..", pwsh: "cd .." },
        expectCwd: (folder) => folder,
        fromCwd: (folder) => join(folder, INSIDE_NAME),
      },
    ],
  },
  {
    title: "tutorial-ch3-title",
    steps: [
      {
        lines: ["tutorial-ch3-create"],
        kind: "block",
        command: { posix: "echo hello > hello.txt", pwsh: '"hello" > hello.txt' },
        pattern: />\s*hello\.txt\b/,
        judge: async (b, s) => ok(b) && (await s.exists(join(s.folder, TXT_FILE))),
      },
      {
        lines: ["tutorial-ch3-read"],
        kind: "block",
        command: { posix: "cat hello.txt", pwsh: "Get-Content hello.txt" },
        pattern: /^\s*(cat|type|gc|get-content)\b.*\bhello\.txt\b/i,
        judge: (b) => ok(b) && outputOf(b).includes("hello"),
      },
    ],
  },
  {
    title: "tutorial-ch4-title",
    prepare: true,
    steps: [
      {
        lines: ["tutorial-ch4-run"],
        kind: "block",
        command: { posix: "python hello.py", pwsh: "python hello.py" },
        alt: { posix: ["node hello.js"], pwsh: ["node hello.js", 'pwsh -c "Write-Output hello"'] },
        pattern: /^\s*(python3?|py|node|pwsh)\b/i,
        judge: (b, s) => {
          if (b.exitCode !== 0) {
            if (isNotFound(b)) s.hint = "alt";
            return false;
          }
          const out = outputOf(b);
          return (
            out.includes("hello from python") ||
            out.includes("hello from node") ||
            (/Write-Output\s+hello/i.test(b.command) && out.includes("hello"))
          );
        },
      },
    ],
  },
  {
    title: "tutorial-ch5-title",
    steps: [
      {
        lines: ["tutorial-ch5-interrupt"],
        kind: "block",
        command: { posix: "sleep 100", pwsh: "Start-Sleep 100" },
        pattern: /^\s*(sleep|start-sleep)\b/i,
        // Ctrl+C reports 130 in the posix shells; PowerShell reports a non-zero code.
        judge: (b, s) => b.exitCode === 130 || (s.family === "pwsh" && failed(b)),
      },
      {
        lines: ["tutorial-ch5-error", "tutorial-ch5-card"],
        kind: "block",
        command: { posix: "cat nothing.txt", pwsh: "Get-Content nothing.txt" },
        pattern: /^\s*(cat|type|gc|get-content)\b.*\bnothing\.txt\b/i,
        judge: (b) => failed(b),
      },
    ],
  },
  {
    title: "tutorial-ch6-title",
    steps: [{ lines: ["tutorial-ch6-history", "tutorial-ch6-tree", "tutorial-ch6-rerun"], kind: "manual" }],
  },
];
