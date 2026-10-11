/**
 * The window's input-assist surfaces (docs/03 §8): the bar under the prompt that explains the
 * line and shows error hints, the completion popup, the history UI (§8.5), the command palette
 * (§7) and the multi-line editor (§8.6). The data comes from mods through the host; these only
 * draw it and hand clicks back.
 */
import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { t } from "../i18n";
import { Icon } from "../icons";
import type { CompletionItem, ErrorHint, Explanation } from "../mods/host";
import "./assist.css";

export interface AssistBarProps {
  /** Kotsume at the left end (docs/08 §6.1); with it the bar stays, even with nothing to explain. */
  mascot?: JSX.Element;
  explanation: Explanation | undefined;
  hint: ErrorHint | undefined;
  /** The line the hint belongs to, shown above it. */
  hintCommand?: string;
  onInsert: (text: string) => void;
  onHintAction: (hint: ErrorHint, index: number) => void;
  onDismissHint: () => void;
}

/** Under the terminal: the explanation of the line being typed, and the last error's hint card. */
export function AssistBar(props: AssistBarProps) {
  return (
    <Show when={props.explanation || props.hint || props.mascot}>
      <div class="assist-bar" data-ot="assist-bar">
        <Show when={props.hint} keyed>
          {(h) => (
            <div class="assist-card" classList={{ danger: true }} data-ot="error-hint">
              <div class="assist-card-head">
                <span class="assist-card-title">{h.title}</span>
                <Show when={props.hintCommand}>
                  <code class="assist-card-command">{props.hintCommand}</code>
                </Show>
                <button
                  type="button"
                  class="assist-close"
                  title={t("action-cancel")}
                  aria-label={t("action-cancel")}
                  onClick={() => props.onDismissHint()}
                >
                  ×
                </button>
              </div>
              <Show when={h.body}>
                <div class="assist-card-body">{h.body}</div>
              </Show>
              <Show when={h.fixCommand || h.actions?.length}>
                <div class="assist-card-actions">
                  <Show when={h.fixCommand}>
                    <button
                      type="button"
                      class="mt-button mt-button-small mt-button-primary"
                      onClick={() => props.onInsert(h.fixCommand ?? "")}
                    >
                      {t("action-insert")}: <code>{h.fixCommand}</code>
                    </button>
                  </Show>
                  <For each={h.actions ?? []}>
                    {(a, i) => (
                      <button
                        type="button"
                        class="mt-button mt-button-small"
                        onClick={() => props.onHintAction(h, i())}
                      >
                        {a.label}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          )}
        </Show>
        <Show when={props.explanation || props.mascot}>
          <div class="assist-row">
            {props.mascot}
            <Show when={props.explanation} keyed>
              {(x) => (
                <div class="assist-explain" classList={{ danger: !!x.danger }} data-ot="assist-explain">
                  <Show when={x.danger}>
                    <Icon name="alert-triangle" class="assist-danger-mark" />
                  </Show>
                  <span>{x.summary}</span>
                </div>
              )}
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
}

export interface CompletionPopupProps {
  items: CompletionItem[];
  selected: number;
  /** Where it goes, in CSS pixels of the panes area: under the cursor (`top`) or above it (`bottom`). */
  x: number;
  top?: number;
  bottom?: number;
  onPick: (item: CompletionItem) => void;
  onHover: (index: number) => void;
}

/** The completion list at the cursor (docs/03 §8.2); keys are handled by the terminal view. */
export function CompletionPopup(props: CompletionPopupProps) {
  let list!: HTMLDivElement;
  createEffect(() => {
    const el = list?.children[props.selected] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  });
  return (
    <div
      ref={list}
      class="completion"
      role="listbox"
      data-ot="completion"
      style={{
        left: `${props.x}px`,
        top: props.top === undefined ? undefined : `${props.top}px`,
        bottom: props.bottom === undefined ? undefined : `${props.bottom}px`,
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <For each={props.items}>
        {(item, i) => (
          // biome-ignore lint/a11y/useFocusableInteractive: keys stay in the terminal (docs/03 §8.2); the popup is pointer-only
          // biome-ignore lint/a11y/useKeyWithClickEvents: same
          <div
            role="option"
            class="completion-item"
            data-ot="completion-item"
            classList={{ selected: i() === props.selected, danger: !!item.danger }}
            aria-selected={i() === props.selected}
            onMouseEnter={() => props.onHover(i())}
            onClick={() => props.onPick(item)}
          >
            <span class="completion-kind">{kindMark(item.kind)}</span>
            <span class="completion-label">{item.label}</span>
            <Show when={item.recommended}>
              <span class="mt-badge mt-badge-success">{t("completion-recommended")}</span>
            </Show>
            <Show when={item.danger}>
              <span class="mt-badge mt-badge-danger">{t("completion-danger")}</span>
            </Show>
            <Show when={item.detail}>
              <span class="completion-detail">{item.detail}</span>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

function kindMark(kind: string): string {
  switch (kind) {
    case "subcommand":
      return "›";
    case "option":
      return "–";
    case "dir":
      return "▸";
    case "file":
      return "·";
    case "history":
      return "↺";
    case "branch":
      return "";
    default:
      return "•";
  }
}

export interface PaletteEntry {
  id: string;
  title: string;
  description?: string;
  /** Shown at the right, such as the key or the source. */
  hint?: string;
  run: () => void;
}

export interface PaletteProps {
  title: string;
  placeholder: string;
  entries: PaletteEntry[];
  /** Text typed before the list is shown (prefix handling is the caller's). */
  onInput?: (text: string) => void;
  /** `!` lines: run the text as a shell command. */
  onBang?: (text: string) => void;
  onClose: () => void;
  /** Rendered right of each row (history: folder, time, exit code). */
  emptyText: string;
  /**
   * Prefix characters with their own source (docs/03 §7: `:` line, `?` help, `@` file, `#` block).
   * The source gets the text after the prefix and returns the rows to show, already filtered.
   */
  prefixes?: Record<string, { hint: string; source: (rest: string) => Promise<PaletteEntry[]> | PaletteEntry[] }>;
  /** Toggles shown under the search box (the history's filters). */
  chips?: { id: string; label: string; on: boolean }[];
  onChip?: (id: string) => void;
}

/** A fuzzy-filtered list with a search box (the palette, docs/03 §7, and the history, §8.5). */
export function Palette(props: PaletteProps) {
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  const bang = () => query().startsWith("!");
  /** The prefix the query starts with, if the caller gave it a source. */
  const prefix = () => {
    const c = query()[0];
    return c && props.prefixes?.[c] ? c : undefined;
  };
  const [prefixed, setPrefixed] = createSignal<PaletteEntry[]>([]);
  let prefixSeq = 0;
  createEffect(() => {
    const p = prefix();
    const rest = query().slice(1).trim();
    if (!p) return;
    const seq = ++prefixSeq;
    // A short pause so a file search does not run on every keystroke.
    setTimeout(async () => {
      if (seq !== prefixSeq) return;
      const rows = await Promise.resolve(props.prefixes?.[p]?.source(rest) ?? []).catch(() => []);
      if (seq === prefixSeq) setPrefixed(rows);
    }, 120);
  });
  const filtered = createMemo(() => {
    if (prefix()) return prefixed();
    const q = bang() ? "" : query().trim().toLowerCase();
    const scored = props.entries
      .map((e) => ({ e, s: q ? fuzzy(q, `${e.title} ${e.description ?? ""} ${e.id}`.toLowerCase()) : 1 }))
      .filter((x) => x.s > 0);
    if (q) scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, 200).map((x) => x.e);
  });
  createEffect(() => {
    filtered();
    setSelected(0);
  });
  createEffect(() => {
    const el = list?.children[selected()] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  });
  onMount(() => input.focus());
  const pick = (e: PaletteEntry) => {
    props.onClose();
    e.run();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected(Math.min(filtered().length - 1, selected() + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected(Math.max(0, selected() - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (bang() && props.onBang) {
        props.onClose();
        props.onBang(query().slice(1).trim());
        return;
      }
      const e2 = filtered()[selected()];
      if (e2) pick(e2);
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click outside closes; Escape does the same from the input
    <div class="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="palette" role="dialog" aria-label={props.title} data-ot="palette">
        <input
          ref={input}
          class="palette-input"
          data-ot="palette-input"
          placeholder={props.placeholder}
          value={query()}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
            props.onInput?.(e.currentTarget.value);
          }}
          onKeyDown={onKeyDown}
        />
        <Show when={props.chips?.length}>
          <div class="palette-chips">
            <For each={props.chips ?? []}>
              {(c) => (
                <button
                  type="button"
                  class="palette-chip"
                  classList={{ on: c.on }}
                  aria-pressed={c.on}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    props.onChip?.(c.id);
                    input.focus();
                  }}
                >
                  {c.label}
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={props.prefixes && query() === ""}>
          <div class="palette-prefixes">
            <For each={Object.entries(props.prefixes ?? {})}>
              {([c, p]) => (
                <span class="palette-prefix">
                  <code>{c}</code> {p.hint}
                </span>
              )}
            </For>
          </div>
        </Show>
        <div ref={list} class="palette-list" role="listbox">
          <Show when={bang() && props.onBang}>
            <div class="palette-item selected" data-ot="palette-item">
              <span class="palette-title">{t("palette-run-shell", { command: query().slice(1).trim() })}</span>
            </div>
          </Show>
          <Show when={!bang()}>
            <For each={filtered()} fallback={<div class="palette-empty">{props.emptyText}</div>}>
              {(e, i) => (
                // biome-ignore lint/a11y/useFocusableInteractive: the search box keeps focus and handles the arrow keys
                // biome-ignore lint/a11y/useKeyWithClickEvents: same
                <div
                  role="option"
                  class="palette-item"
                  data-ot="palette-item"
                  classList={{ selected: i() === selected() }}
                  aria-selected={i() === selected()}
                  onMouseEnter={() => setSelected(i())}
                  onClick={() => pick(e)}
                >
                  <div class="palette-main">
                    <span class="palette-title">{e.title}</span>
                    <Show when={e.description}>
                      <span class="palette-desc">{e.description}</span>
                    </Show>
                  </div>
                  <Show when={e.hint}>
                    <span class="palette-hint">{e.hint}</span>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}

/** Subsequence match with a bonus for word starts; 0 when the query is not in the text. */
function fuzzy(q: string, text: string): number {
  let score = 0;
  let ti = 0;
  for (const c of q) {
    if (c === " ") continue;
    const at = text.indexOf(c, ti);
    if (at < 0) return 0;
    score += at === ti ? 3 : at === 0 || /[\s./:-]/.test(text[at - 1] ?? "") ? 2 : 1;
    ti = at + 1;
  }
  return score + (text.startsWith(q) ? 10 : 0);
}

export interface MultilineEditorProps {
  initial: string;
  onSend: (text: string) => void;
  onClose: () => void;
}

/** Shift+Enter: a box for several lines, sent to the shell as one paste (docs/03 §8.6). */
export function MultilineEditor(props: MultilineEditorProps) {
  let area!: HTMLTextAreaElement;
  onMount(() => {
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  });
  const problems = createMemo(() => {
    const text = area ? area.value : props.initial;
    return quoteProblems(text);
  });
  const [, setTick] = createSignal(0);
  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      props.onSend(area.value);
    }
  };
  onCleanup(() => {});
  return (
    <div class="multiline" data-ot="multiline-editor">
      <div class="multiline-head">
        <span>{t("multiline-title")}</span>
        <span class="muted">{t("multiline-hint")}</span>
      </div>
      <textarea
        ref={area}
        class="multiline-area"
        spellcheck={false}
        value={props.initial}
        rows={6}
        onInput={() => setTick((n) => n + 1)}
        onKeyDown={onKeyDown}
      />
      <div class="multiline-foot">
        <span class="multiline-problems">{problems().join(" · ")}</span>
        <span class="multiline-buttons">
          <button type="button" class="mt-button mt-button-small" onClick={() => props.onClose()}>
            {t("action-cancel")}
          </button>
          <button
            type="button"
            class="mt-button mt-button-small mt-button-primary"
            onClick={() => props.onSend(area.value)}
          >
            {t("multiline-send")}
          </button>
        </span>
      </div>
    </div>
  );
}

/** Unbalanced quotes or brackets, the mistakes a beginner makes most (docs/03 §8.6). */
function quoteProblems(text: string): string[] {
  const out: string[] = [];
  let single = 0;
  let double = 0;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'" && double % 2 === 0) single++;
    else if (c === '"' && single % 2 === 0) double++;
    else if (single % 2 === 0 && double % 2 === 0) {
      if (c === "(" || c === "{" || c === "[") depth++;
      if (c === ")" || c === "}" || c === "]") depth--;
    }
  }
  if (single % 2 === 1) out.push(t("multiline-unclosed-single"));
  if (double % 2 === 1) out.push(t("multiline-unclosed-double"));
  if (depth !== 0) out.push(t("multiline-unbalanced-brackets"));
  return out;
}
