/**
 * nishi-yura.clock (community mod).
 *
 * The current time in the status bar, optionally with the date. The format and the date are settings
 * (../otmod.toml). Uses no permissions.
 */

import type { ModContext } from "@otterm/api";

const TICK_MS = 1000;
const DEFAULT_FORMAT = "HH:mm";

let timer: ReturnType<typeof setInterval> | undefined;

export async function activate(ctx: ModContext): Promise<void> {
  const t = (id: string): string => ctx.i18n.t(id);
  const setting = async (key: string): Promise<unknown> => {
    try {
      return await ctx.settings.get<unknown>(key);
    } catch {
      return undefined;
    }
  };

  const formatSetting = await setting("format");
  let format = typeof formatSetting === "string" ? formatSetting : DEFAULT_FORMAT;
  let withDate = (await setting("show_date")) === true;

  const label = ctx.signal<string>("");
  function update(): void {
    const next = render(new Date(), format, withDate, t("am"), t("pm"));
    if (next !== label.get()) label.set(next);
  }
  update();

  ctx.ui.slot("statusbar.right").add({
    type: "text",
    text: () => label.get(),
    tooltip: t("tooltip"),
  });

  stopTimer();
  timer = setInterval(update, TICK_MS);

  ctx.settings.onChange((e) => {
    if (e.key === "format" && typeof e.value === "string") format = e.value;
    if (e.key === "show_date") withDate = e.value === true;
    update();
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

/** Formats the time as "HH:mm", "HH:mm:ss" or "h:mm a"; an unknown format falls back to "HH:mm". */
function render(now: Date, format: string, withDate: boolean, am: string, pm: string): string {
  const hours = now.getHours();
  const minutes = pad(now.getMinutes());
  let time: string;
  if (format === "h:mm a") {
    time = `${hours % 12 || 12}:${minutes} ${hours < 12 ? am : pm}`;
  } else if (format === "HH:mm:ss") {
    time = `${pad(hours)}:${minutes}:${pad(now.getSeconds())}`;
  } else {
    time = `${pad(hours)}:${minutes}`;
  }
  if (!withDate) return time;
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${time}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
