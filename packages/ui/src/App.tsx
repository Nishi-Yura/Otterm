import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  AssistBar,
  CompletionPopup,
  MultilineEditor,
  Palette,
  type PaletteEntry,
  type PaletteProps,
} from "./assist/AssistUi";
import { wordAt } from "./assist/parse";
import { benchMode, runIpcBench, runStartupBench, runTypingBench, setExposeInternals, startupMark } from "./bench";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { applyThemeCss, loadConfig, onConfigChanged, type UiConfig } from "./config";
import { language, setLanguage, t } from "./i18n";
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
  renamePane,
  resizePane,
  setRatio,
  splitPane,
} from "./layout";
import {
  type BlockPayload,
  type CompletionItem,
  type DialogRequest,
  type ErrorHint,
  type Explanation,
  type HostEnv,
  localized,
  ModHost,
  type SessionSnapshot,
} from "./mods/host";
import { ModDialog, ModsPanel, Panels, PermissionDialog, StatusBar, type Toast, Toasts } from "./mods/ModUi";
import type { ThemeInfo } from "./mods/protocol";
import { PromptBar, type PromptProps } from "./PromptBar";
import { folderName, urlToPath } from "./paths";
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
  /** A name the user gave the tab (double-click); otherwise the title follows the pane. */
  name?: string;
}

interface Pane {
  id: number;
  tab: number;
  /** Where it started (inherited from the pane it was split from). */
  cwd?: string;
  /** Profile it runs (from the new-tab menu). */
  profile?: string;
  /** That profile's name as the menu showed it: the title of last resort ({profile}, decision I10). */
  profileName?: string;
  /** When it was created (ms), to tell a shell that dies at once from one that ran. */
  started?: number;
}

/**
 * A shell's folder as a Windows path, for file operations on the host (docs/03 §9.1, decision J2):
 * `/mnt/c/x` and Git Bash's `/c/x` are `C:\x`; other WSL paths go through `\\wsl.localhost\<distro>`.
 */
