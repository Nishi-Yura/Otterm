import { For, Show } from "solid-js";
import type { RowBar } from "./screen/protocol";

/** A prompt bar in view: the screen row it covers and what the shell reported. */
export interface HeaderRow {
  row: number;
  bar: RowBar;
}

interface BarInfo {
  cwd: string;
  home: string;
  branch: string;
}

/** Folders shown before the rest of a long path is cut to "…". */
const MAX_CRUMBS = 4;

const decoded = new Map<string, BarInfo | null>();

/** The JSON the shell integration sent, or null when it is not readable. */
function decode(info: string): BarInfo | null {
  let v = decoded.get(info);
  if (v !== undefined) return v;
  try {
    const bytes = Uint8Array.from(atob(info), (c) => c.charCodeAt(0));
    const o = JSON.parse(new TextDecoder().decode(bytes));
    v = { cwd: String(o.cwd ?? ""), home: String(o.home ?? ""), branch: String(o.branch ?? "") };
  } catch {
    v = null;
  }
  // Bars repeat as the view scrolls; keep the cache from growing without end.
  if (decoded.size > 500) decoded.clear();
  decoded.set(info, v);
  return v;
}

/** The folder as breadcrumbs, the home folder as "~". */
export function crumbs(cwd: string, home: string): string[] {
  const base = home.replace(/[\\/]+$/, "");
  // Windows paths ignore case.
  const inHome =
    base !== "" &&
    cwd.toLowerCase().startsWith(base.toLowerCase()) &&
    (cwd.length === base.length || /[\\/]/.test(cwd[base.length] ?? ""));
  const parts = (inHome ? cwd.slice(base.length) : cwd).split(/[\\/]/).filter((p) => p !== "");
  if (inHome) parts.unshift("~");
  if (parts.length === 0) return [cwd];
  return parts.length > MAX_CRUMBS ? ["…", ...parts.slice(-MAX_CRUMBS)] : parts;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/**
 * otterm's prompt bars (decision M4), drawn over the blank rows the shell integration reserved.
 * The look comes from CSS (`.prompt-header`, theme keys `prompt-*`), not from the shell.
 */
export function PromptHeaders(props: { rows: HeaderRow[]; lineHeight: number; fontSize: number }) {
  return (
    <div class="prompt-headers" aria-hidden="true">
      <For each={props.rows}>
        {(h) => {
          const info = () => decode(h.bar.info);
          return (
            <Show when={info()}>
              {(i) => (
                <div
                  class="prompt-header"
                  classList={{ ok: h.bar.done?.exit === 0, failed: !!h.bar.done && h.bar.done.exit !== 0 }}
                  style={{
                    top: `${h.row * props.lineHeight}px`,
                    height: `${props.lineHeight}px`,
                    "font-size": `${props.fontSize * 0.9}px`,
                  }}
                >
                  <span class="ph-crumbs">
                    <span class="ph-icon">{""}</span>
                    <For each={crumbs(i().cwd, i().home)}>
                      {(c, n) => (
                        <>
                          <Show when={n() > 0}>
                            <span class="ph-sep">›</span>
                          </Show>
                          <span class="ph-crumb">{c}</span>
                        </>
                      )}
                    </For>
                  </span>
                  <Show when={i().branch}>
                    <span class="ph-branch">
                      <span class="ph-icon">{""}</span>
                      {i().branch}
                    </span>
                  </Show>
                  <span class="ph-spacer" />
                  <Show when={h.bar.done}>
                    {(d) => (
                      <span class="ph-result">
                        <span class="ph-status">{d().exit === 0 ? "✓" : `✗ ${d().exit}`}</span>
                        <span class="ph-time">{duration(d().ms)}</span>
                      </span>
                    )}
                  </Show>
                </div>
              )}
            </Show>
          );
        }}
      </For>
    </div>
  );
}
