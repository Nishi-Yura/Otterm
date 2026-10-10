import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { benchMode, runIpcBench, runStartupBench, runTypingBench, setExposeInternals, startupMark } from "./bench";
import { applyThemeCss, loadConfig, onConfigChanged, type UiConfig } from "./config";
import { setLanguage, t } from "./i18n";
import { Keymap } from "./keymap";
import { type AppAction, platform } from "./keys";
import {
  type Divider,
  layout,
  leaf,
  leaves,
  neighbor,
  type PaneNode,
  type Rect,
  removePane,
  resizePane,
  setRatio,
  splitPane,
} from "./layout";
import { PromptBar, type PromptProps } from "./PromptBar";
import type { Frame } from "./screen/protocol";
import { connectScreen } from "./session";
import { type ScreenHub, TerminalView } from "./TerminalView";

/** How long a notice (such as ignored config keys) stays up. */
const NOTICE_MS = 10_000;
/** How far Alt+Shift+arrow moves a divider, as a fraction of the split. */
const RESIZE_STEP = 0.05;

interface Tab {
  id: number;
  root: PaneNode;
  /** The pane with the keyboard. */
  active: number;
  /** A pane shown alone (Ctrl+Shift+Z), if any. */
  zoomed?: number;
}

interface Pane {
  id: number;
  tab: number;
  /** Where it started (inherited from the pane it was split from). */
  cwd?: string;
}

