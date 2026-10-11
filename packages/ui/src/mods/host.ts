/**
 * The mod host on the UI thread (docs/02 §4.2 `modbridge`): finds installed mods, starts one Web
 * Worker per enabled mod (worker.ts), relays API calls to Rust (the capability broker,
 * docs/05 §6) and to the window, and collects what the mods want drawn. Lifecycle and crash
 * handling follow docs/05 §4.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createSignal } from "solid-js";
import { type ParsedCommand, parseCommand } from "../assist/parse";
import { t } from "../i18n";
import { matches, parseChord } from "../keymap";
import type {
  HostToWorker,
  ManifestInfo,
  PanelItem,
  SerializedMenu,
  ThemeInfo,
  UiItem,
  WorkerToHost,
} from "./protocol";
import type { SerializedNode } from "./tree";

/** How long a mod callback may run (docs/05 §4: unresponsive for 5 s). */
const DEADLINE_MS = 5000;
/** Crashes in a row before a mod is disabled for good (docs/05 §4). */
const MAX_CRASHES = 3;
/** Liveness: how often to ping an active Worker, and how long to wait for the pong. */
const PING_EVERY_MS = 10_000;
const PONG_TIMEOUT_MS = 5000;
const LOG_LIMIT = 200;
/** Block output handed to mods is truncated to this many lines (`Block.output`). */
const OUTPUT_LINES = 2000;
/** How long before-execute waits for a mod (docs/09 §3.1). */
const BEFORE_EXECUTE_MS = 50;
/** How long a provider may take before its answer is dropped. */
const PROVIDER_MS = 400;

/** A danger rule as `DangerRule` in @otterm/api (plain data). */
export interface DangerRule {
  id: string;
  level: "warn" | "confirm" | "block";
  match:
    | { command: string; subcommand?: string; anyOption?: string[]; allOptions?: string[]; argPattern?: string }
    | { regex: string };
  message: string | Record<string, string>;
  alternatives?: { label: string | Record<string, string>; command: string }[];
  platforms?: string[];
}

/** A dictionary entry (`DictionaryEntry`), kept as JSON. */
export type DictionaryEntry = Record<string, unknown> & {
  name: string;
  aliases?: string[];
  danger?: "warn" | "confirm" | "block";
  dangerMessage?: unknown;
  alternative?: { label: unknown; command: string };
  subcommands?: DictionarySub[];
  options?: DictionaryOption[];
};
interface DictionarySub {
  name: string;
  aliases?: string[];
  summary?: unknown;
  danger?: "warn" | "confirm" | "block";
  dangerMessage?: unknown;
  alternative?: { label: unknown; command: string };
  options?: DictionaryOption[];
}
interface DictionaryOption {
  flags: string[];
  danger?: "warn" | "confirm" | "block";
  dangerMessage?: unknown;
  alternative?: { label: unknown; command: string };
}

export interface Explanation {
  summary: string;
  parts?: { range: [number, number]; text: string; danger?: string }[];
  danger?: string;
}
export interface CompletionItem {
  label: string;
  insertText?: string;
  /** Replace the whole line rather than the word at the cursor (history items). */
  replaceLine?: boolean;
  detail?: string;
  kind: string;
  danger?: string;
  recommended?: boolean;
  sortText?: string;
}
export interface ErrorHint {
  title: string;
  body?: string;
  fixCommand?: string;
  actions?: { label: string; fn?: number; variant?: string }[];
  allowAi?: boolean;
  /** The mod it came from, for its action callbacks. */
  mod: string;
}
export type BeforeExecuteVerdict =
  | { action: "run" }
  | { action: "cancel" }
  | { action: "replace"; command: string }
  | { action: "confirm"; title: string; body?: string; alternatives: { label: string; command: string }[] };

interface Provider {
  kind: "completion" | "explain" | "errorHint";
  mod: string;
  fn: number;
  commands?: string[];
}

/** An installed mod as `mods_list` (Rust) describes it. */
export interface ModEntry {
  id: string;
  dir: string;
  name: string;
  version: string;
  description: string;
  author: string;
  kind: string;
  official: boolean;
  /** Installed with `--link`: a symlink to a checkout; its main.js is watched for changes. */
  linked: boolean;
  enabled: boolean;
  granted: boolean;
  problems: string[];
  permissions: ManifestInfo["permissions"];
  adds: { slot?: string; command?: string; panel?: string; label: string }[];
  settings: Record<string, unknown>;
  settingsSchema: Record<string, unknown>;
  hasEntry: boolean;
}

export type ModStatus =
  | "inactive"
  | "starting"
  | "active"
  | "crashed"
  | "disabled"
  | "needs-grant"
  | "error"
  | "stopping";

export interface LogEntry {
  at: number;
  level: "debug" | "info" | "warn" | "error";
  text: string;
}

export interface ModState {
  entry: ModEntry;
  status: ModStatus;
  /** Why it is `error` or `crashed`. */
  message?: string;
  /** How long `activate` took, for developer mode and decision C2. */
  activateMs?: number;
  crashes: number;
  logs: LogEntry[];
  /** API calls by method: count and total time, for developer mode (docs/05 §8.2). */
  calls: Record<string, { n: number; ms: number }>;
}

/** What the host needs from the window (App.tsx). */
export interface SessionSnapshot {
  id: number;
  /** The shell's folder as a path (from OSC 7), if known. */
  cwd?: string;
  title: string;
  profileId: string;
  /** The shell program, to guess `shellKind`. */
  shell: string;
  /** The shell integration has reported a block. */
  integrated: boolean;
  /** For WSL and Git Bash sessions: `cwd` as a Windows path. */
  hostCwd?: string;
  /** Echo is off (a password prompt, decision K2). */
  echoOff: boolean;
}

export interface ToastRequest {
  text: string;
  kind?: "info" | "success" | "warning" | "danger";
  durationMs?: number;
  actions: { label: string; variant?: string; onClick: () => void }[];
  /** The mod it came from, shown so the user knows who is talking. */
  from: string;
}

export interface DialogRequest {
  title: string;
  body?: string | SerializedNode;
  buttons: { id: string; label: string; variant?: string }[];
  cancelId?: string;
  from: string;
  /** The renderer needs a host for a `body` tree. */
  tree?: TreeHostFor;
}

export interface TreeHostFor {
  invoke(fn: { $fn: number }, args?: unknown[]): Promise<unknown>;
  setSignal(sig: { $sig: number }, value: unknown): void;
}

