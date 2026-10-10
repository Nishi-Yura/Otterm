import { createSignal, onCleanup, onMount } from "solid-js";
import type { SearchOptions } from "./session";

/** Delay between typing and searching, so each keystroke does not search the whole history. */
const SEARCH_DELAY_MS = 120;

export interface SearchBarProps {
  /** Search; resolves to the number of matches, rejects with a message for the user. */
  search: (query: string, opts: SearchOptions) => Promise<number>;
  /** Move to an older (-1) or newer (1) match; returns its 1-based position. */
  step: (dir: -1 | 1) => number;
  close: () => void;
  /** Receives a function that focuses the query field (for the shortcut while open). */
  focusRef?: (focus: () => void) => void;
}

/** The scrollback search bar (docs/03 §4): plain or regex, case, whole word. */
export function SearchBar(props: SearchBarProps) {
  const [query, setQuery] = createSignal("");
  const [opts, setOpts] = createSignal<SearchOptions>({ regex: false, caseSensitive: false, wholeWord: false });
  const [count, setCount] = createSignal(0);
  const [index, setIndex] = createSignal(0);
  const [error, setError] = createSignal<string>();
  let input!: HTMLInputElement;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const focus = () => {
    input.focus();
    input.select();
  };
  onMount(() => {
    props.focusRef?.(focus);
    focus();
  });
  onCleanup(() => clearTimeout(timer));

  const run = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const n = await props.search(query(), opts());
        setCount(n);
        setIndex(n);
        setError(undefined);
      } catch (e) {
        setCount(0);
        setIndex(0);
        setError(String(e));
      }
    }, SEARCH_DELAY_MS);
  };

  const toggle = (key: keyof SearchOptions) => {
    setOpts({ ...opts(), [key]: !opts()[key] });
    run();
    input.focus();
  };

  const step = (dir: -1 | 1) => {
    if (count() > 0) setIndex(props.step(dir));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Keys typed here are for the search bar, not the terminal.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      props.close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Enter goes up through history (older), Shift+Enter back down.
      step(e.shiftKey ? 1 : -1);
    }
  };

  const Toggle = (p: { key: keyof SearchOptions; label: string; title: string }) => (
    <button
      type="button"
      class="search-toggle"
      aria-pressed={opts()[p.key]}
      title={p.title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => toggle(p.key)}
    >
      {p.label}
    </button>
  );

  return (
    <search class="search" data-ot="search">
      <input
        ref={input}
        class="search-input"
        classList={{ invalid: error() !== undefined }}
        aria-label="Search the terminal"
        placeholder="Search"
        spellcheck={false}
        value={query()}
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          run();
        }}
        onKeyDown={onKeyDown}
      />
      <Toggle key="caseSensitive" label="Aa" title="Match case" />
      <Toggle key="wholeWord" label="ab" title="Whole word" />
      <Toggle key="regex" label=".*" title="Regular expression" />
      <span class="search-count" title={error()}>
        {error() ? "invalid" : query() ? `${count() === 0 ? 0 : index()}/${count()}` : ""}
      </span>
      <button type="button" class="search-step" title="Older (Enter)" onClick={() => step(-1)}>
        ↑
      </button>
      <button type="button" class="search-step" title="Newer (Shift+Enter)" onClick={() => step(1)}>
        ↓
      </button>
      <button type="button" class="search-step" title="Close (Esc)" onClick={() => props.close()}>
        ×
      </button>
    </search>
  );
}
