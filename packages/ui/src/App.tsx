import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
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
import {
  applyThemeCss,
  applyWindow,
  loadConfig,
  onConfigChanged,
  type UiConfig,
  type UiWorkspace,
  uiTokens,
} from "./config";
import { language, setLanguage, t } from "./i18n";
import { Icon } from "./icons";
import { defaults as defaultKeys, Keymap, type KeyTarget } from "./keymap";
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
import { MascotDock, MascotFloat, MascotLive, MascotSprite, MascotStatus } from "./mascot/Mascot";
import { clearSpriteCache, MOODS, type Mood, type OutfitInfo } from "./mascot/sprite";
import { MascotStore, type SpeechAction, type SpeechKind } from "./mascot/store";
import {
  type AiRequest,
  type AiResult,
  type BlockPayload,
  type CompletionItem,
  type DialogRequest,
  type ErrorHint,
  type Explanation,
  type HostEnv,
  localized,
  ModHost,
  type SessionSnapshot,
  sessionInfo,
  type ToastRequest,
} from "./mods/host";
import { ModDialog, ModsPanel, Panels, PermissionDialog, StatusBar, type Toast, Toasts } from "./mods/ModUi";
import type { ThemeInfo } from "./mods/protocol";
import { PromptBar, type PromptProps } from "./PromptBar";
import { folderName, urlToPath } from "./paths";
import type { Frame } from "./screen/protocol";
import { connectScreen } from "./session";
import { Settings } from "./settings/Settings";
import { type ScreenHub, TerminalView } from "./TerminalView";
import type { WhenContext } from "./when";

/** How long a notice (such as ignored config keys) stays up. */
const NOTICE_MS = 10_000;
/** How far Alt+Shift+arrow moves a divider, as a fraction of the split. */
const RESIZE_STEP = 0.05;
/** The update check waits until the window has settled (docs/09: startup comes first). */
const UPDATE_DELAY_MS = 10_000;
/** A command running this long makes Kotsume wait with it (docs/08 §5.1). */
/** The AI mod's ask command (docs/10 §3.1); mods' command ids carry their mod id. */
const AI_ASK = "otterm.ai-assist.ai.ask";
const LONG_RUN_MS = 3000;
/** Lines of a block's output an AI request may carry (docs/10 §3.2). */
const AI_OUTPUT_LINES = 200;
/** Completions or help taking this long show Kotsume thinking; quicker ones would only flicker. */
const THINKING_DELAY_MS = 300;
/** Actions the focused terminal runs itself: they need its selection, search bar or font. */
const PANE_ACTIONS = new Set<AppAction["kind"]>(["copy", "paste", "search", "font", "clear"]);

/** What a terminal tells the keymap about itself when a key arrives. */
export interface PaneKeyState {
  altScreen: boolean;
  hasSelection: boolean;
}

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
  /** A later `otterm` launch it opened for (docs/06 §4). */
  launch?: number;
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

/** A title that is only a program's path, like `C:\…\pwsh.exe` or `/usr/bin/zsh`. */
/**
 * A tab title template with its `{name}` variables filled in. Separators (` · `, `|`, ` - `) left
 * at either end or doubled by an empty value go away.
 */
export function fillTitle(template: string, vars: Record<string, string>): string {
  // `-` and `:` only with spaces around them, so that "my-app" stays whole.
  const sep = /\s*[·|]\s*|\s+[-–—:]\s+/;
  const text = template.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? (vars[k] ?? "") : m));
  return text
    .replace(new RegExp(`(${sep.source})(?:${sep.source})+`, "g"), "$1")
    .replace(new RegExp(`^(?:${sep.source})+|(?:${sep.source})+$`, "g"), "")
    .trim();
}