export interface HostEnv {
  activeSession(): SessionSnapshot | undefined;
  sessions(): SessionSnapshot[];
  /** Type text at a session's prompt without running it (ctx.terminal.insert). */
  insert(sessionId: number, text: string): Promise<void>;
  /** Write to the PTY (ctx.terminal.write): the user confirms the first use and sees a toast. */
  write(sessionId: number, text: string): Promise<void>;
  toast(req: ToastRequest): void;
  dialog(req: DialogRequest): Promise<string | null>;
  /** Yes / no question for permission confirmations (decision D5). */
  confirm(title: string, body: string): Promise<boolean>;
  theme(): ThemeInfo;
  locale(): "ja" | "en";
  hostSetting(key: string): unknown;
  /** Run one of otterm's own commands (e.g. `otterm.panel.show`); false when there is none. */
  runHostCommand(id: string, args: Record<string, unknown> | undefined): boolean;
  /** `[mods] developer_mode`. */
  developerMode(): boolean;
}

export interface HostCommand {
  id: string;
  mod: string;
  title: string;
  description?: string;
  icon?: string;
  hidden: boolean;
  fn: number;
}

export interface ContextMenuEntry {
  mod: string;
  items: SerializedMenu[];
}

/** A block as mods see it (`Block` in @otterm/api). */
export interface BlockPayload {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  exitCode?: number;
  output?: string;
}

interface Running {
  worker: Worker;
  subs: Set<string>;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: string) => void }>;
  nextInvoke: number;
  pingTimer?: ReturnType<typeof setInterval>;
  pongTimer?: ReturnType<typeof setTimeout>;
  pingId: number;
  /** Timer handles of mod toasts' actions and the like are plain functions here. */
  confirmedWrite: boolean;
  confirmedClipboardRead: boolean;
}

export class ModHost {
  private readonly env: HostEnv;
  private readonly running = new Map<string, Running>();
  private readonly states = new Map<string, ModState>();
  private readonly commands = new Map<string, HostCommand>();
  private readonly keys: { chord: ReturnType<typeof parseChord>; command: string; when?: string }[] = [];
  private unlisten: (() => void)[] = [];
  /** Block start times by "session:line", to fill `startedAt`. */
  private readonly blockStarts = new Map<string, number>();

  readonly mods: () => ModState[];
  private readonly setMods: (v: ModState[]) => void;
  readonly items: () => (UiItem & { mod: string })[];
  private readonly setItems: (v: (UiItem & { mod: string })[]) => void;
  readonly panels: () => (PanelItem & { mod: string })[];
  private readonly setPanels: (v: (PanelItem & { mod: string })[]) => void;
  /** Mods waiting for the user to approve their permissions, in order (one dialog at a time). */
  readonly pendingGrants: () => ModEntry[];
  private readonly setPendingGrants: (v: ModEntry[]) => void;
  readonly menus: () => Map<string, ContextMenuEntry[]>;
  private readonly setMenus: (v: Map<string, ContextMenuEntry[]>) => void;
  private readonly menuRegs = new Map<string, { target: string; items: SerializedMenu[] }>();
  private readonly uiByMod = new Map<string, { items: UiItem[]; panels: PanelItem[] }>();
  // --- assist (docs/03 §8): providers, rules and the dictionary, by "mod#reg" ----------------
  private readonly providers = new Map<string, Provider>();
  private readonly ruleSets = new Map<string, DangerRule[]>();
  private readonly dictSets = new Map<string, DictionaryEntry[]>();
  /** Dictionary mods whose JSON is loaded (`mod_dictionary`). */
  private readonly loadedDictionaries = new Set<string>();
  private dictionary = new Map<string, DictionaryEntry>();
  private rules: DangerRule[] = [];
  private guideLevel = 2;

  constructor(env: HostEnv) {
    this.env = env;
    [this.mods, this.setMods] = createSignal<ModState[]>([]);
    [this.items, this.setItems] = createSignal<(UiItem & { mod: string })[]>([]);
    [this.panels, this.setPanels] = createSignal<(PanelItem & { mod: string })[]>([]);
    [this.pendingGrants, this.setPendingGrants] = createSignal<ModEntry[]>([]);
    [this.menus, this.setMenus] = createSignal(new Map<string, ContextMenuEntry[]>());
  }

  /** Find the installed mods and start the enabled ones. Mods are lazy (docs/09 §3.5): call this
   * after the first tab is up. */
  async start() {
    this.unlisten.push(
      await listen<string[]>("mods-changed", (e) => {
        // A linked mod whose bundle was rebuilt restarts (docs/05 §8.1 hot reload).
        for (const id of e.payload) this.requestReload(id);
        void this.refresh();
      }),
    );
    await this.refresh();
  }

  dispose() {
    for (const f of this.unlisten) f();
    for (const id of [...this.running.keys()]) this.stop(id, "inactive");
  }

  /** Re-read the installed mods; start, stop or restart to match. */
  async refresh() {
    let list: ModEntry[];
    try {
      list = await invoke<ModEntry[]>("mods_list");
    } catch (e) {
      console.error("mods_list failed", e);
      return;
    }
    const seen = new Set<string>();
    this.guideLevel = Number(this.env.hostSetting("general.guide_level") ?? 2);
    for (const entry of list) {
      seen.add(entry.id);
      // Dictionaries have no code: their JSON goes straight into the registry (docs/03 §8.1).
      if (entry.kind === "dictionary") {
        const wanted = entry.enabled && entry.problems.length === 0;
        if (wanted && !this.loadedDictionaries.has(entry.id)) await this.loadDictionary(entry.id);
        if (!wanted && this.loadedDictionaries.has(entry.id)) this.unloadDictionary(entry.id);
      }
      const prev = this.states.get(entry.id);
      const state: ModState = prev ?? { entry, status: "inactive", crashes: 0, logs: [], calls: {} };
      const changedSettings = prev ? diffKeys(prev.entry.settings, entry.settings) : [];
      state.entry = entry;
      this.states.set(entry.id, state);
      const wanted = entry.enabled && entry.hasEntry && entry.problems.length === 0;
      if (!wanted) {
        if (this.running.has(entry.id)) this.stop(entry.id, "inactive");
        state.status = entry.problems.length > 0 ? "error" : entry.enabled && !entry.hasEntry ? "inactive" : "disabled";
        state.message = entry.problems[0];
        continue;
      }
      if (!entry.granted) {
        state.status = "needs-grant";
        if (!this.pendingGrants().some((g) => g.id === entry.id))
          this.setPendingGrants([...this.pendingGrants(), entry]);
        continue;
      }
      // A linked mod whose bundle changed restarts (hot reload, docs/05 §8.1).
      if (this.running.has(entry.id) && prev && prev.entry.version === entry.version && !entry.linked) {
        if (changedSettings.length > 0)
          this.send(entry.id, { t: "settings", settings: entry.settings, changed: changedSettings });
        continue;
      }
      if (this.running.has(entry.id) && changedSettings.length > 0 && !this.reloadRequested.has(entry.id)) {
        this.send(entry.id, { t: "settings", settings: entry.settings, changed: changedSettings });
        continue;
      }
      if (this.running.has(entry.id) && !this.reloadRequested.has(entry.id)) continue;
      this.reloadRequested.delete(entry.id);
      if (state.crashes >= MAX_CRASHES) continue;
      await this.launch(state);
    }
    for (const id of [...this.states.keys()]) {
      if (seen.has(id)) continue;
      this.stop(id, "inactive");
      this.states.delete(id);
      this.uiByMod.delete(id);
      if (this.loadedDictionaries.has(id)) this.unloadDictionary(id);
    }
    this.setPendingGrants(this.pendingGrants().filter((g) => seen.has(g.id) && !this.states.get(g.id)?.entry.granted));
    this.publish();
  }

