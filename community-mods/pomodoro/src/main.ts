/**
 * nishi-yura.pomodoro (community mod).
 *
 * A Pomodoro timer in the status bar: a work period, then a break. Commands start / pause / reset appear
 * in the command palette, and clicking the status bar item starts or pauses. A toast says when a period ends.
 * Uses no permissions: only timers, the status bar, commands and toasts.
 * Settings are declared in ../otmod.toml.
 */

import type { ModContext } from "@otterm/api";

type Phase = "idle" | "work" | "break";

interface Shown {
  phase: Phase;
  /** Whole seconds left, rounded up so the display never shows 00:00 early. */
  seconds: number;
  running: boolean;
}

const TICK_MS = 1000;
const MINUTE_MS = 60_000;
const DEFAULT_WORK_MIN = 25;
const DEFAULT_BREAK_MIN = 5;

let timer: ReturnType<typeof setInterval> | undefined;

export async function activate(ctx: ModContext): Promise<void> {
  const t = (id: string, vars?: Record<string, string | number>): string => ctx.i18n.t(id, vars);
  const setting = async (key: string): Promise<unknown> => {
    try {
      return await ctx.settings.get<unknown>(key);
    } catch {
      return undefined;
    }
  };

  let workMin = clampInt(await setting("work_minutes"), DEFAULT_WORK_MIN, 1, 180);
  let breakMin = clampInt(await setting("break_minutes"), DEFAULT_BREAK_MIN, 1, 60);

  const shown = ctx.signal<Shown>({ phase: "idle", seconds: 0, running: false });
  let phase: Phase = "idle";
  let running = false;
  /** Time left while idle or paused. */
  let remainingMs = 0;
  /** When the current period ends. Used while running. */
  let endAt = 0;

  const leftMs = (): number => (running ? Math.max(0, endAt - Date.now()) : remainingMs);

  function publish(): void {
    const next: Shown = { phase, seconds: Math.ceil(leftMs() / 1000), running };
    const cur = shown.get();
    if (cur.phase !== next.phase || cur.seconds !== next.seconds || cur.running !== next.running) shown.set(next);
  }

  function notify(text: string): void {
    ctx.ui.toast({ text, kind: "success" }).catch(() => undefined);
  }

  function start(): void {
    if (running) return;
    if (phase === "idle") {
      phase = "work";
      remainingMs = workMin * MINUTE_MS;
    }
    endAt = Date.now() + remainingMs;
    running = true;
    stopTimer();
    timer = setInterval(onTick, TICK_MS);
    publish();
  }

  function pause(): void {
    if (!running) return;
    remainingMs = leftMs();
    running = false;
    stopTimer();
    publish();
  }

  function reset(): void {
    stopTimer();
    running = false;
    phase = "idle";
    remainingMs = 0;
    endAt = 0;
    publish();
  }

  function onTick(): void {
    if (!running) return;
    if (Date.now() < endAt) {
      publish();
      return;
    }
    if (phase === "work") {
      // The break starts on its own; the timer keeps running.
      phase = "break";
      remainingMs = breakMin * MINUTE_MS;
      endAt = Date.now() + remainingMs;
      notify(t("toast-work-done", { minutes: breakMin }));
      publish();
      return;
    }
    notify(t("toast-break-done"));
    reset();
  }

  ctx.ui.slot("statusbar.right").add({
    type: "text",
    icon: "clock",
    text: () => statusText(shown.get(), t),
    tooltip: t("tooltip"),
    hidden: () => shown.get().phase === "idle",
    onClick: () => (running ? pause() : start()),
  });

  ctx.commands.register("nishi-yura.pomodoro.start", () => start(), {
    title: t("cmd-start"),
    icon: "play",
  });
  ctx.commands.register("nishi-yura.pomodoro.pause", () => pause(), {
    title: t("cmd-pause"),
    icon: "clock",
  });
  ctx.commands.register("nishi-yura.pomodoro.reset", () => reset(), {
    title: t("cmd-reset"),
    icon: "rotate-ccw",
  });

  // A changed length applies from the next period. The current one keeps its length.
  ctx.settings.onChange((e) => {
    if (e.key === "work_minutes") workMin = clampInt(e.value, DEFAULT_WORK_MIN, 1, 180);
    if (e.key === "break_minutes") breakMin = clampInt(e.value, DEFAULT_BREAK_MIN, 1, 60);
  });
}

export function deactivate(): void {
  stopTimer();
}

// --- helpers ------------------------------------------------------------------

function stopTimer(): void {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
}

/** "24:13", "break 04:50", or "24:13 paused". */
function statusText(s: Shown, label: (id: string) => string): string {
  const minutes = Math.floor(s.seconds / 60);
  const clock = `${pad(minutes)}:${pad(s.seconds % 60)}`;
  const prefix = s.phase === "break" ? `${label("label-break")} ` : "";
  const suffix = s.running ? "" : ` ${label("label-paused")}`;
  return `${prefix}${clock}${suffix}`;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
