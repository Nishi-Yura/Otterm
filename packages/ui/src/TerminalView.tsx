import { invoke } from "@tauri-apps/api/core";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { exposeInternals, startupMark } from "./bench";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import type { UiConfig } from "./config";
import { t } from "./i18n";
import { isCopyShortcut, isSearchShortcut, platform, scrollKey, terminalKey, zoomKey } from "./keys";
import { PromptBar, type PromptProps } from "./PromptBar";
import { attachPointer } from "./pointer";
import { SearchBar } from "./SearchBar";
import { CanvasRenderer, DEFAULT_FONT, type FontConfig } from "./screen/canvasRenderer";
import { Highlights } from "./screen/highlights";
import { type Link, linkAt } from "./screen/links";
import { ScreenModel } from "./screen/model";
import { themeFromConfig } from "./screen/palette";
import type { Frame } from "./screen/protocol";
import { Selection } from "./screen/selection";
import {
  clipboard,
  createSession,
  openUrl,
  SCROLL_BOTTOM,
  SCROLL_TOP,
  type SearchOptions,
  type Session,
} from "./session";

/** PTY resizes are debounced (docs/03 §1.2). */
const RESIZE_DEBOUNCE_MS = 16;

/** Routes frames from the one screen socket to the pane showing each session. */
export interface ScreenHub {
  subscribe(session: number, onFrame: (f: Frame) => void): () => void;
}

export interface TerminalViewProps {
  hub: ScreenHub;
  config: () => UiConfig | undefined;
  /** This pane has the keyboard (it is the active pane of the visible tab). */
  active: () => boolean;
  /** Directory to start in (a path or a file:// URL). */
  cwd?: string;
  onTitle: (title: string) => void;
  onCwd: (url: string) => void;
  onExit: (code: number | null) => void;
  /** The program rang the bell (BEL). */
  onBell: () => void;
  /** The session started; App asks it what runs before closing the pane. */
  onSession: (id: number) => void;
  /** The user clicked into this pane. */
  onActivate: () => void;
  /** Window-level shortcuts (tabs, panes). Returns true when it handled the key. */
  appKey: (e: KeyboardEvent, altScreen: boolean) => boolean;
  notify: (text: string) => void;
}

