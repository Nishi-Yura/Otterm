/**
 * The mods screen: what is installed, what the store has, and each mod in full. It covers the
 * window like the settings screen does, so a mod's description, permissions and settings have
 * room (docs/05 §4, §7.2). A list on the left, the chosen mod on the right.
 */
import { invoke } from "@tauri-apps/api/core";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { t } from "../i18n";
import type { ModEntry, ModHost, ModState } from "./host";
import { permissionLines } from "./ModUi";

/** A setting a mod declares in `[settings.schema]` (`SettingSchema` in index.d.ts). */
interface ModSetting {
  type?: string;
  default?: unknown;
  label?: string;
  min?: number;
  max?: number;
  values?: { value: string; label?: string }[];
}

/** A registry mod as `store_list` returns it (crates/otterm-app/src/mods.rs). */
interface StoreEntry {
  id: string;
  name: string;
  description: string;
  author: string;
  kind: string;
  categories: string[];
  permissions: string[];
  reviewed: boolean;
  /** The index was signed by the registry key; an unsigned one comes from a registry set in the config. */
  signed: boolean;
  latest: string | null;
  compatible: boolean;
  installed: string | null;
}

/** `"日本語 / English"` labels in manifests: the part for the UI language. */
export function bilingual(s: string | undefined): string {
  if (!s) return "";
  const parts = s.split(" / ");
  if (parts.length !== 2) return s;
  return document.documentElement.lang === "ja" ? (parts[0] as string) : (parts[1] as string);
}

/** What "turn on the recommended set" turns on: otterm's own help for typing and reading commands. */
const RECOMMENDED = [
  "otterm.mascot",
  "otterm.dictionary-core",
  "otterm.cmd-explain",
  "otterm.completion",
  "otterm.danger-guard",
  "otterm.error-hint",
  "otterm.history-search",
  "otterm.file-tree",
];

/** The intro was closed once; it stays closed (a per-machine nicety, not a setting). */
const INTRO_CLOSED = "otterm.mods-intro-closed";

const introClosed = () => {
  try {
    return localStorage.getItem(INTRO_CLOSED) === "1";
  } catch {
    return false;
  }
};

/** Registry permission strings (`fs.read:${cwd}/**`, `terminal.read`, …) as a manifest's permissions. */
function fromStrings(list: string[]): ModEntry["permissions"] {
  const p = {
    fsRead: [] as string[],
    fsWrite: [] as string[],
    process: [] as string[],
    network: [] as string[],
    clipboard: false,
    terminalRead: false,
    terminalWrite: false,
    ai: false,
    events: [] as string[],
  };
  for (const s of list) {
    const at = s.indexOf(":");
    const [kind, value] = at < 0 ? [s, ""] : [s.slice(0, at), s.slice(at + 1)];
    if (kind === "fs.read") p.fsRead.push(value);
    else if (kind === "fs.write") p.fsWrite.push(value);
    else if (kind === "process") p.process.push(value);
    else if (kind === "network") p.network.push(value);
    else if (kind === "clipboard") p.clipboard = true;
    else if (kind === "terminal.read") p.terminalRead = true;
    else if (kind === "terminal.write") p.terminalWrite = true;
    else if (kind === "ai") p.ai = true;
  }
  return p as ModEntry["permissions"];
}

type Selection = { tab: "installed"; id: string } | { tab: "store"; id: string } | undefined;

