/**
 * nishi-yura.command-stats (community mod).
 *
 * A side panel with how many commands you ran today and over the last 30 days, and the programs you
 * use most. Only the first word of each finished block (the program name) is counted; arguments and
 * output are never read or stored. Counts are kept per day in the mod's storage on this PC and days
 * older than 30 are dropped. Permissions and settings are declared in ../otmod.toml.
 */

import type { Block, ListItem, ModContext, UiNode } from "@otterm/api";

const PANEL_ID = "nishi-yura.command-stats.panel";
const OPEN_COMMAND_ID = "nishi-yura.command-stats.open";
const RESET_COMMAND_ID = "nishi-yura.command-stats.reset";
const KEEP_DAYS = 30;
const DEFAULT_TOP = 10;
/** Storage key for one day's counts: "day:2026-10-12". */
const DAY_PREFIX = "day:";

/** One day's counts: total commands and per program name. */
interface Day {
  total: number;
  names: Record<string, number>;
}

interface Summary {
  today: number;
  recent: number;
  days: number;
  top: { name: string; count: number }[];
}

export async function activate(ctx: ModContext): Promise<void> {
  const terminal = ctx.terminal;
  if (!terminal.onBlockEnd) throw new Error("command-stats: terminal.read permission is missing");
  const t = (id: string, vars?: Record<string, string | number>): string => ctx.i18n.t(id, vars);

  let topCount = clampInt(await settingOf(ctx, "top_count"), DEFAULT_TOP, 3, 30);
  const summary = ctx.signal<Summary>({ today: 0, recent: 0, days: 0, top: [] });

  /** Days loaded from storage, by date key. */
  const days = new Map<string, Day>();
  for (const key of await ctx.storage.keys(DAY_PREFIX).catch(() => [] as string[])) {
    const day = await ctx.storage.get<Day>(key).catch(() => undefined);
    if (day && typeof day.total === "number" && day.names && typeof day.names === "object") days.set(key, day);
  }
  await prune();
  publish();

  terminal.onBlockEnd((block: Block) => {
    record(block).catch((e: unknown) => ctx.log.warn("command-stats: could not record a command", e));
  });

  async function record(block: Block): Promise<void> {
    const name = programName(block.command);
    if (name === "") return;
    const key = DAY_PREFIX + dateKey(new Date());
    const day = days.get(key) ?? { total: 0, names: {} };
    day.total += 1;
    day.names[name] = (day.names[name] ?? 0) + 1;
    days.set(key, day);
    await ctx.storage.set(key, day);
    await prune();
    publish();
  }

  /** Drops days older than KEEP_DAYS from memory and storage. */
  async function prune(): Promise<void> {
    const oldest = dateKey(new Date(Date.now() - KEEP_DAYS * 86_400_000));
    for (const key of Array.from(days.keys())) {
      if (key.slice(DAY_PREFIX.length) < oldest) {
        days.delete(key);
        await ctx.storage.delete(key).catch(() => undefined);
      }
    }
  }

  function publish(): void {
    const todayKey = DAY_PREFIX + dateKey(new Date());
    const totals = new Map<string, number>();
    let recent = 0;
    for (const day of days.values()) {
      recent += day.total;
      for (const [name, count] of Object.entries(day.names)) totals.set(name, (totals.get(name) ?? 0) + count);
    }
    const top = Array.from(totals.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, topCount);
    summary.set({ today: days.get(todayKey)?.total ?? 0, recent, days: days.size, top });
  }

  async function reset(): Promise<void> {
    const answer = await ctx.ui.dialog({
      title: t("reset-title"),
      body: t("reset-body"),
      buttons: [
        { id: "reset", label: t("reset-confirm"), variant: "danger" },
        { id: "cancel", label: t("reset-cancel") },
      ],
      cancelId: "cancel",
    });
    if (answer !== "reset") return;
    for (const key of Array.from(days.keys())) await ctx.storage.delete(key).catch(() => undefined);
    days.clear();
    publish();
  }

  ctx.ui.panel({
    id: PANEL_ID,
    title: t("panel-title"),
    icon: "bar-chart-2",
    slot: "sidebar.right",
    content: () => content(summary.get(), t, reset),
    badge: () => {
      const n = summary.get().today;
      return n > 0 ? n : undefined;
    },
  });

  ctx.commands.register(
    OPEN_COMMAND_ID,
    async () => {
      try {
        await ctx.commands.run("otterm.panel.show", { id: PANEL_ID });
      } catch (e) {
        ctx.log.warn("command-stats: could not show the panel", e);
      }
    },
    { title: t("cmd-open"), icon: "bar-chart-2" },
  );
  ctx.commands.register(RESET_COMMAND_ID, () => reset(), { title: t("cmd-reset"), icon: "trash-2" });

  ctx.settings.onChange((e) => {
    if (e.key === "top_count") {
      topCount = clampInt(e.value, DEFAULT_TOP, 3, 30);
      publish();
    }
  });
}

export function deactivate(): void {
  // Nothing to do: the panel, the commands and the subscription are Disposables the host tracks.
}

// --- UI -----------------------------------------------------------------------

function content(
  s: Summary,
  t: (id: string, vars?: Record<string, string | number>) => string,
  reset: () => void,
): UiNode {
  const max = s.top[0]?.count ?? 1;
  const items: ListItem[] = s.top.map((entry) => ({
    key: entry.name,
    text: entry.name,
    secondary: bar(entry.count / max),
    badge: `${entry.count}`,
  }));
  return {
    type: "stack",
    gap: "m",
    children: [
      { type: "heading", text: t("heading-today"), level: 3 },
      { type: "text", text: t("count-today", { n: s.today }) },
      { type: "heading", text: t("heading-recent", { days: KEEP_DAYS }), level: 3 },
      { type: "text", text: t("count-recent", { n: s.recent, days: s.days }) },
      { type: "divider" },
      { type: "heading", text: t("heading-top"), level: 3 },
      { type: "list", items, emptyText: t("empty") },
      { type: "spacer", size: "s" },
      { type: "text", text: t("note-privacy"), muted: true },
      {
        type: "row",
        align: "end",
        children: [{ type: "button", text: t("cmd-reset"), icon: "trash-2", variant: "ghost", onClick: reset }],
      },
    ],
  };
}

/** A text bar, 1 to 12 blocks wide, for the share of the most used program. */
function bar(ratio: number): string {
  const width = Math.max(1, Math.round(ratio * 12));
  return "█".repeat(width);
}

// --- helpers ------------------------------------------------------------------

/**
 * The program of a command line: the first word after leading environment assignments (`FOO=1 cmd`)
 * and sudo, without a directory part (`./build.sh` -> `build.sh`, `C:\Tools\x.exe` -> `x.exe`).
 * Arguments are never looked at.
 */
function programName(command: string): string {
  const words = command.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) i += 1;
  if (words[i] === "sudo" || words[i] === "doas") i += 1;
  const word = (words[i] ?? "").replace(/^["']|["']$/g, "");
  if (word === "" || word.startsWith("-")) return "";
  const base = word.split(/[\\/]/).pop() ?? "";
  // Keep the name short and free of anything that could be an argument glued on (e.g. a URL).
  return base.length > 40 ? "" : base;
}

/** Local date as YYYY-MM-DD, so a day boundary follows the user's clock. */
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

async function settingOf(ctx: ModContext, key: string): Promise<unknown> {
  try {
    return await ctx.settings.get<unknown>(key);
  } catch {
    return undefined;
  }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