export function isProgramPath(title: string): boolean {
  const t = title.trim();
  return /^([a-zA-Z]:[\\/]|\/)/.test(t) && /(\.exe|[\\/](ba|z|fi|nu)?sh|[\\/]pwsh|[\\/]cmd)$/i.test(t);
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
  /** The ignored-keys notice last shown, so a reload with the same problems stays quiet. */
  let lastWarnings = "";

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
  const pushToast = (req: ToastRequest) => {
    const id = nextToast++;
    setToasts([...toasts(), { ...req, id }]);
    const ms = req.durationMs ?? 5000;
    if (ms > 0) setTimeout(() => dismissToast(id), ms);
  };

  // --- Kotsume (docs/08) ---------------------------------------------------------------------------
  const mascot = new MascotStore((source, message) => console.warn(`[${source}] ${message}`));
  const [outfits, setOutfits] = createSignal<OutfitInfo[]>([]);
  /** First-time hints already shown (decision E5). */
  const [seen, setSeen] = createSignal<Set<string>>(new Set());
  /** Panes whose command has run for a while: Kotsume juggles the pebble while they wait. */
  const [busyPanes, setBusyPanes] = createSignal<Set<number>>(new Set());
  const busyTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const mascotConf = () => config()?.mascot;
  const mascotShown = () => !!mascotConf()?.visible && mascotConf()?.position !== "hidden";
  const outfit = () => outfits().find((o) => o.id === mascotConf()?.outfit);
  /** The assist bar unless the layout has none; then the status bar (decision E4). */
  const mascotPlace = () => {
    const p = mascotConf()?.position ?? "assist-bar";
    return p === "assist-bar" && config()?.layout.assist_bar === false ? "statusbar" : p;
  };
  /** Whether a line of this kind is spoken now (docs/08 §4.3): level 1 alerts only, level 2 also
   * first-time hints, level 3 everything; an explicit `mascot.speech` overrides the level. */
  const speaks = (kind: SpeechKind) => {
    const m = mascotConf();
    if (!m || !mascotShown() || m.speech === "never") return false;
    if (m.speech === "alert-only") return kind === "alert";
    if (m.speechAuto && (config()?.guideLevel ?? 2) <= 2) return kind !== "info";
    return true;
  };
  /** One of otterm's own lines, when its kind is spoken now. */
  const mascotSay = (
    kind: SpeechKind,
    text: string,
    extra: { mood?: Mood; actions?: SpeechAction[]; durationMs?: number } = {},
  ) => {
    if (speaks(kind)) void mascot.say({ text, kind, source: "otterm", ...extra });
  };
  /** A first-time hint, shown once per feature for good (decision E5). */
  const firstTime = (key: string, text: string, actions?: SpeechAction[]) => {
    if (seen().has(key) || !speaks("first")) return;
    setSeen(new Set([...seen(), key]));
    void invoke("mascot_seen_add", { key }).catch(() => {});
    mascotSay("first", text, { actions, durationMs: 12_000 });
  };
  const loadMascot = () => {
    void invoke<OutfitInfo[]>("mascot_outfits")
      .then((o) => {
        clearSpriteCache();
        setOutfits(o);
      })
      .catch(() => {});
    void invoke<string[]>("mascot_seen")
      .then((s) => setSeen(new Set(s)))
      .catch(() => {});
  };
  /** Each pane's way to read its selection (TerminalView registers it). */
  const selectionReaders = new Map<number, () => Promise<string>>();

  /**
   * The context a mod asked for (docs/10 §4.1), put in front of its prompt by the host: the mod
   * cannot add session data any other way. Output is the last block's tail only, never the
   * whole scrollback.
   */
  const aiContext = async (include: string[]): Promise<string> => {
    const s = env.activeSession();
    const lines: string[] = [];
    if (include.includes("os")) lines.push(`OS: ${platform}`);
    if (include.includes("shell") && s) lines.push(`Shell: ${shellKindOf(s)}`);
    if (include.includes("cwd") && s?.cwd) lines.push(`Current folder: ${s.cwd}`);
    if (include.includes("lastBlock") && s) {
      const blocks = await invoke<{ line: number; command: string | null; exit: number | null }[]>("session_blocks", {
        id: s.id,
      }).catch(() => []);
      const last = [...blocks].reverse().find((b) => b.exit !== null);
      const info = last
        ? await invoke<{ command: string | null; exit: number | null; output: string } | null>("session_block", {
            id: s.id,
            line: last.line,
          }).catch(() => null)
        : null;
      if (info) {
        const tail = info.output.split("\n").slice(-AI_OUTPUT_LINES).join("\n");
        lines.push(`Last command: ${info.command ?? ""}`, `Exit code: ${info.exit ?? ""}`, `Output:\n${tail}`);
      }
    }
    if (include.includes("selection")) {
      const text = await env.selection();
      if (text) lines.push(`Selected text:\n${text}`);
    }
    return lines.length > 0 ? `${lines.join("\n")}\n\n` : "";
  };

  /**
   * `ctx.ai` (docs/10 §4.3, §7): show what goes where, ask, then send. Mods other than otterm's
   * own ask every time; otterm's AI mod shows the full preview for the first requests only
   * (`[ai] preview_first_n`). Kotsume thinks while the answer comes.
   */
  const askAi = async (
    mod: string,
    official: boolean,
    req: AiRequest,
    onChunk?: (text: string) => void,
  ): Promise<AiResult> => {
    const prompt = (await aiContext(req.context?.include ?? [])) + req.prompt;
    const preview = await invoke<{
      provider: string;
      host: string;
      model: string;
      prompt: string;
      redactions: number;
      full: boolean;
    }>("ai_preview", { prompt });
    if (!official || preview.full) {
      const workspace = config()?.workspace;
      const answer = await env.dialog({
        title: t("ai-preview-title", { purpose: req.purpose }),
        body: [
          t("ai-preview-where", { provider: preview.provider, host: preview.host, model: preview.model }),
          official ? "" : t("ai-preview-mod", { mod }),
          preview.redactions > 0 ? t("ai-preview-redacted", { count: preview.redactions }) : "",
          "",
          preview.prompt,
        ]
          .filter((l, i) => l !== "" || i === 3)
          .join("\n"),
        buttons: [
          { id: "send", label: t("ai-preview-send"), variant: "primary" },
          ...(workspace ? [{ id: "off", label: t("ai-preview-workspace-off") }] : []),
          { id: "cancel", label: t("action-cancel") },
        ],
        cancelId: "cancel",
        from: "otterm",
      });
      if (answer === "off") {
        await invoke("ai_workspace_off", { off: true }).catch(() => {});
        throw new Error(t("ai-workspace-off-done"));
      }
      if (answer !== "send") throw new Error(t("ai-cancelled"));
      if (official) void invoke("ai_preview_seen").catch(() => {});
    }
    const events = new Channel<{ kind: "delta"; text: string }>();
    events.onmessage = (e) => onChunk?.(e.text);
    mascot.setReason("ai", "thinking");
    try {
      return await invoke<AiResult>("ai_complete", {
        modId: mod,
        purpose: req.purpose,
        system: req.system ?? null,
        prompt,
        maxTokens: req.maxTokens ?? null,
        jsonOut: req.json,
        events,
      });
    } finally {
      mascot.clearReason("ai");
    }
  };

  const mascotClick = () => {
    // Clicking Kotsume asks the AI when the AI mod is there (decision F1), else opens the palette.
    if (host.hasCommand(AI_ASK)) void host.runCommand(AI_ASK);
    else void openPalette();
  };
  /** Open dialogs, newest last: a dialog opened over another (the AI send preview over the
   * answer it is about to fill) hands the screen back when it closes. */
  const [dialogs, setDialogs] = createSignal<{ key: number; req: DialogRequest; done: (id: string | null) => void }[]>(
    [],
  );
  let nextDialog = 1;
  const modDialog = () => dialogs()[dialogs().length - 1];
  /** The panel open in each panel slot, by panel id. */
  const [shownPanel, setShownPanel] = createSignal<Record<string, string | undefined>>({});
  const MODS_PANEL = "otterm.mods";
  /** The settings screen (docs/04 §6). */
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  /** A theme being edited in the settings: shown in the window until saved or dropped. */
  const [previewTheme, setPreviewTheme] = createSignal<UiConfig["theme"]>();
  /** A panel tab being dragged to another slot. */
  const [dragPanel, setDragPanel] = createSignal<string>();
  const [dropSlot, setDropSlot] = createSignal<string>();
  /** Where a panel is: `appearance.panels` (or the layout) first, else where its mod put it. */
  const slotOf = (id: string, slot: string) => config()?.layout.panels?.[id] ?? slot;
  /** The panel last shown in each slot, for toggling it back. */
  const lastPanel: Record<string, string> = {};
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
    // Every token, derived ones included, so mods see the same colors the window uses.
    for (const [k, v] of Object.entries(th ? uiTokens(th) : {})) vars[`--ot-${k}`] = v;
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
    toast: pushToast,
    mascotSay(mod, req) {
      // A mod's line is information unless it is an urgent alert; when Kotsume would not say it
      // (hidden, level 0, a quieter level) it becomes a toast, so nothing is lost (docs/08 §6.3).
      const kind: SpeechKind = req.mood === "alert" && req.urgent ? "alert" : "info";
      const mood = MOODS.find((m) => m === req.mood);
      if (!speaks(kind)) {
        pushToast({
          text: req.text,
          from: mod,
          kind: mood === "alert" ? "warning" : "info",
          durationMs: req.durationMs,
          actions: req.actions.map((a) => ({ label: a.label, onClick: a.run })),
        });
        return Promise.resolve();
      }
      return mascot.say({
        text: req.text,
        mood,
        kind,
        source: mod,
        durationMs: req.durationMs,
        actions: req.actions,
      });
    },
    mascotSetMood(mod, mood, forMs) {
      const m = MOODS.find((x) => x === mood);
      if (m) mascot.setReason(`mod:${mod}`, m, Math.min(forMs ?? 3000, 60_000));
    },
    mascotMood: () => mascot.mood(),
    selection: () => selectionReaders.get(currentTab()?.active ?? -1)?.() ?? Promise.resolve(""),
    aiAvailable: () => invoke<boolean>("ai_available").catch(() => false),
    aiComplete: (mod, official, req, onChunk) => askAi(mod, official, req, onChunk),
    mascotOutfit: () => mascotConf()?.outfit ?? "default",
    mascotOutfits: () => ["default", ...outfits().map((o) => o.id)],
    dialog: (req) =>
      new Promise((resolve) => {
        const key = nextDialog++;
        const entry = {
          key,
          req,
          done: (id: string | null) => {
            setDialogs(dialogs().filter((d) => d.key !== key));
            if (dialogs().length === 0) refocus();
            resolve(id);
          },
        };
        setDialogs([...dialogs(), entry]);
      }),
    dialogBody: (mod, reg, body) =>
      setDialogs(
        dialogs().map((d) => (d.req.from === mod && d.req.reg === reg ? { ...d, req: { ...d.req, body } } : d)),
      ),
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
        case "ai.question_prefix":
          return c?.aiQuestionPrefix ?? false;
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
        if (!host.isOn("otterm.history-search")) return false;
        void openHistory();
        return true;
      }
      if (id === "otterm.settings.open") {
        setSettingsOpen(true);
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
        setShownPanel({ ...shownPanel(), [slotOf(panel.id, panel.slot)]: panel.id });
        return true;
      }
      if (id === "otterm.mods.show") {
        setShownPanel({ ...shownPanel(), [slotOf(MODS_PANEL, "sidebar.right")]: MODS_PANEL });
        return true;
      }
      return false;
    },
    developerMode: () => config()?.developerMode ?? false,
  };
  const host = new ModHost(env);
  mascot.onMoodChanged((m) => host.emit("mascot-mood", m));
  createEffect(() => {
    mascot.moodChanges = mascotConf()?.moodChanges ?? true;
    const shown = mascotShown();
    if (!shown) mascot.clear();
    host.emit("mascot-visible", shown);
  });
  // A question on screen (a danger, closing a running program, trusting a folder): Kotsume
  // stops with the user (docs/08 §4.2).
  createEffect(() => {
    if (confirm()) mascot.setReason("prompt", "alert");
    else mascot.clearReason("prompt");
  });
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
    const slow = setTimeout(() => mascot.setReason("completion", "thinking"), THINKING_DELAY_MS);
    const [fromMods, mine] = await Promise.all([
      host.complete({ sessionId: String(s.id), line: st.line, cursor: st.cursor, exact: st.exact }, parsed),
      builtinCompletions(st),
    ]).finally(() => {
      clearTimeout(slow);
      mascot.clearReason("completion");
    });
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
            tone: "danger",
            buttons: [
              { label: t("danger-run"), action: () => done(() => true), kind: "danger" },
              ...verdict.alternatives.map((a, i) => ({
                label: a.label || t("danger-alternative-label", { command: a.command }),
                action: () => done(() => replace(a.command).then(() => true)),
                kind: i === 0 ? ("primary" as const) : undefined,
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
  /** The first key bound to an action, written for people (`Ctrl+Shift+T`). */
  const keyHint = (id: string): string | undefined => {
    const chord = (config()?.keybindings[id] ?? defaultKeys()[id])?.[0];
    if (!chord) return undefined;
    // A sequence (`ctrl+k ctrl+t`) shows each of its chords the same way.
    return chord
      .split(/\s+/)
      .map((step) =>
        step
          .split("+")
          .map((p) => (p === "cmd" ? "⌘" : p.replace(/^arrow/, "").replace(/^./, (c) => c.toUpperCase())))
          .join("+"),
      )
      .join(" ");
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
      {
        id: "app.safe_mode",
        title: t(config()?.safeMode ? "palette-cmd-restart-normal" : "palette-cmd-restart-safe"),
        run: () => restart(!config()?.safeMode),
      },
      { id: "app.update", title: t("palette-cmd-update"), run: () => void checkForUpdate(true) },
      {
        id: "settings.file",
        title: t("palette-cmd-settings-file"),
        run: () => void invoke("config_open").catch((e) => showNotice(String(e))),
      },
      ...(["sidebar.left", "sidebar.right", "panel.bottom"] as const).map((slot) => ({
        id: `${slot}.toggle`,
        title: t(`keyact-${slot.replace(".", "-")}-toggle`),
        run: () => run({ kind: "togglePanel", slot }),
      })),
      { id: "mods", title: t("palette-cmd-mods"), run: () => env.runHostCommand("otterm.mods.show", undefined) },
      // The history picker is the `otterm.history-search` mod's; without it the palette has no entry.
      ...(host.isOn("otterm.history-search")
        ? [{ id: "history", title: t("palette-cmd-history"), run: () => void openHistory() }]
        : []),
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
    // The key of each of otterm's own actions, at the right (docs/03 §7).
    for (const e of mine) e.hint ??= keyHint(e.id);
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
  /** The OS asks for high contrast (decision I15): forced colors or "more contrast". */
  const contrastMode = window.matchMedia("(forced-colors: active), (prefers-contrast: more)");
  const motionMode = window.matchMedia("(prefers-reduced-motion: reduce)");
  /** The terminal's default background alpha (window opacity, background image). */
  let terminalAlpha = 1;
  let appliedAppearance: string | undefined;

  /**
   * Pick `theme` or `themeLight` for the OS appearance (appearance.follow_system), High Contrast
   * when asked for, or the theme being edited in the settings.
   */
  const applyTheme = () => {
    if (!loaded) return;
    const light = loaded.followSystem && lightMode.matches && loaded.themeLight;
    let c = light ? { ...loaded, theme: loaded.themeLight as UiConfig["theme"] } : loaded;
    const contrast = loaded.accessibility.highContrast ?? contrastMode.matches;
    if (contrast && loaded.themeHighContrast) c = { ...c, theme: loaded.themeHighContrast };
    const preview = previewTheme();
    if (preview) c = { ...c, theme: preview };
    applyThemeCss(c.theme);
    // The OS title bar follows the theme (otherwise it stays white over a dark window on Windows).
    if (c.theme.appearance !== appliedAppearance) {
      appliedAppearance = c.theme.appearance;
      void getCurrentWindow()
        .setTheme(c.theme.appearance)
        .catch(() => {});
    }
    void applyWindow(c, motionMode.matches).then((alpha) => {
      if (alpha === terminalAlpha) return;
      terminalAlpha = alpha;
      const now = untrack(config);
      if (now) setConfig({ ...now, terminalAlpha: alpha });
    });
    c = { ...c, terminalAlpha };
    setConfig(c);
    host.themeChanged(themeInfo());
    // Programs ask for these (OSC 10/11) to pick light or dark colors of their own.
    const { foreground, background, cursor } = c.theme.terminal;
    void invoke("terminal_colors", { foreground, background, cursor }).catch(() => {});
  };
  for (const m of [lightMode, contrastMode, motionMode]) {
    m.addEventListener("change", applyTheme);
    onCleanup(() => m.removeEventListener("change", applyTheme));
  }
  createEffect(() => {
    previewTheme();
    untrack(applyTheme);
  });

  const applyConfig = (c: UiConfig) => {
    setLanguage(c.language);
    loaded = c;
    applyTheme();
    keymap = new Keymap(c.keybindings, c.customKeys);
    const warnings = [
      ...c.warnings.map((w) => (w.key ? `${w.key}: ${w.message}` : w.message)),
      ...keymap.problems.map((p) => (p.startsWith("custom[") ? `keybindings.${p}` : `keybindings.bindings.${p}`)),
    ].join("; ");
    if (warnings && warnings !== lastWarnings) showNotice(t("config-ignored", { keys: warnings }));
    lastWarnings = warnings;
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
    loadMascot();
    await openFirstTabs();
    setReady(true);
    if (config()?.safeMode) mascotSay("first", t("mascot-safe-mode"));
    else firstTime("first-tab", t("mascot-first-tab"));
    void offerCrashLog();
    // The only connection otterm makes by itself, when the user allowed it (decision K5).
    if (config()?.checkUpdates) setTimeout(() => void checkForUpdate(false), UPDATE_DELAY_MS);
    // A later `otterm` launch (docs/06 §4): a tab, a workflow, or a question for the AI mod.
    const reply = (id: number, ok: boolean, message: string) =>
      invoke("instance_reply", { id, ok, message }).catch(() => {});
    const unlisten = await Promise.all([
      listen<number>("instance-open", (e) => newTab(undefined, undefined, undefined, e.payload)),
      // The answer says whether the command exists; running it may wait for the user (a
      // workflow asks for its fields), longer than the command line should.
      listen<{ id: number; name: string }>("instance-workflow", (e) => {
        const ok = host.hasCommand(`workflows.run.${e.payload.name}`);
        void reply(e.payload.id, ok, ok ? "" : `no workflow ${e.payload.name}`);
        void runKeyCommand("workflow.run", { name: e.payload.name });
      }),
      listen<{ id: number; question: string | null }>("instance-ask", (e) => {
        const q = e.payload.question;
        const ok = host.hasCommand(AI_ASK);
        void reply(e.payload.id, ok, ok ? "" : "the AI mod (otterm.ai-assist) is not running");
        if (ok) void host.runCommand(AI_ASK, q ? { question: q } : undefined);
        else showNotice(t("ai-unavailable"));
      }),
    ]);
    onCleanup(() => {
      for (const u of unlisten) u();
    });
    // Mods load after the first tab is up (docs/09 §3.5).
    // Safe mode starts no mods (docs/04 §2.3): one of them may be what broke the window.
    if (!config()?.safeMode) host.start().catch((e) => showNotice(String(e)));
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
  const newTab = (cwd?: string, profile?: string, profileName?: string, launch?: number) => {
    const tabId = nextId++;
    const paneId = nextId++;
    const at = tabs().findIndex((x) => x.id === activeTab());
    const next = [...tabs()];
    next.splice(at + 1, 0, { id: tabId, root: leaf(paneId), active: paneId });
    batch(() => {
      setTabs(next);
      setActiveTab(tabId);
      setPanes([...panes(), { id: paneId, tab: tabId, cwd, profile, profileName, launch, started: Date.now() }]);
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

  /** Start otterm again in safe mode, or back out of it, asking first if programs run. */
  const restart = (safe: boolean) =>
    void askThenClose(
      panes().map((p) => p.id),
      () => void invoke("app_restart", { safe }).catch((e) => showNotice(String(e))),
    );

  /**
   * The first tabs: the workspace file's (docs/06 §2), else one. A workspace that wants to run
   * commands, turn on mods or change settings asks first (decision K4); Escape decides nothing
   * and asks again next time.
   */
  const openFirstTabs = async () => {
    const ws = config()?.workspace;
    if (ws && ws.trusted === null && ws.gated) {
      const trusted = await askTrust(ws);
      if (trusted !== undefined) await invoke("workspace_trust", { trusted }).catch((e) => showNotice(String(e)));
    }
    const list =
      ws && ws.tabs > 0
        ? await invoke<{ launch: number; name: string | null }[]>("workspace_tabs").catch(() => [])
        : [];
    if (list.length === 0) return newTab();
    for (const tab of list) newTab(undefined, undefined, tab.name ?? undefined, tab.launch);
    const first = tabs()[0];
    if (first) setActiveTab(first.id);
  };

  /**
   * The last run crashed (decision C11): offer to copy the log or open an issue. The log goes to
   * the clipboard, never into the issue URL, so the user sees what they paste.
   */
  const offerCrashLog = async () => {
    const crash = await invoke<{ name: string; path: string; text: string; issueUrl: string } | null>(
      "crash_pending",
    ).catch(() => null);
    if (!crash) return;
    const done = () => {
      setConfirm(undefined);
      void invoke("crash_ack", { name: crash.name }).catch(() => {});
      refocus();
    };
    const copy = () => invoke("clipboard_write", { text: crash.text }).catch(() => {});
    const body = encodeURIComponent(t("crash-issue-body"));
    const title = encodeURIComponent(t("crash-issue-title"));
    setConfirm({
      title: t("crash-title"),
      body: t("crash-body", { path: crash.path }),
      buttons: [
        {
          label: t("crash-issue"),
          action: () => {
            void copy().then(() => invoke("open_url", { url: `${crash.issueUrl}?title=${title}&body=${body}` }));
            done();
          },
        },
        {
          label: t("crash-copy"),
          action: () => {
            void copy();
            done();
          },
        },
        { label: t("crash-close"), action: done },
      ],
      focus: 2,
      cancel: done,
    });
  };

  /**
   * Look for a new version (decision C10). `manual` (the palette) reports every outcome; the check
   * at startup speaks only when there is something to install.
   */
  const checkForUpdate = async (manual: boolean) => {
    let found: { version: string; current: string; notes: string | null } | null;
    try {
      found = await invoke("update_check");
    } catch (e) {
      if (manual) showNotice(t("update-failed", { error: String(e) }));
      return;
    }
    if (!found) {
      if (manual) showNotice(t("update-none"));
      return;
    }
    const later = () => {
      setConfirm(undefined);
      refocus();
    };
    setConfirm({
      title: t("update-title", { version: found.version }),
      body: t("update-body", { current: found.current, notes: found.notes ?? "" }),
      buttons: [
        {
          label: t("update-install"),
          action: () => {
            later();
            showNotice(t("update-installing"));
            void invoke("update_install").catch((e) => showNotice(t("update-failed", { error: String(e) })));
          },
        },
        { label: t("update-later"), action: later },
      ],
      focus: 1,
      cancel: later,
    });
  };

  /**
   * Kotsume and the commands (docs/08 §4.2): waits with a long one, stops on a failure, and is
   * happy when a long one succeeds (`mascot.happy_threshold_ms`).
   */
  const onMascotBlock = (pane: number, kind: "start" | "end", exit?: number, ms?: number) => {
    clearTimeout(busyTimers.get(pane));
    if (kind === "start") {
      busyTimers.set(
        pane,
        setTimeout(() => {
          setBusyPanes(new Set([...busyPanes(), pane]));
          mascot.setReason(`run:${pane}`, "thinking");
        }, LONG_RUN_MS),
      );
      return;
    }
    const busy = new Set(busyPanes());
    busy.delete(pane);
    setBusyPanes(busy);
    mascot.clearReason(`run:${pane}`);
    if (exit === undefined) return;
    if (exit !== 0) {
      mascot.setReason("exit", "alert", 3000);
      return;
    }
    if ((ms ?? 0) >= (mascotConf()?.happyThresholdMs ?? 10_000)) {
      mascot.setReason("done", "happy", 3000);
      mascotSay("info", t("mascot-done", { seconds: Math.round((ms ?? 0) / 1000) }), { mood: "happy" });
    }
  };

  const askTrust = (ws: UiWorkspace) =>
    new Promise<boolean | undefined>((resolve) => {
      const answer = (trusted: boolean | undefined) => {
        setConfirm(undefined);
        resolve(trusted);
      };
      setConfirm({
        title: t("workspace-trust-title", { name: ws.name }),
        body: t("workspace-trust-body", { root: ws.root }),
        buttons: [
          { label: t("workspace-trust-yes"), action: () => answer(true) },
          { label: t("workspace-trust-no"), action: () => answer(false) },
        ],
        // Enter alone does not trust a folder.
        focus: 1,
        cancel: () => answer(undefined),
      });
    });

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
  const onAppKey = (e: KeyboardEvent, pane: PaneKeyState): boolean | AppAction => {
    const ctx = keyContext({ terminalFocus: true, altScreen: pane.altScreen, hasSelection: pane.hasSelection });
    const passthrough = config()?.altScreenPassthrough ?? true;
    const starting = !keymap.pending;
    const r = keymap.feed(e, ctx);
    // On the alternate screen a sequence may only start with a Ctrl+Shift or Cmd chord: nano and
    // emacs need their Ctrl+K.
    if (r?.kind === "pending" && starting && pane.altScreen && passthrough && !keymap.pendingStrong) {
      keymap.reset();
      return false;
    }
    // The middle of a sequence (`ctrl+k ctrl+s`), or a sequence that went nowhere: the key is otterm's.
    if (r?.kind === "pending" || r?.kind === "cancel") return true;
    if (!r) {
      // A mod's suggested key, when the user bound nothing to the chord (docs/06 §5).
      const command = host.matchKey(e, ctx, pane.altScreen && passthrough);
      if (!command) return false;
      void host.runCommand(command);
      return true;
    }
    const local = r.target.kind === "action" && PANE_ACTIONS.has(r.target.action.kind);
    // Copy, paste, search and font size act on otterm itself, so they stay otterm's on the
    // alternate screen too (as before: vim never saw Ctrl+V on Windows).
    if (pane.altScreen && !r.strong && !local && passthrough) return false;
    if (r.target.kind === "action" && local) return r.target.action;
    return runTarget(r.target);
  };

  /** What `when` clauses can test (docs/06 §5.4). */
  const keyContext = (extra: WhenContext = {}): WhenContext => {
    const focused = document.activeElement as HTMLElement | null;
    const side = focused?.closest<HTMLElement>(".side-panel");
    const slot = side?.dataset.slot;
    const st = inputState();
    return {
      terminalFocus: false,
      altScreen: false,
      hasSelection: false,
      inputEmpty: !st.active || st.line.trim() === "",
      paletteOpen: palette() !== undefined,
      panelFocus: !!side,
      fileTreeFocus: !!slot && (shownPanel()[slot] ?? "").includes("file-tree"),
      settingsOpen: settingsOpen(),
      guideLevel: config()?.guideLevel ?? 2,
      platform,
      ...extra,
    };
  };

  const runTarget = (target: KeyTarget): boolean => {
    if (target.kind === "action") return run(target.action);
    void runKeyCommand(target.id, target.args);
    return true;
  };

  /** A `[[keybindings.custom]]` command: otterm's (`workflow.run`), a mod's, or one of the host's. */
  const runKeyCommand = async (id: string, args: Record<string, unknown> = {}): Promise<boolean> => {
    let command = id;
    let rest: Record<string, unknown> | undefined = args;
    // The workflows mod registers one command per workflow (mods/workflows).
    if (id === "workflow.run") {
      command = `workflows.run.${String(args.name ?? "")}`;
      rest = undefined;
    }
    const ok = await host.runCommand(command, rest);
    if (!ok) showNotice(t("command-unknown", { id: command }));
    return ok;
  };

  /**
   * Keys pressed outside the terminal (a panel, the status bar, nothing focused): otterm's own
   * shortcuts still work there (F6 between regions, the palette, panel toggles), and the WebView's
   * browser keys never do — F5 / Ctrl+R would reload the whole window, F6 would move the focus out
   * of it, F7 turns on caret browsing, Ctrl+P prints, Ctrl+F / F3 search the page.
   */
  /** Memory of otterm and its WebView processes (decision I13): over 1 GB, the status bar warns and
   * names the tab with the largest scrollback. Polled every 30 s; the check is cheap. */
  const MEMORY_WARN_BYTES = 1_000_000_000;
  const [memoryWarning, setMemoryWarning] = createSignal<{ gb: string; tab: string; pane: number }>();
  const checkMemory = () => {
    invoke<{ total_bytes: number; largest_scrollback: [number, number] | null }>("memory_usage")
      .then((m) => {
        if (m.total_bytes <= MEMORY_WARN_BYTES) return setMemoryWarning(undefined);
        const session = m.largest_scrollback?.[0];
        const pane = session === undefined ? undefined : [...sessionOf].find(([, s]) => s === session)?.[0];
        setMemoryWarning({
          gb: (m.total_bytes / 1e9).toFixed(1),
          tab: (pane !== undefined && titles()[pane]) || String(session ?? ""),
          pane: pane ?? -1,
        });
      })
      .catch(() => setMemoryWarning(undefined));
  };
  const showMemoryTab = () => {
    const w = memoryWarning();
    if (!w || w.pane < 0) return;
    const tab = tabs().find((x) => leaves(x.root).includes(w.pane));
    if (tab) setActiveTab(tab.id);
    activatePane(w.pane);
  };
  onMount(() => {
    checkMemory();
    const memoryTimer = setInterval(checkMemory, 30_000);
    onCleanup(() => clearInterval(memoryTimer));
  });
  onMount(() => {
    const browserKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (["f3", "f5", "f6", "f7"].includes(k)) return true;
      return (e.ctrlKey || e.metaKey) && !e.altKey && ["r", "p", "f", "g", "u", "j"].includes(k);
    };
    // Capture phase: dialogs (settings, palette) stop keys from bubbling, but the browser's own
    // handling must be cancelled wherever the focus is. The terminal cancels its keys itself.
    const blockBrowser = (e: KeyboardEvent) => {
      if (!(e.target as HTMLElement | null)?.closest(".terminal") && browserKey(e)) e.preventDefault();
    };
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // The terminal asks onAppKey itself before it sends a key.
      if (target?.closest(".terminal")) return;
      const editing = !!target?.matches("input, textarea, select, [contenteditable]");
      const chord = e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.key);
      if (editing && !chord && !keymap.pending) return;
      const r = keymap.feed(e, keyContext());
      const done =
        r?.kind === "pending" ||
        r?.kind === "cancel" ||
        (r?.kind === "hit" &&
          !(r.target.kind === "action" && PANE_ACTIONS.has(r.target.action.kind)) &&
          runTarget(r.target));
      if (done) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", blockBrowser, true);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("keydown", blockBrowser, true);
      window.removeEventListener("keydown", onKey);
    });
  });

  /** Run a mod's command if one is registered; false (the key goes on) when none is. */
  const runModCommand = (id: string): boolean => {
    if (!host.hasCommand(id)) return false;
    void host.runCommand(id);
    return true;
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
        setSettingsOpen(!settingsOpen());
        break;
      case "togglePanel": {
        const slot = action.slot;
        const shown = shownPanel()[slot];
        if (shown) {
          lastPanel[slot] = shown;
          setShownPanel({ ...shownPanel(), [slot]: undefined });
          refocus();
        } else {
          const ids = panelsIn(slot);
          const id = ids.includes(lastPanel[slot] ?? "") ? lastPanel[slot] : ids[0];
          if (!id) return false;
          setShownPanel({ ...shownPanel(), [slot]: id });
        }
        break;
      }
      case "focusRegion":
        focusRegion(action.dir);
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
        // The popup is the completion mod's; without it Ctrl+Space reaches the shell.
        if (!st.active || !(config()?.assist.completion ?? true) || !host.isOn("otterm.completion")) return false;
        if (completion()) {
          const c = completion();
          if (c) setCompletion({ ...c, selected: (c.selected + 1) % c.items.length });
        } else void refreshCompletion(st);
        break;
      }
      case "multiline": {
        const st = inputState();
        // Shift+Enter is the shell's unless the multi-line editor mod is on.
        if (!st.active || multiline() !== undefined || !host.isOn("otterm.multiline-editor")) return false;
        setMultiline(st.line);
        break;
      }
      // Commands of mods that may not be there (the AI mod, the mascot, the guide); without one
      // the key goes on to the terminal.
      case "aiAsk":
        return runModCommand(AI_ASK);
      case "mascotToggle": {
        if (!host.isOn("otterm.mascot")) return false;
        const show = !mascotShown();
        void invoke("config_write", { path: ["mascot", "visible"], value: show }).catch((e) => showNotice(String(e)));
        if (show && mascotConf()?.position === "hidden")
          void invoke("config_write", { path: ["mascot", "position"], value: "assist-bar" }).catch(() => {});
        break;
      }
      case "helpMode":
        return runModCommand("guide.help_mode");
      default:
        // Pane actions (copy, paste, …) are the terminal's; it runs them itself.
        return false;
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
    const set = titles()[pane];
    // A shell that titles its window with its own program path (pwsh after a command, cmd) says
    // nothing useful; the folder and the command do (decision I10).
    if (set && !isProgramPath(set)) return set;
    const p = panes().find((x) => x.id === pane);
    const c = config();
    // A tab opened without picking a profile runs the default one: its id, or else the shell it
    // started (the platform's recommendation), stands in for a name.
    const profile = p?.profileName || p?.profile || c?.defaultProfile || commandName(shellOf.get(pane)?.shell ?? "");
    const command = commandName(running()[pane] ?? "");
    const template = command ? (c?.tabTitleRunning ?? "{command} · {cwd_name}") : (c?.tabTitleIdle ?? "{cwd_name}");
    // `appearance.tabbar.title_idle` / `title_running` (issue #18).
    return fillTitle(template, { cwd_name: folders()[pane] || profile, command, profile, title: set ?? "" });
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

  /** The window's own panels (the mods list) for the slot they are placed in. */
  const builtinPanels = (slot: string) =>
    slotOf(MODS_PANEL, "sidebar.right") === slot
      ? [
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
        ]
      : [];

  /**
   * Under the cursor, or above it when the cursor is near the bottom. The terminal's hidden input
   * sits at the cursor (it anchors the IME), so its box is the cursor's.
   */
  const completionPlace = (): { x: number; top?: number; bottom?: number } => {
    const caret = document.querySelector(".terminal.active .input")?.getBoundingClientRect();
    if (!caret || !area) return { x: 16, bottom: 8 };
    const box = area.getBoundingClientRect();
    const x = Math.max(4, Math.min(caret.left - box.left - 8, box.width - 320));
    if (box.bottom - caret.bottom >= 250) return { x, top: caret.bottom - box.top + 2 };
    return { x, bottom: box.bottom - caret.top + 2 };
  };

  /** Panel ids that go in a slot, built-in ones included. */
  const panelsIn = (slot: string): string[] => [
    ...(slotOf(MODS_PANEL, "sidebar.right") === slot ? [MODS_PANEL] : []),
    ...host
      .panels()
      .filter((p) => slotOf(p.id, p.slot) === slot)
      .map((p) => p.id),
  ];

  /**
   * The layout (docs/04 §1.2) decides which slots start open: a slot it shows gets its first panel
   * once panels arrive, and a slot it hides is closed when the layout changes.
   */
  const opened = new Set<string>();
  let layoutKey = "";
  createEffect(() => {
    const l = config()?.layout;
    if (!l) return;
    const key = JSON.stringify([l.name, l.sidebar_left, l.sidebar_right, l.panel_bottom, l.panels]);
    const slots: [string, boolean][] = [
      ["sidebar.left", l.sidebar_left],
      ["sidebar.right", l.sidebar_right],
      ["panel.bottom", l.panel_bottom],
    ];
    const next = { ...shownPanel() };
    let changed = false;
    if (key !== layoutKey) {
      layoutKey = key;
      opened.clear();
      for (const [slot, on] of slots) {
        if (!on && next[slot] && next[slot] !== MODS_PANEL) {
          next[slot] = undefined;
          changed = true;
        }
      }
    }
    for (const [slot, on] of slots) {
      if (!on || opened.has(slot) || next[slot]) continue;
      const first = panelsIn(slot).find((id) => id !== MODS_PANEL);
      if (first) {
        next[slot] = first;
        opened.add(slot);
        changed = true;
      }
    }
    // A panel moved to another slot goes with its place.
    for (const slot of Object.keys(next)) {
      const id = next[slot];
      if (id && !panelsIn(slot).includes(id)) {
        next[slot] = undefined;
        const to =
          id === MODS_PANEL
            ? slotOf(id, "sidebar.right")
            : slotOf(id, host.panels().find((p) => p.id === id)?.slot ?? slot);
        if (to !== slot) next[to] = id;
        changed = true;
      }
    }
    if (changed) setShownPanel(next);
  });

  /** F6 / Shift+F6: the terminal, each open panel, the status bar (docs/04 §5, keyboard only). */
  const focusRegion = (dir: 1 | -1) => {
    const regions = [
      document.querySelector<HTMLElement>(".terminal.active .input"),
      ...[...document.querySelectorAll<HTMLElement>(".side-panel")].map((el) =>
        el.querySelector<HTMLElement>(
          '.side-panel-body button, .side-panel-body [tabindex], .side-panel-body input, [role="tab"]',
        ),
      ),
      document.querySelector<HTMLElement>(".statusbar button"),
    ].filter((el): el is HTMLElement => !!el);
    if (regions.length === 0) return;
    const at = regions.findIndex((el) =>
      el.closest(".side-panel, .statusbar, .terminal")?.contains(document.activeElement),
    );
    const next = regions[(at + dir + regions.length) % regions.length];
    next?.focus();
  };

  /** Drop a dragged panel tab on a slot: remember the place (`appearance.panels`) and open it there. */
  const dropPanel = (slot: string) => {
    const id = dragPanel();
    setDragPanel(undefined);
    setDropSlot(undefined);
    if (!id) return;
    void invoke("config_write", { path: ["appearance", "panels", id], value: slot }).catch((e) =>
      showNotice(String(e)),
    );
    const next = { ...shownPanel() };
    for (const k of Object.keys(next)) if (next[k] === id) next[k] = undefined;
    next[slot] = id;
    setShownPanel(next);
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
        "blocks-cards": config()?.layout.blocks === "cards",
      }}
    >
      <Show when={config()?.safeMode}>
        <div class="safe-banner" role="status" data-ot="safe-banner">
          <Icon name="alert-triangle" />
          <span>{t("safe-mode-banner")}</span>
          <button type="button" onClick={() => restart(false)}>
            {t("palette-cmd-restart-normal")}
          </button>
        </div>
      </Show>
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
                aria-label={t("tab-close")}
              >
                <Icon name="x" />
              </button>
            </div>
          )}
        </For>
        <button
          type="button"
          class="tab-new"
          title={`${t("tab-new")} (${newTabHint})`}
          onClick={() => run({ kind: "newTab" })}
          aria-label={t("tab-new")}
        >
          <Icon name="plus" />
        </button>
        <button
          ref={newButton}
          type="button"
          class="tab-new tab-profiles"
          title={t("tab-new-profile")}
          onClick={() => void openProfileMenu()}
          aria-label={t("tab-new-profile")}
        >
          <Icon name="chevron-down" />
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
          slotOf={slotOf}
          onDrag={setDragPanel}
          builtin={builtinPanels("sidebar.left")}
        />
        <div class="body-center">
          <div ref={area} class="panes">
            <For each={panes()}>
              {(p) => {
                const rect = () => geometry().rects.get(p.id);
                return (
                  <div
                    class="pane"
                    data-ot="pane"
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
                      launch={p.launch}
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
                        onMascotBlock(p.id, e.kind, e.exit, e.ms);
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
                      registerSelection={(read) => selectionReaders.set(p.id, read)}
                      onSession={(id) => {
                        sessionOf.set(p.id, id);
                        void invoke<{ shell: string; wsl: string | null }>("session_info", { id })
                          .then((info) => shellOf.set(p.id, info))
                          .catch(() => {})
                          .finally(() => {
                            // Once the shell is known, so that `shellKind` is right (issue #14).
                            const s = snapshot(p);
                            if (s) host.emit("session-created", sessionInfo(s));
                            if (currentTab()?.active === p.id) emitFocus();
                          });
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
                  {...completionPlace()}
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
          <Show when={confirm()} keyed>
            {(c) => (
              <div class="app-prompt">
                <PromptBar {...c} />
              </div>
            )}
          </Show>
          <AssistBar
            mascot={
              mascotShown() && mascotPlace() === "assist-bar" ? (
                <MascotDock store={mascot} outfit={outfit()} busy={busyPanes().size > 0} onClick={mascotClick} />
              ) : undefined
            }
            explanation={config()?.layout.assist_bar === false ? undefined : explanation()}
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
            slotOf={slotOf}
            onDrag={setDragPanel}
            builtin={builtinPanels("panel.bottom")}
          />
          <Show when={config()?.statusbar ?? true}>
            <StatusBar
              mascot={
                mascotShown() && mascotPlace() === "statusbar" ? (
                  <MascotStatus store={mascot} outfit={outfit()} busy={busyPanes().size > 0} onClick={mascotClick} />
                ) : undefined
              }
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
              memory={memoryWarning()}
              onMemoryClick={showMemoryTab}
              order={config()?.statusbarOrder ?? []}
              onReorder={(ids) =>
                void invoke("config_write", { path: ["appearance", "statusbar", "order"], value: ids }).catch((e) =>
                  showNotice(String(e)),
                )
              }
              onModsClick={() => {
                const slot = slotOf(MODS_PANEL, "sidebar.right");
                const open = shownPanel()[slot] === MODS_PANEL;
                setShownPanel({ ...shownPanel(), [slot]: open ? undefined : MODS_PANEL });
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
          slotOf={slotOf}
          onDrag={setDragPanel}
          builtin={builtinPanels("sidebar.right")}
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
      <Show when={dragPanel()}>
        <For
          each={[
            { slot: "sidebar.left", style: { left: "8px", top: "48px", bottom: "40px", width: "22%" } },
            { slot: "sidebar.right", style: { right: "8px", top: "48px", bottom: "40px", width: "22%" } },
            { slot: "panel.bottom", style: { left: "24%", right: "24%", bottom: "40px", height: "28%" } },
          ]}
        >
          {(z) => (
            // biome-ignore lint/a11y/noStaticElementInteractions: a target for a mouse drag; Settings › Layout places panels by keyboard
            <div
              class="slot-drop"
              classList={{ over: dropSlot() === z.slot }}
              style={z.style}
              onDragOver={(e) => {
                e.preventDefault();
                setDropSlot(z.slot);
              }}
              onDragLeave={() => setDropSlot(undefined)}
              onDrop={(e) => {
                e.preventDefault();
                dropPanel(z.slot);
              }}
            >
              {t(`settings-slot-${z.slot.replace(".", "-")}`)}
            </div>
          )}
        </For>
      </Show>
      <Show when={settingsOpen()}>
        <Settings
          say={(text) => mascotSay("info", text, { mood: "happy" })}
          onOutfitsChanged={loadMascot}
          onSeenReset={() => setSeen(new Set<string>())}
          restart={restart}
          config={config()}
          host={host}
          panels={[
            { id: MODS_PANEL, title: t("mods-title"), slot: slotOf(MODS_PANEL, "sidebar.right") },
            ...host.panels().map((p) => ({ id: p.id, title: p.title, slot: slotOf(p.id, p.slot) })),
          ]}
          onClose={() => {
            setSettingsOpen(false);
            setPreviewTheme(undefined);
            refocus();
          }}
          preview={setPreviewTheme}
          notify={showNotice}
        />
      </Show>
      <Show when={mascotShown() && mascotPlace() === "float"}>
        <MascotFloat store={mascot} outfit={outfit()} busy={busyPanes().size > 0} onClick={mascotClick} />
      </Show>
      <MascotLive store={mascot} />
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
        {(d) => (
          <ModDialog
            req={d.req}
            insert={insertText}
            copy={copyText}
            onClose={d.done}
            mascot={
              d.req.from === "otterm.onboarding" && mascotShown() ? (
                <MascotSprite
                  mood={mascot.mood()}
                  size={(config()?.guideLevel ?? 2) >= 3 ? 96 : 48}
                  outfit={outfit()}
                />
              ) : undefined
            }
          />
        )}
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
      {notice() && (
        <div class="notice" role="status">
          {notice()}
        </div>
      )}
    </div>
  );
}