  /** The UI language changed: every mod restarts, its translations are fixed at start. */
  restartAll() {
    for (const id of this.running.keys()) this.requestReload(id);
    void this.refresh();
  }

  /** `general.guide_level` changed (status bar, onboarding): mods see it through ctx.assist.guideLevel. */
  setGuideLevel(level: number) {
    this.guideLevel = level;
    for (const id of this.running.keys()) this.send(id, { t: "guide", level });
  }

  /** A host setting mods may watch changed (`ctx.settings.host.onChange`). */
  hostSettingChanged(key: string, value: unknown) {
    for (const id of this.running.keys()) this.send(id, { t: "hostSetting", key, value });
  }

  // --- assist (docs/03 §8) ---------------------------------------------------------------------

  private async loadDictionary(id: string) {
    try {
      const data = await invoke<{ entries: DictionaryEntry[]; rules: DangerRule[] }>("mod_dictionary", { id });
      this.dictSets.set(`${id}#dict`, data.entries);
      this.ruleSets.set(`${id}#rules`, data.rules);
      this.loadedDictionaries.add(id);
      this.rebuildAssist();
    } catch (e) {
      console.error(`dictionary ${id}`, e);
    }
  }

  private unloadDictionary(id: string) {
    this.dictSets.delete(`${id}#dict`);
    this.ruleSets.delete(`${id}#rules`);
    this.loadedDictionaries.delete(id);
    this.rebuildAssist();
  }

  private rebuildAssist() {
    const dict = new Map<string, DictionaryEntry>();
    // Later sets win (a mod can override a bundled entry), so bundled dictionaries go first.
    for (const entries of this.dictSets.values()) {
      for (const e of entries) {
        if (!e || typeof e.name !== "string") continue;
        dict.set(e.name.toLowerCase(), e);
        for (const a of e.aliases ?? []) dict.set(a.toLowerCase(), e);
      }
    }
    this.dictionary = dict;
    this.rules = [...this.ruleSets.values()].flat().filter((r) => r && typeof r.id === "string" && r.match);
  }

  lookup(name: string): DictionaryEntry | undefined {
    return this.dictionary.get(name.toLowerCase());
  }

  /** The dictionary, or else what otterm learned from the command's `--help` (decision B9). */
  async lookupWithHelp(name: string): Promise<DictionaryEntry | undefined> {
    const known = this.lookup(name);
    if (known || !name) return known;
    const help = await invoke<{ name: string; summary: string; options: [string[], string][] } | null>("help_get", {
      name,
    }).catch(() => null);
    if (!help?.summary) return undefined;
    return {
      name: help.name,
      summary: { en: help.summary, ja: help.summary },
      options: help.options.map(([flags, summary]) => ({ flags, summary: { en: summary, ja: summary } })),
      source: "help",
    } as DictionaryEntry;
  }

  /** Every command name the dictionary knows, aliases included (for first-word completion). */
  dictionaryNames(): string[] {
    return [...this.dictionary.keys()];
  }

  /** The dictionary's entries once each (the palette's `?` search). */
  dictionaryEntries(): DictionaryEntry[] {
    return [...new Set(this.dictionary.values())];
  }

  parse(line: string, cwd = "", shellKind = "other"): ParsedCommand {
    return parseCommand(line, cwd, shellKind);
  }

  /** The strongest danger rule a command line hits (docs/03 §8.3): rules, then dictionary marks. */
  evaluate(parsed: ParsedCommand): { level: "warn" | "confirm" | "block"; rule: DangerRule } | undefined {
    const platform = platformName();
    const rank = { warn: 1, confirm: 2, block: 3 };
    let best: { level: "warn" | "confirm" | "block"; rule: DangerRule } | undefined;
    const consider = (rule: DangerRule) => {
      if (!best || rank[rule.level] > rank[best.level]) best = { level: rule.level, rule };
    };
    for (const rule of this.rules) {
      if (rule.platforms && !rule.platforms.includes(platform)) continue;
      if (ruleMatches(rule, parsed)) consider(rule);
    }
    for (const seg of parsed.segments) {
      const entry = this.lookup(seg.name);
      if (!entry) continue;
      const loc = (v: unknown) => localized(v, this.env.locale());
      const sub = seg.subcommand
        ? entry.subcommands?.find((s) => s.name === seg.subcommand || s.aliases?.includes(seg.subcommand ?? ""))
        : undefined;
      const alt = (a?: { label: unknown; command: string }) =>
        a ? [{ label: loc(a.label), command: a.command }] : undefined;
      if (sub?.danger) {
        consider({
          id: `dict.${entry.name}.${sub.name}`,
          level: sub.danger,
          match: { command: entry.name, subcommand: sub.name },
          message: loc(sub.dangerMessage ?? sub.summary),
          alternatives: alt(sub.alternative),
        });
      } else if (entry.danger && !seg.subcommand) {
        consider({
          id: `dict.${entry.name}`,
          level: entry.danger,
          match: { command: entry.name },
          message: loc(entry.dangerMessage ?? entry.summary),
          alternatives: alt(entry.alternative),
        });
      }
      const options = [...(entry.options ?? []), ...(sub?.options ?? [])];
      for (const o of seg.options) {
        const def = options.find((d) => d.flags.includes(o.flag));
        if (def?.danger) {
          consider({
            id: `dict.${entry.name}.${o.flag}`,
            level: def.danger,
            match: { command: entry.name, anyOption: [o.flag] },
            message: loc(def.dangerMessage),
            alternatives: alt(def.alternative),
          });
        }
      }
    }
    return best;
  }

