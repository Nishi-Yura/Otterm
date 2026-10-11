/**
 * nishi-yura.done-notify. Shows a toast when a command that ran for `min_seconds` or longer finishes.
 * It reads the command line (cut to 60 characters) and the exit code only. The output is never looked at.
 *
 * Permissions and settings are declared in ../otmod.toml.
 */

import type { Block, ModContext } from "@otterm/api";

const DEFAULT_MIN_SECONDS = 10;
const MAX_COMMAND_CHARS = 60;

export function activate(ctx: ModContext): void {
  const terminal = ctx.terminal;
  if (!terminal.onBlockEnd) throw new Error("done-notify: terminal.read permission is missing");

  terminal.onBlockEnd((block) => {
    notify(ctx, block).catch((e: unknown) => ctx.log.warn("done-notify failed", e));
  });
}

export function deactivate(): void {
  // Nothing to do: the subscription is a Disposable the host tracks.
}

async function notify(ctx: ModContext, block: Block): Promise<void> {
  const { durationMs, exitCode } = block;
  // Without a duration or an exit code the result is unknown, so no toast.
  if (durationMs === undefined || exitCode === undefined) return;

  const command = shorten(block.command);
  if (command === "") return;
  if (durationMs < (await minSeconds(ctx)) * 1000) return;

  const duration = formatDuration(ctx, durationMs);
  if (exitCode === 0) {
    await ctx.ui.toast({ text: ctx.i18n.t("toast-ok", { command, duration }), kind: "success" });
  } else {
    await ctx.ui.toast({ text: ctx.i18n.t("toast-fail", { command, code: exitCode, duration }), kind: "warning" });
  }
}

async function minSeconds(ctx: ModContext): Promise<number> {
  try {
    const value = await ctx.settings.get<number | undefined>("min_seconds");
    return typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_MIN_SECONDS;
  } catch {
    return DEFAULT_MIN_SECONDS;
  }
}

/** One line, at most 60 characters (the ellipsis counts). */
function shorten(command: string): string {
  const line = command.replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  return chars.length > MAX_COMMAND_CHARS ? `${chars.slice(0, MAX_COMMAND_CHARS - 1).join("")}…` : line;
}

/** 12 s -> "12s", 72 s -> "1m 12s", 3725 s -> "1h 2m". */
function formatDuration(ctx: ModContext, ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return ctx.i18n.t("duration-hm", { h, m });
  if (m > 0) return ctx.i18n.t("duration-ms", { m, s });
  return ctx.i18n.t("duration-s", { s });
}
