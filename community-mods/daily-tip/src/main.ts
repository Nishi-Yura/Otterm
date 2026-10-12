/**
 * nishi-yura.daily-tip (community mod).
 *
 * Once a day (a few seconds after otterm starts), Pebble introduces one command from the dictionary:
 * its name, its one-line summary and, when the entry has one, an example you can put into the input
 * line. The command palette entry shows another tip at any time. The day of the last automatic tip is
 * kept in the mod's storage. Uses no permissions. The setting is declared in ../otmod.toml.
 */

import type { Action, DictionaryEntry, ModContext } from "@otterm/api";

const SHOW_COMMAND_ID = "nishi-yura.daily-tip.show";
const LAST_KEY = "last-shown";
const STARTUP_DELAY_MS = 6000;
const BUBBLE_MS = 15000;
/** How many random picks to try before giving up (an entry may be missing on this platform). */
const MAX_TRIES = 8;

/**
 * Commands worth a tip: in the bundled dictionary, useful on every platform (or in PowerShell,
 * which is the default shell on Windows), and not dangerous on their own.
 */
const CANDIDATES: readonly string[] = [
  "ls",
  "cd",
  "pwd",
  "mkdir",
  "cp",
  "mv",
  "cat",
  "head",
  "tail",
  "less",
  "grep",
  "find",
  "sort",
  "uniq",
  "wc",
  "cut",
  "tr",
  "diff",
  "tar",
  "zip",
  "unzip",
  "curl",
  "wget",
  "ssh",
  "ssh-keygen",
  "scp",
  "rsync",
  "git",
  "gh",
  "jq",
  "sed",
  "awk",
  "xxd",
  "base64",
  "openssl",
  "env",
  "export",
  "alias",
  "history",
  "which",
  "where",
  "man",
  "ps",
  "kill",
  "top",
  "htop",
  "df",
  "du",
  "date",
  "touch",
  "ln",
  "chmod",
  "echo",
  "printf",
  "tmux",
  "docker",
  "kubectl",
  "npm",
  "pnpm",
  "npx",
  "node",
  "python",
  "pip",
  "uv",
  "cargo",
  "rustup",
  "go",
  "code",
  "winget",
  "scoop",
  "brew",
  "apt",
  "Get-ChildItem",
  "Get-Content",
  "Select-String",
  "Get-Process",
  "Get-Help",
  "Get-Command",
  "Test-Path",
  "Measure-Object",
  "Sort-Object",
  "Where-Object",
  "ForEach-Object",
  "Invoke-WebRequest",
];

let startup: ReturnType<typeof setTimeout> | undefined;

export async function activate(ctx: ModContext): Promise<void> {
  const t = (id: string, vars?: Record<string, string | number>): string => ctx.i18n.t(id, vars);

  async function pick(): Promise<DictionaryEntry | undefined> {
    for (let i = 0; i < MAX_TRIES; i += 1) {
      const name = CANDIDATES[Math.floor(Math.random() * CANDIDATES.length)];
      if (!name) continue;
      const entry = await ctx.assist.dictionary.lookup(name).catch(() => undefined);
      if (entry) return entry;
    }
    return undefined;
  }

  async function show(): Promise<void> {
    const entry = await pick();
    if (!entry) {
      await ctx.ui.toast({ text: t("toast-none"), kind: "info" });
      return;
    }
    const summary = ctx.i18n.resolve(entry.summary);
    const example = entry.examples?.[0];
    const actions: Action[] = [];
    if (example) {
      actions.push({
        label: t("action-insert"),
        variant: "primary" as const,
        onClick: () => {
          ctx.terminal
            .insert(example.command, { replaceLine: true })
            .catch((e: unknown) => ctx.log.warn("daily-tip: insert failed", e));
        },
      });
    }
    actions.push({
      label: t("action-another"),
      onClick: () => {
        show().catch((e: unknown) => ctx.log.warn("daily-tip failed", e));
      },
    });
    const text = example
      ? t("tip-with-example", { name: entry.name, summary, example: example.command })
      : t("tip", { name: entry.name, summary });
    await ctx.mascot.say(text, { mood: "happy", duration: BUBBLE_MS, actions });
  }

  ctx.commands.register(SHOW_COMMAND_ID, () => show(), { title: t("cmd-show"), icon: "lightbulb" });

  let auto = true;
  try {
    auto = (await ctx.settings.get<unknown>("auto_show")) !== false;
  } catch {
    auto = true;
  }
  const today = dateKey(new Date());
  const last = await ctx.storage.get<string>(LAST_KEY).catch(() => undefined);
  if (auto && last !== today) {
    startup = setTimeout(() => {
      startup = undefined;
      ctx.storage.set(LAST_KEY, today).catch(() => undefined);
      show().catch((e: unknown) => ctx.log.warn("daily-tip failed", e));
    }, STARTUP_DELAY_MS);
  }
}

export function deactivate(): void {
  if (startup !== undefined) clearTimeout(startup);
  startup = undefined;
}

/** Local date as YYYY-MM-DD, so "once a day" follows the user's clock. */
function dateKey(d: Date): string {
  const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