  private providersOf(kind: Provider["kind"], command?: string): Provider[] {
    return [...this.providers.values()].filter(
      (p) => p.kind === kind && this.running.has(p.mod) && (!p.commands || !command || p.commands.includes(command)),
    );
  }

  private async ask<T>(p: Provider, args: unknown[]): Promise<T | undefined> {
    const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), PROVIDER_MS));
    try {
      return (await Promise.race([this.invoke(p.mod, p.fn, args), timeout])) as T | undefined;
    } catch (e) {
      this.log(p.mod, "warn", `${p.kind} provider: ${String(e)}`);
      return undefined;
    }
  }

  /** The first explanation a provider gives for the line (docs/03 §8.1). */
  async explain(parsed: ParsedCommand): Promise<Explanation | undefined> {
    const name = parsed.segments.at(-1)?.name;
    for (const p of this.providersOf("explain", name)) {
      const r = await this.ask<Explanation>(p, [parsed]);
      if (r?.summary) return r;
    }
    return undefined;
  }

  /** Completion items from every provider (docs/03 §8.2). */
  async complete(
    input: { sessionId: string; line: string; cursor: number; exact: boolean },
    parsed: ParsedCommand,
  ): Promise<CompletionItem[]> {
    const name = parsed.segments.at(-1)?.name;
    const lists = await Promise.all(
      this.providersOf("completion", name).map((p) => this.ask<CompletionItem[]>(p, [input, parsed])),
    );
    const seen = new Set<string>();
    const out: CompletionItem[] = [];
    for (const list of lists) {
      for (const it of list ?? []) {
        const key = `${it.kind}:${it.insertText ?? it.label}`;
        if (!it?.label || seen.has(key)) continue;
        seen.add(key);
        out.push(it);
      }
    }
    out.sort((a, b) => (a.sortText ?? a.label).localeCompare(b.sortText ?? b.label));
    return out.slice(0, 50);
  }

  /** The first hint a provider gives for a failed block (docs/03 §8.4). */
  async errorHint(block: BlockPayload): Promise<ErrorHint | undefined> {
    for (const p of this.providersOf("errorHint")) {
      const r = await this.ask<Omit<ErrorHint, "mod">>(p, [block]);
      if (r?.title) return { ...r, mod: p.mod };
    }
    return undefined;
  }

  /**
   * Enter was pressed with `line` at the prompt: mods that subscribed to before-execute get at
   * most 50 ms each (docs/09 §3.1). A cancel wins over a confirm, which wins over a replace.
   */
  async beforeExecute(session: SessionSnapshot, line: string): Promise<BeforeExecuteVerdict> {
    const payload = { sessionId: String(session.id), command: line, cwd: session.cwd ?? "" };
    const asks: Promise<unknown[]>[] = [];
    for (const [id, r] of this.running) {
      if (!r.subs.has("before-execute") || !this.states.get(id)?.entry.permissions.terminalRead) continue;
      const reqId = r.nextInvoke++;
      const started = performance.now();
      const p = new Promise<unknown[]>((resolve) => {
        const timer = setTimeout(() => {
          r.pending.delete(reqId);
          this.log(id, "warn", `before-execute took over ${BEFORE_EXECUTE_MS} ms; the command ran`);
          resolve([]);
        }, BEFORE_EXECUTE_MS);
        r.pending.set(reqId, {
          resolve: (v) => {
            clearTimeout(timer);
            if (this.env.developerMode())
              this.log(id, "debug", `before-execute ${Math.round(performance.now() - started)} ms`);
            resolve(Array.isArray(v) ? v : []);
          },
          reject: () => {
            clearTimeout(timer);
            resolve([]);
          },
        });
      });
      r.worker.postMessage({ t: "event", name: "before-execute", payload, id: reqId } satisfies HostToWorker);
      asks.push(p);
    }
    const results = (await Promise.all(asks)).flat() as (Record<string, unknown> | undefined)[];
    let verdict: BeforeExecuteVerdict = { action: "run" };
    const rank = { run: 0, replace: 1, confirm: 2, cancel: 3 };
    for (const r of results) {
      if (!r || typeof r !== "object" || typeof r.action !== "string") continue;
      const a = r.action;
      let v: BeforeExecuteVerdict | undefined;
      if (a === "cancel") v = { action: "cancel" };
      else if (a === "replace" && typeof r.command === "string") v = { action: "replace", command: r.command };
      else if (a === "confirm") {
        const alts = Array.isArray(r.alternatives) ? (r.alternatives as { label: string; command: string }[]) : [];
        v = {
          action: "confirm",
          title: String(r.title ?? ""),
          body: r.body === undefined ? undefined : String(r.body),
          alternatives: alts.filter((x) => x && typeof x.command === "string"),
        };
      }
      if (v && rank[v.action] > rank[verdict.action]) verdict = v;
    }
    return verdict;
  }

  /** Mods whose source changed on disk (Rust reports the ids); they restart on the next refresh. */
  private readonly reloadRequested = new Set<string>();
  requestReload(id: string) {
    this.reloadRequested.add(id);
  }

  /** The user approved the permission list (docs/05 §6.2). */
  async grant(id: string) {
    await invoke("mod_grant", { id });
    this.setPendingGrants(this.pendingGrants().filter((g) => g.id !== id));
    await this.refresh();
  }

  /** The user declined: the mod is disabled so the question does not come back at every start. */
  async decline(id: string) {
    this.setPendingGrants(this.pendingGrants().filter((g) => g.id !== id));
    await invoke("mod_set_enabled", { id, enabled: false });
    await this.refresh();
  }

  async setEnabled(id: string, enabled: boolean) {
    const state = this.states.get(id);
    if (state && enabled) state.crashes = 0;
    await invoke("mod_set_enabled", { id, enabled });
    await this.refresh();
  }

  async uninstall(id: string) {
    this.stop(id, "inactive");
    await invoke("mod_uninstall", { id });
    await this.refresh();
  }

  async install(path: string, link: boolean) {
    await invoke("mod_install", { path, link });
    await this.refresh();
  }

  // --- events from the window -------------------------------------------------------------------

  /** Deliver an event to the mods that subscribed to it. */
  emit(name: string, payload: unknown) {
    for (const [id, r] of this.running) {
      if (!r.subs.has(name)) continue;
      // `output` needs the manifest's say-so as well (docs/05 §5.4, decision D11).
      const perms = this.states.get(id)?.entry.permissions;
      if (name === "output" && !perms?.events.includes("output")) continue;
      if ((name === "block-start" || name === "block-end" || name === "output") && !perms?.terminalRead) continue;
      r.worker.postMessage({ t: "event", name, payload } satisfies HostToWorker);
    }
  }

  /** A block started or ended in a session; the block's text is fetched for the mods that may read it. */
  async emitBlock(
    kind: "block-start" | "block-end",
    session: SessionSnapshot,
    line: number,
    exit?: number,
    ms?: number,
  ) {
    const key = `${session.id}:${line}`;
    const now = Date.now();
    if (kind === "block-start") this.blockStarts.set(key, now);
    const startedAt = this.blockStarts.get(key) ?? now - (ms ?? 0);
    if (kind === "block-end") this.blockStarts.delete(key);
    const anyone = [...this.running.values()].some((r) => r.subs.has(kind));
    if (!anyone) return;
    let command = "";
    let output: string | undefined;
    try {
      const b = await invoke<{ command: string | null; output: string } | null>("session_block", {
        id: session.id,
        line,
      });
      command = b?.command ?? "";
      if (kind === "block-end" && b) output = lastLines(b.output, OUTPUT_LINES);
    } catch {
      // The block is gone (scrollback cleared); the event still goes out.
    }
    const block: BlockPayload = {
      id: `${session.id}:${line}`,
      sessionId: String(session.id),
      command,
      cwd: session.cwd ?? "",
      startedAt,
      ...(kind === "block-end" ? { endedAt: now, durationMs: ms, exitCode: exit, output } : {}),
    };
    this.emit(kind, block);
  }

  /** A key the window did not bind itself: a mod's suggested binding (docs/06 §5; user keys win). */
  matchKey(e: KeyboardEvent, altScreen: boolean): string | undefined {
    for (const k of this.keys) {
      if (!k.chord || !matches(k.chord, e)) continue;
      if (!when(k.when, altScreen)) continue;
      if (this.commands.has(k.command)) return k.command;
    }
    return undefined;
  }

  /** Commands for the palette and keybindings. */
  commandList(): HostCommand[] {
    return [...this.commands.values()];
  }

  /** Run a command: a mod's, else one of otterm's own. Resolves to false when nobody has it. */
  async runCommand(id: string, args?: Record<string, unknown>): Promise<boolean> {
    const c = this.commands.get(id);
    if (!c) return this.env.runHostCommand(id, args);
    try {
      await this.invoke(c.mod, c.fn, [args]);
    } catch (e) {
      this.log(c.mod, "error", `command ${id}: ${String(e)}`);
    }
    return true;
  }

  /** The renderer's way back into a mod: run a callback by id. */
  invoke(mod: string, fn: number, args: unknown[] = []): Promise<unknown> {
    const r = this.running.get(mod);
    if (!r) return Promise.reject(new Error(`${mod} is not running`));
    const id = r.nextInvoke++;
    return new Promise((resolve, reject) => {
      r.pending.set(id, { resolve, reject: (e) => reject(new Error(e)) });
      r.worker.postMessage({ t: "invoke", id, fn, args } satisfies HostToWorker);
    });
  }

  setSignal(mod: string, sig: number, value: unknown) {
    this.send(mod, { t: "signal", sig, value });
  }

  /** A `TreeHost`-shaped pair for the renderer, bound to one mod. */
  treeHostFor(mod: string): TreeHostFor {
    return {
      invoke: (fn, args) => this.invoke(mod, fn.$fn, args),
      setSignal: (sig, value) => this.setSignal(mod, sig.$sig, value),
    };
  }

  /** Mods' right-click items for a target (`context.terminal`, `context.block`, …). */
  menuItems(target: string): { label: string; mod: string; fn: number; enabled: boolean }[] {
    const out: { label: string; mod: string; fn: number; enabled: boolean }[] = [];
    for (const e of this.menus().get(target) ?? []) {
      const walk = (items: SerializedMenu[], prefix: string) => {
        for (const it of items) {
          const label = prefix ? `${prefix} › ${it.label}` : it.label;
          if (it.children?.length) walk(it.children, label);
          else out.push({ label, mod: e.mod, fn: it.fn, enabled: it.enabled !== false });
        }
      };
      walk(e.items, "");
    }
    return out;
  }

  themeChanged(theme: ThemeInfo) {
    for (const id of this.running.keys()) this.send(id, { t: "theme", theme });
  }

  state(id: string): ModState | undefined {
    return this.states.get(id);
  }

  // --- lifecycle ---------------------------------------------------------------------------------

  private async launch(state: ModState) {
    const { entry } = state;
    if (this.running.has(entry.id)) this.stop(entry.id, "inactive");
    state.status = "starting";
    state.message = undefined;
    this.publish();
    let source: { source: string; locales: Record<string, string> };
    try {
      source = await invoke("mod_source", { id: entry.id });
    } catch (e) {
      state.status = "error";
      state.message = String(e);
      this.publish();
      return;
    }
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: `mod:${entry.id}` });
    const r: Running = {
      worker,
      subs: new Set(),
      pending: new Map(),
      nextInvoke: 1,
      pingId: 0,
      confirmedWrite: false,
      confirmedClipboardRead: false,
    };
    this.running.set(entry.id, r);
    worker.onmessage = (e: MessageEvent<WorkerToHost>) => this.onMessage(entry.id, e.data);
    worker.onerror = (e) => this.crashed(entry.id, e.message || "worker error");
    worker.postMessage({
      t: "init",
      init: {
        modId: entry.id,
        modPath: entry.dir,
        source: source.source,
        manifest: { permissions: entry.permissions },
        host: { version: "0.0.0", apiVersion: 1, platform: platformName() },
        locale: this.env.locale(),
        locales: source.locales,
        settings: entry.settings,
        theme: this.env.theme(),
        deadlineMs: DEADLINE_MS,
        guideLevel: this.guideLevel,
      },
    } satisfies HostToWorker);
  }

  private stop(id: string, status: ModStatus) {
    const r = this.running.get(id);
    if (!r) return;
    this.running.delete(id);
    clearInterval(r.pingTimer);
    clearTimeout(r.pongTimer);
    for (const p of r.pending.values()) p.reject("the mod stopped");
    // Give the mod its deactivate(), then end the Worker whatever it does.
    r.worker.postMessage({ t: "deactivate" } satisfies HostToWorker);
    const kill = setTimeout(() => r.worker.terminate(), 1000);
    r.worker.onmessage = (e: MessageEvent<WorkerToHost>) => {
      if (e.data.t === "deactivated") {
        clearTimeout(kill);
        r.worker.terminate();
      }
    };
    this.forget(id);
    const state = this.states.get(id);
    if (state) state.status = status;
    this.publish();
  }

  /** Everything the mod registered is withdrawn (docs/05 §4 deactivated). */
  private forget(id: string) {
    for (const [cid, c] of this.commands) if (c.mod === id) this.commands.delete(cid);
    for (let i = this.keys.length - 1; i >= 0; i--) {
      const k = this.keys[i];
      if (k && !this.commands.has(k.command) && k.command.startsWith(`${id}.`)) this.keys.splice(i, 1);
    }
    for (const key of [...this.menuRegs.keys()]) if (key.startsWith(`${id}#`)) this.menuRegs.delete(key);
    for (const key of [...this.providers.keys()]) if (key.startsWith(`${id}#`)) this.providers.delete(key);
    let assist = false;
    for (const key of [...this.ruleSets.keys()]) {
      if (key.startsWith(`${id}#`) && key !== `${id}#rules`) {
        this.ruleSets.delete(key);
        assist = true;
      }
    }
    for (const key of [...this.dictSets.keys()]) {
      if (key.startsWith(`${id}#`) && key !== `${id}#dict`) {
        this.dictSets.delete(key);
        assist = true;
      }
    }
    if (assist) this.rebuildAssist();
    this.uiByMod.delete(id);
    this.publishUi();
    this.publishMenus();
  }

  private crashed(id: string, message: string) {
    const state = this.states.get(id);
    const r = this.running.get(id);
    if (r) {
      this.running.delete(id);
      clearInterval(r.pingTimer);
      clearTimeout(r.pongTimer);
      for (const p of r.pending.values()) p.reject("the mod crashed");
      r.worker.terminate();
    }
    this.forget(id);
    if (!state) return;
    state.crashes++;
    state.status = "crashed";
    state.message = message;
    this.log(id, "error", `crashed: ${message}`);
    if (state.crashes >= MAX_CRASHES) {
      // Three in a row: off until the user turns it back on (docs/05 §4).
      void invoke("mod_set_enabled", { id, enabled: false }).catch(() => {});
      this.env.toast({
        text: t("mod-crashed-disabled", { name: state.entry.name }),
        kind: "danger",
        actions: [],
        from: id,
      });
    } else {
      this.env.toast({
        text: t("mod-crashed-toast", { name: state.entry.name, message: firstLine(message) }),
        kind: "warning",
        actions: [],
        from: id,
      });
    }
    this.publish();
  }

  private send(id: string, msg: HostToWorker) {
    this.running.get(id)?.worker.postMessage(msg);
  }

  private onMessage(id: string, msg: WorkerToHost) {
    const r = this.running.get(id);
    const state = this.states.get(id);
    if (!r || !state) return;
    switch (msg.t) {
      case "ready":
        break;
      case "activated":
        state.status = "active";
        state.activateMs = msg.ms;
        state.crashes = 0;
        this.log(id, "info", `activated in ${msg.ms} ms`);
        this.startPings(id, r);
        this.publish();
        break;
      case "deactivated":
        break;
      case "crash":
        this.crashed(id, msg.message);
        break;
      case "log":
        this.log(id, msg.level, msg.args.map(show).join(" "));
        break;
      case "call":
        void this.handleCall(id, r, msg.id, msg.method, msg.args);
        break;
      case "ui":
        this.uiByMod.set(id, { items: msg.items, panels: msg.panels });
        this.publishUi();
        break;
      case "result": {
        const p = r.pending.get(msg.id);
        if (!p) break;
        r.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(msg.error ?? "error");
        break;
      }
      case "pong":
        if (msg.id === r.pingId) {
          clearTimeout(r.pongTimer);
          r.pongTimer = undefined;
        }
        break;
      case "command":
        this.commands.set(msg.id, { ...msg, mod: id });
        break;
      case "unregister":
        this.commands.delete(msg.id);
        break;
      case "keybinding":
        this.keys.push({ chord: parseChord(msg.key), command: msg.command, when: msg.when });
        break;
      case "subscribe":
        r.subs.add(msg.event);
        break;
      case "unsubscribe":
        r.subs.delete(msg.event);
        break;
      case "contextMenu": {
        const key = `${id}#${msg.reg}`;
        if (msg.items) this.menuRegs.set(key, { target: msg.target, items: msg.items });
        else this.menuRegs.delete(key);
        this.publishMenus();
        break;
      }
      case "provider":
        this.providers.set(`${id}#${msg.reg}`, { kind: msg.kind, mod: id, fn: msg.fn, commands: msg.commands });
        break;
      case "unprovide":
        this.providers.delete(`${id}#${msg.reg}`);
        break;
      case "rules":
        if (msg.rules) this.ruleSets.set(`${id}#${msg.reg}`, msg.rules as DangerRule[]);
        else this.ruleSets.delete(`${id}#${msg.reg}`);
        this.rebuildAssist();
        break;
      case "dictionary":
        if (msg.entries) this.dictSets.set(`${id}#${msg.reg}`, msg.entries as DictionaryEntry[]);
        else this.dictSets.delete(`${id}#${msg.reg}`);
        this.rebuildAssist();
        break;
    }
  }

  private startPings(id: string, r: Running) {
    clearInterval(r.pingTimer);
    r.pingTimer = setInterval(() => {
      if (r.pongTimer) return;
      r.pingId++;
      r.worker.postMessage({ t: "ping", id: r.pingId } satisfies HostToWorker);
      r.pongTimer = setTimeout(() => this.crashed(id, "no response for 5 s"), PONG_TIMEOUT_MS);
    }, PING_EVERY_MS);
  }

  // --- API calls from a mod -----------------------------------------------------------------------

  private async handleCall(id: string, r: Running, callId: number, method: string, args: unknown[]) {
    const state = this.states.get(id);
    const started = performance.now();
    let reply: HostToWorker;
    try {
      const value = await this.call(id, r, method, args);
      reply = { t: "reply", id: callId, ok: true, value };
    } catch (e) {
      reply = { t: "reply", id: callId, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (state) {
      state.calls[method] ??= { n: 0, ms: 0 };
      const s = state.calls[method];
      s.n++;
      s.ms += performance.now() - started;
      if (this.env.developerMode())
        this.log(
          id,
          "debug",
          `${method} ${Math.round(performance.now() - started)} ms${reply.ok ? "" : ` → ${reply.error}`}`,
        );
    }
    if (this.running.get(id) === r) r.worker.postMessage(reply);
  }

  private async call(id: string, r: Running, method: string, args: unknown[]): Promise<unknown> {
    const state = this.states.get(id);
    if (!state) throw new Error("unknown mod");
    const perms = state.entry.permissions;
    const active = this.env.activeSession();
    const cwd = active?.cwd;
    const a = args as unknown[];
    switch (method) {
      // --- UI
      case "ui.toast": {
        const o = a[0] as {
          text: string;
          kind?: ToastRequest["kind"];
          durationMs?: number;
          actions: { label: string; variant?: string; fn: number }[];
        };
        this.env.toast({
          text: o.text,
          kind: o.kind,
          durationMs: o.durationMs,
          from: id,
          actions: o.actions.map((x) => ({
            label: x.label,
            variant: x.variant,
            onClick: () => void this.invoke(id, x.fn).catch(() => {}),
          })),
        });
        return undefined;
      }
      case "ui.dialog": {
        const o = a[0] as unknown as Omit<DialogRequest, "from" | "tree">;
        return this.env.dialog({ ...o, from: id, tree: this.treeHostFor(id) });
      }
      case "ui.pickPath":
        throw new Error("ui.pickPath is not available yet");
      // --- commands
      case "commands.run": {
        const [cid, cargs] = a as unknown as [string, Record<string, unknown> | undefined];
        if (!(await this.runCommand(cid, cargs))) throw new Error(`no command ${cid}`);
        return undefined;
      }
      // --- sessions
      case "session.current":
        return active && sessionInfo(active);
      case "session.get": {
        const s = this.env.sessions().find((x) => String(x.id) === String(a[0]));
        return s && sessionInfo(s);
      }
      case "session.list":
        return this.env.sessions().map(sessionInfo);
      // --- terminal
      case "terminal.insert": {
        const [text, opts] = a as unknown as [string, { sessionId?: string; replaceLine?: boolean } | undefined];
        const target = opts?.sessionId ? Number(opts.sessionId) : active?.id;
        if (target === undefined) throw new Error("no session");
        await this.env.insert(target, text);
        return undefined;
      }
      case "terminal.write": {
        if (!perms.terminalWrite) throw new Error("terminal.write is not granted");
        const [sid, text] = a as unknown as [string, string];
        // The most abused permission: confirmed again the first time it is used (decision D5).
        if (!r.confirmedWrite) {
          const ok = await this.env.confirm(
            t("mod-write-confirm-title", { name: state.entry.name }),
            t("mod-write-confirm-body"),
          );
          if (!ok) throw new Error("the user refused terminal.write");
          r.confirmedWrite = true;
        }
        await this.env.write(Number(sid), text);
        this.env.toast({
          text: t("mod-wrote-terminal", { name: state.entry.name, text: firstLine(text).slice(0, 80) }),
          kind: "warning",
          actions: [],
          from: id,
        });
        return undefined;
      }
      case "terminal.screen": {
        if (!perms.terminalRead) throw new Error("terminal.read is not granted");
        const sid = Number(a[0] ?? active?.id);
        const [lines, [row, col]] = await invoke<[string[], [number, number]]>("session_screen", { id: sid });
        return { lines, cursor: { row, col } };
      }
      case "terminal.blocks": {
        if (!perms.terminalRead) throw new Error("terminal.read is not granted");
        const sid = Number(a[0] ?? active?.id);
        const opts = (a[1] ?? {}) as { limit?: number };
        const list = await invoke<{ line: number; command: string | null; running: boolean; exit: number | null }[]>(
          "session_blocks",
          { id: sid },
        );
        return list
          .filter((b) => b.command)
          .slice(-(opts.limit ?? 100))
          .map((b) => ({
            id: `${sid}:${b.line}`,
            sessionId: String(sid),
            command: b.command ?? "",
            cwd: "",
            startedAt: 0,
            exitCode: b.exit ?? undefined,
          }));
      }
      case "terminal.selection":
        throw new Error("terminal.selection is not available yet");
      // --- settings and storage
      case "settings.set": {
        const [key, value] = a as unknown as [string, unknown];
        if (!(key in state.entry.settingsSchema)) throw new Error(`no setting ${key} in the manifest`);
        await invoke("mod_setting_set", { id, key, value });
        return undefined;
      }
      case "settings.host": {
        const key = String(a[0]);
        if (!HOST_KEYS.includes(key)) throw new Error(`${key} is not readable`);
        return this.env.hostSetting(key);
      }
      case "settings.hostSet": {
        const [key, value] = a as unknown as [string, unknown];
        if (!state.entry.official) throw new Error("only otterm's own mods may change host settings");
        if (!HOST_KEYS.includes(key)) throw new Error(`${key} cannot be set`);
        await invoke("config_set", { key, value });
        return undefined;
      }
      // --- assist
      case "assist.parse": {
        const [line, opts] = a as unknown as [string, { cwd?: string; shellKind?: string } | undefined];
        return this.parse(
          String(line ?? ""),
          opts?.cwd ?? cwd ?? "",
          opts?.shellKind ?? (active ? sessionInfo(active).shellKind : "other"),
        );
      }
      case "assist.evaluate":
        return this.evaluate(a[0] as ParsedCommand);
      case "assist.lookup":
        return this.lookupWithHelp(String(a[0] ?? ""));
      case "storage.get": {
        // Missing keys come back as JSON null; the API promises undefined.
        const v = await invoke("mod_storage", { id, op: "get", key: a[0] ?? null, value: null });
        return v === null ? undefined : v;
      }
      case "storage.set":
      case "storage.delete":
      case "storage.keys":
      case "storage.usage":
        return invoke("mod_storage", {
          id,
          op: method.slice("storage.".length),
          key: a[0] ?? null,
          value: a[1] ?? null,
        });
      // --- capabilities, checked again in Rust (docs/05 §6.1)
      case "fs.readText":
      case "fs.readBytes":
      case "fs.readDir":
      case "fs.stat":
      case "fs.exists":
      case "fs.resolve":
      case "fs.writeText":
      case "fs.writeBytes":
      case "fs.mkdir":
      case "fs.rename":
      case "fs.trash":
        return invoke("mod_fs", { id, cwd: cwd ?? null, op: method.slice("fs.".length), args: a });
      case "process.run": {
        const [cmd, pargs, opts] = a as unknown as [
          string,
          string[],
          { cwd?: string; env?: Record<string, string>; timeoutMs?: number; stdin?: string } | undefined,
        ];
        return invoke("mod_process_run", { id, cwd: cwd ?? null, cmd, args: pargs, opts: opts ?? {} });
      }
      case "http.fetch": {
        const [url, opts] = a as unknown as [string, Record<string, unknown> | undefined];
        return invoke("mod_http_fetch", { id, url, opts: opts ?? {} });
      }
      case "clipboard.read": {
        if (!perms.clipboard) throw new Error("clipboard is not granted");
        if (!r.confirmedClipboardRead) {
          const ok = await this.env.confirm(
            t("mod-clipboard-confirm-title", { name: state.entry.name }),
            t("mod-clipboard-confirm-body"),
          );
          if (!ok) throw new Error("the user refused clipboard.read");
          r.confirmedClipboardRead = true;
        }
        return invoke("clipboard_read");
      }
      case "clipboard.write":
        if (!perms.clipboard) throw new Error("clipboard is not granted");
        return invoke("clipboard_write", { text: String(a[0]) });
      // --- mod-to-mod
      case "events.emit": {
        const [name, payload] = a as unknown as [string, unknown];
        this.emit(`custom:${id}.${name}`, { payload, from: id });
        return undefined;
      }
      default:
        throw new Error(`unknown API ${method}`);
    }
  }

  // --- signals for the UI --------------------------------------------------------------------------

  private publish() {
    this.setMods([...this.states.values()].sort((x, y) => x.entry.id.localeCompare(y.entry.id)));
  }

  private publishUi() {
    const items: (UiItem & { mod: string })[] = [];
    const panels: (PanelItem & { mod: string })[] = [];
    for (const [mod, ui] of this.uiByMod) {
      for (const it of ui.items) items.push({ ...it, mod });
      for (const p of ui.panels) panels.push({ ...p, mod });
    }
    items.sort((x, y) => x.order - y.order || x.mod.localeCompare(y.mod) || x.reg - y.reg);
    this.setItems(items);
    this.setPanels(panels);
  }

  private publishMenus() {
    const m = new Map<string, ContextMenuEntry[]>();
    for (const [key, reg] of this.menuRegs) {
      const mod = key.slice(0, key.indexOf("#"));
      const list = m.get(reg.target) ?? [];
      list.push({ mod, items: reg.items });
      m.set(reg.target, list);
    }
    this.setMenus(m);
  }

  private log(id: string, level: LogEntry["level"], text: string) {
    const state = this.states.get(id);
    if (!state) return;
    state.logs.push({ at: Date.now(), level, text });
    if (state.logs.length > LOG_LIMIT) state.logs.splice(0, state.logs.length - LOG_LIMIT);
    if (level === "error" || level === "warn") console[level](`[mod ${id}]`, text);
    // Also on disk (<data>/logs/mods.log): a toast is gone before anyone can read it.
    if (level === "error" || level === "warn" || this.env.developerMode()) {
      void invoke("mod_log", { id, level, text }).catch(() => {});
    }
    this.publish();
  }
}

const HOST_KEYS = [
  "general.guide_level",
  "general.language",
  "appearance.theme",
  "appearance.follow_system",
  "general.check_updates",
  "shell.default_profile",
  "font.size",
];

/** A `LocalizedString` (string or per-locale map) in `locale`, English second. */
export function localized(v: unknown, locale: string): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const m = v as Record<string, string>;
    return m[locale] ?? m.en ?? Object.values(m)[0] ?? "";
  }
  return "";
}