export function ModsScreen(props: {
  host: ModHost;
  developer: boolean;
  modsDir: string | undefined;
  notify: (text: string) => void;
  /** Kotsume says a line (a mod was installed, docs/08 §5.1). */
  say?: (text: string) => void;
  onOutfitsChanged?: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = createSignal<"installed" | "store">("installed");
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal<Selection>();
  const [closedIntro, setClosedIntro] = createSignal(introClosed());
  const [allowed, setAllowed] = createSignal<boolean>();
  const [store, setStore] = createSignal<StoreEntry[]>();
  const [storeError, setStoreError] = createSignal<string>();
  const [busy, setBusy] = createSignal<string>();
  let search!: HTMLInputElement;

  onMount(() => {
    search.focus();
    void invoke<boolean>("store_consent", { allow: false })
      .then((ok) => {
        setAllowed(ok);
        if (ok) loadStore(false);
      })
      .catch(() => setAllowed(false));
  });

  const loadStore = (refresh: boolean) => {
    setStoreError(undefined);
    void invoke<StoreEntry[]>("store_list", { refresh })
      .then(setStore)
      .catch((e) => setStoreError(String(e)));
  };

  const matches = (hay: string) => {
    const words = query().toLowerCase().split(/\s+/).filter(Boolean);
    const h = hay.toLowerCase();
    return words.every((w) => h.includes(w));
  };
  /** Installed mods, the ones that are on first. */
  const installed = createMemo(() =>
    props.host
      .mods()
      .filter((m) => matches(`${m.entry.id} ${m.entry.name} ${m.entry.description} ${m.entry.author}`))
      .sort(
        (a, b) =>
          Number(b.entry.enabled) - Number(a.entry.enabled) ||
          bilingual(a.entry.name).localeCompare(bilingual(b.entry.name)),
      ),
  );
  const storeShown = createMemo(() =>
    (store() ?? []).filter((m) => matches(`${m.id} ${m.name} ${m.description} ${m.author} ${m.categories.join(" ")}`)),
  );

  // Nothing is on yet: a word on how otterm works, and the recommended set, until closed once.
  const showIntro = () => !closedIntro() && props.host.mods().every((m) => !m.entry.enabled);
  const recommended = () => RECOMMENDED.filter((id) => props.host.mods().some((m) => m.entry.id === id));
  const closeIntro = () => {
    setClosedIntro(true);
    try {
      localStorage.setItem(INTRO_CLOSED, "1");
    } catch {
      // Private storage unavailable: the intro shows again next time, which is harmless.
    }
  };

  const chosenMod = (): ModState | undefined => {
    const s = selected();
    return s?.tab === "installed" ? props.host.mods().find((m) => m.entry.id === s.id) : undefined;
  };
  const chosenStore = (): StoreEntry | undefined => {
    const s = selected();
    return s?.tab === "store" ? store()?.find((m) => m.id === s.id) : undefined;
  };

  const install = (m: StoreEntry) => {
    setBusy(m.id);
    void invoke<string>("store_install", { id: m.id })
      .then(() => {
        if (props.say) props.say(t("mascot-mod-installed", { name: bilingual(m.name) }));
        if (m.kind === "outfit") props.onOutfitsChanged?.();
        void props.host.refresh();
        loadStore(false);
      })
      .catch((e) => props.notify(String(e)))
      .finally(() => setBusy(undefined));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  };

  return (
    <div
      class="settings mods-screen"
      role="dialog"
      aria-modal="true"
      aria-label={t("mods-title")}
      data-ot="mods-screen"
      onKeyDown={onKeyDown}
    >
      <div class="mods-screen-side">
        <div class="settings-heading">{t("mods-title")}</div>
        <div class="mods-screen-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab() === "installed"}
            onClick={() => {
              setTab("installed");
              setSelected(undefined);
            }}
          >
            {t("mods-tab-installed")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab() === "store"}
            onClick={() => {
              setTab("store");
              setSelected(undefined);
            }}
          >
            {t("mods-tab-store")}
          </button>
        </div>
        <input
          ref={search}
          type="search"
          class="settings-search mods-screen-search"
          placeholder={t("store-search")}
          aria-label={t("store-search")}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <div class="mods-screen-list">
          <Show when={tab() === "installed"}>
            <Show when={showIntro()}>
              <div class="mods-intro" data-ot="mods-intro">
                <p class="muted">{t("mods-intro")}</p>
                <div class="mods-intro-actions">
                  <Show when={recommended().length > 0}>
                    <button
                      type="button"
                      class="mt-button mt-button-small"
                      onClick={() => void props.host.enableAll(recommended())}
                    >
                      {t("mods-enable-recommended")}
                    </button>
                  </Show>
                  <button type="button" class="mt-button mt-button-small mt-button-ghost" onClick={closeIntro}>
                    {t("mods-intro-close")}
                  </button>
                </div>
              </div>
            </Show>
            <Show when={installed().length === 0}>
              <p class="muted">{query() ? t("mods-no-results") : t("mods-none")}</p>
            </Show>
            <For each={installed()}>
              {(m) => (
                <button
                  type="button"
                  class="mods-screen-item"
                  aria-current={selected()?.id === m.entry.id ? "true" : undefined}
                  onClick={() => setSelected({ tab: "installed", id: m.entry.id })}
                >
                  <span class="mods-screen-item-name">{bilingual(m.entry.name)}</span>
                  <span class="mods-screen-item-state" classList={{ on: m.entry.enabled }}>
                    {stateLabel(m)}
                  </span>
                  <span class="mods-screen-item-desc">{bilingual(m.entry.description)}</span>
                </button>
              )}
            </For>
          </Show>
          <Show when={tab() === "store"}>
            <Show
              when={allowed()}
              fallback={
                <div class="mods-intro">
                  <p class="muted">{t("store-consent")}</p>
                  <button
                    type="button"
                    class="mt-button mt-button-small"
                    onClick={() =>
                      void invoke<boolean>("store_consent", { allow: true }).then((ok) => {
                        setAllowed(ok);
                        loadStore(true);
                      })
                    }
                  >
                    {t("store-connect")}
                  </button>
                </div>
              }
            >
              <Show when={storeError()}>
                <p class="muted">{t("store-error", { error: storeError() ?? "" })}</p>
              </Show>
              <Show when={store() && storeShown().length === 0 && !storeError()}>
                <p class="muted">{t("store-empty")}</p>
              </Show>
              <For each={storeShown()}>
                {(m) => (
                  <button
                    type="button"
                    class="mods-screen-item"
                    aria-current={selected()?.id === m.id ? "true" : undefined}
                    onClick={() => setSelected({ tab: "store", id: m.id })}
                  >
                    <span class="mods-screen-item-name">{bilingual(m.name)}</span>
                    <span class="mods-screen-item-state" classList={{ on: m.installed !== null }}>
                      {m.installed ? t("store-installed") : m.latest ? `v${m.latest}` : ""}
                    </span>
                    <span class="mods-screen-item-desc">{bilingual(m.description)}</span>
                  </button>
                )}
              </For>
              <button type="button" class="mt-button mt-button-small mt-button-ghost" onClick={() => loadStore(true)}>
                {t("store-refresh")}
              </button>
            </Show>
          </Show>
        </div>
      </div>
      <div class="settings-main">
        <div class="settings-top">
          <button type="button" class="settings-close" aria-label={t("settings-close")} onClick={props.onClose}>
            ×
          </button>
        </div>
        <div class="settings-body mods-screen-detail">
          <Show when={chosenMod()}>
            {(m) => <InstalledDetail mod={m()} host={props.host} developer={props.developer} notify={props.notify} />}
          </Show>
          <Show when={chosenStore()}>
            {(m) => (
              <StoreDetail
                mod={m()}
                busy={busy()}
                onInstall={install}
                onOpenInstalled={() => {
                  setTab("installed");
                  setSelected({ tab: "installed", id: m().id });
                }}
              />
            )}
          </Show>
          <Show when={!chosenMod() && !chosenStore()}>
            <p class="muted mods-screen-empty">
              {tab() === "installed" ? t("mods-pick-installed") : t("mods-pick-store")}
            </p>
            <Show when={tab() === "installed" && props.developer && props.modsDir}>
              <p class="muted mono">{props.modsDir}</p>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}

/** "On", "off", "needs your OK", "stopped by an error", as a word. */
function stateLabel(m: ModState): string {
  if (m.status === "error" || m.status === "crashed") return t("mods-state-error");
  if (m.entry.enabled && !m.entry.granted && m.entry.hasEntry) return t("mod-status-needs-grant");
  return m.entry.enabled ? t("mods-state-on") : t("mods-state-off");
}

const KINDS = new Set(["theme", "layout", "dictionary", "workflows", "outfit", "extension", "pack", "feature"]);
const kindLabel = (kind: string) => (KINDS.has(kind) ? t(`mods-kind-${kind}`) : kind);

function Permissions(props: { permissions: ModEntry["permissions"] }) {
  const lines = () => permissionLines(props.permissions);
  return (
    <section class="mods-detail-section">
      <h3>{t("mods-detail-permissions")}</h3>
      <ul class="mod-permissions">
        <For each={lines()}>{(l) => <li classList={{ danger: !!l.danger }}>{l.text}</li>}</For>
        <Show when={lines().length === 0}>
          <li class="muted">{t("mod-permission-nothing")}</li>
        </Show>
      </ul>
    </section>
  );
}

function InstalledDetail(props: { mod: ModState; host: ModHost; developer: boolean; notify: (s: string) => void }) {
  const e = () => props.mod.entry;
  const schema = () => Object.entries(e().settingsSchema ?? {}) as [string, ModSetting][];
  const set = (key: string, value: unknown) =>
    void invoke("mod_setting_set", { id: e().id, key, value }).catch((err) => props.notify(String(err)));
  const fmt = (n: number) => new Date(n).toLocaleTimeString();
  const workspaceLocked = () => e().source === "workspace" && e().permissions.terminalWrite;
  return (
    <article class="mods-detail" data-ot="mod-detail">
      <header class="mods-detail-head">
        <div>
          <h2>{bilingual(e().name)}</h2>
          <div class="muted mono">
            {e().id} · v{e().version} · {e().author || "—"} · {kindLabel(e().kind)}
          </div>
        </div>
        <div class="mods-detail-actions">
          <button
            type="button"
            class="mt-button"
            classList={{ "mt-button-primary": !e().enabled }}
            disabled={workspaceLocked()}
            onClick={() => void props.host.setEnabled(e().id, !e().enabled).catch((err) => props.notify(String(err)))}
          >
            {e().enabled ? t("mod-disable") : t("mod-enable")}
          </button>
          {/* Mods that ship with otterm can be turned off but not removed (decision M8). */}
          <Show when={e().source === "user"}>
            <button
              type="button"
              class="mt-button mt-button-ghost"
              onClick={() => void props.host.uninstall(e().id).catch((err) => props.notify(String(err)))}
            >
              {t("mod-uninstall")}
            </button>
          </Show>
        </div>
      </header>
      <p class="mods-detail-state">
        {stateLabel(props.mod)}
        <Show when={e().source === "bundled"}> · {t("mods-bundled")}</Show>
        <Show when={e().source === "workspace"}> · {t("mod-source-workspace")}</Show>
        <Show when={e().linked}> · {t("mod-linked")}</Show>
      </p>
      <Show when={props.mod.message}>
        <pre class="mods-entry-message">{props.mod.message}</pre>
      </Show>
      <p class="mods-detail-desc">{bilingual(e().description)}</p>
      <Show when={e().source === "workspace"}>
        <p class="muted">
          {e().permissions.terminalWrite
            ? t("mod-workspace-no-write")
            : t("mod-workspace-note", { root: e().workspaceRoot ?? "" })}
        </p>
      </Show>
      <Permissions permissions={e().permissions} />
      <Show when={schema().length > 0}>
        <section class="mods-detail-section">
          <h3>{t("mods-detail-settings")}</h3>
          <For each={schema()}>
            {([key, s]) => {
              const v = () => (e().settings as Record<string, unknown>)[key] ?? s.default;
              const id = `mod-${e().id}-${key}`;
              return (
                <div class="settings-row">
                  <div class="settings-label">
                    <label for={id}>{bilingual(s.label) || key}</label>
                  </div>
                  <div class="settings-control">
                    <Show when={s.type === "boolean"}>
                      <input
                        id={id}
                        type="checkbox"
                        class="settings-switch"
                        checked={v() === true}
                        onChange={(ev) => set(key, ev.currentTarget.checked)}
                      />
                    </Show>
                    <Show when={s.type === "integer" || s.type === "number"}>
                      <input
                        id={id}
                        type="number"
                        min={s.min}
                        max={s.max}
                        value={Number(v() ?? 0)}
                        onChange={(ev) => set(key, Number(ev.currentTarget.value))}
                      />
                    </Show>
                    <Show when={s.type === "string"}>
                      <input
                        id={id}
                        type="text"
                        value={String(v() ?? "")}
                        onChange={(ev) => set(key, ev.currentTarget.value)}
                      />
                    </Show>
                    <Show when={s.type === "enum"}>
                      <select id={id} value={String(v() ?? "")} onChange={(ev) => set(key, ev.currentTarget.value)}>
                        <For each={s.values ?? []}>
                          {(o) => <option value={o.value}>{bilingual(o.label) || o.value}</option>}
                        </For>
                      </select>
                    </Show>
                  </div>
                </div>
              );
            }}
          </For>
        </section>
      </Show>
      <Show when={props.developer}>
        <section class="mods-detail-section">
          <h3>{t("mod-logs", { n: props.mod.logs.length })}</h3>
          <div class="mods-calls">
            <For each={Object.entries(props.mod.calls)}>
              {([method, c]) => (
                <div>
                  <span class="muted">{method}</span> ×{c.n} · {(c.ms / c.n).toFixed(1)} ms
                </div>
              )}
            </For>
          </div>
          <pre class="mods-log">
            <For each={props.mod.logs}>{(l) => `${fmt(l.at)} ${l.level.padEnd(5)} ${l.text}\n`}</For>
          </pre>
        </section>
      </Show>
    </article>
  );
}

function StoreDetail(props: {
  mod: StoreEntry;
  busy: string | undefined;
  onInstall: (m: StoreEntry) => void;
  onOpenInstalled: () => void;
}) {
  const m = () => props.mod;
  return (
    <article class="mods-detail" data-ot="store-detail">
      <header class="mods-detail-head">
        <div>
          <h2>{bilingual(m().name)}</h2>
          <div class="muted mono">
            {m().id} · {m().latest ? `v${m().latest}` : "—"} · {m().author} · {kindLabel(m().kind)}
          </div>
        </div>
        <div class="mods-detail-actions">
          <Show
            when={m().installed !== m().latest}
            fallback={
              <button type="button" class="mt-button" onClick={props.onOpenInstalled}>
                {t("mods-open-installed")}
              </button>
            }
          >
            <button
              type="button"
              class="mt-button mt-button-primary"
              disabled={props.busy !== undefined || !m().latest || !m().compatible}
              onClick={() => props.onInstall(m())}
            >
              {props.busy === m().id
                ? "…"
                : m().installed
                  ? t("store-update", { version: m().installed ?? "" })
                  : t("store-install")}
            </button>
          </Show>
        </div>
      </header>
      <p class="mods-detail-state">
        {m().reviewed ? t("store-reviewed") : t("mods-not-reviewed")}
        <Show when={!m().signed}> · {t("store-unsigned")}</Show>
        <Show when={m().categories.length > 0}> · {m().categories.join(", ")}</Show>
      </p>
      <Show when={!m().compatible}>
        <p class="settings-workspace">{t("store-incompatible")}</p>
      </Show>
      <p class="mods-detail-desc">{bilingual(m().description)}</p>
      <Permissions permissions={fromStrings(m().permissions)} />
      <p class="muted">{t("mods-store-note")}</p>
    </article>
  );
}