/** One terminal: a session, its screen, and the input that goes to it. */
export function TerminalView(props: TerminalViewProps) {
  const [status, setStatus] = createSignal<string>();
  /** IME composition in progress (shown at the cursor, not sent to the shell until committed). */
  const [preedit, setPreedit] = createSignal<string>();
  const [anchor, setAnchor] = createSignal({ x: 0, y: 0, height: 0 });
  /** Scrollbar thumb as fractions of the track; none without scrollback. */
  const [bar, setBar] = createSignal<{ top: number; height: number; scrolled: boolean }>();
  /** Search matches as fractions of the track (docs/03 §4: hits shown on the scrollbar). */
  const [markers, setMarkers] = createSignal<number[]>([]);
  const [font, setFont] = createSignal<FontConfig>(DEFAULT_FONT);
  const [searching, setSearching] = createSignal(false);
  const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[] }>();
  const [prompt, setPrompt] = createSignal<PromptProps>();
  const [flash, setFlash] = createSignal(false);
  let lastBell = 0;
  /** The user chose "always allow" for OSC 52 in this pane. */
  let osc52Allowed = false;
  let host!: HTMLDivElement;
  let viewport!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  let input!: HTMLTextAreaElement;
  let session: Session | undefined;
  let unsubscribe: (() => void) | undefined;
  let observer: ResizeObserver | undefined;
  let detachPointer: (() => void) | undefined;
  let renderer: CanvasRenderer | undefined;
  let closed = false;
  /** Fit the grid to the pane again (after a resize or a font change). */
  let refit: (() => void) | undefined;
  /** The configured font; `zoom` is added to its size by the font size keys. */
  let baseFont: FontConfig = DEFAULT_FONT;
  let zoom = 0;
  let copyOnSelect = false;
  const model = new ScreenModel();
  const viewportId = `viewport-${++viewCount}`;
  const selection = new Selection();
  const highlights = new Highlights();
  let focusSearch: (() => void) | undefined;

  // Dev and bench builds expose the active pane for automated checks (screen text, cursor, draws).
  createEffect(() => {
    if ((import.meta.env.DEV || exposeInternals()) && props.active()) {
      // Getters: the renderer and the input exist only once the view has mounted.
      const exposed = {
        model,
        selection,
        get renderer() {
          return renderer;
        },
        get input() {
          return input;
        },
      };
      Object.assign(window, { __otterm: exposed });
    }
  });

  const applyConfig = (c: UiConfig) => {
    renderer?.setTheme(themeFromConfig(c.theme.terminal));
    baseFont = c.font;
    applyFont();
    selection.setWordSeparators(c.wordSeparators);
    copyOnSelect = c.copyOnSelect;
  };

  onMount(async () => {
    const r = new CanvasRenderer(canvas, model);
    renderer = r;
    r.selection = selection;
    r.highlights = highlights;
    const config = props.config();
    if (config) applyConfig(config);
    const fit = () => r.gridSize(viewport.clientWidth, viewport.clientHeight);

    // The size the session starts with; later fits compare against it.
    let last = fit();
    try {
      const { cols, rows } = last;
      session = await createSession(
        cols,
        rows,
        (e) => {
          if (e.kind === "title") props.onTitle(e.title);
          if (e.kind === "cwd") props.onCwd(e.url);
          if (e.kind === "clipboard") clipboardRequest(e.data);
          if (e.kind === "bell") bell();
          // A view that is gone (its pane was closed) has nothing left to report.
          if (e.kind === "exited" && !closed) {
            setStatus(t("process-exited", { code: e.code ?? "none" }));
            props.onExit(e.code);
          }
        },
        props.cwd,
      );
      startupMark("session created");
      props.onSession(session.id);
      if (closed) {
        session.close().catch(() => {});
        return;
      }
      unsubscribe = props.hub.subscribe(session.id, (frame) => {
        model.apply(frame);
        updateThumb();
        r.schedule();
      });
      // Frames sent before the subscription were dropped; ask for the whole screen.
      await session.redraw();
      // The pane may have been closed while we waited; its cleanup has already run.
      if (closed) return;
    } catch (e) {
      setStatus(t("start-failed", { error: String(e) }));
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    refit = () => {
      // A pane in a hidden tab has no size; keep its grid until it is shown again.
      if (viewport.clientWidth === 0 || viewport.clientHeight === 0) return;
      // The display scale may have changed (window moved to another monitor).
      r.measure();
      const next = fit();
      if (next.cols !== last.cols || next.rows !== last.rows) {
        last = next;
        // Reflow renumbers lines; a selection would point at other text.
        clearSelection();
        void session?.resize(next.cols, next.rows);
      } else {
        r.invalidate();
      }
    };
    observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => refit?.(), RESIZE_DEBOUNCE_MS);
    });
    observer.observe(viewport);

    const onFocus = (focused: boolean) => () => {
      r.focused = focused;
      model.dirty.add(model.cursorRow);
      r.schedule();
    };
    input.addEventListener("focus", onFocus(true));
    input.addEventListener("blur", onFocus(false));
    r.onDraw = () => placeInput(r.cursorRect());
    detachPointer = attachPointer({
      canvas,
      renderer: r,
      model,
      selection,
      session: () => session,
      onSelect: () => {
        if (copyOnSelect) void copySelection();
      },
      linkAt: (row, col) => linkAt(model, row, col),
      openLink: (link) => void openUrl(link.url).catch((e) => props.notify(String(e))),
      hoverLink: (link) => {
        if (sameLink(r.link, link)) return;
        r.link = link;
        canvas.style.cursor = link ? "pointer" : "";
        // The target, since an OSC 8 link's text need not be its URL.
        canvas.title = link ? `${link.url}\n${t("link-hint-first")}` : "";
        r.invalidate();
      },
      menu: (x, y, shift) => rightClick(x, y, shift),
    });
    if (props.active()) input.focus();
  });

  // A config change (theme, font) re-applies to this pane.
  createEffect(
    on(props.config, (c) => {
      if (!c || !renderer) return;
      applyConfig(c);
      refit?.();
    }),
  );

  // The active pane takes the keyboard.
  createEffect(() => {
    if (props.active() && input && !searching() && !menu()) input.focus();
  });

  // Registered synchronously: cleanups created after an `await` in onMount would never run.
  onCleanup(() => {
    closed = true;
    observer?.disconnect();
    detachPointer?.();
    unsubscribe?.();
    // The process may already have exited; then there is nothing to close.
    session?.close().catch(() => {});
  });

  /** Keep the hidden input at the cursor so the IME candidate window opens there (decision I4). */
  const placeInput = (r: { x: number; y: number; height: number }) => {
    input.style.transform = `translate(${r.x}px, ${r.y}px)`;
    input.style.height = `${r.height}px`;
    setAnchor(r);
  };

  const applyFont = () => {
    const size = Math.min(72, Math.max(6, baseFont.size + zoom));
    renderer?.setFont({ ...baseFont, size });
    setFont(renderer?.currentFont ?? baseFont);
  };

  const updateThumb = () => {
    if (model.scrollback === 0) {
      setBar(undefined);
      return;
    }
    const total = model.scrollback + model.rows;
    const top = (model.scrollback - model.offset) / total;
    const old = bar();
    if (old && old.top === top && old.height === model.rows / total) {
      // A full scrollback at the bottom keeps the thumb still while old lines drop off.
      updateMarkers();
      return;
    }
    setBar({ top, height: model.rows / total, scrolled: model.offset > 0 });
    updateMarkers();
  };

  const updateMarkers = () => {
    if (highlights.matches.length === 0) {
      if (markers().length > 0) setMarkers([]);
      return;
    }
    const first = model.topLine - (model.scrollback - model.offset);
    const total = model.scrollback + model.rows;
    // One marker per half percent of the track is as fine as the eye can tell.
    const at = new Set(highlights.matches.map((m) => Math.round(((m[0] - first) / total) * 200) / 200));
    setMarkers([...at].filter((f) => f >= 0 && f <= 1));
  };

  /** Click or drag on the scrollbar: center the view on that point of the history. */
  const onTrackDown = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const track = e.currentTarget as HTMLElement;
    const rect = track.getBoundingClientRect();
    // Offsets already asked for; frames confirming them may still be on their way.
    let requested = model.offset;
    const go = (y: number) => {
      const total = model.scrollback + model.rows;
      const top = Math.round(((y - rect.top) / rect.height) * total - model.rows / 2);
      const offset = Math.min(model.scrollback, Math.max(0, model.scrollback - top));
      if (offset !== requested) void session?.scroll(offset - requested);
      requested = offset;
    };
    go(e.clientY);
    const move = (ev: MouseEvent) => go(ev.clientY);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      input.focus();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const clearSelection = () => {
    if (!selection.active) return;
    selection.clear();
    renderer?.invalidate();
  };

  /** Copy the selection to the clipboard. Block selections are copied line by line. */
  const copySelection = async () => {
    const range = selection.range(model);
    if (!range || !session || selection.empty) return;
    let text: string;
    if (selection.mode === "block") {
      const lines: string[] = [];
      for (let line = range.start.line; line <= range.end.line; line++) {
        const cols = selection.colsOn(model, line);
        if (cols) lines.push(await session.text(line, cols[0], line, cols[1] - 1));
      }
      text = lines.join("\n");
    } else {
      text = await session.text(range.start.line, range.start.col, range.end.line, range.end.col);
    }
    await clipboard.write(text).catch((e) => props.notify(t("copy-failed", { error: String(e) })));
  };

  const pasteClipboard = async () => {
    pasteText(await clipboard.read().catch(() => ""));
  };

  const closePrompt = () => {
    setPrompt(undefined);
    input.focus();
  };

  /** BEL, as `terminal.bell` says: a short flash of the pane, a beep, or both. */
  const bell = () => {
    const mode = props.config()?.bell ?? "visual";
    if (mode === "none") return;
    props.onBell();
    // A program printing many BELs (cat of a binary file) should not strobe or buzz.
    const now = performance.now();
    if (now - lastBell < 200) return;
    lastBell = now;
    if (mode === "visual" || mode === "both") {
      setFlash(true);
      setTimeout(() => setFlash(false), 120);
    }
    if (mode === "sound" || mode === "both") beep();
  };

  /** Paste, asking first when the text has line breaks (decision B16): each line could run. */
  const pasteText = (text: string) => {
    if (!text || !session) return;
    if (!props.config()?.confirmMultilinePaste || !/[\r\n]/.test(text)) {
      void session.paste(text);
      return;
    }
    const lines = text.split(/\r\n|\r|\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    const shown = lines.slice(0, 5).join("\n") + (lines.length > 5 ? "\n…" : "");
    const send = (value: string) => {
      closePrompt();
      void session?.paste(value);
    };
    setPrompt({
      title: t("paste-multiline-title"),
      body: t("paste-multiline-body", { lines: lines.length }),
      preview: shown,
      buttons: [
        { label: t("paste-confirm"), action: () => send(text) },
        {
          label: t("paste-as-single-line"),
          action: () =>
            send(
              lines
                .map((l) => l.trim())
                .filter(Boolean)
                .join(" "),
            ),
        },
        { label: t("action-cancel"), action: closePrompt },
      ],
      cancel: closePrompt,
    });
  };

  /** An application asked to set the clipboard with OSC 52 (decision H2). */
  const clipboardRequest = (data: string) => {
    const policy = props.config()?.osc52Clipboard ?? "ask";
    const write = () => void clipboard.write(data).catch((e) => props.notify(t("copy-failed", { error: String(e) })));
    if (policy === "deny") return;
    if (policy === "allow" || osc52Allowed) return write();
    // One question at a time: a request while another is open (a paste confirmation, say) is
    // refused rather than replacing it.
    if (prompt()) return;
    setPrompt({
      // Enter alone must not hand the clipboard to a program: focus "deny".
      focus: 2,
      title: t("osc52-ask", { chars: [...data].length }),
      preview: data.length > 200 ? `${data.slice(0, 200)}…` : data,
      buttons: [
        {
          label: t("osc52-allow"),
          action: () => {
            closePrompt();
            write();
          },
        },
        {
          label: t("osc52-allow-always"),
          action: () => {
            osc52Allowed = true;
            closePrompt();
            write();
          },
        },
        { label: t("osc52-deny"), action: closePrompt },
      ],
      cancel: closePrompt,
    });
  };

  /** Right button (decision I1): the menu, or paste / copy-or-paste as configured. Shift: menu. */
  const rightClick = (x: number, y: number, shift: boolean) => {
    const mode = shift ? "context-menu" : (props.config()?.rightClick ?? "context-menu");
    if (mode === "paste") {
      props.onActivate();
      void pasteClipboard();
    } else if (mode === "copy-or-paste" && selection.active && !selection.empty) {
      void copySelection().then(clearSelection);
    } else if (mode === "copy-or-paste") {
      void pasteClipboard();
    } else {
      openMenu(x, y);
    }
  };

  /** Select every line: the scrollback and the screen. */
  const selectAll = () => {
    const first = model.topLine - (model.scrollback - model.offset);
    const last = model.topLine + model.offset + model.rows - 1;
    selection.start({ line: first, col: 0 }, "line");
    selection.extend({ line: last, col: 0 });
    renderer?.invalidate();
  };

  const shortcut = (key: string, shift = false) =>
    platform === "macos" ? `⌘${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`;

  const openMenu = (clientX: number, clientY: number) => {
    props.onActivate();
    const box = host.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    const cell = renderer?.cellAt(clientX - c.left, clientY - c.top);
    const link = cell ? linkAt(model, cell.row, cell.col) : undefined;
    const hasSelection = selection.active && !selection.empty;
    const items: MenuItem[] = [
      {
        label: t("menu-copy"),
        hint: shortcut("C", platform === "linux"),
        disabled: !hasSelection,
        action: () => void copySelection().then(clearSelection),
      },
      { label: t("menu-paste"), hint: shortcut("V", platform === "linux"), action: () => void pasteClipboard() },
      { label: t("menu-select-all"), action: selectAll },
      { label: t("menu-search"), hint: shortcut("F", platform !== "macos"), action: () => setSearching(true) },
      { label: t("menu-clear-scrollback"), action: () => void session?.clearScrollback() },
      { label: t("menu-reset-modes"), action: () => void session?.resetModes() },
      {
        label: t("menu-open-config"),
        action: () => void invoke("config_open").catch((e) => props.notify(String(e))),
      },
    ];
    if (link) {
      items.unshift(
        { label: t("menu-open-link"), action: () => void openUrl(link.url).catch((e) => props.notify(String(e))) },
        { label: t("menu-copy-link"), action: () => void clipboard.write(link.url) },
      );
    }
    setMenu({ x: clientX - box.left, y: clientY - box.top, items });
  };

  const closeMenu = () => {
    setMenu(undefined);
    input.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (props.appKey(e, model.altScreen)) {
      e.preventDefault();
      return;
    }
    if (!session) return;
    if (isSearchShortcut(e)) {
      e.preventDefault();
      if (searching()) focusSearch?.();
      else setSearching(true);
      return;
    }
    const z = zoomKey(e);
    if (z !== undefined) {
      e.preventDefault();
      // Keep zoom inside the size limits so the opposite key works at once.
      zoom = z === 0 ? 0 : Math.min(72 - baseFont.size, Math.max(6 - baseFont.size, zoom + z));
      applyFont();
      refit?.();
      return;
    }
    const hasSelection = selection.active && !selection.empty;
    if (isCopyShortcut(e, hasSelection)) {
      e.preventDefault();
      void copySelection().then(clearSelection);
      return;
    }
    const scroll = model.altScreen ? undefined : scrollKey(e, model.rows);
    if (scroll !== undefined) {
      e.preventDefault();
      void session.scroll(scroll === "top" ? SCROLL_TOP : scroll === "bottom" ? SCROLL_BOTTOM : scroll);
      return;
    }
    const key = terminalKey(e);
    if (key === undefined) return;
    e.preventDefault();
    clearSelection();
    void session.key(key);
  };

  let searchSeq = 0;
  const runSearch = async (query: string, opts: SearchOptions) => {
    if (!session) return 0;
    const seq = ++searchSeq;
    const matches = query ? await session.search(query, opts) : [];
    // A later search has started; its answer will set the highlights.
    if (seq !== searchSeq) return highlights.matches.length;
    // Start at the newest match, nearest the prompt.
    highlights.set(matches, matches.length - 1);
    updateMarkers();
    revealCurrent();
    return matches.length;
  };

  const stepSearch = (dir: -1 | 1) => {
    const n = highlights.matches.length;
    if (n === 0) return 0;
    highlights.current = (highlights.current + dir + n) % n;
    revealCurrent();
    return highlights.current + 1;
  };

  const revealCurrent = () => {
    const m = highlights.matches[highlights.current];
    if (m && session) void session.reveal(m[0]);
    renderer?.invalidate();
  };

  const closeSearch = () => {
    setSearching(false);
    highlights.clear();
    updateMarkers();
    renderer?.invalidate();
    input.focus();
  };

  // Text that did not come as a key press: committed IME compositions, some input methods.
  const onCompositionStart = () => setPreedit("");
  const onCompositionUpdate = (e: CompositionEvent) => setPreedit(e.data);
  /** Text just committed by the IME; WebKit can repeat it in a following input event. */
  let committed: string | undefined;
  const onCompositionEnd = (e: CompositionEvent) => {
    committed = e.data;
    setTimeout(() => {
      committed = undefined;
    });
    setPreedit(undefined);
    if (e.data && session) void session.write(e.data);
    input.value = "";
  };
  const onInput = (e: Event) => {
    const ev = e as InputEvent;
    if (ev.isComposing || preedit() !== undefined) return;
    if (committed !== undefined && ev.data === committed) {
      input.value = "";
      return;
    }
    if (ev.data && session) void session.write(ev.data);
    input.value = "";
  };

  const onPaste = (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData("text/plain");
    e.preventDefault();
    if (text) pasteText(text);
  };

  return (
    // A terminal is an application region: it takes its own keyboard and mouse input.
    <div
      ref={host}
      class="terminal"
      classList={{ active: props.active(), flash: flash() }}
      role="application"
      aria-label={t("terminal-label")}
      onMouseDown={() => {
        props.onActivate();
        setTimeout(() => input.focus());
      }}
    >
      <div ref={viewport} id={viewportId} class="viewport">
        <canvas ref={canvas} />
        <textarea
          ref={input}
          class="input"
          aria-label={t("terminal-input-label")}
          autocapitalize="off"
          autocomplete="off"
          spellcheck={false}
          onKeyDown={onKeyDown}
          onInput={onInput}
          onCompositionStart={onCompositionStart}
          onCompositionUpdate={onCompositionUpdate}
          onCompositionEnd={onCompositionEnd}
          onPaste={onPaste}
        />
        {preedit() && (
          <span
            class="preedit"
            style={{
              transform: `translate(${anchor().x}px, ${anchor().y}px)`,
              "line-height": `${anchor().height}px`,
              "font-family": font().family,
              "font-size": `${font().size}px`,
            }}
          >
            {preedit()}
          </span>
        )}
      </div>
      {menu() && <ContextMenu x={menu()?.x ?? 0} y={menu()?.y ?? 0} items={menu()?.items ?? []} close={closeMenu} />}
      {searching() && (
        <SearchBar
          search={runSearch}
          step={stepSearch}
          close={closeSearch}
          focusRef={(f) => {
            focusSearch = f;
          }}
        />
      )}
      <Show when={bar()}>
        {(b) => (
          <div
            class="scrolltrack"
            classList={{ shown: b().scrolled || markers().length > 0 }}
            role="scrollbar"
            aria-controls={viewportId}
            aria-orientation="vertical"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(b().top * 100)}
            tabIndex={-1}
            onMouseDown={onTrackDown}
          >
            <For each={markers()}>{(f) => <div class="scrollmark" style={{ top: `${f * 100}%` }} />}</For>
            <div class="scrollthumb" style={{ top: `${b().top * 100}%`, height: `${b().height * 100}%` }} />
          </div>
        )}
      </Show>
      <Show when={prompt()} keyed>
        {(p) => <PromptBar {...p} />}
      </Show>
      {status() && <div class="status">{status()}</div>}
    </div>
  );
}

function sameLink(a: Link | undefined, b: Link | undefined): boolean {
  return a?.url === b?.url && a?.start.row === b?.start.row && a?.start.col === b?.start.col;
}

let audio: AudioContext | undefined;
/** Numbers views for element ids. */
let viewCount = 0;

/** A short, quiet tone for the audible bell. */
function beep(): void {
  try {
    audio ??= new AudioContext();
    // Created before any user gesture, the context starts suspended.
    void audio.resume();
    tone(audio);
  } catch {
    // No audio device: the bell stays silent.
  }
}

function tone(audio: AudioContext): void {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.06, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.12);
  osc.connect(gain).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + 0.12);
}
