/**
 * @otterm/api — type definitions for otterm mods.
 *
 * Source of truth for the mod API; docs/05 defers to these types when they disagree.
 * Spec: docs/05-mod-system.md, docs/08-character.md, docs/10-ai-assist.md
 *
 * Design rules
 * - Every function that crosses the Worker boundary returns a Promise.
 * - Everything a mod registers returns a Disposable; the host disposes them on deactivate.
 * - Capabilities not declared in otmod.toml are *absent* from `ctx` at runtime.
 *   The optional (`?`) members below mark those capability-gated namespaces.
 */

// ---------------------------------------------------------------------------
// Runtime globals
// ---------------------------------------------------------------------------

/**
 * The mod sandbox starts with no host globals (no `fetch`, no DOM). Besides the ES2022
 * built-ins it provides only these timers; the host clears them on deactivate.
 * Decision M1 in docs/11-decisions.md.
 */
declare global {
  function setTimeout(callback: () => void, ms?: number): number;
  function clearTimeout(id: number | undefined): void;
  function setInterval(callback: () => void, ms?: number): number;
  function clearInterval(id: number | undefined): void;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** A mod's main module must export these. */
export interface ModModule {
  activate(ctx: ModContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export interface Disposable {
  dispose(): void;
}

/** A static value or a getter. Getters re-run when a `Signal` they read changes or on `ctx.ui.refresh()`. */
export type Reactive<T> = T | (() => T);

/** Minimal reactive cell. Reading inside a `Reactive` getter subscribes the UI to it. */
export interface Signal<T> {
  get(): T;
  set(value: T): void;
  update(fn: (prev: T) => T): void;
}

/** Plain string, or per-locale map such as { ja: "...", en: "..." }. */
export type LocalizedString = string | { [locale: string]: string };

export type Platform = "windows" | "macos" | "linux";
export type ShellKind = "bash" | "zsh" | "fish" | "pwsh" | "powershell" | "cmd" | "nushell" | "other";
export type GuideLevel = 0 | 1 | 2 | 3;

// ---------------------------------------------------------------------------
// ModContext
// ---------------------------------------------------------------------------

export interface ModContext {
  /** Mod id from the manifest, e.g. "example.git-status-bar". */
  readonly modId: string;
  /** Absolute path of the mod's directory. Readable via `ctx.fs` even without fs.read. */
  readonly modPath: string;
  readonly host: { version: string; apiVersion: 1; platform: Platform };

  readonly ui: UiApi;
  readonly commands: CommandsApi;
  readonly keybindings: KeybindingsApi;
  readonly session: SessionApi;
  readonly assist: AssistApi;
  readonly links: LinksApi;
  readonly settings: SettingsApi;
  readonly storage: StorageApi;
  readonly theme: ThemeApi;
  readonly i18n: I18nApi;
  readonly log: LogApi;
  readonly events: EventsApi;
  readonly mascot: MascotApi;
  readonly workspace: WorkspaceApi;

  /** Always present; members inside are gated by terminal.read / terminal.write. */
  readonly terminal: TerminalApi;
  /** Present only with fs.read and/or fs.write. */
  readonly fs?: FsApi;
  /** Present only with process. */
  readonly process?: ProcessApi;
  /** Present only with network. */
  readonly http?: HttpApi;
  /** Present only with clipboard. */
  readonly clipboard?: ClipboardApi;
  /** Present only with ai. Uses the provider the *user* configured; the mod cannot choose. */
  readonly ai?: AiApi;

  signal<T>(initial: T): Signal<T>;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export type SlotName =
  | "titlebar.left"
  | "titlebar.right"
  | "tabbar.before"
  | "tabbar.after"
  | "tab.decoration"
  | "sidebar.left"
  | "sidebar.right"
  | "panel.bottom"
  | "terminal.overlay"
  | "assist.bar"
  | "block.gutter"
  | "block.footer"
  | "statusbar.left"
  | "statusbar.right"
  | "mascot";

export type ContextMenuTarget = "context.terminal" | "context.tab" | "context.file" | "context.block";

export interface UiApi {
  slot(name: SlotName): SlotHandle;
  panel(def: PanelDefinition): Disposable;
  toast(opts: ToastOptions): Promise<void>;
  dialog<T extends string = string>(opts: DialogOptions<T>): Promise<T | null>;
  /** Native picker. Returned paths are readable regardless of fs globs (the user chose them). */
  pickPath(opts: {
    mode: "open-file" | "open-folder" | "save-file";
    title?: LocalizedString;
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<string | null>;
  contextMenu(target: ContextMenuTarget, items: Reactive<MenuItem[]>): Disposable;
  /** Re-evaluate every Reactive getter owned by this mod. Batched to the next frame. */
  refresh(): void;
}

export interface SlotHandle {
  add(component: Reactive<UiNode>, opts?: { order?: number }): Disposable;
}

export interface PanelDefinition {
  id: string;
  title: LocalizedString;
  icon?: IconName;
  slot: "sidebar.left" | "sidebar.right" | "panel.bottom";
  content: Reactive<UiNode>;
  badge?: Reactive<string | number | undefined>;
  onShow?(): void;
  onHide?(): void;
}

export interface ToastOptions {
  text: LocalizedString;
  kind?: "info" | "success" | "warning" | "danger";
  durationMs?: number;
  actions?: Action[];
}

export interface DialogOptions<T extends string> {
  title: LocalizedString;
  body?: Reactive<UiNode | LocalizedString>;
  buttons: { id: T; label: LocalizedString; variant?: "primary" | "danger" | "default" }[];
  cancelId?: T;
}

export interface MenuItem {
  label: LocalizedString;
  icon?: IconName;
  onClick(ctx: MenuClickContext): void;
  enabled?: boolean;
  children?: MenuItem[];
}

export interface MenuClickContext {
  sessionId?: SessionId;
  blockId?: BlockId;
  /** For context.file. */
  path?: string;
  /** Selected terminal text, if any. */
  selection?: string;
}

export interface Action {
  label: LocalizedString;
  onClick(): void;
  variant?: "primary" | "danger" | "default";
}

/** Lucide icon names plus otterm extras ("otter", "shell", "block"). Unknown names render a placeholder. */
export type IconName = string;

// Declarative UI --------------------------------------------------------------

export type UiNode =
  | TextNode
  | HeadingNode
  | StackNode
  | RowNode
  | ListNode
  | TreeNode
  | TableNode
  | ButtonNode
  | InputNode
  | SelectNode
  | ToggleNode
  | BadgeNode
  | ProgressNode
  | CodeNode
  | MarkdownNode
  | DividerNode
  | SpacerNode
  | SparklineNode
  | CustomNode;

interface BaseNode {
  /** Stable key for diffing node arrays. */
  key?: string;
  tooltip?: LocalizedString;
  /** Only `--ot-*` variables and a small whitelist of layout properties are honored. */
  style?: Partial<Record<"padding" | "margin" | "width" | "height" | "flex" | "color" | "background", string>>;
  hidden?: Reactive<boolean>;
}

export interface TextNode extends BaseNode {
  type: "text";
  text: Reactive<LocalizedString>;
  icon?: IconName;
  muted?: boolean;
  onClick?(): void;
}
export interface HeadingNode extends BaseNode {
  type: "heading";
  text: Reactive<LocalizedString>;
  level?: 1 | 2 | 3;
}
export interface StackNode extends BaseNode {
  type: "stack";
  children: Reactive<UiNode[]>;
  gap?: "none" | "s" | "m" | "l";
}
export interface RowNode extends BaseNode {
  type: "row";
  children: Reactive<UiNode[]>;
  gap?: "none" | "s" | "m" | "l";
  align?: "start" | "center" | "end" | "space-between";
}

export interface ListItem {
  key?: string;
  text: LocalizedString;
  secondary?: LocalizedString;
  icon?: IconName;
  badge?: string;
  onClick?(): void;
  contextMenu?: MenuItem[];
}
export interface ListNode extends BaseNode {
  type: "list";
  items: Reactive<ListItem[]>;
  /** Render only visible rows. The host forces this on above 200 items. */
  virtual?: boolean;
  selectable?: boolean;
  onSelect?(keys: string[]): void;
  emptyText?: LocalizedString;
}

export interface TreeItem {
  key: string;
  text: LocalizedString;
  icon?: IconName;
  badge?: string;
  /** `true` = has children, loaded lazily with `loadChildren`. Array = eager children. */
  children?: TreeItem[] | true;
  onClick?(): void;
  onDoubleClick?(): void;
  contextMenu?: MenuItem[];
  /** Drag payload. "path" payloads are inserted quoted into the terminal on drop. */
  drag?: { kind: "path"; path: string } | { kind: "text"; text: string };
}
export interface TreeNode extends BaseNode {
  type: "tree";
  roots: Reactive<TreeItem[]>;
  loadChildren?(key: string): Promise<TreeItem[]>;
  expanded?: Signal<Set<string>>;
  selected?: Signal<string | undefined>;
}

export interface TableColumn {
  key: string;
  title: LocalizedString;
  width?: number;
  sortable?: boolean;
  align?: "left" | "right";
}
export interface TableNode extends BaseNode {
  type: "table";
  columns: TableColumn[];
  rows: Reactive<Record<string, string | number | UiNode>[]>;
  rowKey?: string;
  virtual?: boolean;
  sort?: Signal<{ key: string; dir: "asc" | "desc" } | undefined>;
  onRowClick?(row: Record<string, unknown>): void;
}

export interface ButtonNode extends BaseNode {
  type: "button";
  text: LocalizedString;
  icon?: IconName;
  variant?: "primary" | "danger" | "default" | "ghost";
  disabled?: Reactive<boolean>;
  onClick(): void;
}
export interface InputNode extends BaseNode {
  type: "input";
  value: Signal<string>;
  placeholder?: LocalizedString;
  kind?: "text" | "password" | "number" | "search";
  onSubmit?(value: string): void;
}
export interface SelectNode extends BaseNode {
  type: "select";
  value: Signal<string>;
  options: Reactive<{ value: string; label: LocalizedString }[]>;
}
export interface ToggleNode extends BaseNode {
  type: "toggle";
  value: Signal<boolean>;
  label?: LocalizedString;
}
export interface BadgeNode extends BaseNode {
  type: "badge";
  text: Reactive<string>;
  kind?: "info" | "success" | "warning" | "danger" | "neutral";
}
export interface ProgressNode extends BaseNode {
  type: "progress";
  /** 0..1; undefined = indeterminate. */
  value: Reactive<number | undefined>;
  label?: LocalizedString;
}
export interface CodeNode extends BaseNode {
  type: "code";
  code: Reactive<string>;
  language?: string;
  /** Adds an "insert into terminal" button (uses ctx.terminal.insert; no permission needed). */
  insertable?: boolean;
  copyable?: boolean;
}
/** Sanitized Markdown; raw HTML is stripped. */
export interface MarkdownNode extends BaseNode {
  type: "markdown";
  source: Reactive<string>;
}
export interface DividerNode extends BaseNode {
  type: "divider";
}
export interface SpacerNode extends BaseNode {
  type: "spacer";
  size?: "s" | "m" | "l" | "flex";
}
export interface SparklineNode extends BaseNode {
  type: "sparkline";
  values: Reactive<number[]>;
  min?: number;
  max?: number;
  color?: "accent" | "success" | "warning" | "danger";
}

/**
 * Sandboxed iframe. HTML/CSS only; scripts are blocked by CSP (decision D7).
 * Assets from the mod directory are addressable as `otmod:///assets/...`.
 */
export interface CustomNode extends BaseNode {
  type: "custom";
  html: Reactive<string>;
  height?: number | "auto";
  /** Messages posted from the iframe via `parent.postMessage(data, "*")`. */
  onMessage?(data: unknown): void;
  /** Receives a function that posts messages into the iframe. */
  ref?(post: (data: unknown) => void): void;
}

// ---------------------------------------------------------------------------
// Commands & keybindings
// ---------------------------------------------------------------------------

export interface CommandMeta {
  title: LocalizedString;
  description?: LocalizedString;
  icon?: IconName;
  /** Hide from the palette (still bindable). */
  hidden?: boolean;
}

export interface CommandsApi {
  /** `id` is namespaced automatically as "<modId>.<id>" unless it already contains a dot. */
  register(
    id: string,
    handler: (args?: Record<string, unknown>) => void | Promise<void>,
    meta: CommandMeta,
  ): Disposable;
  run(id: string, args?: Record<string, unknown>): Promise<void>;
}

/** e.g. "ctrl+shift+g", "cmd+k cmd+s" (chord). `mod` expands to ctrl / cmd per platform. */
export type KeyChord = string;

/** Subset of the `when` grammar: identifiers, `!`, `&&`, `||`, comparisons on guideLevel. */
export type WhenClause = string;

export interface KeybindingsApi {
  /** A suggestion only; user bindings win and conflicts show in Settings. */
  suggest(command: string, key: KeyChord, when?: WhenClause): Disposable;
}

// ---------------------------------------------------------------------------
// Sessions, blocks, terminal
// ---------------------------------------------------------------------------

export type SessionId = string & { readonly __brand: "SessionId" };
export type BlockId = string & { readonly __brand: "BlockId" };

export interface SessionInfo {
  id: SessionId;
  profileId: string;
  shellKind: ShellKind;
  cwd: string;
  /** For WSL / Git Bash sessions: cwd translated to a host (Windows) path. */
  hostCwd?: string;
  title: string;
  integration: "full" | "partial" | "none";
  altScreen: boolean;
  /** Echo is off (password prompt). Assist is paused; do not store input. */
  echoOff: boolean;
  pid: number;
}

export interface Block {
  id: BlockId;
  sessionId: SessionId;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  exitCode?: number;
  /** Requires terminal.read; otherwise undefined. Truncated to the last 2000 lines. */
  output?: string;
}

export interface SessionApi {
  current(): Promise<SessionInfo | undefined>;
  get(id: SessionId): Promise<SessionInfo | undefined>;
  list(): Promise<SessionInfo[]>;
  onCwdChanged(cb: (e: { sessionId: SessionId; cwd: string; hostCwd?: string }) => void): Disposable;
  onCreated(cb: (s: SessionInfo) => void): Disposable;
  onClosed(cb: (e: { sessionId: SessionId; exitCode?: number }) => void): Disposable;
  onFocusChanged(cb: (e: { sessionId: SessionId }) => void): Disposable;
}

export interface InputState {
  sessionId: SessionId;
  line: string;
  cursor: number;
  /** false when the line was inferred (no shell integration). The UI marks it "estimated". */
  exact: boolean;
}

export type BeforeExecuteResult =
  | void
  | { action: "cancel" }
  | { action: "replace"; command: string }
  | {
      action: "confirm";
      title: LocalizedString;
      body?: LocalizedString;
      alternatives?: { label: LocalizedString; command: string }[];
    };

export interface TerminalApi {
  // --- no permission ---
  /** Insert text at the shell cursor without executing. Always available. */
  insert(text: string, opts?: { sessionId?: SessionId; replaceLine?: boolean }): Promise<void>;

  // --- terminal.read ---
  onInputChange?(cb: (s: InputState) => void): Disposable;
  /** Veto point. The host waits at most 50 ms (docs/09 §3.1). */
  onBeforeExecute?(
    cb: (e: {
      sessionId: SessionId;
      command: string;
      cwd: string;
    }) => BeforeExecuteResult | Promise<BeforeExecuteResult>,
  ): Disposable;
  onBlockStart?(cb: (b: Block) => void): Disposable;
  onBlockEnd?(cb: (b: Block) => void): Disposable;
  /** Raw output. Requires `events` to list "output". Batched, at most once per second. */
  onOutput?(cb: (e: { sessionId: SessionId; chunk: string }) => void): Disposable;
  screen?(sessionId: SessionId): Promise<{ lines: string[]; cursor: { row: number; col: number } }>;
  blocks?(sessionId: SessionId, opts?: { limit?: number; before?: BlockId }): Promise<Block[]>;
  selection?(sessionId?: SessionId): Promise<string | undefined>;

  // --- terminal.write ---
  /** Writes to the PTY. The host shows a toast naming the mod every time. */
  write?(sessionId: SessionId, text: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Assist (completion, explain, danger, error hints, dictionary)
// ---------------------------------------------------------------------------

export interface ParsedCommand {
  raw: string;
  /** Pipeline segments; most providers look at `segments.at(-1)`. */
  segments: {
    name: string;
    subcommand?: string;
    options: { flag: string; value?: string }[];
    args: string[];
    /** Character range in `raw`. */
    range: [number, number];
  }[];
  cwd: string;
  shellKind: ShellKind;
}

export interface CompletionItem {
  label: string;
  insertText?: string;
  detail?: LocalizedString;
  kind: "command" | "subcommand" | "option" | "file" | "dir" | "history" | "value" | "branch" | "custom";
  danger?: DangerLevel;
  recommended?: boolean;
  sortText?: string;
}

export interface CompletionProvider {
  /** Only called when the last segment's command matches (omit = all commands). */
  commands?: string[];
  provide(input: InputState, parsed: ParsedCommand): Promise<CompletionItem[]> | CompletionItem[];
}

export interface Explanation {
  /** 1–2 sentences. */
  summary: LocalizedString;
  /** Per-token notes shown on hover. */
  parts?: { range: [number, number]; text: LocalizedString; danger?: DangerLevel }[];
  danger?: DangerLevel;
}

export interface ExplainProvider {
  commands?: string[];
  provide(parsed: ParsedCommand): Promise<Explanation | undefined> | Explanation | undefined;
}

export type DangerLevel = "warn" | "confirm" | "block";

export interface DangerRule {
  id: string;
  level: DangerLevel;
  /** Structural matcher (preferred) or regex on the raw command line. */
  match:
    | { command: string; subcommand?: string; anyOption?: string[]; allOptions?: string[]; argPattern?: string }
    | { regex: string };
  message: LocalizedString;
  /** `{args}` expands to the original arguments. */
  alternatives?: { label: LocalizedString; command: string }[];
  platforms?: Platform[];
}

export interface ErrorHint {
  title: LocalizedString;
  body?: LocalizedString;
  /** Offered via an "insert" button; never auto-run. */
  fixCommand?: string;
  actions?: Action[];
  /** When true, the host adds an "Ask Kelp" button if the AI mod is enabled. */
  allowAi?: boolean;
}

export interface ErrorHintProvider {
  provide(block: Block & { output: string }): Promise<ErrorHint | undefined> | ErrorHint | undefined;
}

export interface AssistApi {
  parse(line: string, opts?: { cwd?: string; shellKind?: ShellKind }): Promise<ParsedCommand>;
  completions: { provide(p: CompletionProvider): Disposable };
  explain: { provide(p: ExplainProvider): Disposable };
  danger: {
    addRules(rules: DangerRule[]): Disposable;
    evaluate(parsed: ParsedCommand): Promise<{ level: DangerLevel; rule: DangerRule } | undefined>;
  };
  errorHints: { provide(p: ErrorHintProvider): Disposable };
  /** Dictionary entries (kind "dictionary" mods register through the manifest instead). */
  dictionary: {
    add(entries: DictionaryEntry[]): Disposable;
    lookup(command: string): Promise<DictionaryEntry | undefined>;
  };
  readonly guideLevel: Signal<GuideLevel>;
}

/** Mirrors schemas/dictionary.schema.json. */
export interface DictionaryEntry {
  name: string;
  aliases?: string[];
  platforms?: Platform[];
  shells?: ShellKind[];
  summary: LocalizedString;
  description?: LocalizedString;
  danger?: DangerLevel;
  dangerMessage?: LocalizedString;
  alternative?: { label: LocalizedString; command: string };
  subcommands?: DictionarySubcommand[];
  options?: DictionaryOption[];
  args?: DictionaryArg[];
  examples?: DictionaryExample[];
  errors?: DictionaryError[];
  /** Shown when a GUI action performed the equivalent of this command. */
  learn?: LocalizedString;
  /** Package manager → install command, for "command not found" hints. */
  install?: Partial<
    Record<
      "winget" | "scoop" | "choco" | "brew" | "apt" | "dnf" | "pacman" | "nix" | "npm" | "pip" | "cargo" | "url",
      string
    >
  >;
}
export interface DictionarySubcommand {
  name: string;
  aliases?: string[];
  summary: LocalizedString;
  description?: LocalizedString;
  danger?: DangerLevel;
  dangerMessage?: LocalizedString;
  alternative?: { label: LocalizedString; command: string };
  options?: DictionaryOption[];
  args?: DictionaryArg[];
  examples?: DictionaryExample[];
}
export interface DictionaryOption {
  flags: string[];
  summary: LocalizedString;
  takesValue?: boolean;
  valueType?: DictionaryArg["type"];
  danger?: DangerLevel;
  dangerMessage?: LocalizedString;
}
export interface DictionaryArg {
  name: string;
  type:
    | "path"
    | "file"
    | "dir"
    | "string"
    | "number"
    | "url"
    | "branch"
    | "remote"
    | "package"
    | "container"
    | "image"
    | "command"
    | "pattern";
  optional?: boolean;
  variadic?: boolean;
  summary?: LocalizedString;
}
export interface DictionaryExample {
  command: string;
  summary: LocalizedString;
}
export interface DictionaryError {
  pattern: string;
  hint: LocalizedString;
  fix?: string;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export type LinkTarget =
  | { kind: "url"; url: string; label?: LocalizedString }
  | { kind: "file"; path: string; line?: number; col?: number }
  | { kind: "command"; command: string; label: LocalizedString };

export interface LinksApi {
  addDetector(def: {
    id: string;
    regex: RegExp | string;
    /** Return undefined to drop the match (e.g. the file does not exist). */
    resolve(
      match: string,
      ctx: { sessionId: SessionId; cwd: string },
    ): Promise<LinkTarget | undefined> | LinkTarget | undefined;
  }): Disposable;
}

// ---------------------------------------------------------------------------
// Files, processes, network, clipboard (capability-gated)
// ---------------------------------------------------------------------------

export interface DirEntry {
  name: string;
  path: string;
  kind: "file" | "dir" | "symlink" | "other";
  size?: number;
  modifiedAt?: number;
  hidden: boolean;
}

export interface FsApi {
  readText(path: string, opts?: { maxBytes?: number }): Promise<string>;
  readBytes(path: string, opts?: { maxBytes?: number }): Promise<Uint8Array>;
  readDir(path: string, opts?: { includeHidden?: boolean }): Promise<DirEntry[]>;
  stat(path: string): Promise<DirEntry | undefined>;
  exists(path: string): Promise<boolean>;
  watch(path: string, cb: (e: { kind: "create" | "modify" | "remove"; path: string }) => void): Disposable;
  /** Expand ${cwd} ${home} ${workspace} ${mod} ${data}. */
  resolve(template: string, sessionId?: SessionId): Promise<string>;
  // --- fs.write ---
  writeText?(path: string, text: string): Promise<void>;
  writeBytes?(path: string, data: Uint8Array): Promise<void>;
  mkdir?(path: string): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
  /** Moves to the OS trash. Hard delete is intentionally not exposed. */
  trash?(path: string): Promise<void>;
}

export interface ChildProcess extends Disposable {
  onStdout(cb: (chunk: string) => void): Disposable;
  onStderr(cb: (chunk: string) => void): Disposable;
  onExit(cb: (code: number) => void): Disposable;
  write(data: string): Promise<void>;
  kill(): Promise<void>;
}

export interface ProcessApi {
  /** `cmd` must be in the manifest allow-list. Not a PTY; invisible to the user. */
  run(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; stdin?: string },
  ): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>;
  /** Streaming variant for long-running helpers (e.g. `docker events`). */
  spawn(cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<ChildProcess>;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  bytes(): Promise<Uint8Array>;
}

export interface HttpApi {
  /** The URL host must match a manifest `network` pattern. */
  fetch(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; timeoutMs?: number },
  ): Promise<HttpResponse>;
}

export interface ClipboardApi {
  /** First use prompts the user (decision D5). */
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Settings, storage, theme, i18n, log, events, workspace
// ---------------------------------------------------------------------------

export type HostSettingKey = "general.guide_level" | "general.language" | "appearance.theme" | "font.size";

export interface SettingsApi {
  get<T = unknown>(key: string): Promise<T>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  onChange(cb: (e: { key: string; value: unknown }) => void): Disposable;
  /** Read-only access to a few host settings. */
  host: { get<T = unknown>(key: HostSettingKey): Promise<T> };
}

export interface StorageApi {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
  /** Quota is 10 MB per mod. */
  usage(): Promise<{ bytes: number; quota: number }>;
}

export interface ThemeInfo {
  name: string;
  appearance: "light" | "dark";
  /** CSS variables, e.g. { "--ot-accent": "#4f8cff" }. */
  vars: Record<string, string>;
  terminal: { foreground: string; background: string; ansi: string[]; bright: string[] };
}
export interface ThemeApi {
  current(): Promise<ThemeInfo>;
  onChange(cb: (t: ThemeInfo) => void): Disposable;
}

export interface I18nApi {
  /** Fluent message id from the mod's locales/*.ftl. */
  t(id: string, vars?: Record<string, string | number>): string;
  readonly locale: string;
  /** Resolve a LocalizedString for the current locale (falls back to "en", then any). */
  resolve(s: LocalizedString): string;
}

export interface LogApi {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface EventsApi {
  /** Mod-to-mod messaging. Delivered as `custom:<modId>.<name>`. */
  emit(name: string, payload: unknown): void;
  on(name: string, cb: (payload: unknown, from: string) => void): Disposable;
  onTitleChanged(cb: (e: { sessionId: SessionId; title: string }) => void): Disposable;
}

export interface WorkspaceApi {
  current(): Promise<{ name?: string; root: string; trusted: boolean } | undefined>;
  onChanged(cb: () => void): Disposable;
}

// ---------------------------------------------------------------------------
// Mascot (Rakko / Kelp)
// ---------------------------------------------------------------------------

export type Mood = "calm" | "thinking" | "alert" | "happy";

export interface SayOptions {
  mood?: Mood;
  /** ms; 0 = until dismissed. Default 4000. */
  duration?: number;
  actions?: Action[];
  /** Interrupts the queue. Only honored together with mood "alert". */
  urgent?: boolean;
}

export type ReactionEvent = "block-end" | "block-start" | "cwd-changed" | "session-created" | "input-changed";

export interface ReactionRule {
  id?: string;
  on: ReactionEvent;
  when?(payload: Block | InputState | SessionInfo | { sessionId: SessionId; cwd: string }): boolean;
  mood?: Mood;
  /** "i18n:<fluent-id>" or a literal LocalizedString. */
  say?: string | LocalizedString;
  once?: "never" | "per-session" | "per-day" | "always";
}

export type OutfitSlot = "head" | "face" | "body" | "hand" | "shell" | "back" | "effect";

export interface Outfit {
  id: string;
  name: LocalizedString;
  base?: "default" | "custom";
  layers?: { slot: OutfitSlot; svgPath: string }[];
  moods?: Partial<Record<Mood, string>>;
  lines?: Record<string, LocalizedString>;
}

export interface MascotApi {
  /** Resolves when the bubble closes. Rate-limited to 3/min per mod. At guide level 0 it degrades to a toast. */
  say(text: LocalizedString, opts?: SayOptions): Promise<void>;
  setMood(mood: Mood, opts?: { for?: number }): Promise<void>;
  onMoodChanged(cb: (mood: Mood) => void): Disposable;
  readonly visible: Signal<boolean>;
  reactions: { add(rule: ReactionRule): Disposable };
  outfits: {
    register(outfit: Outfit): Disposable;
    current(): Promise<string>;
    list(): Promise<Outfit[]>;
  };
}

// ---------------------------------------------------------------------------
// AI (capability "ai")
// ---------------------------------------------------------------------------

export interface AiCompleteRequest {
  /** Shown to the user in the consent preview. Required. */
  purpose: LocalizedString;
  prompt: string;
  system?: string;
  /** Host-managed context. The mod cannot inject session data except through these flags. */
  context?: { include?: ("cwd" | "os" | "shell" | "lastBlock" | "selection")[] };
  maxTokens?: number;
  json?: boolean;
}

export interface AiCompleteResult {
  text: string;
  provider: "local" | "cloud";
  model: string;
  /** Set when the host trimmed context due to redaction or size. */
  truncated?: boolean;
}

export interface AiApi {
  /** Rate-limited to 10/min per mod. Always shows a toast naming the mod and purpose. */
  complete(req: AiCompleteRequest): Promise<AiCompleteResult>;
  stream(req: AiCompleteRequest, onChunk: (text: string) => void): Promise<AiCompleteResult>;
  available(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Manifest (otmod.toml) as a type, for tooling
// ---------------------------------------------------------------------------

export type ModKind = "theme" | "layout" | "dictionary" | "workflows" | "outfit" | "extension" | "pack";

export type ManifestEvent =
  | "session-created"
  | "session-closed"
  | "cwd-changed"
  | "input-changed"
  | "before-execute"
  | "block-start"
  | "block-end"
  | "output"
  | "title-changed"
  | "focus-changed";

export interface Manifest {
  mod: {
    id: string;
    name: string;
    version: string;
    description?: string;
    author: string;
    license?: string;
    homepage?: string;
    kind: ModKind;
    icon?: string;
  };
  compat: { otterm: string; api: "1"; platforms?: Platform[] };
  entry?: { main: string };
  adds?: ({ slot: SlotName; label: string } | { command: string; label: string } | { panel: string; label: string })[];
  permissions?: {
    process?: string[];
    "fs.read"?: string[];
    "fs.write"?: string[];
    network?: string[];
    clipboard?: boolean;
    ai?: boolean;
    "terminal.read"?: boolean;
    "terminal.write"?: boolean;
    events?: ManifestEvent[];
  };
  settings?: { schema: Record<string, SettingSchema> };
  dependencies?: Record<string, string>;
}

export type SettingSchema =
  | { type: "boolean"; default: boolean; label: string; description?: string }
  | {
      type: "integer" | "number";
      default: number;
      min?: number;
      max?: number;
      step?: number;
      label: string;
      description?: string;
    }
  | { type: "string"; default: string; pattern?: string; label: string; description?: string; secret?: boolean }
  | { type: "enum"; default: string; values: { value: string; label: string }[]; label: string; description?: string }
  | { type: "path"; default: string; mode?: "file" | "dir"; label: string; description?: string }
  | { type: "color"; default: string; label: string; description?: string }
  | { type: "keychord"; default: string; label: string; description?: string };
