import { For, Show } from "solid-js";
import { t } from "./i18n";
import type { RowBlock } from "./screen/protocol";

/** A row standing in for folded lines (docs/03 §6.3). */
export interface FoldRow {
  row: number;
  line: number;
  count: number;
}

/** A block head in view: the screen row it is on and what the shell reported. */
export interface HeaderRow {
  row: number;
  block: RowBlock;
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
export function decodeInfo(info: string): BarInfo | null {
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

/** Gutter color of a block (docs/03 §6.3): running is blue, a failure red, the rest neutral. */
export type GutterState = "none" | "idle" | "running" | "ok" | "failed";

/** `Frame.topBlock` codes (crates/otterm-vt/src/diff.rs) as gutter states. */
const TOP_STATES: GutterState[] = ["none", "idle", "running", "ok", "failed"];

export function gutterState(block: RowBlock): GutterState {
  if (block.state === 2) return "running";
  if (block.done) return block.done.exit === 0 ? "ok" : "failed";
  return "idle";
}

interface Segment {
  row: number;
  rows: number;
  state: GutterState;
}

/**
 * The gutter segments of a view: one per block in it, the first for the block row 0 is in. The
 * last block of the live screen ends at the cursor (`lastRow`), where its output stops.
 */
export function segments(rows: HeaderRow[], topBlock: number, viewRows: number, lastRow: number): Segment[] {
  const out: Segment[] = [];
  let row = 0;
  let state = TOP_STATES[topBlock] ?? "none";
  for (const h of rows) {
    if (h.row > row && state !== "none") out.push({ row, rows: h.row - row, state });
    row = h.row;
    state = gutterState(h.block);
  }
  const end = Math.min(viewRows, Math.max(lastRow + 1, row + 1));
  if (end > row && state !== "none") out.push({ row, rows: end - row, state });
  return out;
}

/**
 * Block gutters and otterm's prompt bars (decision M4), over the terminal. The bars are drawn on
 * the blank rows the shell integration reserved; their look comes from CSS (`.prompt-header`,
 * theme keys `prompt-*`), not from the shell.
 */
export function PromptHeaders(props: {
  rows: HeaderRow[];
  lineHeight: number;
  fontSize: number;
  /** Gutter state of the block that row 0 is in (`Frame.topBlock`). */
  topBlock: number;
  viewRows: number;
  /** The last row the last block covers: the cursor row on the live screen, else the bottom. */
  lastRow: number;
  folds: FoldRow[];
  /** The user clicked a fold: show its lines again. */
  onUnfold: (line: number) => void;
}) {
  return (
    <div class="prompt-headers">
      <For each={props.folds}>
        {(f) => (
          <button
            type="button"
            class="block-fold"
            style={{
              top: `${f.row * props.lineHeight}px`,
              height: `${props.lineHeight}px`,
              "font-size": `${props.fontSize * 0.9}px`,
            }}
            onClick={() => props.onUnfold(f.line)}
          >
            {t("block-folded", { n: f.count })}
          </button>
        )}
      </For>
      <For each={segments(props.rows, props.topBlock, props.viewRows, props.lastRow)}>
        {(s) => (
          <div
            class={`block-gutter ${s.state}`}
            style={{ top: `${s.row * props.lineHeight}px`, height: `${s.rows * props.lineHeight}px` }}
          />
        )}
      </For>
      <For each={props.rows.filter((h) => h.block.info !== "")}>
        {(h) => {
          const info = () => decodeInfo(h.block.info);
          return (
            <Show when={info()}>
              {(i) => (
                <div
                  class={`prompt-header ${gutterState(h.block)}`}
                  style={{
                    top: `${h.row * props.lineHeight}px`,
                    height: `${props.lineHeight}px`,
                    "font-size": `${props.fontSize * 0.9}px`,
                  }}
                >
                  <span class="ph-crumbs">
                    <span class="ph-icon">{""}</span>
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
                      <span class="ph-icon">{""}</span>
                      {i().branch}
                    </span>
                  </Show>
                  <span class="ph-spacer" />
                  <Show when={h.block.state === 2}>
                    <span class="ph-result">
                      <span class="ph-status ph-running">…</span>
                    </span>
                  </Show>
                  <Show when={h.block.done}>
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
