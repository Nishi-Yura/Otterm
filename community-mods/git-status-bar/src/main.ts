/**
 * nishi-yura.git-status-bar (community mod).
 *
 * Status bar item: the Git branch of the focused terminal's folder and the number of changed files,
 * e.g. "⎇ main ●3". Nothing is shown outside a repository. It runs only `git rev-parse` and `git status`
 * (permission `process = ["git"]`) and never writes to the terminal.
 *
 * Refreshes on cwd change, focus change and block end, and every `refresh_interval` seconds.
 * Permissions and settings are declared in ../otmod.toml.
 */

import type { ModContext } from "@otterm/api";

/** Per git call. A slow repository keeps the last shown state rather than blocking the status bar. */
const GIT_TIMEOUT_MS = 3000;
const DEFAULT_INTERVAL_S = 10;
const MIN_INTERVAL_S = 3;

interface GitState {
  /** Undefined when the focused folder is not inside a repository. */
  branch?: string;
  dirty: number;
}

let timer: ReturnType<typeof setInterval> | undefined;

export async function activate(ctx: ModContext): Promise<void> {
  if (!ctx.process) throw new Error("git-status-bar: process permission is missing");
  const proc = ctx.process;
  const t = (id: string, vars?: Record<string, string | number>): string => ctx.i18n.t(id, vars);
  const setting = async (key: string): Promise<unknown> => {
    try {
      return await ctx.settings.get<unknown>(key);
    } catch {
      return undefined;
    }
  };

  const dirtyOn = ctx.signal<boolean>((await setting("show_dirty_count")) !== false);
  const state = ctx.signal<GitState>({ dirty: 0 });
  let intervalS = toInterval(await setting("refresh_interval"));

  function publish(next: GitState): void {
    const cur = state.get();
    if (cur.branch !== next.branch || cur.dirty !== next.dirty) state.set(next);
  }

  async function measure(): Promise<void> {
    const session = await ctx.session.current().catch(() => undefined);
    const dir = session ? (session.hostCwd ?? session.cwd) : undefined;
    if (!dir) {
      publish({ dirty: 0 });
      return;
    }

    const head = await proc
      .run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS })
      .catch(() => undefined);
    if (head?.code !== 0) {
      publish({ dirty: 0 });
      return;
    }
    if (head.timedOut) return;
    const branch = head.stdout.trim();
    if (branch === "") {
      publish({ dirty: 0 });
      return;
    }

    let dirty = 0;
    if (dirtyOn.get()) {
      const status = await proc
        .run("git", ["status", "--porcelain"], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS })
        .catch(() => undefined);
      if (status && status.code === 0 && !status.timedOut) dirty = countLines(status.stdout);
    }
    publish({ branch, dirty });
  }

  // One run at a time. A request that arrives during a run starts one more run after it.
  let busy = false;
  let again = false;
  async function refresh(): Promise<void> {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        await measure();
      } while (again);
    } catch (e) {
      ctx.log.warn("git status failed", e);
    } finally {
      busy = false;
    }
  }

  function startTimer(): void {
    stopTimer();
    timer = setInterval(() => void refresh(), intervalS * 1000);
  }

  function notify(): void {
    const s = state.get();
    if (s.branch === undefined) return;
    const text = dirtyOn.get()
      ? t("toast-branch", { branch: s.branch, count: s.dirty })
      : t("toast-branch-only", { branch: s.branch });
    ctx.ui.toast({ text, kind: "info" }).catch(() => undefined);
  }

  ctx.ui.slot("statusbar.left").add({
    type: "text",
    text: () => statusText(state.get(), dirtyOn.get()),
    tooltip: t("tooltip"),
    hidden: () => state.get().branch === undefined,
    onClick: () => notify(),
  });

  ctx.commands.register("nishi-yura.git-status-bar.refresh", () => refresh(), {
    title: t("cmd-refresh"),
    icon: "refresh-cw",
  });

  ctx.session.onCwdChanged(() => void refresh());
  ctx.session.onFocusChanged(() => void refresh());
  ctx.terminal.onBlockEnd?.(() => void refresh());

  ctx.settings.onChange((e) => {
    if (e.key === "show_dirty_count") {
      dirtyOn.set(e.value !== false);
      void refresh();
    }
    if (e.key === "refresh_interval") {
      intervalS = toInterval(e.value);
      startTimer();
    }
  });

  startTimer();
  await refresh();
}

export function deactivate(): void {
  stopTimer();
}

// --- helpers ------------------------------------------------------------------

function stopTimer(): void {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
}

/** "⎇ main" or "⎇ main ●3". */
function statusText(s: GitState, showDirty: boolean): string {
  const base = `⎇ ${s.branch ?? ""}`;
  return showDirty && s.dirty > 0 ? `${base} ●${s.dirty}` : base;
}

function toInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_INTERVAL_S;
  return Math.max(MIN_INTERVAL_S, Math.round(value));
}

/** Counts the non-empty lines of `git status --porcelain`, one per changed path. */
function countLines(out: string): number {
  return out.split(/\r?\n/).filter((line) => line.trim() !== "").length;
}
