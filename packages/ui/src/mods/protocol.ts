/**
 * Messages between the UI thread (the mod host, `host.ts`) and a mod's Web Worker (`worker.ts`).
 * One Worker per mod (docs/02 §4.3); everything crossing is JSON.
 */
import type { SerializedNode } from "./tree";

/** What the Worker needs to start a mod. */
export interface ModInit {
  modId: string;
  modPath: string;
  /** The bundled ESM source of `entry.main`. */
  source: string;
  manifest: ManifestInfo;
  host: { version: string; apiVersion: 1; platform: "windows" | "macos" | "linux" };
  locale: "ja" | "en";
  /** Fluent sources by locale from the mod's `locales/`. */
  locales: Record<string, string>;
  /** The mod's settings with defaults applied. */
  settings: Record<string, unknown>;
  /** The caller's view of the theme, for `ctx.theme.current()`. */
  theme: ThemeInfo;
  /** Longest a single callback may run before it is interrupted (ms). */
  deadlineMs: number;
  /** `general.guide_level`, for `ctx.assist.guideLevel`. */
  guideLevel: unknown;
}

/** The parts of the manifest the sandbox needs (which namespaces exist). */
export interface ManifestInfo {
  permissions: {
    process: string[];
    fsRead: string[];
    fsWrite: string[];
    network: string[];
    clipboard: boolean;
    ai: boolean;
    terminalRead: boolean;
    terminalWrite: boolean;
    events: string[];
  };
}

export interface ThemeInfo {
  name: string;
  appearance: "light" | "dark";
  vars: Record<string, string>;
  terminal: { foreground: string; background: string; ansi: string[]; bright: string[] };
}

export type HostToWorker =
  | { t: "init"; init: ModInit }
  /** An event the mod subscribed to (session-created, cwd-changed, block-end, …). With `id`, the
   * host wants the handlers' return values back as a `result` (before-execute). */
  | { t: "event"; name: string; payload: unknown; id?: number }
  /** `general.guide_level` changed (ctx.assist.guideLevel). */
  | { t: "guide"; level: number }
  /** A host setting a mod may watch changed (ctx.settings.host.onChange). */
  | { t: "hostSetting"; key: string; value: unknown }
  /** Run a mod callback (a UI handler, a command, a `loadChildren`). `id` gets a `result` back. */
  | { t: "invoke"; id: number; fn: number; args: unknown[] }
  /** The user edited a Signal-backed control. */
  | { t: "signal"; sig: number; value: unknown }
  /** Answer to a `call`. */
  | { t: "reply"; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: "settings"; settings: Record<string, unknown>; changed: string[] }
  | { t: "theme"; theme: ThemeInfo }
  | { t: "deactivate" }
  /** Liveness check; the Worker answers `pong`. */
  | { t: "ping"; id: number };

/** One item a mod put in a Slot, or a panel it registered. */
export interface UiItem {
  /** The registration's id inside the mod. */
  reg: number;
  slot: string;
  order: number;
  node: SerializedNode;
}
export interface PanelItem {
  reg: number;
  id: string;
  title: string;
  icon?: string;
  slot: "sidebar.left" | "sidebar.right" | "panel.bottom";
  badge?: string;
  node: SerializedNode;
}

export type WorkerToHost =
  | { t: "ready" }
  | { t: "activated"; ms: number }
  | { t: "deactivated" }
  /** The mod threw or hung; the host deactivates it (docs/05 §4). */
  | { t: "crash"; message: string }
  | { t: "log"; level: "debug" | "info" | "warn" | "error"; args: unknown[] }
  /** A host API call that needs an answer (`reply`). `ns.method` such as "fs.readText". */
  | { t: "call"; id: number; method: string; args: unknown[] }
  /** The mod's slot items and panels, whole, after a render. */
  | { t: "ui"; items: UiItem[]; panels: PanelItem[]; dialogs?: { reg: number; node: SerializedNode }[] }
  | { t: "result"; id: number; ok: boolean; value?: unknown; error?: string }
  | { t: "pong"; id: number }
  /** Registrations without UI. */
  | { t: "command"; id: string; title: string; description?: string; icon?: string; hidden: boolean; fn: number }
  | { t: "unregister"; kind: "command"; id: string }
  | { t: "keybinding"; command: string; key: string; when?: string }
  | { t: "subscribe"; event: string }
  | { t: "unsubscribe"; event: string }
  /** Menu items for a right-click target (`context.terminal`, `context.block`, …). */
  | { t: "contextMenu"; target: string; reg: number; items: SerializedMenu[] | null }
  /** An assist provider (docs/03 §8): the host invokes `fn` with the provider's arguments. */
  | { t: "provider"; kind: "completion" | "explain" | "errorHint"; reg: number; fn: number; commands?: string[] }
  | { t: "unprovide"; reg: number }
  /** Danger rules (`ctx.assist.danger.addRules`) and dictionary entries (`ctx.assist.dictionary.add`). */
  | { t: "rules"; reg: number; rules: unknown[] | null }
  | { t: "dictionary"; reg: number; entries: unknown[] | null };

export interface SerializedMenu {
  label: string;
  icon?: string;
  fn: number;
  enabled?: boolean;
  children?: SerializedMenu[];
}