export function hostPath(path: string, info: { shell: string; wsl: string | null } | undefined): string | undefined {
  if (!/^\//.test(path) || !/Windows/.test(navigator.userAgent)) return undefined;
  const drive = /^\/(?:mnt\/)?([a-zA-Z])(\/.*)?$/.exec(path);
  if (drive && (info?.wsl || /bash|sh\.exe|zsh|fish/i.test(info?.shell ?? ""))) {
    const letter = (drive[1] as string).toUpperCase();
    // Git Bash says /c/…, WSL says /mnt/c/…; a WSL path like /c/… is not a drive.
    if (info?.wsl ? path.startsWith("/mnt/") : true) return `${letter}:${(drive[2] ?? "/").replaceAll("/", "\\")}`;
  }
  if (info?.wsl) return `\\\\wsl.localhost\\${info.wsl}${path.replaceAll("/", "\\")}`;
  return undefined;
}

/** The program a command line starts: its first word without a path or quotes ("git", "npm"). */
export function commandName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  const word = first.replace(/^["']|["']$/g, "");
  const base = word.split(/[\\/]/).pop() ?? "";
  return base.replace(/\.exe$/i, "");
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
  /** Folder name of each pane, from OSC 7, for tab titles when the shell sets none. */
  const [folders, setFolders] = createSignal<Record<number, string>>({});
  /** The command each pane is running (shell integration), for the title while it runs. */
  const [running, setRunning] = createSignal<Record<number, string>>({});
  /** Session id of each pane, once started. */
  const sessionOf = new Map<number, number>();
  const [confirm, setConfirm] = createSignal<PromptProps>();
  /** Exit code of the last command in each pane (shell integration), for the status bar. */
  const [lastExit, setLastExit] = createSignal<Record<number, number>>({});
  /** Panes whose shell integration has reported a block. */
  const integrated = new Set<number>();
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

  // --- mods (docs/05): the host runs them; the window shows what they register ---------------
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  let nextToast = 1;
  const dismissToast = (id: number) => setToasts(toasts().filter((x) => x.id !== id));
  const [modDialog, setModDialog] = createSignal<{ req: DialogRequest; done: (id: string | null) => void }>();
  /** The panel open in each panel slot, by panel id. */
  const [shownPanel, setShownPanel] = createSignal<Record<string, string | undefined>>({});
  const MODS_PANEL = "otterm.mods";
  /** Each session's shell program and WSL distribution, from Rust (`session_info`). */
  const shellOf = new Map<number, { shell: string; wsl: string | null }>();
  /** Panes whose terminal has echo off now (a password prompt, decision K2). */
  const echoOff = new Set<number>();
  const snapshot = (pane: Pane): SessionSnapshot | undefined => {
    const id = sessionOf.get(pane.id);
    if (id === undefined) return undefined;
    const url = cwds.get(pane.id);
    const cwd = url ? urlToPath(url) : undefined;
    const info = shellOf.get(pane.id);
    return {
      id,
      cwd,
      hostCwd: cwd ? hostPath(cwd, info) : undefined,
      title: titles()[pane.id] ?? "",
      profileId: pane.profile ?? config()?.defaultProfile ?? "",
      shell: info?.shell ?? pane.profile ?? "",
      integrated: integrated.has(pane.id),
      echoOff: echoOff.has(pane.id),
    };
  };
  const activePane = () => {
    const tab = tabs().find((x) => x.id === activeTab());
    return tab ? panes().find((p) => p.id === tab.active) : undefined;
  };
  const themeInfo = (): ThemeInfo => {
    const th = config()?.theme;
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(th?.ui ?? {})) vars[`--ot-${k}`] = v;
    return {
      name: th?.name ?? "",
      appearance: th?.appearance ?? "dark",
      vars,
      terminal: {
        foreground: th?.terminal.foreground ?? "",
        background: th?.terminal.background ?? "",
        ansi: th?.terminal.ansi ?? [],
        bright: th?.terminal.bright ?? [],
      },
    };
  };
  const env: HostEnv = {
    activeSession: () => {
      const p = activePane();
      return p && snapshot(p);
    },
    sessions: () =>
      panes()
        .map(snapshot)
        .filter((s): s is SessionSnapshot => s !== undefined),
    insert: (id, text) => invoke("session_paste", { id, text }),
    write: (id, text) => invoke("session_write", { id, data: text }),
    toast(req) {
      const id = nextToast++;
      setToasts([...toasts(), { ...req, id }]);
      const ms = req.durationMs ?? 5000;
      if (ms > 0) setTimeout(() => dismissToast(id), ms);
    },
    dialog: (req) =>
      new Promise((resolve) => {
        setModDialog({
          req,
          done: (id) => {
            setModDialog(undefined);
            refocus();
            resolve(id);
          },
        });
      }),
    confirm: (title, body) =>
      new Promise((resolve) => {
        const done = (answer: boolean) => {
          setConfirm(undefined);
          refocus();
          resolve(answer);
        };
        setConfirm({
          title,
          body,
          buttons: [
            { label: t("action-yes"), action: () => done(true) },
            { label: t("action-no"), action: () => done(false) },
          ],
          focus: 1,
          cancel: () => done(false),
        });
      }),
    theme: themeInfo,
    locale: () => language(),
    hostSetting(key) {
      const c = config();
      switch (key) {
        case "general.guide_level":
          return 2;
        case "general.language":
          return c?.language;
        case "appearance.theme":
          return c?.theme.name;
        case "font.size":
          return c?.font.size;
        default:
          return undefined;
      }
    },
    runHostCommand(id, args) {
      if (id === "otterm.open") {
        const path = String(args?.path ?? "");
        if (!path) return false;
        const line =
          args?.line === undefined
            ? ""
            : `:${String(args.line)}${args.col === undefined ? "" : `:${String(args.col)}`}`;
        void invoke("path_open", { cwd: null, text: `${path}${line}` }).catch((e) => showNotice(String(e)));
        return true;
      }
      if (id === "otterm.tab.new") {
        newTab(args?.cwd === undefined ? undefined : String(args.cwd));
        return true;
      }
      if (id === "otterm.palette.show") {
        void openPalette();
        return true;
      }
      if (id === "otterm.history.show") {
        void openHistory();
        return true;
      }
      if (id === "otterm.settings.open") {
        void invoke("config_open").catch((e) => showNotice(String(e)));
        return true;
      }
      if (id === "otterm.panel.hide") {
        const target = String(args?.id ?? "");
        const next = { ...shownPanel() };
        for (const slot of Object.keys(next)) if (next[slot] === target) next[slot] = undefined;
        setShownPanel(next);
        return true;
      }
      if (id === "otterm.panel.show") {
        const target = String(args?.id ?? "");
        const panel = host.panels().find((p) => p.id === target);
        if (!panel) return false;
        setShownPanel({ ...shownPanel(), [panel.slot]: panel.id });
        return true;
      }
      if (id === "otterm.mods.show") {
        setShownPanel({ ...shownPanel(), "sidebar.right": MODS_PANEL });
        return true;
      }
      return false;
    },
    developerMode: () => config()?.developerMode ?? false,
  };
  const host = new ModHost(env);
  const insertText = (text: string) => {
    const s = env.activeSession();
    if (s) void env.insert(s.id, text).catch((e) => showNotice(String(e)));
  };

  // --- input assist (docs/03 §8): what the user types, explanations, hints, completion -------
  interface InputState {
    line: string;
    cursor: number;
    active: boolean;
    /** The shell reported the line (method A); otherwise it was read off the screen. */
    exact: boolean;
  }
  const inputs = new Map<number, InputState>();
  const [inputState, setInputState] = createSignal<InputState>({ line: "", cursor: 0, active: false, exact: false });
  const [explanation, setExplanation] = createSignal<Explanation>();
  const [hint, setHint] = createSignal<{ hint: ErrorHint; command: string }>();
  const [completion, setCompletion] = createSignal<{ items: CompletionItem[]; selected: number }>();
  const [palette, setPalette] = createSignal<{
    title: string;
    placeholder: string;
    entries: PaletteEntry[];
    empty: string;
    bang?: boolean;
    prefixes?: PaletteProps["prefixes"];
    chips?: PaletteProps["chips"];
    onChip?: (id: string) => void;
  }>();
  const [multiline, setMultiline] = createSignal<string>();
  let explainTimer: ReturnType<typeof setTimeout> | undefined;
  let explainSeq = 0;
  const shellKindOf = (s: SessionSnapshot | undefined) => {
    const shell =
      (s?.shell ?? "")
        .toLowerCase()
        .replace(/\.exe$/, "")
        .split(/[\\/]/)
        .pop() ?? "";
    return ["bash", "zsh", "fish", "pwsh", "powershell", "cmd"].includes(shell) ? shell : "other";
  };
  /** Re-explain the line after a pause in typing; danger-only mode shows only dangerous lines. */
  const scheduleExplain = (st: InputState) => {
    clearTimeout(explainTimer);
    const mode = config()?.assist.explain ?? "always";
    if (!st.active || st.line.trim() === "" || mode === "off") {
      setExplanation(undefined);
      return;
    }
    const seq = ++explainSeq;
    explainTimer = setTimeout(async () => {
      const s = env.activeSession();
      const parsed = host.parse(st.line, s?.cwd ?? "", shellKindOf(s));
      const x = await host.explain(parsed).catch(() => undefined);
      if (seq !== explainSeq) return;
      setExplanation(x && (mode === "always" || x.danger) ? x : undefined);
    }, 80);
  };
  const onPaneInput = (pane: Pane, st: InputState) => {
    // Nothing typed at a password prompt reaches the assist or the mods (decision K2).
    if (echoOff.has(pane.id)) return;
    inputs.set(pane.id, st);
    if (currentTab()?.active !== pane.id) return;
    setInputState(st);
    const s = snapshot(pane);
    if (s) host.emit("input-changed", { sessionId: String(s.id), line: st.line, cursor: st.cursor, exact: st.exact });
    scheduleExplain(st);
    if (completion()) void refreshCompletion(st);
    if (!st.active) setCompletion(undefined);
  };
  const onPaneEcho = (pane: Pane, off: boolean) => {
    if (off) echoOff.add(pane.id);
    else echoOff.delete(pane.id);
    if (off && currentTab()?.active === pane.id) {
      clearTimeout(explainTimer);
      setExplanation(undefined);
      setCompletion(undefined);
    }
  };
  /** Executables on PATH, fetched once per session of the window (docs/03 §8.2 source 2). */
  let pathCommands: Promise<string[]> | undefined;
  /** otterm's own completion sources: command names (dictionary and PATH) and the history. */
  const builtinCompletions = async (st: InputState): Promise<CompletionItem[]> => {
    const { word, start } = wordAt(st.line, st.cursor);
    const lower = word.toLowerCase();
    const out: CompletionItem[] = [];
    // The first word: commands. Only from two letters on, so the list stays short and useful.
    if (st.line.slice(0, start).trim() === "" && word.length >= 2) {
      pathCommands ??= invoke<string[]>("path_commands").catch(() => []);
      const names = new Set([...host.dictionaryNames(), ...(await pathCommands)]);
      for (const n of names) {
        if (n.toLowerCase().startsWith(lower) && n.toLowerCase() !== lower) {
          const entry = host.lookup(n);
          const summary = entry?.summary;
          out.push({
            label: n,
            kind: "command",
            detail: summary ? localized(summary, language()) : undefined,
            sortText: `0${entry ? "0" : "1"}${n}`,
          });
        }
        if (out.length >= 40) break;
      }
    }
    // The history: earlier lines that start with what is typed (source 4).
    if (st.line.trim().length >= 2) {
      const runs = await invoke<{ command: string; exit: number }[]>("history_query", {
        query: { text: st.line.trim(), limit: 40 },
      }).catch(() => []);
      const seen = new Set<string>();
      for (const r of runs) {
        if (!r.command.startsWith(st.line.trim()) || r.command === st.line || seen.has(r.command)) continue;
        seen.add(r.command);
        out.push({ label: r.command, kind: "history", replaceLine: true, sortText: `9${seen.size}` });
        if (seen.size >= 8) break;
      }
    }
    return out;
  };
  /** Ask the providers for items at the cursor (docs/03 §8.2). */
  const refreshCompletion = async (st: InputState) => {
    const s = env.activeSession();
    if (!s || !st.active || s.echoOff) return setCompletion(undefined);
    const parsed = host.parse(st.line, s.cwd ?? "", shellKindOf(s));
    const [fromMods, mine] = await Promise.all([
      host.complete({ sessionId: String(s.id), line: st.line, cursor: st.cursor, exact: st.exact }, parsed),
      builtinCompletions(st),
    ]);
    if (inputState() !== st && inputState().line !== st.line) return;
    const seen = new Set<string>();
    const items = [...fromMods, ...mine].filter((it) => {
      const key = `${it.replaceLine ? "line" : "word"}:${it.insertText ?? it.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    items.sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label));
    setCompletion(items.length > 0 ? { items: items.slice(0, 50), selected: 0 } : undefined);
  };
  /** Put a completion in place of the word under the cursor: delete it, then paste the text. */
  const acceptCompletion = (item: CompletionItem) => {
    const s = env.activeSession();
    const st = inputState();
    setCompletion(undefined);
    if (!s) return;
    if (item.replaceLine) {
      void invoke("session_replace_line", { id: s.id, text: item.insertText ?? item.label }).catch((e) =>
        showNotice(String(e)),
      );
      return;
    }
    const { word } = wordAt(st.line, st.cursor);
    const text = item.insertText ?? item.label;
    const erase = "\u007f".repeat([...word].length);
    void invoke("session_write", { id: s.id, data: erase })
      .then(() => env.insert(s.id, text))
      .catch((e) => showNotice(String(e)));
  };
  /** Keys the assist UI takes before the terminal (completion navigation, Tab at level 3). */
  const assistKey = (e: KeyboardEvent, st: InputState): boolean => {
    const c = completion();
    if (!c) return false;
    const tabAccepts = (config()?.assist.completionKey ?? "ctrl-space") === "tab";
    if (e.key === "Escape") {
      setCompletion(undefined);
      return true;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const n = c.items.length;
      setCompletion({ ...c, selected: (c.selected + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
      return true;
    }
    if (e.key === "Enter" || (e.key === "Tab" && tabAccepts)) {
      const item = c.items[c.selected];
      if (item) acceptCompletion(item);
      return true;
    }
    if (e.key === "Tab") setCompletion(undefined);
    if (!st.active) setCompletion(undefined);
    return false;
  };
  /** Enter at the prompt: the mods' verdict (danger-guard), then the line runs or not. */
  const beforeExecute = async (line: string): Promise<boolean> => {
    setCompletion(undefined);
    const s = env.activeSession();
    if (!s || !(config()?.assist.dangerGuard ?? true)) return true;
    const verdict = await host.beforeExecute(s, line).catch(() => ({ action: "run" as const }));
    const replace = async (command: string) => {
      await invoke("session_replace_line", { id: s.id, text: command }).catch((e) => showNotice(String(e)));
      // The editor needs a moment to take the paste before Enter arrives.
      await new Promise((r) => setTimeout(r, 60));
    };
    switch (verdict.action) {
      case "run":
        return true;
      case "cancel":
        return false;
      case "replace":
        await replace(verdict.command);
        return true;
      case "confirm":
        return new Promise<boolean>((resolve) => {
          const done = (answer: () => Promise<boolean> | boolean) => {
            setConfirm(undefined);
            refocus();
            void Promise.resolve(answer()).then(resolve);
          };
          setConfirm({
            title: verdict.title || t("danger-title-confirm"),
            body: verdict.body,
            preview: line,
            buttons: [
              { label: t("danger-run"), action: () => done(() => true) },
              ...verdict.alternatives.map((a) => ({
                label: a.label || t("danger-alternative-label", { command: a.command }),
                action: () => done(() => replace(a.command).then(() => true)),
              })),
              { label: t("danger-cancel"), action: () => done(() => false) },
            ],
            // Enter alone picks the alternative when there is one, else cancels (never "run").
            focus: verdict.alternatives.length > 0 ? 1 : verdict.alternatives.length + 1,
            cancel: () => done(() => false),
          });
        });
    }
  };
  /** A block failed: the error-hint providers get a look (docs/03 §8.4). */
  const onBlockFailed = async (pane: Pane, line: number, exit: number, ms: number) => {
    if (exit === 0) {
      // A command the dictionary does not know ran once: learn its --help for next time (decision B9).
      const s = snapshot(pane);
      const b = s
        ? await invoke<{ command: string | null } | null>("session_block", { id: s.id, line }).catch(() => null)
        : null;
      const name = b?.command ? host.parse(b.command).segments[0]?.name : undefined;
      if (name && !host.lookup(name)) void invoke("help_learn", { name }).catch(() => {});
      return;
    }
    if (!(config()?.assist.errorHint ?? true) || exit === 130) return;
    const s = snapshot(pane);
    if (!s) return;
    const b = await invoke<{ command: string | null; output: string } | null>("session_block", {
      id: s.id,
      line,
    }).catch(() => null);
    if (!b?.command) return;
    const block: BlockPayload = {
      id: `${s.id}:${line}`,
      sessionId: String(s.id),
      command: b.command,
      cwd: s.cwd ?? "",
      startedAt: Date.now() - ms,
      endedAt: Date.now(),
      durationMs: ms,
      exitCode: exit,
      output: b.output.split("\n").slice(-2000).join("\n"),
    };
    const h = await host.errorHint(block).catch(() => undefined);
    if (h && currentTab()?.active === pane.id) setHint({ hint: h, command: b.command });
  };
  /** The palette (docs/03 §7): otterm's own actions, profiles, and every mod command. */
  const openPalette = async () => {
    const list = await invoke<{ id: string; name: string; detected: boolean }[]>("profiles_list").catch(() => []);
    const mine: PaletteEntry[] = [
      { id: "tab.new", title: t("palette-cmd-new-tab"), run: () => run({ kind: "newTab" }) },
      { id: "tab.close", title: t("palette-cmd-close-tab"), run: () => run({ kind: "closeTab" }) },
      {
        id: "pane.split.vertical",
        title: t("palette-cmd-split-vertical"),
        run: () => run({ kind: "split", dir: "row" }),
      },
      {
        id: "pane.split.horizontal",
        title: t("palette-cmd-split-horizontal"),
        run: () => run({ kind: "split", dir: "column" }),
      },
      { id: "settings", title: t("palette-cmd-settings"), run: () => run({ kind: "settings" }) },
      { id: "mods", title: t("palette-cmd-mods"), run: () => env.runHostCommand("otterm.mods.show", undefined) },
      { id: "history", title: t("palette-cmd-history"), run: () => run({ kind: "history" }) },
      ...[0, 1, 2, 3].map((level) => ({
        id: `guide.${level}`,
        title: t("palette-cmd-guide", { level }),
        run: () =>
          void invoke("config_set", { key: "general.guide_level", value: level }).catch((e) => showNotice(String(e))),
      })),
      ...list.map((p) => {
        const key = `profile-${p.id}`;
        const label = p.detected && t(key) !== key ? t(key) : p.name;
        return {
          id: `profile.${p.id}`,
          title: t("palette-cmd-profile", { name: label }),
          run: () => newTab(undefined, p.id, label),
        };
      }),
    ];
    const mods: PaletteEntry[] = host
      .commandList()
      .filter((c) => !c.hidden)
      .map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        hint: c.mod,
        run: () => void host.runCommand(c.id),
      }));
    const editors = await invoke<{ id: string; name: string }[]>("editors_detect").catch(() => []);
    const editorEntries: PaletteEntry[] = editors.map((ed) => ({
      id: `editor.${ed.id}`,
      title: t("palette-cmd-editor", { name: ed.name }),
      run: () => void invoke("config_set", { key: "open.editor", value: ed.id }).catch((e) => showNotice(String(e))),
    }));
    setPalette(undefined);
    setPalette({
      title: t("palette-title"),
      placeholder: t("palette-placeholder"),
      entries: [...mine, ...editorEntries, ...mods],
      empty: t("palette-empty"),
      bang: true,
      prefixes: palettePrefixes(),
    });
  };
  /** docs/03 §7: `:` line, `?` help, `@` file under the folder, `#` block. */
  const palettePrefixes = () => {
    const s = env.activeSession();
    return {
      ":": {
        hint: t("palette-prefix-line"),
        source: (rest: string): PaletteEntry[] => {
          const n = Number.parseInt(rest, 10);
          if (!s || !Number.isFinite(n) || n < 1) return [];
          return [
            {
              id: `line.${n}`,
              title: t("palette-goto-line", { line: n }),
              run: () => void invoke("session_reveal_row", { id: s.id, n }).catch(() => {}),
            },
          ];
        },
      },
      "?": {
        hint: t("palette-prefix-help"),
        source: (rest: string): PaletteEntry[] => {
          const q = rest.toLowerCase();
          return host
            .dictionaryEntries()
            .filter(
              (e) =>
                !q || e.name.toLowerCase().includes(q) || localized(e.summary, language()).toLowerCase().includes(q),
            )
            .slice(0, 100)
            .map((e) => ({
              id: `help.${e.name}`,
              title: e.name,
              description: localized(e.summary, language()),
              run: () => insertText(`${e.name} `),
            }));
        },
      },
      "@": {
        hint: t("palette-prefix-file"),
        source: async (rest: string): Promise<PaletteEntry[]> => {
          const cwd = s?.hostCwd ?? s?.cwd;
          if (!cwd) return [];
          const files = await invoke<string[]>("files_find", { cwd, query: rest, limit: 100 }).catch(() => []);
          return files.map((f) => ({
            id: `file.${f}`,
            title: f,
            run: () => void invoke("path_open", { cwd, text: f }).catch((e) => showNotice(String(e))),
          }));
        },
      },
      "#": {
        hint: t("palette-prefix-block"),
        source: async (rest: string): Promise<PaletteEntry[]> => {
          if (!s) return [];
          const q = rest.toLowerCase();
          const list = await invoke<{ line: number; command: string | null; running: boolean; exit: number | null }[]>(
            "session_blocks",
            { id: s.id },
          ).catch(() => []);
          return list
            .filter((b) => b.command && (!q || b.command.toLowerCase().includes(q)))
            .reverse()
            .slice(0, 200)
            .map((b) => ({
              id: `block.${b.line}`,
              title: b.command ?? "",
              hint: b.running ? "…" : b.exit === null ? "" : b.exit === 0 ? "✓" : `✗ ${b.exit}`,
              run: () => void invoke("session_reveal", { id: s.id, line: b.line }).catch(() => {}),
            }));
        },
      },
    };
  };
  /** The history UI's filters (docs/03 §8.5): this folder, successful runs, today, shells' history. */
  const [historyFilters, setHistoryFilters] = createSignal({ cwd: false, ok: false, today: false, shell: true });
  /** otterm's history UI (docs/03 §8.5): newest first; picking a row types it at the prompt. */
  const openHistory = async () => {
    const f = historyFilters();
    const s = env.activeSession();
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const runs = await invoke<
      { id: number; started: number; ms: number; exit: number; command: string; cwd: string }[]
    >("history_query", {
      query: {
        text: "",
        limit: 500,
        cwd: f.cwd ? (s?.cwd ?? null) : null,
        successOnly: f.ok,
        since: f.today ? midnight.getTime() : null,
      },
    }).catch(() => []);
    const entries: PaletteEntry[] = runs.map((r) => ({
      id: String(r.id),
      title: r.command,
      description: `${folderName(r.cwd.replaceAll("\\", "/"))} · ${new Date(r.started).toLocaleString()} · ${r.exit === 0 ? t("history-exit-ok") : t("history-exit-failed", { code: r.exit })}`,
      run: () => insertText(r.command),
    }));
    // The shells' own history files, below otterm's records; they know no folder or exit code.
    if (f.shell && !f.cwd && !f.ok) {
      const mine = new Set(runs.map((r) => r.command));
      const shell = await invoke<{ command: string; shell: string; at: number | null }[]>("shell_history", {
        limit: 500,
      }).catch(() => []);
      for (const e of shell) {
        if (mine.has(e.command)) continue;
        if (f.today && (e.at === null || e.at < midnight.getTime())) continue;
        mine.add(e.command);
        entries.push({
          id: `shell.${entries.length}`,
          title: e.command,
          description: t("history-from-shell", { shell: e.shell }),
          run: () => insertText(e.command),
        });
      }
    }
    setPalette({
      title: t("history-title"),
      placeholder: t("history-placeholder"),
      entries,
      empty: t("history-empty"),
      chips: [
        { id: "cwd", label: t("history-filter-cwd"), on: f.cwd },
        { id: "ok", label: t("history-filter-ok"), on: f.ok },
        { id: "today", label: t("history-filter-today"), on: f.today },
        { id: "shell", label: t("history-filter-shell"), on: f.shell },
      ],
      onChip: (id: string) => {
        const k = id as keyof ReturnType<typeof historyFilters>;
        setHistoryFilters({ ...historyFilters(), [k]: !historyFilters()[k] });
        void openHistory();
      },
    });
  };
  const closePalette = () => {
    setPalette(undefined);
    refocus();
  };
  const cycleGuide = () => {
    const next = ((config()?.guideLevel ?? 2) + 1) % 4;
    void invoke("config_set", { key: "general.guide_level", value: next }).catch((e) => showNotice(String(e)));
  };
  const copyText = (text: string) => void invoke("clipboard_write", { text }).catch(() => {});
  /** Mods' right-click items for the terminal (docs/05 §5.2). */
  const modMenu = (): MenuItem[] =>
    host.menuItems("context.terminal").map((m) => ({
      label: m.label,
      disabled: !m.enabled,
      action: () =>
        void host.invoke(m.mod, m.fn, [{ sessionId: String(env.activeSession()?.id ?? "") }]).catch(() => {}),
    }));
  const emitFocus = () => {
    const s = env.activeSession();
    if (s) host.emit("focus-changed", { sessionId: String(s.id) });
  };

  /** The configuration as loaded; `config()` is it with the theme for the OS mode filled in. */
  let loaded: UiConfig | undefined;
  const lightMode = window.matchMedia("(prefers-color-scheme: light)");

  /** Pick `theme` or `themeLight` for the OS appearance (appearance.follow_system). */
  const applyTheme = () => {
    if (!loaded) return;
    const light = loaded.followSystem && lightMode.matches && loaded.themeLight;
    const c = light ? { ...loaded, theme: loaded.themeLight as UiConfig["theme"] } : loaded;
    applyThemeCss(c.theme);
    setConfig(c);
    host.themeChanged(themeInfo());
    // Programs ask for these (OSC 10/11) to pick light or dark colors of their own.
    const { foreground, background, cursor } = c.theme.terminal;
    void invoke("terminal_colors", { foreground, background, cursor }).catch(() => {});
  };
  lightMode.addEventListener("change", applyTheme);
  onCleanup(() => lightMode.removeEventListener("change", applyTheme));

  const applyConfig = (c: UiConfig) => {
    setLanguage(c.language);
    loaded = c;
    applyTheme();
    keymap = new Keymap(c.keybindings);
    const warnings = [
      ...c.warnings.map((w) => (w.key ? `${w.key}: ${w.message}` : w.message)),
      ...keymap.problems.map((p) => `keybindings.bindings.${p}`),
    ];
    if (warnings.length > 0) showNotice(t("config-ignored", { keys: warnings.join("; ") }));
    // Enabled lists and mod settings live in config.toml too (docs/06 §2).
    if (ready()) {
      if (previous && previous.language !== c.language) host.restartAll();
      else void host.refresh();
      if (previous && previous.guideLevel !== c.guideLevel) host.setGuideLevel(c.guideLevel);
      const watched: [string, unknown, unknown][] = [
        ["general.guide_level", previous?.guideLevel, c.guideLevel],
        ["general.language", previous?.language, c.language],
        ["appearance.theme", previous?.theme.name, c.theme.name],
        ["appearance.follow_system", previous?.followSystem, c.followSystem],
        ["font.size", previous?.font.size, c.font.size],
      ];
      for (const [key, before, after] of watched) if (before !== after) host.hostSettingChanged(key, after);
    }
    previous = c;
  };
  /** The configuration before the last change, to tell mods what moved. */
  let previous: UiConfig | undefined;

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
    // Mods load after the first tab is up (docs/09 §3.5).
    host.start().catch((e) => showNotice(String(e)));
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

  // Files dropped on a pane: their quoted paths go to its shell (FR-FILE-03).
  const [dropTarget, setDropTarget] = createSignal<number>();
  const paneAt = (x: number, y: number) => {
    // The position is in physical pixels.
    const el = document.elementFromPoint(x / devicePixelRatio, y / devicePixelRatio)?.closest<HTMLElement>(".pane");
    const id = Number(el?.dataset.pane);
    return panes().find((p) => p.id === id);
  };
  let unlistenDrop: (() => void) | undefined;
  void getCurrentWebview()
    .onDragDropEvent((event) => {
      const e = event.payload;
      if (e.type === "leave") return setDropTarget(undefined);
      const pane = paneAt(e.position.x, e.position.y);
      if (e.type !== "drop") return setDropTarget(pane?.id);
      setDropTarget(undefined);
      const session = pane && sessionOf.get(pane.id);
      if (!pane || session === undefined || e.paths.length === 0) return;
      setActiveTab(pane.tab);
      activatePane(pane.id);
      void invoke("session_drop_paths", { id: session, paths: e.paths }).catch((err) => showNotice(String(err)));
    })
    .then((f) => {
      unlistenDrop = f;
    });

  onCleanup(() => {
    unlistenConfig?.();
    unlistenClose?.();
    unlistenDrop?.();
    clearTimeout(noticeTimer);
    ws?.close();
    host.dispose();
  });

  // Mods hear when the keyboard moves to another session.
  createEffect(() => {
    activeTab();
    currentTab()?.active;
    emitFocus();
  });

  const currentTab = () => tabs().find((x) => x.id === activeTab());
  const updateTab = (id: number, f: (tab: Tab) => Tab) => setTabs(tabs().map((x) => (x.id === id ? f(x) : x)));

  // Tabs and panes change together (batch), so a new pane is laid out and visible by the time its
  // terminal mounts and measures itself.
  const newTab = (cwd?: string, profile?: string, profileName?: string) => {
    const tabId = nextId++;
    const paneId = nextId++;
    const at = tabs().findIndex((x) => x.id === activeTab());
    const next = [...tabs()];
    next.splice(at + 1, 0, { id: tabId, root: leaf(paneId), active: paneId });
    batch(() => {
      setTabs(next);
      setActiveTab(tabId);
      setPanes([...panes(), { id: paneId, tab: tabId, cwd, profile, profileName, started: Date.now() }]);
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
      setPanes([...panes(), { id: paneId, tab: tab.id, cwd: cwds.get(tab.active), started: Date.now() }]);
    });
  };

  /** The shell in a pane exited: terminal.close_behavior decides what happens to the pane. */
  const paneExited = (paneId: number) => {
    const behavior = config()?.closeBehavior ?? "close";
    if (behavior === "keep") return; // The pane shows the exit message until it is closed.
    if (behavior === "close") return closePane(paneId);
    // restart: a new pane (and shell) takes the old one's place and folder. A shell that exits
    // within two seconds would restart forever; it stays as "keep" with its message instead.
    const old = panes().find((p) => p.id === paneId);
    if (old && Date.now() - (old.started ?? 0) < 2000) return;
    const tab = tabs().find((x) => leaves(x.root).includes(paneId));
    if (!old || !tab) return;
    const fresh = nextId++;
    batch(() => {
      updateTab(tab.id, (x) => ({
        ...x,
        root: renamePane(x.root, paneId, fresh),
        active: x.active === paneId ? fresh : x.active,
        zoomed: x.zoomed === paneId ? fresh : x.zoomed,
      }));
      setPanes(
        panes().map((p) =>
          p.id === paneId ? { ...old, id: fresh, cwd: cwds.get(paneId) ?? old.cwd, started: Date.now() } : p,
        ),
      );
      // The tab keeps its title until the new shell sets one.
      setTitles({ ...titles(), [fresh]: titles()[paneId] ?? "" });
      setFolders({ ...folders(), [fresh]: folders()[paneId] ?? "" });
    });
    cwds.delete(paneId);
    sessionOf.delete(paneId);
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
    const done = () => {
      setConfirm(undefined);
      refocus();
    };
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
    if (!hit) {
      // A mod's suggested key, when the user bound nothing to the chord (docs/06 §5).
      const command = host.matchKey(e, altScreen);
      if (!command) return false;
      void host.runCommand(command);
      return true;
    }
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
      case "newTabMenu":
        void openProfileMenu();
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
      case "fullscreen": {
        const w = getCurrentWindow();
        void w.isFullscreen().then((on) => w.setFullscreen(!on));
        break;
      }
      case "settings":
        void invoke("config_open").catch((e) => showNotice(String(e)));
        break;
      case "blockJump": {
        const id = tab ? sessionOf.get(tab.active) : undefined;
        if (id === undefined) return false;
        void invoke("session_block_jump", { id, dir: action.dir }).catch(() => {});
        break;
      }
      case "blockFold": {
        const id = tab ? sessionOf.get(tab.active) : undefined;
        if (id === undefined) return false;
        void invoke("session_block_fold", { id, line: null, fold: null }).catch(() => {});
        break;
      }
      case "palette":
        void openPalette();
        break;
      case "history":
        // Ctrl+R stays the shell's at guide level 0 (decision B5).
        if ((config()?.assist.historyKey ?? "otterm") !== "otterm") return false;
        void openHistory();
        break;
      case "completion": {
        const st = inputState();
        if (!st.active || !(config()?.assist.completion ?? true)) return false;
        if (completion()) {
          const c = completion();
          if (c) setCompletion({ ...c, selected: (c.selected + 1) % c.items.length });
        } else void refreshCompletion(st);
        break;
      }
      case "multiline": {
        const st = inputState();
        if (!st.active || multiline() !== undefined) return false;
        setMultiline(st.line);
        break;
      }
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

  /**
   * Decision I10: the program's title (OSC 0/2) if it set one, else "command · folder" while a
   * command runs, else the folder name.
   */
  const paneTitle = (pane: number) => {
    if (titles()[pane]) return titles()[pane] as string;
    const folder = folders()[pane] || panes().find((p) => p.id === pane)?.profileName || "";
    const command = commandName(running()[pane] ?? "");
    return command ? (folder ? `${command} · ${folder}` : command) : folder;
  };
  /** The color of the profile the tab's active pane runs, if it has one (`profiles.color`). */
  const tabAccent = (tab: Tab) => {
    const c = config();
    const pane = panes().find((p) => p.id === tab.active);
    const id = pane?.profile ?? c?.defaultProfile ?? "";
    // Own keys only: a profile named "constructor" must not pick up Object's.
    return c && Object.hasOwn(c.profileColors, id) ? c.profileColors[id] : undefined;
  };
  const tabTitle = (tab: Tab) => tab.name || paneTitle(tab.active) || t("tab-untitled");

  /** The tab whose name is being edited. */
  const [renaming, setRenaming] = createSignal<number>();
  const finishRename = (tabId: number, value: string | undefined) => {
    if (renaming() !== tabId) return;
    setRenaming(undefined);
    // An empty name goes back to the automatic title.
    if (value !== undefined) updateTab(tabId, (x) => ({ ...x, name: value.trim() || undefined }));
    focusActive();
  };
  const focusActive = () =>
    setTimeout(() => (document.querySelector(".terminal.active .input") as HTMLElement | null)?.focus());

  /** Drag a tab sideways to reorder (docs/03 §3.2). Starts after a few pixels, so a click selects. */
  const dragTab = (tabId: number, e: MouseEvent) => {
    // Tabs run down the side when the bar is on the left.
    const vertical = config()?.tabbar === "left";
    const along = (ev: MouseEvent) => (vertical ? ev.clientY : ev.clientX);
    const start = along(e);
    let dragging = false;
    const move = (ev: MouseEvent) => {
      // Released outside the window: the mouseup never came.
      if (ev.buttons === 0) return up();
      if (!dragging && Math.abs(along(ev) - start) < 6) return;
      dragging = true;
      const els = [...document.querySelectorAll<HTMLElement>(".tabbar .tab")];
      const list = tabs();
      const from = list.findIndex((x) => x.id === tabId);
      // The slot whose middle the pointer has passed.
      let to = els.findIndex((el) => {
        const r = el.getBoundingClientRect();
        return vertical ? ev.clientY < r.top + r.height / 2 : ev.clientX < r.left + r.width / 2;
      });
      if (to === -1) to = list.length - 1;
      else if (to > from) to -= 1;
      if (to === from || from === -1) return;
      const next = [...list];
      const [moved] = next.splice(from, 1);
      if (moved) next.splice(to, 0, moved);
      setTabs(next);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // Looking at a tab clears its bell marker.
  createEffect(() => {
    const id = activeTab();
    if (rang().has(id)) setRang(new Set([...rang()].filter((x) => x !== id)));
  });

  // The window title follows the active tab.
  createEffect(() => {
    const tab = currentTab();
    if (!tab || !ready()) return;
    const title = paneTitle(tab.active) ? `${paneTitle(tab.active)} — otterm` : "otterm";
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

  /**
   * Give the keyboard back to the active pane after a window-level menu or prompt closes; without
   * this, Escape left the focus on nothing and keys went nowhere until a click. After a tick, so a
   * tab the menu just opened is the active one.
   */
  const refocus = () => setTimeout(() => document.querySelector<HTMLElement>(".terminal.active .input")?.focus());

  /** The new-tab menu (Ctrl+Shift+N, or the ∨ next to +): one entry per profile. */
  const [profileMenu, setProfileMenu] = createSignal<{ x: number; y: number; items: MenuItem[] }>();
  let newButton!: HTMLButtonElement;
  const openProfileMenu = async () => {
    const list = await invoke<{ id: string; name: string; detected: boolean }[]>("profiles_list").catch(() => []);
    const r = newButton.getBoundingClientRect();
    const cwd = currentTab() ? cwds.get(currentTab()?.active ?? 0) : undefined;
    setProfileMenu({
      x: r.left,
      y: r.bottom,
      items: list.map((p) => {
        // Shells otterm found itself have translated names; the user's own profiles keep theirs.
        const key = `profile-${p.id}`;
        const label = p.detected && t(key) !== key ? t(key) : p.name;
        return { label, action: () => newTab(cwd, p.id, label) };
      }),
    });
  };

  const pct = (n: number) => `${n * 100}%`;
  const newTabHint = platform === "macos" ? "⌘T" : "Ctrl+Shift+T";

  return (
    <div
      class="app"
      classList={{
        "tabbar-bottom": config()?.tabbar === "bottom",
        "tabbar-left": config()?.tabbar === "left",
        "tabbar-hidden": config()?.tabbar === "hidden-when-single" && tabs().length === 1,
      }}
    >
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
              style={{ "--tab-accent": tabAccent(tab) }}
              data-ot="tab"
              onMouseDown={(e) => {
                // Middle click closes, as in browsers.
                if (e.button === 1) {
                  e.preventDefault();
                  void askThenClose(leaves(tab.root), () => closeTab(tab.id));
                } else if (e.button === 0) {
                  setActiveTab(tab.id);
                  if (renaming() !== tab.id) dragTab(tab.id, e);
                }
              }}
              onDblClick={() => setRenaming(tab.id)}
            >
              {rang().has(tab.id) && <span class="tab-bell" aria-hidden="true" />}
              <Show when={renaming() === tab.id} fallback={<span class="tab-title">{tabTitle(tab)}</span>}>
                <input
                  class="tab-rename"
                  aria-label={t("tab-rename")}
                  value={tab.name ?? tabTitle(tab)}
                  ref={(el) => setTimeout(() => el.select())}
                  onMouseDown={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") finishRename(tab.id, e.currentTarget.value);
                    if (e.key === "Escape") finishRename(tab.id, undefined);
                  }}
                  onBlur={(e) => finishRename(tab.id, e.currentTarget.value)}
                />
              </Show>
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
        <button
          ref={newButton}
          type="button"
          class="tab-new tab-profiles"
          title={t("tab-new-profile")}
          onClick={() => void openProfileMenu()}
        >
          ⌄
        </button>
      </div>
      <div class="body">
        <Panels
          host={host}
          slot="sidebar.left"
          shown={shownPanel()["sidebar.left"]}
          onShow={(id) => setShownPanel({ ...shownPanel(), "sidebar.left": id })}
          insert={insertText}
          copy={copyText}
        />
        <div class="body-center">
          <div ref={area} class="panes">
            <For each={panes()}>
              {(p) => {
                const rect = () => geometry().rects.get(p.id);
                return (
                  <div
                    class="pane"
                    classList={{ hidden: !paneVisible(p), "drop-target": dropTarget() === p.id }}
                    data-pane={p.id}
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
                      profile={p.profile}
                      onTitle={(title) => {
                        setTitles({ ...titles(), [p.id]: title });
                        const s = snapshot(p);
                        if (s) host.emit("title-changed", { sessionId: String(s.id), title });
                      }}
                      onRunning={(command) => setRunning({ ...running(), [p.id]: command })}
                      onInput={(st) => onPaneInput(p, st)}
                      onEchoOff={(off) => onPaneEcho(p, off)}
                      beforeExecute={beforeExecute}
                      assistKey={assistKey}
                      onBlock={(e) => {
                        integrated.add(p.id);
                        if (e.kind === "start" && currentTab()?.active === p.id) setHint(undefined);
                        if (e.kind === "end" && e.exit !== undefined) {
                          setLastExit({ ...lastExit(), [p.id]: e.exit });
                          void onBlockFailed(p, e.line, e.exit, e.ms ?? 0);
                        }
                        const s = snapshot(p);
                        if (s)
                          void host.emitBlock(
                            e.kind === "start" ? "block-start" : "block-end",
                            s,
                            e.line,
                            e.exit,
                            e.ms,
                          );
                      }}
                      extraMenu={modMenu}
                      onCwd={(url) => {
                        cwds.set(p.id, url);
                        setFolders({ ...folders(), [p.id]: folderName(url) });
                        const s = snapshot(p);
                        if (s) host.emit("cwd-changed", { sessionId: String(s.id), cwd: urlToPath(url) });
                      }}
                      onExit={(code) => {
                        const s = snapshot(p);
                        if (s) host.emit("session-closed", { sessionId: String(s.id), exitCode: code ?? undefined });
                        paneExited(p.id);
                      }}
                      onSession={(id) => {
                        sessionOf.set(p.id, id);
                        void invoke<{ shell: string; wsl: string | null }>("session_info", { id })
                          .then((info) => shellOf.set(p.id, info))
                          .catch(() => {});
                        const s = snapshot(p);
                        if (s) host.emit("session-created", s);
                        if (currentTab()?.active === p.id) emitFocus();
                      }}
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
            <Show when={completion()} keyed>
              {(c) => (
                <CompletionPopup
                  items={c.items}
                  selected={c.selected}
                  x={16}
                  y={8}
                  onPick={acceptCompletion}
                  onHover={(i) => setCompletion({ ...c, selected: i })}
                />
              )}
            </Show>
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
          <Show when={multiline() !== undefined}>
            <MultilineEditor
              initial={multiline() ?? ""}
              onClose={() => {
                setMultiline(undefined);
                refocus();
              }}
              onSend={(text) => {
                setMultiline(undefined);
                const s = env.activeSession();
                if (s) {
                  void invoke("session_replace_line", { id: s.id, text })
                    .then(() => new Promise((r) => setTimeout(r, 60)))
                    .then(() =>
                      invoke("session_key", {
                        id: s.id,
                        input: { key: "Enter", ctrl: false, alt: false, shift: false },
                      }),
                    )
                    .catch((e) => showNotice(String(e)));
                }
                refocus();
              }}
            />
          </Show>
          <AssistBar
            explanation={explanation()}
            hint={hint()?.hint}
            hintCommand={hint()?.command}
            onInsert={insertText}
            onDismissHint={() => setHint(undefined)}
            onHintAction={(h, i) => {
              const a = h.actions?.[i];
              if (a?.fn !== undefined) void host.invoke(h.mod, a.fn).catch(() => {});
            }}
          />
          <Panels
            host={host}
            slot="panel.bottom"
            shown={shownPanel()["panel.bottom"]}
            onShow={(id) => setShownPanel({ ...shownPanel(), "panel.bottom": id })}
            insert={insertText}
            copy={copyText}
          />
          <Show when={config()?.statusbar ?? true}>
            <StatusBar
              host={host}
              folder={(() => {
                const p = activePane();
                return p ? folders()[p.id] || "" : "";
              })()}
              lastExit={(() => {
                const p = activePane();
                return p ? lastExit()[p.id] : undefined;
              })()}
              insert={insertText}
              copy={copyText}
              guideLevel={config()?.guideLevel ?? 2}
              onGuideClick={cycleGuide}
              onModsClick={() => {
                const open = shownPanel()["sidebar.right"] === MODS_PANEL;
                setShownPanel({ ...shownPanel(), "sidebar.right": open ? undefined : MODS_PANEL });
              }}
            />
          </Show>
        </div>
        <Panels
          host={host}
          slot="sidebar.right"
          shown={shownPanel()["sidebar.right"]}
          onShow={(id) => setShownPanel({ ...shownPanel(), "sidebar.right": id })}
          insert={insertText}
          copy={copyText}
          builtin={[
            {
              id: MODS_PANEL,
              title: t("mods-title"),
              render: () => (
                <ModsPanel
                  host={host}
                  developer={config()?.developerMode ?? false}
                  modsDir={config()?.modsDir ?? undefined}
                />
              ),
            },
          ]}
        />
      </div>
      <Show when={palette()}>
        {(p) => (
          <Palette
            title={p().title}
            placeholder={p().placeholder}
            entries={p().entries}
            emptyText={p().empty}
            onClose={closePalette}
            onBang={p().bang ? (cmd) => insertText(cmd) : undefined}
            prefixes={p().prefixes}
            chips={p().chips}
            onChip={p().onChip}
          />
        )}
      </Show>
      <Toasts toasts={toasts()} dismiss={dismissToast} />
      <Show when={host.pendingGrants()[0]} keyed>
        {(entry) => (
          <PermissionDialog
            entry={entry}
            onAllow={() => void host.grant(entry.id).catch((e) => showNotice(String(e)))}
            onDecline={() => void host.decline(entry.id).catch((e) => showNotice(String(e)))}
          />
        )}
      </Show>
      <Show when={modDialog()} keyed>
        {(d) => <ModDialog req={d.req} insert={insertText} copy={copyText} onClose={d.done} />}
      </Show>
      <Show when={profileMenu()} keyed>
        {(m) => (
          <ContextMenu
            x={m.x}
            y={m.y}
            items={m.items}
            close={() => {
              setProfileMenu(undefined);
              refocus();
            }}
          />
        )}
      </Show>
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
