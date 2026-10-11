/**
 * The settings screen (docs/04 §6): categories on the left, a form on the right, a search box
 * across everything. The form is generated from the JSON Schema of config.toml (decision C6);
 * the appearance pages add a theme gallery and editor, layouts, fonts, the background image and
 * user CSS, so that the look can be changed without writing a file (M5's goal).
 *
 * Every change is written to config.toml at once (toml_edit keeps comments) and comes back
 * through `config-changed`, so the window behind the screen shows it live.
 */
import { invoke } from "@tauri-apps/api/core";
import { createEffect, createMemo, createResource, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js";
import { type Layout, setStyleSheet, UI_TOKENS, type UiConfig, uiTokens } from "../config";
import { t } from "../i18n";
import { defaults as defaultKeys, Keymap } from "../keymap";
import type { ModHost } from "../mods/host";
import { describe, type Field, help, label, leaves, optionLabel, resolve, type Schema, tidy, valueAt } from "./schema";
import "./settings.css";

type Theme = UiConfig["theme"];

interface Form {
  schema: Schema;
  values: Record<string, unknown>;
  set: string[];
  path: string | null;
}

type Write = (path: string[], value: unknown) => Promise<void>;

export interface SettingsProps {
  config: UiConfig | undefined;
  host: ModHost;
  /** Panels the window offers (id, title, where it is now), for placing them. */
  panels: { id: string; title: string; slot: string }[];
  onClose: () => void;
  /** Show this theme in the window while it is edited; undefined to stop. */
  preview: (theme: Theme | undefined) => void;
  notify: (text: string) => void;
  /** Start otterm again, in safe mode (`true`) or normally. */
  restart: (safe: boolean) => void;
}

/** Keys the generic form leaves to a page of its own. */
const SPECIAL = new Set([
  "appearance.theme",
  "appearance.theme_light",
  "appearance.layout",
  "appearance.panels",
  "mods.enabled",
  "mods.disabled",
  "mods.settings",
  "keybindings.bindings",
  "keybindings.custom",
  "schema",
]);

interface Category {
  id: string;
  paths: string[][];
  page?: "theme" | "layout" | "font" | "keys" | "mods" | "advanced";
}

const CATEGORIES: Category[] = [
  { id: "general", paths: [["general"]] },
  {
    id: "appearance",
    page: "theme",
    paths: [
      ["appearance", "follow_system"],
      ["appearance", "minimum_contrast"],
      ["appearance", "renderer"],
      ["appearance", "ui_scale"],
      ["appearance", "window"],
    ],
  },
  {
    id: "layout",
    page: "layout",
    paths: [
      ["appearance", "tabbar"],
      ["appearance", "sidebar"],
      ["appearance", "panel"],
      ["appearance", "statusbar"],
      ["appearance", "assist_bar"],
      ["appearance", "blocks"],
    ],
  },
  { id: "font", page: "font", paths: [["font"]] },
  { id: "terminal", paths: [["terminal"]] },
  { id: "profiles", paths: [["shell"], ["profiles"]] },
  { id: "assist", paths: [["assist"], ["history"], ["open"]] },
  { id: "mascot", paths: [["mascot"]] },
  { id: "keys", page: "keys", paths: [["keybindings"]] },
  { id: "mods", page: "mods", paths: [["mods"]] },
  { id: "ai", paths: [["ai"]] },
  { id: "accessibility", paths: [["accessibility"], ["appearance", "ui_scale"]] },
  { id: "advanced", page: "advanced", paths: [["appearance", "custom_css"]] },
];

export function Settings(props: SettingsProps) {
  const [form, setForm] = createSignal<Form>();
  const [category, setCategory] = createSignal("appearance");
  const [query, setQuery] = createSignal("");
  let searchBox!: HTMLInputElement;
  let root!: HTMLDivElement;
  let body!: HTMLDivElement;

  let schemaText = "";
  const reload = () =>
    invoke<Form>("config_form")
      .then((next) => {
        // The schema never changes while otterm runs; keeping the same object keeps every row (and
        // the focus in it) in place when only the values changed.
        const text = JSON.stringify(next.schema);
        const old = form();
        if (old && text === schemaText) next.schema = old.schema;
        schemaText = text;
        setForm(next);
      })
      .catch((e) => props.notify(String(e)));
  // The file changed (here or by hand): read the values again.
  createEffect(() => {
    props.config;
    void reload();
  });

  const write: Write = async (path, value) => {
    try {
      await invoke("config_write", { path, value: value === undefined ? null : value });
    } catch (e) {
      props.notify(String(e));
      void reload();
    }
  };

  onMount(() => {
    const prev = document.activeElement as HTMLElement | null;
    searchBox.focus();
    // Escape still closes the screen when the focus fell out of it (a control that went away).
    const outside = (e: KeyboardEvent) => {
      if (root.contains(document.activeElement)) return;
      if (e.key === "Escape" || ((e.ctrlKey || e.metaKey) && e.key === ",")) {
        e.preventDefault();
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("keydown", outside, true);
    onCleanup(() => {
      window.removeEventListener("keydown", outside, true);
      prev?.focus();
    });
  });

  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      if (query()) setQuery("");
      else props.onClose();
    }
    // The terminal's own keys stay out while the screen is open, except the settings key itself.
    if ((e.ctrlKey || e.metaKey) && e.key === ",") {
      e.preventDefault();
      props.onClose();
    }
  };

  const results = createMemo(() => {
    const f = form();
    const q = query().trim().toLowerCase();
    if (!f || !q) return [];
    const seen = new Set<string>();
    const out: { path: string[]; cat: string }[] = [];
    for (const c of CATEGORIES) {
      for (const p of c.paths) {
        const node = schemaAt(f.schema, p);
        if (!node) continue;
        for (const leaf of leaves(f.schema, node, p)) {
          const key = leaf.path.join(".");
          if (seen.has(key) || SPECIAL.has(key)) continue;
          const text = `${label(leaf.path)} ${help(leaf.path, leaf.field) ?? ""} ${key}`.toLowerCase();
          if (text.includes(q)) {
            seen.add(key);
            out.push({ path: leaf.path, cat: c.id });
          }
        }
      }
    }
    return out;
  });

  const current = () => CATEGORIES.find((c) => c.id === category()) ?? (CATEGORIES[0] as Category);

  return (
    <div
      ref={root}
      class="settings"
      role="dialog"
      aria-modal="true"
      aria-label={t("settings-title")}
      data-ot="settings"
      onKeyDown={onKeyDown}
    >
      <nav class="settings-nav" aria-label={t("settings-categories")}>
        <div class="settings-heading">{t("settings-title")}</div>
        <For each={CATEGORIES}>
          {(c) => (
            <button
              type="button"
              class="settings-cat"
              aria-current={c.id === category() && !query() ? "page" : undefined}
              data-ot="settings-category"
              onClick={() => {
                setQuery("");
                setCategory(c.id);
                body.scrollTop = 0;
              }}
            >
              {t(`settings-cat-${c.id}`)}
            </button>
          )}
        </For>
      </nav>
      <div class="settings-main">
        <div class="settings-top">
          <input
            ref={searchBox}
            class="settings-search"
            type="search"
            placeholder={t("settings-search")}
            aria-label={t("settings-search")}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <button type="button" class="settings-close" aria-label={t("settings-close")} onClick={props.onClose}>
            ×
          </button>
        </div>
        <div ref={body} class="settings-body">
          <Show when={form()} fallback={<p class="muted">…</p>}>
            {(f) => (
              <Show
                when={!query()}
                fallback={
                  <Show when={results().length > 0} fallback={<p class="muted">{t("settings-no-results")}</p>}>
                    <For each={results()}>
                      {(r) => (
                        <div class="settings-result">
                          <div class="settings-crumb">
                            {t(`settings-cat-${r.cat}`)} ›{" "}
                            {r.path
                              .slice(0, -1)
                              .map((_, i) => label(r.path.slice(0, i + 1)))
                              .join(" › ")}
                          </div>
                          <FieldView form={f()} path={r.path} write={write} />
                        </div>
                      )}
                    </For>
                  </Show>
                }
              >
                <div class="settings-title-row">
                  <h2 class="settings-title">{t(`settings-cat-${current().id}`)}</h2>
                  <Show when={current().id !== "advanced" && current().id !== "mods"}>
                    <ConfirmButton
                      label={t("settings-reset-category")}
                      confirm={t("settings-reset-confirm")}
                      onConfirm={() => {
                        for (const p of current().paths) void write(p, undefined);
                      }}
                    />
                  </Show>
                </div>
                <Show when={current().page === "theme"}>
                  <ThemePage {...props} form={f()} write={write} />
                </Show>
                <Show when={current().page === "layout"}>
                  <LayoutPage {...props} form={f()} write={write} />
                </Show>
                <Show when={current().page === "font"}>
                  <FontPreview config={props.config} />
                </Show>
                <Show when={current().page === "keys"}>
                  <KeysPage {...props} write={write} />
                </Show>
                <Show when={current().page === "mods"}>
                  <ModsPage host={props.host} notify={props.notify} />
                </Show>
                <Show when={current().page === "advanced"}>
                  <AdvancedPage {...props} form={f()} />
                </Show>
                <For each={current().paths}>{(p) => <FieldView form={f()} path={p} write={write} />}</For>
                <Show when={current().page === "theme"}>
                  <BackgroundPicker {...props} write={write} />
                </Show>
              </Show>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}

function schemaAt(root: Schema, path: string[]): Schema | undefined {
  let node: Schema | undefined = root;
  for (const p of path) {
    const r = resolve(root, node);
    node = r.properties?.[p];
    if (!node) return undefined;
  }
  return node;
}

// ---------------------------------------------------------------------------
// The generated form
// ---------------------------------------------------------------------------

function FieldView(props: { form: Form; path: string[]; write: Write; nested?: boolean }) {
  const node = () => schemaAt(props.form.schema, props.path);
  const field = createMemo(() => {
    const n = node();
    return n ? describe(props.form.schema, n) : undefined;
  });
  const key = () => props.path.join(".");
  return (
    <Show when={field() && !SPECIAL.has(key())}>
      <Show
        when={field()?.kind === "object"}
        fallback={
          <Row
            path={props.path}
            field={field() as Field}
            value={valueAt(props.form.values, props.path)}
            isSet={props.form.set.includes(key())}
            write={props.write}
            schema={props.form.schema}
          />
        }
      >
        <fieldset class="settings-group" classList={{ nested: props.nested }}>
          <legend>{label(props.path)}</legend>
          <For each={(field()?.props ?? []).map(([k]) => k)}>
            {(k) => <FieldView form={props.form} path={[...props.path, k]} write={props.write} nested />}
          </For>
        </fieldset>
      </Show>
    </Show>
  );
}

function Row(props: { path: string[]; field: Field; value: unknown; isSet: boolean; write: Write; schema: Schema }) {
  const id = () => `set-${props.path.join("-")}`;
  const desc = () => help(props.path, props.field);
  return (
    <div class="settings-row" classList={{ advanced: props.field.advanced }} data-ot="settings-row">
      <div class="settings-label">
        <label for={id()}>{label(props.path)}</label>
        <Show when={desc()}>
          <div class="settings-desc">{desc()}</div>
        </Show>
        <Show when={props.field.restart}>
          <div class="settings-desc">{t("settings-restart")}</div>
        </Show>
      </div>
      <div class="settings-control">
        <Control id={id()} {...props} />
        <Show when={props.isSet}>
          <button
            type="button"
            class="settings-reset"
            title={t("settings-reset")}
            aria-label={`${t("settings-reset")}: ${label(props.path)}`}
            onClick={() => void props.write(props.path, undefined)}
          >
            ↺
          </button>
        </Show>
      </div>
    </div>
  );
}

function Control(props: { id: string; path: string[]; field: Field; value: unknown; write: Write; schema: Schema }) {
  const f = () => props.field;
  const set = (v: unknown) => void props.write(props.path, v);
  // Auto<bool> and enums: one select.
  if (f().kind === "bool" && f().auto) {
    const v = () => (props.value === "auto" ? "auto" : props.value ? "on" : "off");
    return (
      <select id={props.id} value={v()} onChange={(e) => set(pick(e.currentTarget.value))}>
        <option value="auto">{optionLabel("auto")}</option>
        <option value="on">{t("settings-on")}</option>
        <option value="off">{t("settings-off")}</option>
      </select>
    );
  }
  switch (f().kind) {
    case "bool":
      return (
        <input
          id={props.id}
          type="checkbox"
          class="settings-switch"
          checked={props.value === true}
          onChange={(e) => set(e.currentTarget.checked)}
        />
      );
    case "enum": {
      const options = () => [...(f().auto ? ["auto"] : []), ...(f().options ?? [])];
      return (
        <select
          id={props.id}
          value={props.value === null || props.value === undefined ? "" : String(props.value)}
          onChange={(e) => set(e.currentTarget.value === "" ? null : e.currentTarget.value)}
        >
          <Show when={f().nullable}>
            <option value="">{t("settings-none")}</option>
          </Show>
          <For each={options()}>{(o) => <option value={o}>{optionLabel(o)}</option>}</For>
        </select>
      );
    }
    case "number":
      return <NumberControl {...props} />;
    case "color":
    case "string":
      return <TextControl {...props} />;
    case "strings":
      return <ListControl {...props} />;
    case "map":
      return <MapControl {...props} />;
    case "objects":
      return <ObjectsControl {...props} />;
    default:
      return <code class="settings-raw">{JSON.stringify(props.value)}</code>;
  }
}

const pick = (v: string) => (v === "auto" ? "auto" : v === "on");

function NumberControl(props: { id: string; path: string[]; field: Field; value: unknown; write: Write }) {
  const f = () => props.field;
  const auto = () => props.value === "auto";
  const n = () => (typeof props.value === "number" ? tidy(props.value) : 0);
  const step = () => (f().integer ? 1 : (f().max ?? 100) <= 2 ? 0.05 : 0.5);
  const slider = () =>
    f().min !== undefined && f().max !== undefined && (f().max as number) - (f().min as number) <= 100;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = (v: number, now = false) => {
    if (Number.isNaN(v)) return;
    clearTimeout(timer);
    const value = f().integer ? Math.round(v) : v;
    if (now) void props.write(props.path, value);
    // A slider being dragged writes a few times a second, not on every pixel.
    else timer = setTimeout(() => void props.write(props.path, value), 120);
  };
  return (
    <span class="settings-number">
      <Show when={f().auto}>
        <label class="settings-inline">
          <input
            type="checkbox"
            checked={auto()}
            onChange={(e) => void props.write(props.path, e.currentTarget.checked ? "auto" : (f().min ?? 0))}
          />
          {optionLabel("auto")}
        </label>
      </Show>
      <Show when={!auto()}>
        <Show when={slider()}>
          <input
            type="range"
            aria-label={label(props.path)}
            min={f().min}
            max={f().max}
            step={step()}
            value={n()}
            onInput={(e) => send(Number(e.currentTarget.value))}
          />
        </Show>
        <input
          id={props.id}
          type="number"
          min={f().min}
          max={f().max}
          step={step()}
          value={n()}
          onChange={(e) => send(Number(e.currentTarget.value), true)}
        />
      </Show>
    </span>
  );
}

function TextControl(props: { id: string; path: string[]; field: Field; value: unknown; write: Write }) {
  const f = () => props.field;
  const auto = () => props.value === "auto" && f().auto;
  const text = () => (typeof props.value === "string" && !auto() ? props.value : "");
  const commit = (v: string) => {
    if (v === text()) return;
    void props.write(props.path, v === "" && f().nullable ? null : v);
  };
  return (
    <span class="settings-text">
      <Show when={f().auto}>
        <label class="settings-inline">
          <input
            type="checkbox"
            checked={auto()}
            onChange={(e) => void props.write(props.path, e.currentTarget.checked ? "auto" : "")}
          />
          {optionLabel("auto")}
        </label>
      </Show>
      <Show when={f().kind === "color"}>
        <input
          type="color"
          aria-label={label(props.path)}
          value={/^#[0-9a-f]{6}$/i.test(text()) ? text() : "#000000"}
          onChange={(e) => commit(e.currentTarget.value)}
        />
      </Show>
      <Show when={!auto()}>
        <input
          id={props.id}
          type="text"
          value={text()}
          spellcheck={false}
          onChange={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && commit(e.currentTarget.value)}
        />
      </Show>
    </span>
  );
}

/** A list of strings (font families, mod ids): chips with remove and an add box. */
function ListControl(props: { id: string; path: string[]; value: unknown; write: Write; suggest?: string[] }) {
  const items = () => (Array.isArray(props.value) ? (props.value as string[]) : []);
  const listId = () => `${props.id}-list`;
  const [fonts] = createResource(
    () => props.path.join(".") === "font.family",
    (yes) => (yes ? invoke<{ name: string; monospace: boolean }[]>("fonts_list").catch(() => []) : []),
  );
  const add = (input: HTMLInputElement) => {
    const v = input.value.trim();
    if (!v) return;
    input.value = "";
    void props.write(props.path, [...items(), v]);
  };
  const move = (i: number, d: number) => {
    const a = [...items()];
    const j = i + d;
    if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j] as string, a[i] as string];
    void props.write(props.path, a);
  };
  return (
    <div class="settings-list">
      <Index each={items()}>
        {(item, i) => (
          <span class="settings-chip">
            {item()}
            <button type="button" aria-label={t("settings-move-up")} onClick={() => move(i, -1)}>
              ↑
            </button>
            <button
              type="button"
              aria-label={`${t("settings-remove")}: ${item()}`}
              onClick={() =>
                void props.write(
                  props.path,
                  items().filter((_, k) => k !== i),
                )
              }
            >
              ×
            </button>
          </span>
        )}
      </Index>
      <input
        id={props.id}
        type="text"
        list={listId()}
        placeholder={t("settings-add")}
        onKeyDown={(e) => e.key === "Enter" && add(e.currentTarget)}
        onChange={(e) => add(e.currentTarget)}
      />
      <datalist id={listId()}>
        <For each={fonts() ?? []}>
          {(f) => <option value={f.name}>{f.monospace ? t("settings-monospace") : ""}</option>}
        </For>
      </datalist>
    </div>
  );
}

/** A map of free keys to strings or enum values (`open.rules`, a profile's `env`). */
function MapControl(props: { id: string; path: string[]; field: Field; value: unknown; write: Write; schema: Schema }) {
  const entries = () => Object.entries((props.value as Record<string, unknown>) ?? {});
  const valueField = createMemo(() => describe(props.schema, props.field.item ?? {}));
  const put = (k: string, v: unknown, old?: string) => {
    const next: Record<string, unknown> = {};
    for (const [a, b] of entries()) if (a !== old) next[a] = b;
    if (k) next[k] = v;
    void props.write(props.path, next);
  };
  const simple = () => ["string", "enum", "number", "bool"].includes(valueField().kind);
  return (
    <Show when={simple()} fallback={<code class="settings-raw">{JSON.stringify(props.value)}</code>}>
      <div class="settings-map">
        <For each={entries()}>
          {([k, v]) => (
            <div class="settings-map-row">
              <input
                type="text"
                value={k}
                aria-label={t("settings-key")}
                onChange={(e) => put(e.currentTarget.value, v, k)}
              />
              <Show
                when={valueField().kind === "enum"}
                fallback={
                  <input
                    type="text"
                    value={String(v)}
                    aria-label={t("settings-value")}
                    onChange={(e) => put(k, e.currentTarget.value)}
                  />
                }
              >
                <select
                  value={String(v)}
                  aria-label={t("settings-value")}
                  onChange={(e) => put(k, e.currentTarget.value)}
                >
                  <For each={valueField().options ?? []}>{(o) => <option value={o}>{optionLabel(o)}</option>}</For>
                </select>
              </Show>
              <button type="button" aria-label={`${t("settings-remove")}: ${k}`} onClick={() => put("", undefined, k)}>
                ×
              </button>
            </div>
          )}
        </For>
        <button
          type="button"
          class="settings-small"
          onClick={() => put(`new${entries().length + 1}`, valueField().options?.[0] ?? "")}
        >
          {t("settings-add")}
        </button>
      </div>
    </Show>
  );
}

/** A list of tables (`[[profiles]]`): one small form per item. */
function ObjectsControl(props: {
  id: string;
  path: string[];
  field: Field;
  value: unknown;
  write: Write;
  schema: Schema;
}) {
  const items = () => (Array.isArray(props.value) ? (props.value as Record<string, unknown>[]) : []);
  const props_ = () => Object.entries(props.field.item?.properties ?? {}) as [string, Schema][];
  const update = (i: number, k: string, v: unknown) => {
    const next = items().map((x, j) => (j === i ? { ...x, [k]: v } : x));
    void props.write(props.path, next.map(clean));
  };
  return (
    <div class="settings-objects">
      <Index each={items()}>
        {(item, i) => (
          <fieldset class="settings-group nested">
            <legend>{String(item().name || item().id || item().key || `#${i + 1}`)}</legend>
            <For each={props_()}>
              {([k, s]) => {
                const f = describe(props.schema, s);
                const p = [...props.path, k];
                return (
                  <Show when={["bool", "number", "string", "color", "enum", "strings"].includes(f.kind)}>
                    <Row
                      path={p}
                      field={f}
                      value={item()[k]}
                      isSet={false}
                      schema={props.schema}
                      write={(_, v) => {
                        update(i, k, v);
                        return Promise.resolve();
                      }}
                    />
                  </Show>
                );
              }}
            </For>
            <button
              type="button"
              class="settings-small"
              onClick={() =>
                void props.write(
                  props.path,
                  items()
                    .filter((_, j) => j !== i)
                    .map(clean),
                )
              }
            >
              {t("settings-remove")}
            </button>
          </fieldset>
        )}
      </Index>
      <button
        type="button"
        class="settings-small"
        onClick={() => void props.write(props.path, [...items().map(clean), { id: `item${items().length + 1}` }])}
      >
        {t("settings-add")}
      </button>
    </div>
  );
}

/** Drop null and empty values so that only what the user set goes into the file. */
function clean(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
    out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Themes: gallery, live editor, import, export (docs/04 §2.4, §2.5)
// ---------------------------------------------------------------------------

interface ThemeEntry {
  theme: Theme;
  bundled: boolean;
  userFile: string | null;
}

const TERMINAL_KEYS = ["foreground", "background", "cursor", "selection"] as const;

function ThemePage(props: SettingsProps & { form: Form; write: Write }) {
  const [list, { refetch }] = createResource(() => invoke<ThemeEntry[]>("themes_list").catch(() => []));
  createEffect(() => {
    props.config;
    void refetch();
  });
  const [draft, setDraft] = createSignal<Theme>();
  const [original, setOriginal] = createSignal<string>();
  createEffect(() => props.preview(draft()));
  onCleanup(() => props.preview(undefined));

  const appearance = () => props.form.values.appearance as Record<string, unknown>;
  const darkName = () => String(appearance().theme ?? "");
  const lightName = () => String(appearance().theme_light ?? "");
  const follow = () => appearance().follow_system === true;
  /**
   * Use a theme now. Following the OS, a theme for the mode the OS is in takes that mode's place;
   * one for the other mode turns following off, or the click would change nothing visible.
   */
  const choose = async (theme: Theme) => {
    const osLight = window.matchMedia("(prefers-color-scheme: light)").matches;
    if (follow() && (theme.appearance === "light") === osLight) {
      await props.write(["appearance", osLight ? "theme_light" : "theme"], theme.name);
      return;
    }
    await props.write(["appearance", "theme"], theme.name);
    if (follow()) await props.write(["appearance", "follow_system"], false);
  };
  const edit = (e: ThemeEntry) => {
    const copy: Theme = JSON.parse(JSON.stringify(e.theme));
    // Rust leaves out an empty `[theme.ui]`.
    copy.ui ??= {};
    if (e.bundled) copy.name = t("settings-theme-copy-name", { name: e.theme.name });
    setOriginal(e.theme.name);
    setDraft(copy);
  };
  const save = async () => {
    const d = draft();
    if (!d) return;
    try {
      await invoke("theme_save", { theme: d });
      await choose(d);
      setDraft(undefined);
    } catch (e) {
      props.notify(String(e));
    }
  };
  const importFile = async (file: File) => {
    try {
      const names = await invoke<string[]>("theme_import", { text: await file.text(), fileName: file.name });
      props.notify(t("settings-theme-imported", { names: names.join(", ") }));
      void refetch();
    } catch (e) {
      props.notify(t("settings-theme-import-failed", { error: String(e) }));
    }
  };
  let importInput!: HTMLInputElement;

  return (
    <section class="settings-section" aria-label={t("settings-theme")}>
      <h3>{t("settings-theme")}</h3>
      <Show when={!draft()}>
        <div class="theme-grid">
          <For each={list() ?? []}>
            {(e) => {
              const selected = () => e.theme.name === darkName() || (follow() && e.theme.name === lightName());
              return (
                <div class="theme-card" classList={{ selected: selected() }} data-ot="theme-card">
                  <button
                    type="button"
                    class="theme-swatch"
                    aria-pressed={selected()}
                    aria-label={e.theme.name}
                    style={{ background: e.theme.terminal.background, color: e.theme.terminal.foreground }}
                    onClick={() => void choose(e.theme)}
                  >
                    <span class="theme-name">{e.theme.name}</span>
                    <span class="theme-dots" aria-hidden="true">
                      <For each={e.theme.terminal.ansi.slice(1, 7)}>{(c) => <i style={{ background: c }} />}</For>
                    </span>
                  </button>
                  <div class="theme-meta">
                    <span class="muted">
                      {optionLabel(e.theme.appearance)}
                      {e.theme.name === darkName() ? ` · ${t("settings-theme-in-use")}` : ""}
                      {follow() && e.theme.name === lightName() ? ` · ${t("settings-theme-in-use-light")}` : ""}
                    </span>
                    <button type="button" class="settings-small" onClick={() => edit(e)}>
                      {e.bundled ? t("settings-theme-customize") : t("settings-theme-edit")}
                    </button>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
        <div class="settings-actions">
          <button type="button" onClick={() => importInput.click()}>
            {t("settings-theme-import")}
          </button>
          <input
            ref={importInput}
            type="file"
            hidden
            accept=".itermcolors,.json,.jsonc,.toml,.yml,.yaml"
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (file) void importFile(file);
            }}
          />
          <span class="muted">{t("settings-theme-import-hint")}</span>
        </div>
      </Show>
      <Show when={draft()} keyed>
        {(d) => (
          <ThemeEditor
            theme={d}
            onChange={setDraft}
            onSave={() => void save()}
            onCancel={() => setDraft(undefined)}
            userFile={(list() ?? []).find((e) => e.theme.name === original())?.userFile ?? null}
            onDelete={async () => {
              try {
                await invoke("theme_delete", { name: original() });
                setDraft(undefined);
              } catch (e) {
                props.notify(String(e));
              }
            }}
            onExport={async () => {
              try {
                const dir = await invoke<string>("theme_export_mod", { name: original() });
                props.notify(t("settings-theme-exported", { path: dir }));
              } catch (e) {
                props.notify(String(e));
              }
            }}
          />
        )}
      </Show>
    </section>
  );
}

function ThemeEditor(props: {
  theme: Theme;
  onChange: (t: Theme) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onExport: () => void;
  userFile: string | null;
}) {
  // Edits go to a local copy; every change is shown in the window at once (live editing, 04 §2.5).
  const [theme, setTheme] = createSignal<Theme>(props.theme);
  const update = (f: (t: Theme) => Theme) => {
    const next = f(JSON.parse(JSON.stringify(theme())));
    setTheme(next);
    props.onChange(next);
  };
  const tokens = () => uiTokens(theme());
  const colorInput = (value: string, set: (v: string) => void, name: string) => (
    <label class="color-field">
      <input type="color" value={toHex(value)} aria-label={name} onInput={(e) => set(e.currentTarget.value)} />
      <span>{name}</span>
    </label>
  );
  return (
    <div class="theme-editor" data-ot="theme-editor">
      <div class="settings-row">
        <div class="settings-label">
          <label for="theme-name">{t("settings-theme-name")}</label>
        </div>
        <div class="settings-control">
          <input
            id="theme-name"
            type="text"
            value={theme().name}
            onChange={(e) => update((x) => ({ ...x, name: e.currentTarget.value }))}
          />
          <select
            aria-label={t("settings-theme-appearance")}
            value={theme().appearance}
            onChange={(e) => update((x) => ({ ...x, appearance: e.currentTarget.value as "light" | "dark" }))}
          >
            <option value="dark">{optionLabel("dark")}</option>
            <option value="light">{optionLabel("light")}</option>
          </select>
        </div>
      </div>
      <h4>{t("settings-theme-terminal-colors")}</h4>
      <div class="color-grid">
        <For each={TERMINAL_KEYS}>
          {(k) =>
            colorInput(
              theme().terminal[k],
              (v) => update((x) => ({ ...x, terminal: { ...x.terminal, [k]: v } })),
              t(`settings-theme-color-${k}`),
            )
          }
        </For>
      </div>
      <div class="color-grid ansi">
        <For each={[0, 1, 2, 3, 4, 5, 6, 7]}>
          {(i) =>
            colorInput(
              theme().terminal.ansi[i] ?? "#000000",
              (v) =>
                update((x) => {
                  x.terminal.ansi[i] = v;
                  return x;
                }),
              t(`settings-theme-ansi-${i}`),
            )
          }
        </For>
        <For each={[0, 1, 2, 3, 4, 5, 6, 7]}>
          {(i) =>
            colorInput(
              theme().terminal.bright[i] ?? "#000000",
              (v) =>
                update((x) => {
                  x.terminal.bright[i] = v;
                  return x;
                }),
              t("settings-theme-bright", { name: t(`settings-theme-ansi-${i}`) }),
            )
          }
        </For>
      </div>
      <h4>{t("settings-theme-ui-colors")}</h4>
      <p class="muted">{t("settings-theme-ui-hint")}</p>
      <div class="color-grid">
        <For each={UI_TOKENS.filter((k) => !["radius", "shadow", "font-ui"].includes(k))}>
          {(k) =>
            colorInput(
              tokens()[k] ?? "#000000",
              (v) => update((x) => ({ ...x, ui: { ...x.ui, [k]: v } })),
              t(`settings-token-${k}`),
            )
          }
        </For>
      </div>
      <For each={["radius", "font-ui"] as const}>
        {(k) => (
          <div class="settings-row">
            <div class="settings-label">
              <label for={`token-${k}`}>{t(`settings-token-${k}`)}</label>
            </div>
            <div class="settings-control">
              <input
                id={`token-${k}`}
                type="text"
                value={theme().ui[k] ?? ""}
                placeholder={tokens()[k]}
                onChange={(e) =>
                  update((x) => {
                    const ui = { ...x.ui };
                    if (e.currentTarget.value) ui[k] = e.currentTarget.value;
                    else delete ui[k];
                    return { ...x, ui };
                  })
                }
              />
            </div>
          </div>
        )}
      </For>
      <h4>{t("settings-theme-css")}</h4>
      <textarea
        class="settings-code"
        spellcheck={false}
        aria-label={t("settings-theme-css")}
        placeholder={'[data-ot="tab"] { border-radius: 12px; }'}
        value={theme().css?.text ?? ""}
        onInput={(e) => {
          const text = e.currentTarget.value;
          update((x) => ({ ...x, css: text ? { text } : undefined }));
        }}
      />
      <div class="settings-actions">
        <button type="button" class="primary" onClick={props.onSave}>
          {t("settings-theme-save")}
        </button>
        <button type="button" onClick={props.onCancel}>
          {t("settings-cancel")}
        </button>
        <Show when={props.userFile}>
          <button type="button" onClick={props.onExport}>
            {t("settings-theme-export")}
          </button>
          <button type="button" class="danger" onClick={props.onDelete}>
            {t("settings-theme-delete")}
          </button>
        </Show>
      </div>
    </div>
  );
}

function toHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${[...c.slice(1)].map((x) => x + x).join("")}`;
  return "#000000";
}

/** The background image: pick a picture (copied into the config folder) or remove it. */
function BackgroundPicker(props: SettingsProps & { write: Write }) {
  let input!: HTMLInputElement;
  const pickFile = async (file: File) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await invoke("background_set", bytes, { headers: { name: encodeURIComponent(file.name) } });
    } catch (e) {
      props.notify(String(e));
    }
  };
  return (
    <div class="settings-actions">
      <button type="button" onClick={() => input.click()}>
        {t("settings-bg-pick")}
      </button>
      <Show when={props.config?.window.backgroundImage}>
        <button type="button" onClick={() => void props.write(["appearance", "window", "background_image"], undefined)}>
          {t("settings-bg-clear")}
        </button>
      </Show>
      <input
        ref={input}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,image/avif"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (file) void pickFile(file);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layouts (docs/04 §1.2) and where panels go (§1.1)
// ---------------------------------------------------------------------------

function LayoutPage(props: SettingsProps & { form: Form; write: Write }) {
  const [list, { refetch }] = createResource(() =>
    invoke<{ layout: Layout; saved: boolean }[]>("layouts_list").catch(() => []),
  );
  createEffect(() => {
    props.config;
    void refetch();
  });
  const current = () => String((props.form.values.appearance as Record<string, unknown>).layout ?? "guided");
  const [name, setName] = createSignal("");
  const describeLayout = (l: Layout) =>
    [
      l.sidebar_left && t("settings-layout-part-left"),
      l.sidebar_right && t("settings-layout-part-right"),
      l.panel_bottom && t("settings-layout-part-bottom"),
      l.assist_bar && t("settings-layout-part-assist"),
      l.statusbar && t("settings-layout-part-status"),
      l.blocks === "cards" && t("settings-layout-part-cards"),
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <section class="settings-section">
      <h3>{t("settings-layout-presets")}</h3>
      <div class="layout-grid">
        <For each={list() ?? []}>
          {(e) => (
            <button
              type="button"
              class="layout-card"
              aria-pressed={e.layout.name.toLowerCase() === current().toLowerCase()}
              data-ot="layout-card"
              onClick={() => void props.write(["appearance", "layout"], e.layout.name)}
            >
              <LayoutSketch layout={e.layout} />
              <strong>{e.saved ? e.layout.name : t(`settings-layout-${e.layout.name}`)}</strong>
              <span class="muted">{describeLayout(e.layout) || t("settings-layout-part-none")}</span>
            </button>
          )}
        </For>
      </div>
      <p class="muted">{t("settings-layout-hint")}</p>
      <div class="settings-actions">
        <input
          type="text"
          placeholder={t("settings-layout-name")}
          aria-label={t("settings-layout-name")}
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
        />
        <button
          type="button"
          disabled={!name().trim()}
          onClick={() =>
            void invoke("layout_save", { name: name() })
              .then(() => {
                props.notify(t("settings-layout-saved", { name: name() }));
                setName("");
              })
              .catch((e) => props.notify(String(e)))
          }
        >
          {t("settings-layout-save")}
        </button>
      </div>
      <StatusOrder {...props} />
      <h3>{t("settings-panels")}</h3>
      <p class="muted">{t("settings-panels-hint")}</p>
      <For each={props.panels} fallback={<p class="muted">{t("settings-panels-none")}</p>}>
        {(p) => (
          <div class="settings-row">
            <div class="settings-label">
              <label for={`panel-${p.id}`}>{p.title}</label>
            </div>
            <div class="settings-control">
              <select
                id={`panel-${p.id}`}
                value={p.slot}
                onChange={(e) => void props.write(["appearance", "panels", p.id], e.currentTarget.value)}
              >
                <For each={["sidebar.left", "sidebar.right", "panel.bottom"]}>
                  {(s) => <option value={s}>{t(`settings-slot-${s.replace(".", "-")}`)}</option>}
                </For>
              </select>
            </div>
          </div>
        )}
      </For>
    </section>
  );
}

/**
 * The status bar's items in order, with buttons to move them: the keyboard way of what dragging an
 * item on the bar does (`appearance.statusbar.order`).
 */
function StatusOrder(props: SettingsProps & { write: Write }) {
  const builtin: Record<string, string> = {
    "otterm.folder": t("status-folder"),
    "otterm.guide": t("status-guide"),
    "otterm.exit": t("status-exit"),
    "otterm.mods": t("status-mods"),
  };
  const items = createMemo(() => {
    const seen = new Map<string, number>();
    const mods = props.host.items().filter((i) => i.slot.startsWith("statusbar."));
    const ids = [
      "otterm.folder",
      ...mods.map((i) => {
        const n = seen.get(i.mod) ?? 0;
        seen.set(i.mod, n + 1);
        return `${i.mod}#${n}`;
      }),
      "otterm.guide",
      "otterm.exit",
      "otterm.mods",
    ];
    const order = props.config?.statusbarOrder ?? [];
    const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
    return ids
      .map((id, i) => ({ id, i }))
      .sort((a, b) => rank(a.id) - rank(b.id) || a.i - b.i)
      .map((x) => x.id);
  });
  const name = (id: string) => {
    if (builtin[id]) return builtin[id];
    const mod = id.split("#")[0] ?? id;
    return props.host.mods().find((m) => m.entry.id === mod)?.entry.name ?? mod;
  };
  const move = (i: number, d: number) => {
    const a = [...items()];
    const j = i + d;
    if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j] as string, a[i] as string];
    void props.write(["appearance", "statusbar", "order"], a);
  };
  return (
    <>
      <h3>{t("settings-statusbar-order")}</h3>
      <p class="muted">{t("settings-statusbar-order-hint")}</p>
      <ol class="status-order">
        <For each={items()}>
          {(id, i) => (
            <li>
              <span>{name(id)}</span>
              <span class="muted mono">{id}</span>
              <button
                type="button"
                class="settings-small"
                aria-label={`${t("settings-move-up")}: ${name(id)}`}
                disabled={i() === 0}
                onClick={() => move(i(), -1)}
              >
                ↑
              </button>
              <button
                type="button"
                class="settings-small"
                aria-label={`${t("settings-move-down")}: ${name(id)}`}
                disabled={i() === items().length - 1}
                onClick={() => move(i(), 1)}
              >
                ↓
              </button>
            </li>
          )}
        </For>
      </ol>
    </>
  );
}

