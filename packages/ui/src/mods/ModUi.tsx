/**
 * The window's parts for mods: the status bar with its Slots (docs/04 §1.1), side and bottom
 * panels, the permission screen (docs/05 §6.2), toasts and dialogs mods ask for, and the mods
 * list with developer mode (docs/05 §8.2).
 */
import { createMemo, createSignal, For, Show } from "solid-js";
import { t } from "../i18n";
import type { DialogRequest, ModEntry, ModHost, ModState, ToastRequest } from "./host";
import type { PanelItem } from "./protocol";
import { iconGlyph, ModTree } from "./render";
import type { TreeHost } from "./tree";
import "./chrome.css";

/** The renderer's host for one mod's trees. */
export function treeHost(
  host: ModHost,
  mod: string,
  insert: (text: string) => void,
  copy: (text: string) => void,
): TreeHost {
  const h = host.treeHostFor(mod);
  return {
    invoke: h.invoke,
    setSignal: h.setSignal,
    insert,
    copy,
    contextMenu: () => {},
  };
}

export interface StatusBarProps {
  host: ModHost;
  /** Folder name of the active pane, shown at the left (docs/04 §1). */
  folder: string;
  /** Exit code of the last command in the active pane, if the shell integration reported one. */
  lastExit?: number;
  insert: (text: string) => void;
  copy: (text: string) => void;
  onModsClick: () => void;
  /** `general.guide_level`; a click cycles it (docs/03 §11.2). */
  guideLevel: number;
  onGuideClick: () => void;
}

export function StatusBar(props: StatusBarProps) {
  const left = createMemo(() => props.host.items().filter((i) => i.slot === "statusbar.left"));
  const right = createMemo(() => props.host.items().filter((i) => i.slot === "statusbar.right"));
  const summary = createMemo(() => {
    const mods = props.host.mods();
    const active = mods.filter((m) => m.status === "active").length;
    const broken = mods.filter((m) => m.status === "crashed" || m.status === "error").length;
    return { active, broken, pending: props.host.pendingGrants().length };
  });
  return (
    <div class="statusbar" role="status" data-ot="statusbar">
      <div class="statusbar-side">
        <Show when={props.folder}>
          <span class="statusbar-item" data-ot="statusbar-item" title={t("status-folder")}>
            <span class="mt-icon" aria-hidden="true">
              {iconGlyph("folder")}
            </span>
            {props.folder}
          </span>
        </Show>
        <For each={left()}>
          {(it) => (
            <span class="statusbar-item" data-ot="statusbar-item" data-mod={it.mod}>
              <ModTree node={it.node} host={treeHost(props.host, it.mod, props.insert, props.copy)} context="status" />
            </span>
          )}
        </For>
      </div>
      <div class="statusbar-side right">
        <For each={right()}>
          {(it) => (
            <span class="statusbar-item" data-ot="statusbar-item" data-mod={it.mod}>
              <ModTree node={it.node} host={treeHost(props.host, it.mod, props.insert, props.copy)} context="status" />
            </span>
          )}
        </For>
        <button
          type="button"
          class="statusbar-item statusbar-button"
          data-ot="statusbar-item"
          title={t("status-guide")}
          onClick={() => props.onGuideClick()}
        >
          {t("status-guide-level", { level: props.guideLevel })}
        </button>
        <Show when={props.lastExit !== undefined && props.lastExit !== 0}>
          <span class="statusbar-item failed" data-ot="statusbar-item" title={t("status-exit")}>
            ✗ {props.lastExit}
          </span>
        </Show>
        <button
          type="button"
          class="statusbar-item statusbar-button"
          data-ot="statusbar-item"
          classList={{ failed: summary().broken > 0, attention: summary().pending > 0 }}
          title={t("status-mods")}
          onClick={() => props.onModsClick()}
        >
          ⚙ {t("status-mods-count", { n: summary().active })}
          {summary().broken > 0 ? ` · ${t("status-mods-broken", { n: summary().broken })}` : ""}
        </button>
      </div>
    </div>
  );
}