/** The window: a tab bar and, per tab, panes laid out by a split tree (docs/03 §3). */
export function App() {
  const [ready, setReady] = createSignal(false);
  const [bench, setBench] = createSignal<string>();
  const [config, setConfig] = createSignal<UiConfig>();
  const [notice, setNotice] = createSignal<string>();
  const [tabs, setTabs] = createSignal<Tab[]>([]);
  const [activeTab, setActiveTab] = createSignal(0);
  /** Every pane of every tab, in creation order. Each keeps its object so its view stays mounted. */
  const [panes, setPanes] = createSignal<Pane[]>([]);
  const [titles, setTitles] = createSignal<Record<number, string>>({});
  /** Tabs whose program rang the bell while they were in the background. */
  const [rang, setRang] = createSignal<Set<number>>(new Set());
  const cwds = new Map<number, string>();
  /** Session id of each pane, once started. */
  const sessionOf = new Map<number, number>();
  const [confirm, setConfirm] = createSignal<PromptProps>();
  const routes = new Map<number, (f: Frame) => void>();
  let area!: HTMLDivElement;
  let ws: WebSocket | undefined;
  let unlistenConfig: (() => void) | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let nextId = 1;
  /** The user confirmed closing the window; do not ask again. */
  let closingWindow = false;
  let keymap = new Keymap();

  const hub: ScreenHub = {
    subscribe(session, onFrame) {
      routes.set(session, onFrame);
      return () => routes.delete(session);
    },
  };

  const showNotice = (text: string) => {
    setNotice(text);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => setNotice(undefined), NOTICE_MS);
  };

  const applyConfig = (c: UiConfig) => {
    setLanguage(c.language);
    applyThemeCss(c.theme);
    setConfig(c);
    keymap = new Keymap(c.keybindings);
    const warnings = [
      ...c.warnings.map((w) => (w.key ? `${w.key}: ${w.message}` : w.message)),
      ...keymap.problems.map((p) => `keybindings.bindings.${p}`),
    ];
    if (warnings.length > 0) showNotice(t("config-ignored", { keys: warnings.join("; ") }));
  };

  onMount(async () => {
    startupMark("page start", 0);
    startupMark("ui mounted");
    const mode = await benchMode();
    if (mode === "ipc") {
      setBench("ipc bench running…");
      await runIpcBench(setBench);
      return;
    }
    if (mode) setExposeInternals(true);
    try {
      applyConfig(await loadConfig());
      startupMark("config loaded");
      unlistenConfig = await onConfigChanged(applyConfig);
    } catch (e) {
      showNotice(t("config-unreadable", { error: String(e) }));
    }
    try {
      ws = await connectScreen((frame) => routes.get(frame.session)?.(frame));
      startupMark("screen socket open");
    } catch (e) {
      showNotice(t("start-failed", { error: String(e) }));
      return;
    }
    newTab();
    setReady(true);
    const unknown = await invoke<string[]>("launch_problems").catch(() => []);
    if (unknown.length > 0) showNotice(t("launch-unknown", { args: unknown.join(" ") }));
    if (mode === "startup") runStartupBench().catch((e) => setBench(`startup bench failed: ${String(e)}`));
    if (mode === "typing") {
      runTypingBench(setBench).catch((e) => setBench(`typing bench failed: ${String(e)}`));
    }
  });

  // The window's close button: ask when something still runs anywhere.
  let unlistenClose: (() => void) | undefined;
  void getCurrentWindow()
    .onCloseRequested(async (event) => {
      if (closingWindow) return;
      // If the check fails, close: a window that cannot be closed is worse.
      const program = await runningIn(panes().map((p) => p.id)).catch(() => undefined);
      if (!program) return;
      event.preventDefault();
      await askThenClose(
        panes().map((p) => p.id),
        () => {
          closingWindow = true;
          void getCurrentWindow().destroy();
        },
      );
    })
    .then((f) => {
      unlistenClose = f;
    });

  onCleanup(() => {
    unlistenConfig?.();
    unlistenClose?.();
    clearTimeout(noticeTimer);
    ws?.close();
  });

  const currentTab = () => tabs().find((x) => x.id === activeTab());
  const updateTab = (id: number, f: (tab: Tab) => Tab) => setTabs(tabs().map((x) => (x.id === id ? f(x) : x)));

  // Tabs and panes change together (batch), so a new pane is laid out and visible by the time its
  // terminal mounts and measures itself.
  const newTab = (cwd?: string) => {
    const tabId = nextId++;
    const paneId = nextId++;
    const at = tabs().findIndex((x) => x.id === activeTab());
    const next = [...tabs()];
    next.splice(at + 1, 0, { id: tabId, root: leaf(paneId), active: paneId });
    batch(() => {
      setTabs(next);
      setActiveTab(tabId);
      setPanes([...panes(), { id: paneId, tab: tabId, cwd }]);
    });
  };

  const closeTab = (tabId: number) => {
    const tab = tabs().find((x) => x.id === tabId);
    if (!tab) return;
    const ids = new Set(leaves(tab.root));
    setPanes(panes().filter((p) => !ids.has(p.id)));
    const keep = { ...titles() };
    for (const id of ids) {
      delete keep[id];
      cwds.delete(id);
    }
    setTitles(keep);
    const index = tabs().findIndex((x) => x.id === tabId);
    const rest = tabs().filter((x) => x.id !== tabId);
    setTabs(rest);
    if (rest.length === 0) {
      void getCurrentWindow().close();
      return;
    }
    if (activeTab() === tabId) setActiveTab((rest[Math.min(index, rest.length - 1)] as Tab).id);
  };

  const closePane = (paneId: number) => {
    const tab = tabs().find((x) => leaves(x.root).includes(paneId));
    if (!tab) return;
    const root = removePane(tab.root, paneId);
    if (!root) {
      closeTab(tab.id);
      return;
    }
    setPanes(panes().filter((p) => p.id !== paneId));
    cwds.delete(paneId);
    // Focus the pane that took its place.
    const next = tab.active === paneId ? (neighbor(tab.root, paneId, "left") ?? leaves(root)[0] ?? 0) : tab.active;
    updateTab(tab.id, (x) => ({
      ...x,
      root,
      active: leaves(root).includes(next) ? next : (leaves(root)[0] ?? 0),
      zoomed: undefined,
    }));
  };

  const split = (dir: "row" | "column") => {
    const tab = currentTab();
    if (!tab) return;
    const paneId = nextId++;
    batch(() => {
      updateTab(tab.id, (x) => ({
        ...x,
        root: splitPane(x.root, x.active, paneId, dir),
        active: paneId,
        zoomed: undefined,
      }));
      setPanes([...panes(), { id: paneId, tab: tab.id, cwd: cwds.get(tab.active) }]);
    });
  };

  const activatePane = (paneId: number) => {
    const tab = tabs().find((x) => leaves(x.root).includes(paneId));
    if (tab && tab.active !== paneId) updateTab(tab.id, (x) => ({ ...x, active: paneId }));
  };

  /** A program running in one of these panes, if any (when the user wants to be asked). */
  const runningIn = async (paneIds: number[]): Promise<string | undefined> => {
    if (!(config()?.confirmCloseRunning ?? true)) return undefined;
    for (const pane of paneIds) {
      const id = sessionOf.get(pane);
      if (id === undefined) continue;
      const name = await invoke<string | null>("session_running", { id }).catch(() => null);
      if (name) return name;
    }
    return undefined;
  };

  /** Close, asking first when a program is still running there (docs/03 §3.2). */
  const askThenClose = async (paneIds: number[], close: () => void) => {
    const program = await runningIn(paneIds);
    if (!program) return close();
    const done = () => setConfirm(undefined);
    setConfirm({
      title: t("close-running-title"),
      body: t("close-running-body", { program }),
      buttons: [
        {
          label: t("close-running-confirm"),
          action: () => {
            done();
            close();
          },
        },
        { label: t("action-cancel"), action: done },
      ],
      // Enter alone keeps the program running.
      focus: 1,
      cancel: done,
    });
  };

  /**
   * Window-level shortcuts; called by the focused terminal before it handles a key. On the
   * alternate screen (vim, less, …) only Ctrl+Shift and Cmd chords stay with otterm, unless
   * `keybindings.alt_screen_passthrough` is off (issue #5).
   */
  const onAppKey = (e: KeyboardEvent, altScreen: boolean): boolean => {
    const hit = keymap.match(e);
    if (!hit) return false;
    if (altScreen && !hit.strong && (config()?.altScreenPassthrough ?? true)) return false;
    return run(hit.action);
  };

  /** Returns false when the action had nothing to do, so the key goes to the terminal instead. */
  const run = (action: AppAction): boolean => {
    const tab = currentTab();
    const list = tabs();
    const index = list.findIndex((x) => x.id === activeTab());
    switch (action.kind) {
      case "newTab":
        newTab(tab ? cwds.get(tab.active) : undefined);
        break;
      case "closeTab":
        if (tab) void askThenClose(leaves(tab.root), () => closeTab(tab.id));
        break;
      case "nextTab":
      case "prevTab": {
        const step = action.kind === "nextTab" ? 1 : -1;
        const next = list[(index + step + list.length) % list.length];
        if (next) setActiveTab(next.id);
        break;
      }
      case "gotoTab": {
        // Like browsers, 9 is the last tab.
        const target = action.index === 8 ? list[list.length - 1] : list[action.index];
        if (!target) return false;
        setActiveTab(target.id);
        break;
      }
      case "split":
        split(action.dir);
        break;
      case "focusPane": {
        // With no pane that way (one pane, or the edge), the key is the shell's: Alt+arrow moves
        // by word in many programs.
        const next = tab ? neighbor(tab.root, tab.active, action.dir) : undefined;
        if (!tab || next === undefined) return false;
        updateTab(tab.id, (x) => ({ ...x, active: next, zoomed: undefined }));
        break;
      }
      case "resizePane":
        if (!tab || leaves(tab.root).length < 2) return false;
        updateTab(tab.id, (x) => ({ ...x, root: resizePane(x.root, x.active, action.dir, RESIZE_STEP) }));
        break;
      case "zoomPane":
        if (!tab || leaves(tab.root).length < 2) return false;
        updateTab(tab.id, (x) => ({ ...x, zoomed: x.zoomed === undefined ? x.active : undefined }));
        break;
      case "closePane":
        if (tab) void askThenClose([tab.active], () => closePane(tab.active));
        break;
    }
    return true;
  };

  /** Each pane's rectangle in its tab, and the active tab's dividers. */
  const geometry = createMemo(() => {
    const rects = new Map<number, Rect>();
    let dividers: Divider[] = [];
    for (const tab of tabs()) {
      const l = layout(tab.root);
      if (tab.zoomed !== undefined) {
        rects.set(tab.zoomed, { x: 0, y: 0, w: 1, h: 1 });
      } else {
        for (const [id, r] of l.panes) rects.set(id, r);
      }
      if (tab.id === activeTab() && tab.zoomed === undefined) dividers = l.dividers;
    }
    return { rects, dividers };
  });

  const paneVisible = (p: Pane) => {
    const tab = tabs().find((x) => x.id === p.tab);
    return p.tab === activeTab() && (tab?.zoomed === undefined || tab.zoomed === p.id);
  };
  const paneActive = (p: Pane) => paneVisible(p) && currentTab()?.active === p.id;

  const tabTitle = (tab: Tab) => titles()[tab.active] || t("tab-untitled");

  // Looking at a tab clears its bell marker.
  createEffect(() => {
    const id = activeTab();
    if (rang().has(id)) setRang(new Set([...rang()].filter((x) => x !== id)));
  });

  // The window title follows the active tab.
  createEffect(() => {
    const tab = currentTab();
    if (!tab || !ready()) return;
    const title = titles()[tab.active] ? `${titles()[tab.active]} — otterm` : "otterm";
    document.title = title;
    void getCurrentWindow()
      .setTitle(title)
      .catch(() => {});
  });

  const dragDivider = (d: Divider, e: MouseEvent) => {
    e.preventDefault();
    const tab = currentTab();
    if (!tab) return;
    const box = area.getBoundingClientRect();
    const move = (ev: MouseEvent) => {
      const fx = (ev.clientX - box.left) / box.width;
      const fy = (ev.clientY - box.top) / box.height;
      const ratio = d.dir === "row" ? (fx - d.parent.x) / d.parent.w : (fy - d.parent.y) / d.parent.h;
      updateTab(tab.id, (x) => ({ ...x, root: setRatio(x.root, d.path, ratio) }));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const pct = (n: number) => `${n * 100}%`;
  const newTabHint = platform === "macos" ? "⌘T" : "Ctrl+Shift+T";

  return (
    <div class="app">
      <Show when={bench()}>
        <div class="status">{bench()}</div>
      </Show>
      <div class="tabbar" role="tablist" data-ot="tabbar">
        <For each={tabs()}>
          {(tab) => (
            <div
              class="tab"
              role="tab"
              tabIndex={-1}
              aria-selected={tab.id === activeTab()}
              data-ot="tab"
              onMouseDown={(e) => {
                // Middle click closes, as in browsers.
                if (e.button === 1) {
                  e.preventDefault();
                  void askThenClose(leaves(tab.root), () => closeTab(tab.id));
                } else if (e.button === 0) {
                  setActiveTab(tab.id);
                }
              }}
            >
              {rang().has(tab.id) && <span class="tab-bell" aria-hidden="true" />}
              <span class="tab-title">{tabTitle(tab)}</span>
              <button
                type="button"
                class="tab-close"
                title={t("tab-close")}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => void askThenClose(leaves(tab.root), () => closeTab(tab.id))}
              >
                ×
              </button>
            </div>
          )}
        </For>
        <button
          type="button"
          class="tab-new"
          title={`${t("tab-new")} (${newTabHint})`}
          onClick={() => run({ kind: "newTab" })}
        >
          +
        </button>
      </div>
      <div ref={area} class="panes">
        <For each={panes()}>
          {(p) => {
            const rect = () => geometry().rects.get(p.id);
            return (
              <div
                class="pane"
                classList={{ hidden: !paneVisible(p) }}
                style={{
                  left: pct(rect()?.x ?? 0),
                  top: pct(rect()?.y ?? 0),
                  width: pct(rect()?.w ?? 1),
                  height: pct(rect()?.h ?? 1),
                }}
              >
                <TerminalView
                  hub={hub}
                  config={config}
                  active={() => paneActive(p)}
                  cwd={p.cwd}
                  onTitle={(title) => setTitles({ ...titles(), [p.id]: title })}
                  onCwd={(url) => cwds.set(p.id, url)}
                  onExit={() => closePane(p.id)}
                  onSession={(id) => sessionOf.set(p.id, id)}
                  onBell={() => {
                    if (p.tab !== activeTab()) setRang(new Set([...rang(), p.tab]));
                  }}
                  onActivate={() => {
                    setActiveTab(p.tab);
                    activatePane(p.id);
                  }}
                  appKey={onAppKey}
                  notify={showNotice}
                />
              </div>
            );
          }}
        </For>
        <For each={geometry().dividers}>
          {(d) => (
            <hr
              class="divider"
              aria-orientation={d.dir === "row" ? "vertical" : "horizontal"}
              classList={{ row: d.dir === "row", column: d.dir === "column" }}
              style={{ left: pct(d.rect.x), top: pct(d.rect.y), width: pct(d.rect.w), height: pct(d.rect.h) }}
              onMouseDown={(e) => dragDivider(d, e)}
            />
          )}
        </For>
      </div>
      <Show when={confirm()} keyed>
        {(c) => (
          <div class="app-prompt">
            <PromptBar {...c} />
          </div>
        )}
      </Show>
      {notice() && (
        <div class="notice" role="status">
          {notice()}
        </div>
      )}
    </div>
  );
}