/** A small drawing of a layout. */
function LayoutSketch(props: { layout: Layout }) {
  const l = () => props.layout;
  return (
    <svg class="layout-sketch" viewBox="0 0 60 40" aria-hidden="true">
      <rect x="0.5" y="0.5" width="59" height="39" rx="3" class="frame" />
      <Show when={l().tabbar !== "hidden-when-single"}>
        <rect x="1" y={l().tabbar === "bottom" ? 35 : 1} width="58" height="4" class="part" />
      </Show>
      <Show when={l().sidebar_left}>
        <rect x="1" y="6" width="12" height="28" class="part" />
      </Show>
      <Show when={l().sidebar_right}>
        <rect x="47" y="6" width="12" height="28" class="part" />
      </Show>
      <Show when={l().panel_bottom}>
        <rect x={l().sidebar_left ? 14 : 1} y="26" width={l().sidebar_left ? 32 : 45} height="6" class="part" />
      </Show>
      <Show when={l().assist_bar}>
        <rect x={l().sidebar_left ? 14 : 1} y={l().panel_bottom ? 22 : 29} width="32" height="3" class="accent" />
      </Show>
      <Show when={l().statusbar}>
        <rect x="1" y={l().tabbar === "bottom" ? 31 : 35} width="58" height="3" class="part" />
      </Show>
      <Show when={l().blocks === "cards"}>
        <rect x={l().sidebar_left ? 16 : 4} y="8" width="26" height="6" rx="1.5" class="card" />
        <rect x={l().sidebar_left ? 16 : 4} y="15" width="26" height="6" rx="1.5" class="card" />
      </Show>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Fonts (docs/04 §3)
// ---------------------------------------------------------------------------

function FontPreview(props: { config: UiConfig | undefined }) {
  const f = () => props.config?.font;
  return (
    <div
      class="font-preview"
      data-ot="font-preview"
      style={{
        "font-family": f()?.family,
        "font-size": `${f()?.size ?? 14}px`,
        "line-height": String(f()?.lineHeight ?? 1.2),
        "letter-spacing": `${f()?.letterSpacing ?? 0}px`,
        "font-weight": String(f()?.weight ?? 400),
        "font-variant-ligatures": f()?.ligatures ? "normal" : "none",
        background: props.config?.theme.terminal.background,
        color: props.config?.theme.terminal.foreground,
      }}
      title={t("settings-font-preview")}
    >
      <div>The quick brown fox jumps over the lazy dog. 0O 1lI</div>
      <div>{t("settings-font-sample-ja")}</div>
      <div>{"-> => != === <= >= :: ... && || </>"}</div>
      <div>{" main   src   git  🦦 ✨"}</div>
      <div style={{ "font-weight": String(f()?.weightBold ?? 700) }}>{t("settings-font-sample-bold")}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Key bindings (docs/06 §5)
// ---------------------------------------------------------------------------

function chordOf(e: KeyboardEvent): string | undefined {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return undefined;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("ctrl");
  if (e.metaKey) parts.push("cmd");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  let key = e.key.toLowerCase();
  if (key === " ") key = "space";
  else if (e.code.startsWith("Key")) key = e.code.slice(3).toLowerCase();
  else if (e.code.startsWith("Digit")) key = e.code.slice(5);
  parts.push(key);
  return parts.join("+");
}

function KeysPage(props: SettingsProps & { write: Write }) {
  const defs = defaultKeys();
  const ids = Object.keys(defs);
  const [recording, setRecording] = createSignal<string>();
  /** Chords pressed so far while recording; a pause ends the sequence (`ctrl+k ctrl+s`). */
  const [steps, setSteps] = createSignal<string[]>([]);
  let stepTimer: ReturnType<typeof setTimeout> | undefined;
  const [filter, setFilter] = createSignal("");
  const bound = (id: string) => props.config?.keybindings[id] ?? defs[id] ?? [];
  const conflicts = createMemo(() => {
    const by = new Map<string, string[]>();
    for (const id of ids) for (const k of bound(id)) by.set(k, [...(by.get(k) ?? []), id]);
    return new Set([...by.values()].filter((v) => v.length > 1).flat());
  });
  const name = (id: string) => {
    const key = `keyact-${id.replaceAll(".", "-")}`;
    const s = t(key);
    return s === key ? id : s;
  };
  const shown = () => ids.filter((id) => `${id} ${name(id)}`.toLowerCase().includes(filter().toLowerCase()));
  const record = (id: string, e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      clearTimeout(stepTimer);
      setSteps([]);
      return setRecording(undefined);
    }
    const chord = chordOf(e);
    if (!chord) return;
    const next = [...steps(), chord];
    setSteps(next);
    clearTimeout(stepTimer);
    // A second chord within a moment makes a sequence; two steps at most, like VS Code.
    const done = () => {
      setSteps([]);
      setRecording(undefined);
      void props.write(["keybindings", "bindings", id], [next.join(" ")]);
    };
    if (next.length >= 2) done();
    else stepTimer = setTimeout(done, 900);
  };
  /** Mods' suggested keys, and whether one of otterm's or the user's keys took the chord (docs/06 §5.3). */
  const suggested = createMemo(() => {
    const map = new Keymap(props.config?.keybindings ?? {}, props.config?.customKeys ?? []);
    return props.host.suggestedKeys().map((k) => ({ ...k, lost: !!k.chord && map.claims(k.chord) }));
  });
  return (
    <section class="settings-section">
      <input
        type="search"
        class="settings-filter"
        placeholder={t("settings-keys-filter")}
        aria-label={t("settings-keys-filter")}
        onInput={(e) => setFilter(e.currentTarget.value)}
      />
      <table class="keys-table">
        <tbody>
          <For each={shown()}>
            {(id) => (
              <tr classList={{ conflict: conflicts().has(id) }} data-ot="keybinding">
                <td>
                  {name(id)}
                  <div class="muted mono">{id}</div>
                </td>
                <td class="mono">
                  <Show when={recording() === id} fallback={bound(id).join(", ") || t("settings-keys-none")}>
                    <input
                      class="keys-record"
                      readonly
                      value={steps().length > 0 ? `${steps().join(" ")} …` : t("settings-keys-press")}
                      ref={(el) => setTimeout(() => el.focus())}
                      onKeyDown={(e) => record(id, e)}
                      onBlur={() => setRecording(undefined)}
                    />
                  </Show>
                  <Show when={conflicts().has(id)}>
                    <div class="keys-conflict">⚠ {t("settings-keys-conflict")}</div>
                  </Show>
                </td>
                <td class="keys-buttons">
                  <button type="button" class="settings-small" onClick={() => setRecording(id)}>
                    {t("settings-keys-record")}
                  </button>
                  <button
                    type="button"
                    class="settings-small"
                    onClick={() => void props.write(["keybindings", "bindings", id], [])}
                  >
                    {t("settings-keys-clear")}
                  </button>
                  <Show when={props.config?.keybindings[id] !== undefined}>
                    <button
                      type="button"
                      class="settings-small"
                      aria-label={`${t("settings-reset")}: ${name(id)}`}
                      onClick={() => void props.write(["keybindings", "bindings", id], undefined)}
                    >
                      ↺
                    </button>
                  </Show>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <h3>{t("settings-keys-custom")}</h3>
      <p class="muted">{t("settings-keys-custom-hint")}</p>
      <Show when={(props.config?.customKeys ?? []).length > 0}>
        <table class="keys-table">
          <tbody>
            <For each={props.config?.customKeys ?? []}>
              {(k) => (
                <tr data-ot="keybinding-custom">
                  <td class="mono">{k.key}</td>
                  <td>
                    <span class="mono">{k.command}</span>
                    <Show when={Object.keys(k.args).length > 0}>
                      <div class="muted mono">{JSON.stringify(k.args)}</div>
                    </Show>
                    <Show when={k.when}>
                      <div class="muted mono">when {k.when}</div>
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
      <Show when={suggested().length > 0}>
        <h3>{t("settings-keys-mods")}</h3>
        <table class="keys-table">
          <tbody>
            <For each={suggested()}>
              {(k) => (
                <tr classList={{ conflict: k.lost }} data-ot="keybinding-mod">
                  <td>
                    <span class="mono">{k.command}</span>
                    <div class="muted mono">{k.mod}</div>
                  </td>
                  <td class="mono">
                    {k.key}
                    <Show when={k.lost}>
                      <div class="keys-conflict">⚠ {t("settings-keys-mod-lost")}</div>
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </section>
  );
}

/** A button that asks once more before it acts (resets that cannot be undone from here). */
function ConfirmButton(props: { label: string; confirm: string; onConfirm: () => void }) {
  const [armed, setArmed] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  return (
    <button
      type="button"
      class="settings-small"
      classList={{ danger: armed() }}
      onClick={() => {
        if (armed()) {
          clearTimeout(timer);
          setArmed(false);
          props.onConfirm();
          return;
        }
        setArmed(true);
        timer = setTimeout(() => setArmed(false), 4000);
      }}
    >
      {armed() ? props.confirm : props.label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Mods: on/off and each mod's own settings (`[settings.schema]`, docs/05 §3.1)
// ---------------------------------------------------------------------------

interface ModSetting {
  type?: string;
  default?: unknown;
  label?: string;
  min?: number;
  max?: number;
  values?: { value: string; label?: string }[];
}

/** `"日本語 / English"` labels in manifests: the part for the UI language. */
function bilingual(s: string | undefined): string {
  if (!s) return "";
  const parts = s.split(" / ");
  if (parts.length !== 2) return s;
  return document.documentElement.lang === "ja" ? (parts[0] as string) : (parts[1] as string);
}

function ModsPage(props: { host: ModHost; notify: (s: string) => void }) {
  const set = (id: string, key: string, value: unknown) =>
    void invoke("mod_setting_set", { id, key, value }).catch((e) => props.notify(String(e)));
  return (
    <section class="settings-section">
      <For each={props.host.mods()}>
        {(m) => {
          const schema = () => Object.entries(m.entry.settingsSchema ?? {}) as [string, ModSetting][];
          return (
            <fieldset class="settings-group" data-ot="mod-settings">
              <legend>
                {m.entry.name} <span class="muted">v{m.entry.version}</span>
              </legend>
              <div class="settings-row">
                <div class="settings-label">
                  <label for={`mod-${m.entry.id}`}>{t("settings-mod-enabled")}</label>
                  <div class="settings-desc mono">{m.entry.id}</div>
                </div>
                <div class="settings-control">
                  <input
                    id={`mod-${m.entry.id}`}
                    type="checkbox"
                    class="settings-switch"
                    checked={m.entry.enabled}
                    onChange={(e) =>
                      void invoke("mod_set_enabled", { id: m.entry.id, enabled: e.currentTarget.checked }).catch(
                        (err) => props.notify(String(err)),
                      )
                    }
                  />
                </div>
              </div>
              <For each={schema()}>
                {([key, s]) => {
                  const v = () => (m.entry.settings as Record<string, unknown>)[key] ?? s.default;
                  const id = `mod-${m.entry.id}-${key}`;
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
                            onChange={(e) => set(m.entry.id, key, e.currentTarget.checked)}
                          />
                        </Show>
                        <Show when={s.type === "integer" || s.type === "number"}>
                          <input
                            id={id}
                            type="number"
                            min={s.min}
                            max={s.max}
                            value={Number(v() ?? 0)}
                            onChange={(e) => set(m.entry.id, key, Number(e.currentTarget.value))}
                          />
                        </Show>
                        <Show when={s.type === "string"}>
                          <input
                            id={id}
                            type="text"
                            value={String(v() ?? "")}
                            onChange={(e) => set(m.entry.id, key, e.currentTarget.value)}
                          />
                        </Show>
                        <Show when={s.type === "enum"}>
                          <select
                            id={id}
                            value={String(v() ?? "")}
                            onChange={(e) => set(m.entry.id, key, e.currentTarget.value)}
                          >
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
            </fieldset>
          );
        }}
      </For>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Advanced: user.css and the file itself
// ---------------------------------------------------------------------------

function AdvancedPage(props: SettingsProps & { form: Form }) {
  let bundleInput!: HTMLInputElement;
  const [css, setCss] = createSignal("");
  const [dirty, setDirty] = createSignal(false);
  onMount(
    () =>
      void invoke<string>("user_css_get")
        .then(setCss)
        .catch(() => {}),
  );
  onCleanup(() => {
    // Leaving without saving: back to what the file says.
    if (dirty()) setStyleSheet("ot-user-css", props.config?.userCss ?? "");
  });
  return (
    <section class="settings-section">
      <h3>{t("settings-css")}</h3>
      <p class="muted">{t("settings-css-hint")}</p>
      <textarea
        class="settings-code tall"
        spellcheck={false}
        aria-label={t("settings-css")}
        placeholder={'[data-ot="statusbar"] { font-size: 13px; }'}
        value={css()}
        onInput={(e) => {
          setCss(e.currentTarget.value);
          setDirty(true);
          // Live: shown before it is saved.
          setStyleSheet("ot-user-css", e.currentTarget.value);
        }}
      />
      <div class="settings-actions">
        <button
          type="button"
          class="primary"
          disabled={!dirty()}
          onClick={() =>
            void invoke("user_css_set", { text: css() })
              .then(() => setDirty(false))
              .catch((e) => props.notify(String(e)))
          }
        >
          {t("settings-css-save")}
        </button>
      </div>
      <h3>{t("settings-safe-mode")}</h3>
      <p class="muted">{t("settings-safe-mode-hint")}</p>
      <div class="settings-actions">
        <button type="button" onClick={() => props.restart(!props.config?.safeMode)}>
          {t(props.config?.safeMode ? "palette-cmd-restart-normal" : "palette-cmd-restart-safe")}
        </button>
      </div>
      <h3>{t("settings-file")}</h3>
      <p class="muted mono">{props.form.path ?? ""}</p>
      <div class="settings-actions">
        <button type="button" onClick={() => void invoke("config_open").catch((e) => props.notify(String(e)))}>
          {t("settings-open-file")}
        </button>
      </div>
      <h3>{t("settings-bundle")}</h3>
      <p class="muted">{t("settings-bundle-hint")}</p>
      <div class="settings-actions">
        <button
          type="button"
          onClick={() =>
            void invoke<string>("config_export")
              .then((path) => props.notify(t("settings-exported", { path })))
              .catch((e) => props.notify(String(e)))
          }
        >
          {t("settings-export")}
        </button>
        <button type="button" onClick={() => bundleInput.click()}>
          {t("settings-import")}
        </button>
        <input
          ref={bundleInput}
          type="file"
          hidden
          accept=".zip"
          onChange={async (e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (!file) return;
            try {
              const body = new Uint8Array(await file.arrayBuffer());
              const report = await invoke<string>("config_import", body);
              props.notify(report.trim().split("\n").join(" · "));
            } catch (err) {
              props.notify(String(err));
            }
          }}
        />
      </div>
      <h3>{t("settings-reset-all")}</h3>
      <p class="muted">{t("settings-reset-all-hint")}</p>
      <div class="settings-actions">
        <ConfirmButton
          label={t("settings-reset-all")}
          confirm={t("settings-reset-confirm")}
          onConfirm={() => void invoke("config_reset", { path: [] }).catch((e) => props.notify(String(e)))}
        />
      </div>
    </section>
  );
}
