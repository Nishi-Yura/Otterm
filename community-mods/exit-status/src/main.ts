/**
 * nishi-yura.exit-status (community mod).
 *
 * Status bar item with the result of the last command in the focused terminal: "✓ 1.2s" when it
 * succeeded, "✗ 127 · 0.3s" when it failed. It reads only the exit code and the duration of finished blocks;
 * the command line and the output are never read.
 * Permissions and settings are declared in ../otmod.toml.
 */

import type { Block, ModContext, SessionId } from "@otterm/api";

interface Result {
  exitCode: number;
  durationMs?: number;
}

export async function activate(ctx: ModContext): Promise<void> {
  const terminal = ctx.terminal;
  if (!terminal.onBlockEnd) throw new Error("exit-status: terminal.read permission is missing");
  const t = (id: string): string => ctx.i18n.t(id);
  const setting = async (key: string): Promise<unknown> => {
    try {
      return await ctx.settings.get<unknown>(key);
    } catch {
      return undefined;
    }
  };

  let showSuccess = (await setting("show_success")) !== false;
  let showDuration = (await setting("show_duration")) !== false;

  /** The last finished block per session, so switching tabs shows that tab's result. */
  const last = new Map<SessionId, Result>();
  const shown = ctx.signal<Result | undefined>(undefined);

  async function showFocused(): Promise<void> {
    const session = await ctx.session.current().catch(() => undefined);
    shown.set(session ? last.get(session.id) : undefined);
  }

  terminal.onBlockEnd((block: Block) => {
    if (block.exitCode === undefined) return;
    const result: Result = { exitCode: block.exitCode, durationMs: block.durationMs };
    last.set(block.sessionId, result);
    showFocused().catch(() => undefined);
  });
  ctx.session.onFocusChanged(() => {
    showFocused().catch(() => undefined);
  });
  ctx.session.onClosed((e) => {
    last.delete(e.sessionId);
  });

  ctx.ui.slot("statusbar.left").add({
    type: "text",
    text: () => {
      const r = shown.get();
      if (!r) return "";
      const duration = showDuration && r.durationMs !== undefined ? formatDuration(r.durationMs) : "";
      if (r.exitCode === 0) return duration === "" ? "✓" : `✓ ${duration}`;
      return duration === "" ? `✗ ${r.exitCode}` : `✗ ${r.exitCode} · ${duration}`;
    },
    tooltip: t("tooltip"),
    hidden: () => {
      const r = shown.get();
      return r === undefined || (r.exitCode === 0 && !showSuccess);
    },
  });

  ctx.settings.onChange((e) => {
    if (e.key === "show_success") showSuccess = e.value !== false;
    if (e.key === "show_duration") showDuration = e.value !== false;
    ctx.ui.refresh();
  });
}

export function deactivate(): void {
  // Nothing to do: the subscriptions and the slot item are Disposables the host tracks.
}

// --- helpers ------------------------------------------------------------------

/** 340 ms -> "0.3s", 12.4 s -> "12s", 72 s -> "1m12s", 3725 s -> "1h02m". */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${pad(m)}m`;
  if (m > 0) return `${m}m${pad(s)}s`;
  return `${s}s`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