export interface PanelsProps {
  host: ModHost;
  slot: "sidebar.left" | "sidebar.right" | "panel.bottom";
  /** The panel shown, by id; nothing when undefined. */
  shown: string | undefined;
  onShow: (id: string | undefined) => void;
  insert: (text: string) => void;
  copy: (text: string) => void;
  /** Built-in panels rendered by the window itself, such as the mods list. */
  builtin?: { id: string; title: string; render: () => import("solid-js").JSX.Element }[];
  /** Where a panel goes (`appearance.panels` moves them; docs/04 §1.1); defaults to the mod's slot. */
  slotOf?: (id: string, slot: string) => string;
  /** A panel's tab is being dragged (to another slot), or the drag ended. */
  onDrag?: (id: string | undefined) => void;
}

/** A panel area: tabs for the panels mods put there, and the one that is open (docs/04 §1.1). */
export function Panels(props: PanelsProps) {
  const panels = createMemo(() =>
    props.host.panels().filter((p) => (props.slotOf ? props.slotOf(p.id, p.slot) : p.slot) === props.slot),
  );
  const drag = (id: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer?.setData("application/x-otterm-panel", id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      props.onDrag?.(id);
    },
    onDragEnd: () => props.onDrag?.(undefined),
  });
  const current = createMemo(() => panels().find((p) => p.id === props.shown));
  const builtin = createMemo(() => props.builtin?.find((b) => b.id === props.shown));
  const titleOf = (p: PanelItem) => p.title;
  return (
    <Show when={props.shown && (current() || builtin())}>
      <div class="side-panel" data-ot={props.slot} data-slot={props.slot}>
        <div class="side-panel-tabs" role="tablist">
          <For each={props.builtin ?? []}>
            {(b) => (
              <button
                type="button"
                role="tab"
                class="side-panel-tab"
                data-ot="panel-tab"
                aria-selected={props.shown === b.id}
                {...drag(b.id)}
                onClick={() => props.onShow(b.id)}
              >
                {b.title}
              </button>
            )}
          </For>
          <For each={panels()}>
            {(p) => (
              <button
                type="button"
                role="tab"
                class="side-panel-tab"
                data-ot="panel-tab"
                aria-selected={props.shown === p.id}
                {...drag(p.id)}
                onClick={() => props.onShow(p.id)}
              >
                <Show when={p.icon}>
                  <span class="mt-icon" aria-hidden="true">
                    {iconGlyph(p.icon ?? "")}
                  </span>
                </Show>
                {titleOf(p)}
                <Show when={p.badge}>
                  <span class="side-panel-badge">{p.badge}</span>
                </Show>
              </button>
            )}
          </For>
          <span class="side-panel-spacer" />
          <button
            type="button"
            class="side-panel-close"
            data-ot="panel-close"
            title={t("panel-close")}
            aria-label={t("panel-close")}
            onClick={() => props.onShow(undefined)}
          >
            ×
          </button>
        </div>
        <div class="side-panel-body" data-ot="panel-body">
          <Show when={current()} keyed>
            {(p) => (
              <ModTree node={p.node} host={treeHost(props.host, p.mod, props.insert, props.copy)} context="panel" />
            )}
          </Show>
          <Show when={builtin()} keyed>
            {(b) => b.render()}
          </Show>
        </div>
      </div>
    </Show>
  );
}