/** `DangerRule.match` against a parsed line: a regex on the raw line, or the structure of a segment. */
function ruleMatches(rule: DangerRule, parsed: ParsedCommand): boolean {
  const m = rule.match;
  if ("regex" in m) {
    try {
      return new RegExp(m.regex, "i").test(parsed.raw);
    } catch {
      return false;
    }
  }
  return parsed.segments.some((seg) => {
    if (seg.name.toLowerCase() !== m.command.toLowerCase()) return false;
    if (m.subcommand !== undefined && seg.subcommand !== m.subcommand) return false;
    const flags = seg.options.map((o) => o.flag);
    if (m.anyOption && !m.anyOption.some((f) => flags.includes(f))) return false;
    if (m.allOptions && !m.allOptions.every((f) => flags.includes(f))) return false;
    if (m.argPattern) {
      try {
        const re = new RegExp(m.argPattern);
        if (!seg.args.some((x) => re.test(x))) return false;
      } catch {
        return false;
      }
    }
    return true;
  });
}

function sessionInfo(s: SessionSnapshot) {
  const shell =
    s.shell
      .toLowerCase()
      .replace(/\.exe$/, "")
      .split(/[\\/]/)
      .pop() ?? "";
  const shellKind = ["bash", "zsh", "fish", "pwsh", "powershell", "cmd"].includes(shell)
    ? shell
    : shell === "nu"
      ? "nushell"
      : "other";
  return {
    id: String(s.id),
    profileId: s.profileId,
    shellKind,
    cwd: s.cwd ?? "",
    hostCwd: s.hostCwd,
    title: s.title,
    integration: s.integrated ? "full" : "none",
    altScreen: false,
    echoOff: s.echoOff,
    // Not tracked yet; 0 says so rather than inventing one.
    pid: 0,
  };
}

/** A tiny `when` clause: identifiers joined by `&&`, each optionally negated (docs/06 §5). */
function when(clause: string | undefined, altScreen: boolean): boolean {
  if (!clause) return true;
  return clause.split("&&").every((term) => {
    const t = term.trim();
    const neg = t.startsWith("!");
    const name = neg ? t.slice(1).trim() : t;
    const value = name === "terminalFocus" ? true : name === "altScreen" ? altScreen : undefined;
    if (value === undefined) return false;
    return neg ? !value : value;
  });
}

function platformName(): "windows" | "macos" | "linux" {
  return /Mac/.test(navigator.userAgent) ? "macos" : /Windows/.test(navigator.userAgent) ? "windows" : "linux";
}

function diffKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.length <= n ? text : lines.slice(-n).join("\n");
}

function firstLine(s: string): string {
  return s.split("\n")[0] ?? "";
}

function show(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}
