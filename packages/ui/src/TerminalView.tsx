import { invoke } from "@tauri-apps/api/core";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { exposeInternals, startupMark } from "./bench";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import type { UiConfig } from "./config";
import { t } from "./i18n";
import { Icon } from "./icons";
import { type AppAction, platform, scrollKey, terminalKey } from "./keys";
import { PromptBar, type PromptProps } from "./PromptBar";
import { decodeInfo, duration, type FoldRow, type HeaderRow, PromptHeaders } from "./PromptHeaders";
import { attachPointer } from "./pointer";
import { SearchBar } from "./SearchBar";
import { CanvasRenderer } from "./screen/canvasRenderer";
import { Highlights } from "./screen/highlights";
import { type Link, linkAt, pathAt } from "./screen/links";
import { ScreenModel } from "./screen/model";
import { themeFromConfig } from "./screen/palette";
import type { Frame } from "./screen/protocol";
import { DEFAULT_FONT, type FontConfig, type Renderer } from "./screen/renderer";
import { Selection } from "./screen/selection";
import { textMetrics } from "./screen/text";
import { WebGLRenderer } from "./screen/webglRenderer";
import {
  type Block,
  clipboard,
  createSession,
  openUrl,
  SCROLL_BOTTOM,
  SCROLL_TOP,
  type SearchOptions,
  type Session,
  saveDownload,
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
  /** Profile to start (new-tab menu); the default when absent. */
  profile?: string;
  /** The later `otterm` launch this pane opens for (docs/06 §4). */
  launch?: number;
  /** A kept shell to take back (decision M26) instead of starting a new one. */
  attach?: number;
  onTitle: (title: string) => void;
  /** A command started (its line, maybe empty) or ended (""), from the shell integration. */
  onRunning: (command: string) => void;
  /** A block started or ended (docs/03 §6.3), with its head line, for mods and the status bar. */
  onBlock?: (e: { kind: "start" | "end"; line: number; exit?: number; ms?: number }) => void;
  /** Extra right-click items, from mods (`context.terminal`). */
  extraMenu?: () => MenuItem[];
  /** The line being typed at the prompt changed (docs/02 §6). `active` false once input ended. */
  onInput?: (e: { line: string; cursor: number; active: boolean; exact: boolean }) => void;
  /** Echo went off (a password prompt) or back on (decision K2). */
  onEchoOff?: (off: boolean) => void;
  /**
   * Enter at the prompt with a non-empty line: mods may veto or replace it (before-execute,
   * docs/05 §5.4). Resolves to false when the Enter must not be sent.
   */
  /**
   * A command line is about to run: the mods' verdict (the danger guard). Resolves to the line to
   * run (an alternative the user picked, perhaps), or false. `typed` means the line is in the
   * shell's editor already; otherwise it is text otterm is about to write.
   */
  beforeExecute?: (line: string, typed?: boolean) => Promise<string | false>;
  /** Keys the window's assist UI (completion popup, history) wants first. Returns true when taken. */
  assistKey?: (e: KeyboardEvent, input: { line: string; cursor: number; active: boolean; exact: boolean }) => boolean;
  onCwd: (url: string) => void;
  onExit: (code: number | null) => void;
  /** The program rang the bell (BEL). */
  onBell: () => void;
  /** The session started; App asks it what runs before closing the pane. */
  onSession: (id: number) => void;
  /** Hands over a way to read this pane's selection as text (`ctx.terminal.selection`, AI). */
  registerSelection?: (read: () => Promise<string>) => void;
  /** The user clicked into this pane. */
  onActivate: () => void;
  /** Window-level shortcuts (tabs, panes). Returns true when it handled the key. */
  /** Window keys first: true when otterm took the key, an action when this terminal should run it. */
  appKey: (e: KeyboardEvent, pane: { altScreen: boolean; hasSelection: boolean }) => boolean | AppAction;
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
  /** Block heads in view (docs/03 §6.3), the block row 0 is in, and the row height to place them. */
  const [headers, setHeaders] = createSignal<{
    rows: HeaderRow[];
    folds: FoldRow[];
    lineHeight: number;
    topBlock: number;
    lastRow: number;
  }>({ rows: [], folds: [], lineHeight: 0, topBlock: 0, lastRow: 0 });
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

  // Paths in the output (FR-FILE-06): looked up against the shell's folder before they show as links.
  let cwdNow = props.cwd;
  /**
   * "folder\ntext" → the absolute path, or null when there is no such file. Entries are kept for a
   * few seconds only: files come and go while the output stays on screen.
   */
  const pathCache = new Map<string, { found: string | null; at: number }>();
  const PATH_CACHE_MS = 5000;
  const pathKey = (link: Link) => `${link.base ?? ""}\n${link.url}`;
  const cachedPath = (link: Link) => {
    const hit = pathCache.get(pathKey(link));
    return hit && performance.now() - hit.at < PATH_CACHE_MS ? hit.found : undefined;
  };
  const resolvePath = async (link: Link) => {
    const known = cachedPath(link);
    if (known !== undefined) return known;
    // A failed call is not an answer; it is not cached.
    const found = await invoke<string | null>("path_resolve", { cwd: link.base ?? null, text: link.url });
    if (pathCache.size > 1000) pathCache.clear();
    pathCache.set(pathKey(link), { found, at: performance.now() });
    return found;
  };
  /** The path under a cell, with the folder it is relative to taken now (hover and click agree). */
  const pathLinkAt = (row: number, col: number) => {
    const path = pathAt(model, row, col);
    return path && { ...path, base: cwdNow };
  };
  /** A URL or OSC 8 link under a cell, else a path already known to exist. */
  const knownLinkAt = (row: number, col: number) => {
    const link = linkAt(model, row, col);
    if (link) return link;
    const path = pathLinkAt(row, col);
    return path && cachedPath(path) ? path : undefined;
  };
  const openLink = (link: Link) => {
    if (!link.path) return void openUrl(link.url).catch((e) => props.notify(String(e)));
    // A path that is not there (any more) is not worth a message.
    void invoke("path_open", { cwd: link.base ?? null, text: link.url }).catch((e) => {
      if (!String(e).startsWith("not found")) props.notify(String(e));
    });
  };
  let renderer: Renderer | undefined;
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

  /**
   * A screen reader hears new output (accessibility.screen_reader, docs/04 §5): once the output
   * pauses, the lines finished since last time go into a polite live region.
   */
  const [spoken, setSpoken] = createSignal("");
  let announced = -1;
  let announceTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleAnnounce = () => {
    if (!props.config()?.accessibility.screenReader || !props.active()) return;
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      if (model.altScreen || model.offset > 0) return;
      const cursorLine = model.lineAt(model.cursorRow);
      if (announced < 0 || announced >= cursorLine) {
        announced = cursorLine - 1;
        return;
      }
      const out: string[] = [];
      for (let row = 0; row < model.cursorRow; row++) {
        const line = model.lineAt(row);
        if (line > announced) out.push(model.text(row).trimEnd());
      }
      announced = cursorLine - 1;
      const text = out
        .filter((l) => l !== "")
        .slice(-30)
        .join("\n");
      if (text) setSpoken(text);
    }, 400);
  };
  onCleanup(() => clearTimeout(announceTimer));

  const applyConfig = (c: UiConfig) => {
    if (renderer) renderer.minimumContrast = c.minimumContrast;
    renderer?.setTheme({ ...themeFromConfig(c.theme.terminal), backgroundAlpha: c.terminalAlpha ?? 1 });
    baseFont = c.font;
    const ready = applyFont();
    selection.setWordSeparators(c.wordSeparators);
    copyOnSelect = c.copyOnSelect;
    host.style.padding = `${c.padding}px`;
    return ready;
  };

  onMount(async () => {
    const r = createRenderer(canvas, model, props.config()?.renderer ?? "auto");
    renderer = r;
    r.selection = selection;
    r.highlights = highlights;
    r.onRemeasure = () => void applyFont();
    const config = props.config();
    // The grid size the session starts with comes from the font's metrics.
    if (config) await applyConfig(config);
    if (closed) return;
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
          if (e.kind === "cwd") {
            cwdNow = e.url;
            props.onCwd(e.url);
          }
          if (e.kind === "clipboard") clipboardRequest(e.data);
          if (e.kind === "bell") bell();
          if (e.kind === "blockStart") {
            props.onRunning(e.command);
            props.onBlock?.({ kind: "start", line: e.line });
          }
          if (e.kind === "blockEnd") {
            props.onRunning("");
            props.onBlock?.({ kind: "end", line: e.line, exit: e.exit, ms: e.ms });
          }
          if (e.kind === "input") {
            inputState = { line: e.line, cursor: e.cursor, active: e.active, exact: e.exact };
            props.onInput?.(inputState);
          }
          if (e.kind === "echoOff") props.onEchoOff?.(e.off);
          // A view that is gone (its pane was closed) has nothing left to report.
          if (e.kind === "exited" && !closed) {
            setStatus(t("process-exited", { code: e.code ?? "none" }));
            props.onExit(e.code);
          }
        },
        props.cwd,
        props.profile,
        props.launch,
        props.attach,
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
        updateHeaders();
        r.schedule();
        scheduleAnnounce();
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
      session?.focus(focused).catch(() => {});
      r.focused = focused;
      model.dirty.add(model.cursorRow);
      r.schedule();
    };
    input.addEventListener("focus", onFocus(true));
    input.addEventListener("blur", onFocus(false));
    r.onDraw = () => {
      // The IME composes where the user types, even when the program draws its own cursor.
      const cell = r.cursorRect();
      const at = model.imeCursor();
      placeInput({ x: at.col * cell.width, y: at.row * cell.height, height: cell.height });
    };
    /** The link (or path still being looked up) under the pointer while Ctrl is held. */
    let hovered: Link | undefined;
    const showLink = (link: Link | undefined, target?: string) => {
      if (sameLink(r.link, link)) return;
      r.link = link;
      canvas.style.cursor = link ? "pointer" : "";
      // The target, since an OSC 8 link's text need not be its URL.
      canvas.title = link ? `${target ?? link.url}\n${t("link-hint-first")}` : "";
      r.invalidate();
    };
    detachPointer = attachPointer({
      canvas,
      renderer: r,
      model,
      selection,
      session: () => session,
      onSelect: () => {
        if (copyOnSelect) void copySelection();
      },
      // A click may come before the lookup; path_open checks the path itself.
      linkAt: (row, col) => linkAt(model, row, col) ?? pathLinkAt(row, col),
      openLink,
      hoverLink: (link) => {
        hovered = link;
        if (!link?.path) return showLink(link, link?.url);
        const known = cachedPath(link);
        if (known !== undefined) return showLink(known ? link : undefined, known ?? undefined);
        showLink(undefined);
        resolvePath(link)
          .then((found) => {
            if (found && sameLink(hovered, link)) showLink(link, found);
          })
          .catch(() => {});
      },
      menu: (x, y, shift) => rightClick(x, y, shift),
    });
    if (props.active()) input.focus();
  });

  // A config change (theme, font) re-applies to this pane.
  createEffect(
    on(props.config, (c) => {
      if (!c || !renderer) return;
      void applyConfig(c);
      refit?.();
    }),
  );

  // The active pane takes the keyboard.
  createEffect(() => {
    if (props.active() && input && !searching() && !menu()) input.focus();
  });

  // A web font (the bundled Nerd Font symbols) arrives after the first frame: glyphs drawn
  // before it came are redrawn with it.
  const onFontsLoaded = () => renderer?.invalidate();
  document.fonts.addEventListener("loadingdone", onFontsLoaded);

  // Registered synchronously: cleanups created after an `await` in onMount would never run.
  onCleanup(() => {
    document.fonts.removeEventListener("loadingdone", onFontsLoaded);
    closed = true;
    observer?.disconnect();
    detachPointer?.();
    unsubscribe?.();
    renderer?.dispose();
    // The process may already have exited; then there is nothing to close.
    session?.close().catch(() => {});
  });

  /** Keep the hidden input at the cursor so the IME candidate window opens there (decision I4). */
  const placeInput = (r: { x: number; y: number; height: number }) => {
    input.style.transform = `translate(${r.x}px, ${r.y}px)`;
    input.style.height = `${r.height}px`;
    setAnchor(r);
  };

  let fontRequest = 0;
  const applyFont = async () => {
    const size = Math.min(72, Math.max(6, baseFont.size + zoom));
    // Canvas text does not make the browser fetch a web font; ask for the symbols font here.
    void document.fonts.load(`${size}px "Symbols Nerd Font Mono"`, "").catch(() => {});
    const font = { ...baseFont, size };
    // The WebGL renderer draws glyphs Rust rasterizes, so the grid follows Rust's metrics.
    let metrics: Awaited<ReturnType<typeof textMetrics>> | undefined;
    const request = ++fontRequest;
    if (renderer instanceof WebGLRenderer) {
      try {
        metrics = await textMetrics(font.families, size * (window.devicePixelRatio || 1));
      } catch (e) {
        console.warn("font metrics from Rust unavailable:", e);
      }
      // A newer font change (zoom) happened while waiting.
      if (request !== fontRequest || closed) return;
    }
    renderer?.setFont(font, metrics);
    setFont(renderer?.currentFont ?? baseFont);
    updateHeaders();
    refit?.();
  };

  const updateHeaders = () => {
    const rows: HeaderRow[] = [];
    const folds: FoldRow[] = [];
    for (let row = 0; row < model.rows; row++) {
      const line = model.lines[row];
      if (line?.block) rows.push({ row, block: line.block });
      if (line?.folded) folds.push({ row, line: line.line, count: line.folded });
    }
    const lineHeight = renderer?.lineHeightCss ?? 0;
    // Scrolled up, the view shows history only, which the blocks fill to the bottom.
    const lastRow = model.offset > 0 ? model.rows - 1 : model.cursorRow;
    const old = headers();
    const same =
      old.lineHeight === lineHeight &&
      old.topBlock === model.topBlock &&
      old.lastRow === lastRow &&
      old.folds.length === folds.length &&
      folds.every((f, i) => old.folds[i]?.row === f.row && old.folds[i]?.count === f.count) &&
      old.rows.length === rows.length &&
      rows.every((h, i) => {
        const o = old.rows[i];
        return (
          o?.row === h.row &&
          o.block.info === h.block.info &&
          o.block.state === h.block.state &&
          o.block.done?.exit === h.block.done?.exit
        );
      });
    if (!same) setHeaders({ rows, folds, lineHeight, topBlock: model.topBlock, lastRow });
  };

  /** The block (docs/03 §6.3) as Markdown: command and output in code blocks, the rest as a line. */
  const blockMarkdown = (b: Block) => {
    const meta = [b.exit !== null ? `exit ${b.exit}` : b.running ? t("block-running") : ""];
    if (b.ms !== null) meta.push(duration(b.ms));
    const cwd = decodeInfo(b.info)?.cwd;
    if (cwd) meta.push(cwd);
    const parts = [`\`\`\`sh\n$ ${b.command ?? ""}\n\`\`\``];
    if (b.output) parts.push(`\`\`\`\n${b.output}\n\`\`\``);
    parts.push(meta.filter(Boolean).join(" · "));
    return parts.join("\n\n");
  };

  /** Save the output as otterm-<command>-<date>.txt in Downloads (decision I12). */
  const saveOutput = async (b: Block) => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const name =
      (b.command ?? "")
        .trim()
        .split(/\s+/)[0]
        ?.replace(/[^\w.-]/g, "") || "output";
    try {
      const path = await saveDownload(`otterm-${name}-${stamp}.txt`, b.output);
      props.notify(t("block-saved", { path }));
    } catch (e) {
      props.notify(String(e));
    }
  };

  /**
   * The block under the pointer, for the small toolbar at its first row (docs/03 §6.3: rerun, copy,
   * fold without opening the menu). Looked up once the pointer rests on a new row.
   */
  const [hoverBlock, setHoverBlock] = createSignal<{ row: number; block: Block }>();
  let hoverRow = -1;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  const onHoverMove = (e: MouseEvent) => {
    if (e.buttons !== 0 || (e.target as HTMLElement).closest(".block-actions")) return;
    const c = canvas.getBoundingClientRect();
    const cell = renderer?.cellAt(e.clientX - c.left, e.clientY - c.top);
    if (!cell || cell.row === hoverRow) return;
    hoverRow = cell.row;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(async () => {
      const line = model.lineAt(hoverRow);
      const b = session && !model.altScreen && line >= 0 ? await session.block(line).catch(() => null) : null;
      if (!b || b.command === null) return setHoverBlock(undefined);
      // The block's first row, or the top of the view when it starts above it.
      setHoverBlock({ row: Math.max(0, model.rowOf(b.line)), block: b });
    }, 150);
  };
  const clearHover = () => {
    clearTimeout(hoverTimer);
    hoverRow = -1;
    setHoverBlock(undefined);
  };
  onCleanup(() => clearTimeout(hoverTimer));

  /** Menu items for the block under the pointer, if the shell integration made one there. */
  const blockItems = async (row: number): Promise<MenuItem[]> => {
    const line = model.lineAt(row);
    if (!session || model.altScreen || line < 0) return [];
    const b = await session.block(line).catch(() => null);
    if (!b || b.command === null) return [];
    const command = b.command;
    const short = command.length > 40 ? `${command.slice(0, 40)}…` : command;
    const selectBlock = () => {
      selection.start({ line: b.line, col: 0 }, "line");
      selection.extend({ line: b.end, col: 0 });
      renderer?.invalidate();
    };
    return [
      {
        label: t("menu-rerun", { command: short }),
        disabled: b.running,
        action: () => void runLine(command),
      },
      {
        label: t(b.folded ? "menu-unfold" : "menu-fold"),
        disabled: !b.foldable,
        action: () => void session?.blockFold(b.line, !b.folded),
      },
      { label: t("menu-select-block"), action: selectBlock },
      { label: t("menu-copy-command"), action: () => void clipboard.write(command) },
      { label: t("menu-copy-output"), disabled: !b.output, action: () => void clipboard.write(b.output) },
      { label: t("menu-save-output"), disabled: !b.output, action: () => void saveOutput(b) },
      { label: t("menu-copy-markdown"), action: () => void clipboard.write(blockMarkdown(b)) },
    ];
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
    const first = model.firstLine;
    const total = model.lastLine - first + 1;
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

  /** The selection as text ("" without one). Block selections come line by line. */
  const selectedText = async (): Promise<string> => {
    const range = selection.range(model);
    if (!range || !session || selection.empty) return "";
    if (selection.mode === "block") {
      const lines: string[] = [];
      for (let line = range.start.line; line <= range.end.line; line++) {
        const cols = selection.colsOn(model, line);
        if (cols) lines.push(await session.text(line, cols[0], line, cols[1] - 1));
      }
      return lines.join("\n");
    }
    return session.text(range.start.line, range.start.col, range.end.line, range.end.col);
  };
  props.registerSelection?.(selectedText);

  /** Copy the selection to the clipboard. */
  const copySelection = async () => {
    const text = await selectedText();
    if (!text) return;
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

  /** Write `line` and Enter, after the mods' verdict (the danger guard) when there is one. */
  const runLine = async (line: string) => {
    const s = session;
    if (!s) return;
    const final = props.beforeExecute ? await props.beforeExecute(line, false) : line;
    if (final !== false) void s.write(`${final}\r`);
  };

  /**
   * Paste `text` whose line breaks would run its lines: each line gets the danger guard's look,
   * like a typed Enter (an alternative the user picks replaces that line), and one cancel drops
   * the whole paste.
   */
  const pasteLines = async (text: string) => {
    const s = session;
    if (!s) return;
    let out = text;
    if (props.beforeExecute) {
      const parts = text.split(/(\r\n|\r|\n)/);
      for (let i = 0; i < parts.length; i += 2) {
        const line = parts[i] ?? "";
        if (line.trim() === "") continue;
        const checked = await props.beforeExecute(line, false);
        if (checked === false) return;
        parts[i] = checked;
      }
      out = parts.join("");
    }
    void s.paste(out);
  };

  /** Paste, asking first when the text has line breaks (decision B16): each line could run. */
  const pasteText = (text: string) => {
    if (!text || !session) return;
    if (!/[\r\n]/.test(text)) {
      void session.paste(text);
      return;
    }
    if (!props.config()?.confirmMultilinePaste) {
      void pasteLines(text);
      return;
    }
    const lines = text.split(/\r\n|\r|\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    const shown = lines.slice(0, 5).join("\n") + (lines.length > 5 ? "\n…" : "");
    const send = (value: string) => {
      closePrompt();
      void pasteLines(value);
    };
    setPrompt({
      title: t("paste-multiline-title"),
      body: t("paste-multiline-body", { lines: lines.length }),
      preview: shown,
      buttons: [
        { label: t("paste-confirm"), action: () => send(text) },
        {
          label: t("paste-as-single-line"),
          action: () => {
            closePrompt();
            const one = lines
              .map((l) => l.trim())
              .filter(Boolean)
              .join(" ");
            // One line, not run: it goes in as typed text, so no guard until Enter.
            void session?.paste(one);
          },
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
      void openMenu(x, y);
    }
  };

  /** Select every line: the scrollback and the screen. */
  const selectAll = () => {
    selection.start({ line: model.firstLine, col: 0 }, "line");
    selection.extend({ line: model.lastLine, col: 0 });
    renderer?.invalidate();
  };

  const shortcut = (key: string, shift = false) =>
    platform === "macos" ? `⌘${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`;

  const openMenu = async (clientX: number, clientY: number) => {
    props.onActivate();
    const box = host.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    const cell = renderer?.cellAt(clientX - c.left, clientY - c.top);
    const link = cell ? knownLinkAt(cell.row, cell.col) : undefined;
    const hasSelection = selection.active && !selection.empty;
    const block = cell ? await blockItems(cell.row) : [];
    const items: MenuItem[] = [
      ...block,
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
        { label: t("menu-open-link"), action: () => openLink(link) },
        { label: t("menu-copy-link"), action: () => void clipboard.write(link.url) },
      );
    }
    // Mods' items (docs/05 §5.2 `ctx.ui.contextMenu`) go last, under otterm's own.
    items.push(...(props.extraMenu?.() ?? []));
    setMenu({ x: clientX - box.left, y: clientY - box.top, items });
  };

  const closeMenu = () => {
    setMenu(undefined);
    input.focus();
  };

  /** What the user is typing at the prompt, as the last `input` event reported it. */
  let inputState = { line: "", cursor: 0, active: false, exact: false };
  /** An Enter is waiting for the mods' verdict; keys typed meanwhile are not lost (they queue in the DOM). */
  let enterPending = false;

  /** Copy, paste, search, font size and clear (docs/06 §5.2): bound in keymap.ts, run here. */
  const runPaneAction = (a: AppAction): boolean => {
    switch (a.kind) {
      case "copy":
        // Ctrl+Shift+C with nothing selected does nothing rather than reach the shell.
        if (selection.active && !selection.empty) void copySelection().then(clearSelection);
        return true;
      case "paste":
        void pasteClipboard();
        return true;
      case "search":
        if (searching()) focusSearch?.();
        else setSearching(true);
        return true;
      case "font":
        // Keep zoom inside the size limits so the opposite key works at once.
        zoom = a.step === 0 ? 0 : Math.min(72 - baseFont.size, Math.max(6 - baseFont.size, zoom + a.step));
        void applyFont();
        refit?.();
        return true;
      case "clear":
        // The shell clears the screen; the scrollback stays (docs/06 §5.2).
        if (!session) return false;
        void session.key({ key: "l", ctrl: true, alt: false, shift: false });
        return true;
      default:
        return false;
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const app = props.appKey(e, { altScreen: model.altScreen, hasSelection: selection.active && !selection.empty });
    if (app === true || (typeof app === "object" && runPaneAction(app))) {
      e.preventDefault();
      return;
    }
    if (!session) return;
    if (!model.altScreen && props.assistKey?.(e, inputState)) {
      e.preventDefault();
      return;
    }
    // Enter at the prompt: mods get a look first (before-execute), with a short deadline.
    if (
      e.key === "Enter" &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey &&
      !e.metaKey &&
      !model.altScreen &&
      inputState.active &&
      inputState.line.trim() !== "" &&
      props.beforeExecute
    ) {
      e.preventDefault();
      if (enterPending) return;
      enterPending = true;
      const s = session;
      props
        .beforeExecute(inputState.line, true)
        .then((line) => {
          if (line !== false) void s.key({ key: "Enter", ctrl: false, alt: false, shift: false });
        })
        .finally(() => {
          enterPending = false;
        });
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
      data-ot="terminal"
      classList={{ active: props.active(), flash: flash() }}
      role="application"
      aria-label={t("terminal-label")}
      onMouseDown={(e) => {
        props.onActivate();
        if (e.target === canvas) {
          // Keep the keyboard on the input: a click on the canvas would otherwise blur it until
          // the refocus below, and a key pressed in between (right after a double-click) is lost.
          e.preventDefault();
          input.focus();
        } else {
          setTimeout(() => input.focus());
        }
      }}
    >
      <Show when={props.config()?.accessibility.screenReader}>
        <div class="sr-only" aria-live="polite" aria-atomic="true">
          {spoken()}
        </div>
      </Show>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the pointer only decides which block's toolbar shows; the same actions are in the menu and the palette */}
      <div
        ref={viewport}
        id={viewportId}
        class="viewport"
        onMouseMove={onHoverMove}
        onMouseLeave={clearHover}
        onWheel={clearHover}
      >
        <canvas ref={canvas} />
        <Show when={hoverBlock()} keyed>
          {(h) => (
            <div
              class="block-actions"
              role="toolbar"
              aria-label={t("block-actions")}
              data-ot="block-actions"
              classList={{ "beside-header": headers().rows.some((r) => r.row === h.row && r.block.info !== "") }}
              style={{ top: `${h.row * headers().lineHeight}px`, height: `${headers().lineHeight}px` }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                title={t("menu-rerun", { command: h.block.command ?? "" })}
                aria-label={t("menu-rerun", { command: h.block.command ?? "" })}
                disabled={h.block.running}
                onClick={() => void session?.write(`${h.block.command}\r`)}
              >
                <Icon name="play" />
              </button>
              <button
                type="button"
                title={t("menu-copy-output")}
                aria-label={t("menu-copy-output")}
                disabled={!h.block.output}
                onClick={() => void clipboard.write(h.block.output)}
              >
                <Icon name="copy" />
              </button>
              <Show when={h.block.foldable}>
                <button
                  type="button"
                  title={t(h.block.folded ? "menu-unfold" : "menu-fold")}
                  aria-label={t(h.block.folded ? "menu-unfold" : "menu-fold")}
                  onClick={() => {
                    void session?.blockFold(h.block.line, !h.block.folded);
                    clearHover();
                  }}
                >
                  <Icon name={h.block.folded ? "chevron-down" : "chevron-up"} />
                </button>
              </Show>
              <button
                type="button"
                title={t("block-more")}
                aria-label={t("block-more")}
                onClick={(e) => void openMenu(e.clientX, e.clientY)}
              >
                <Icon name="more-horizontal" />
              </button>
            </div>
          )}
        </Show>
        <PromptHeaders
          rows={headers().rows}
          lineHeight={headers().lineHeight}
          fontSize={font().size}
          topBlock={headers().topBlock}
          viewRows={model.rows}
          lastRow={headers().lastRow}
          folds={headers().folds}
          onUnfold={(line) => void session?.blockFold(line, false)}
        />
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

/** WebGL2 unless the configuration asks for Canvas 2D or WebGL2 is not available (docs/02 §1.2). */
function createRenderer(canvas: HTMLCanvasElement, model: ScreenModel, kind: UiConfig["renderer"]): Renderer {
  if (kind !== "canvas") {
    try {
      return new WebGLRenderer(canvas, model);
    } catch (e) {
      console.warn("WebGL2 renderer unavailable, using Canvas 2D:", e);
    }
  }
  return new CanvasRenderer(canvas, model);
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