/** The permission screen a mod gets before its first start (docs/05 §6.2, decision D5). */
export function PermissionDialog(props: { entry: ModEntry; onAllow: () => void; onDecline: () => void }) {
  const p = () => props.entry.permissions;
  /** `${cwd}/**` reads as "the current folder" (docs/05 §6.2). */
  const scope = (globs: string[]) =>
    globs
      .map((g) => {
        const m = /^\$\{(cwd|home|workspace|mod|data)\}(\/\*\*)?$/.exec(g);
        return m ? t(`scope-${m[1]}`) : g;
      })
      .join(", ");
  const lines = createMemo(() => {
    const out: { text: string; danger?: boolean }[] = [];
    if (p().fsRead.length) out.push({ text: t("mod-permission-fs-read", { scope: scope(p().fsRead) }) });
    if (p().fsWrite.length) out.push({ text: t("mod-permission-fs-write", { scope: scope(p().fsWrite) }) });
    if (p().process.length) out.push({ text: t("mod-permission-process", { commands: p().process.join(", ") }) });
    if (p().network.length) out.push({ text: t("mod-permission-network", { hosts: p().network.join(", ") }) });
    if (p().clipboard) out.push({ text: t("mod-permission-clipboard") });
    if (p().terminalRead) out.push({ text: t("mod-permission-terminal-read") });
    if (p().events.includes("output")) out.push({ text: t("mod-permission-output"), danger: true });
    if (p().terminalWrite) out.push({ text: t("mod-permission-terminal-write"), danger: true });
    if (p().ai) out.push({ text: t("mod-permission-ai") });
    return out;
  });
  return (
    <div class="mod-dialog-backdrop">
      <div
        class="mod-dialog"
        role="dialog"
        aria-label={t("mod-permissions-title", { name: props.entry.name })}
        data-ot="mod-permissions"
      >
        <div class="mod-dialog-title">
          {t("mod-permissions-title", { name: `${props.entry.name} v${props.entry.version}` })}
        </div>
        <ul class="mod-permissions">
          <For each={lines()}>{(l) => <li classList={{ danger: !!l.danger }}>{l.text}</li>}</For>
          <Show when={lines().length === 0}>
            <li class="muted">{t("mod-permission-nothing")}</li>
          </Show>
        </ul>
        <div class="mod-dialog-note">
          <Show when={!p().terminalWrite}>{t("mod-permission-none-write")} </Show>
          <Show when={!p().network.length}>{t("mod-permission-none-network")}</Show>
        </div>
        <div class="mod-dialog-buttons">
          <button type="button" class="mt-button mt-button-primary" onClick={() => props.onAllow()}>
            {t("mod-allow-enable")}
          </button>
          <button type="button" class="mt-button" onClick={() => props.onDecline()}>
            {t("action-cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A mod's `ctx.ui.dialog`: title, a body (text or a tree), and buttons by id. */
export function ModDialog(props: {
  req: DialogRequest;
  insert: (text: string) => void;
  copy: (text: string) => void;
  onClose: (id: string | null) => void;
}) {
  const body = () => props.req.body;
  const tree = (): TreeHost | undefined => {
    const h = props.req.tree;
    if (!h) return undefined;
    return { invoke: h.invoke, setSignal: h.setSignal, insert: props.insert, copy: props.copy, contextMenu: () => {} };
  };
  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") props.onClose(props.req.cancelId ?? null);
  };
  return (
    <div class="mod-dialog-backdrop">
      <div class="mod-dialog" role="dialog" aria-label={props.req.title} data-ot="mod-dialog" onKeyDown={onKeyDown}>
        <div class="mod-dialog-from">{props.req.from}</div>
        <div class="mod-dialog-title">{props.req.title}</div>
        <Show when={typeof body() === "string"}>
          <div class="mod-dialog-body">{body() as string}</div>
        </Show>
        <Show when={typeof body() === "object" ? tree() : undefined} keyed>
          {(h) => (
            <div class="mod-dialog-body">
              <ModTree node={body() as Exclude<DialogRequest["body"], string | undefined>} host={h} context="panel" />
            </div>
          )}
        </Show>
        <div class="mod-dialog-buttons">
          <For each={props.req.buttons}>
            {(b) => (
              <button
                type="button"
                class="mt-button"
                classList={{ "mt-button-primary": b.variant === "primary", "mt-button-danger": b.variant === "danger" }}
                onClick={() => props.onClose(b.id)}
              >
                {b.label}
              </button>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

export interface Toast extends ToastRequest {
  id: number;
}

/** Toasts stack at the top right; each names the mod it came from. */
export function Toasts(props: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div class="toasts" aria-live="polite">
      <For each={props.toasts}>
        {(toast) => (
          <div class="toast" classList={{ [toast.kind ?? "info"]: true }} data-ot="toast">
            <div class="toast-text">
              <span class="toast-from">{toast.from}</span>
              {toast.text}
            </div>
            <Show when={toast.actions.length > 0}>
              <div class="toast-actions">
                <For each={toast.actions}>
                  {(a) => (
                    <button
                      type="button"
                      class="mt-button mt-button-small"
                      classList={{
                        "mt-button-primary": a.variant === "primary",
                        "mt-button-danger": a.variant === "danger",
                      }}
                      onClick={() => {
                        a.onClick();
                        props.dismiss(toast.id);
                      }}
                    >
                      {a.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <button
              type="button"
              class="toast-close"
              title={t("action-cancel")}
              aria-label={t("action-cancel")}
              onClick={() => props.dismiss(toast.id)}
            >
              ×
            </button>
          </div>
        )}
      </For>
    </div>
  );
}

const STATUS_KEY: Record<ModState["status"], string> = {
  inactive: "mod-status-inactive",
  starting: "mod-status-starting",
  active: "mod-status-active",
  crashed: "mod-status-crashed",
  disabled: "mod-status-disabled",
  "needs-grant": "mod-status-needs-grant",
  error: "mod-status-error",
  stopping: "mod-status-stopping",
};

/** The installed mods, with logs and API timings in developer mode (docs/05 §8.2). */
export function ModsPanel(props: { host: ModHost; developer: boolean; modsDir: string | undefined }) {
  const [open, setOpen] = createSignal<string>();
  const fmt = (n: number) => new Date(n).toLocaleTimeString();
  return (
    <div class="mods-panel">
      <Show when={props.host.mods().length === 0}>
        <p class="muted">{t("mods-none")}</p>
        <Show when={props.modsDir}>
          <p class="muted mods-dir">{props.modsDir}</p>
        </Show>
      </Show>
      <For each={props.host.mods()}>
        {(m) => (
          <div
            class="mods-entry"
            data-ot="mod-row"
            classList={{ broken: m.status === "crashed" || m.status === "error" }}
          >
            <div class="mods-entry-head">
              <div class="mods-entry-name">
                <strong>{m.entry.name}</strong> <span class="muted">v{m.entry.version}</span>
                <Show when={m.entry.linked}>
                  <span class="mt-badge mt-badge-neutral">{t("mod-linked")}</span>
                </Show>
              </div>
              <span class="mods-entry-status" classList={{ [m.status]: true }}>
                {t(STATUS_KEY[m.status])}
                <Show when={m.activateMs !== undefined && props.developer}> · {m.activateMs} ms</Show>
              </span>
            </div>
            <div class="muted mods-entry-id">{m.entry.id}</div>
            <Show when={m.entry.description}>
              <div class="mods-entry-desc">{m.entry.description}</div>
            </Show>
            <Show when={m.message}>
              <pre class="mods-entry-message">{m.message}</pre>
            </Show>
            <div class="mods-entry-actions">
              <button
                type="button"
                class="mt-button mt-button-small"
                onClick={() => void props.host.setEnabled(m.entry.id, !m.entry.enabled)}
              >
                {m.entry.enabled ? t("mod-disable") : t("mod-enable")}
              </button>
              <Show when={m.entry.enabled && !m.entry.granted && m.entry.hasEntry}>
                <span class="muted">{t("mod-status-needs-grant")}</span>
              </Show>
              <Show when={props.developer}>
                <button
                  type="button"
                  class="mt-button mt-button-small mt-button-ghost"
                  onClick={() => setOpen(open() === m.entry.id ? undefined : m.entry.id)}
                >
                  {t("mod-logs", { n: m.logs.length })}
                </button>
              </Show>
              <button
                type="button"
                class="mt-button mt-button-small mt-button-ghost"
                onClick={() => void props.host.uninstall(m.entry.id)}
              >
                {t("mod-uninstall")}
              </button>
            </div>
            <Show when={props.developer && open() === m.entry.id}>
              <div class="mods-calls">
                <For each={Object.entries(m.calls)}>
                  {([method, s]) => (
                    <div>
                      <span class="muted">{method}</span> ×{s.n} · {(s.ms / s.n).toFixed(1)} ms
                    </div>
                  )}
                </For>
              </div>
              <pre class="mods-log">
                <For each={m.logs}>{(l) => `${fmt(l.at)} ${l.level.padEnd(5)} ${l.text}\n`}</For>
              </pre>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
