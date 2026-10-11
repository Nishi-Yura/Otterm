/**
 * Renders a mod's declarative UI tree (docs/05 §5.3) with plain HTML and `mt-*` classes.
 *
 * The tree is replaced wholesale whenever the mod re-renders. `NodeView` picks a view per node type
 * through `Switch`, so a view survives a re-render that keeps its type: an input keeps focus while the
 * user types, and list/tree local state is not thrown away. Only `props.node` changes underneath.
 */

import type { JSX } from "solid-js";
import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { Dynamic } from "solid-js/web";
import { t } from "../i18n";
import { Icon as SvgIcon } from "../icons";
import { platform } from "../keys";
import type {
  BadgeNode,
  BaseNode,
  ButtonNode,
  CodeNode,
  CustomNode,
  DividerNode,
  FnRef,
  HeadingNode,
  InputNode,
  ListItem,
  ListNode,
  MarkdownNode,
  MenuItemRef,
  ProgressNode,
  RowNode,
  SelectNode,
  SerializedNode,
  SpacerNode,
  SparklineNode,
  StackNode,
  TableColumn,
  TableNode,
  TextNode,
  ToggleNode,
  TreeHost,
  TreeItem,
  TreeNode,
} from "./tree";
import "./ui.css";

/** Render context: the host callbacks go through, and whether this tree sits in the status bar. */
interface Ctx {
  readonly host: TreeHost;
  /** Status bar: everything inline and compact. Panels get block layout. */
  readonly status: boolean;
  /** The mod that owns this tree: its `custom` views load their `otmod:` assets from its folder. */
  readonly mod?: string;
}

type Props<N> = { node: N; ctx: Ctx };

/** Lists and tables stop here so a huge mod list cannot freeze the window. */
const ROW_CAP = 500;

export interface ModTreeProps {
  node: SerializedNode;
  host: TreeHost;
  /** "status" for the status bar (inline, compact), "panel" for side/bottom panels (block layout). */
  context?: "status" | "panel";
  /** The id of the mod that sent the tree (for `custom` views' `otmod:` assets). */
  mod?: string;
}

/** Entry point: renders one serialized node (and everything below it). */
export function ModTree(props: ModTreeProps): JSX.Element {
  const ctx: Ctx = {
    get host() {
      return props.host;
    },
    get status() {
      return props.context === "status";
    },
    get mod() {
      return props.mod;
    },
  };
  return (
    <div class="mt-root" classList={{ "mt-status": ctx.status, "mt-panel": !ctx.status }}>
      <NodeView node={props.node} ctx={ctx} />
    </div>
  );
}

// ---- helpers --------------------------------------------------------------

function invoke(host: TreeHost, fn: FnRef | undefined, args?: unknown[]): void {
  if (!fn) return;
  host.invoke(fn, args).catch((err: unknown) => console.error("[mod-ui] callback failed", err));
}

function openMenu(e: MouseEvent, host: TreeHost, items: MenuItemRef[] | undefined): void {
  if (!items || items.length === 0) return;
  e.preventDefault();
  host.contextMenu(e.clientX, e.clientY, items);
}

/** Enter and Space activate a focusable element that is not a native button. */
function activateOnKey(e: KeyboardEvent, act: () => void): void {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  e.stopPropagation();
  act();
}

/** Only the whitelisted style properties pass through (`BaseNode.style`). */
function styleOf(s: BaseNode["style"]): JSX.CSSProperties | undefined {
  if (!s) return undefined;
  return {
    padding: s.padding,
    margin: s.margin,
    width: s.width,
    height: s.height,
    flex: s.flex,
    color: s.color,
    background: s.background,
  };
}

/** A mod's icon by its Lucide name, from otterm's own set (icons.tsx). */
function Icon(props: { name?: string }): JSX.Element {
  return (
    <Show when={props.name}>
      {(name) => (
        <span class="mt-icon" data-icon={name()} aria-hidden="true">
          <SvgIcon name={name()} />
        </span>
      )}
    </Show>
  );
}

function ItemBadge(props: { text?: string }): JSX.Element {
  return <Show when={props.text}>{(text) => <span class="mt-badge mt-badge-neutral">{text()}</span>}</Show>;
}

// ---- dispatch -------------------------------------------------------------

/**
 * Picks the view for a node. `Switch` keeps the matched view alive while its type stays the same:
 * the view reads `props.node` lazily, so a re-render only updates its attributes.
 */
function NodeView(props: { node: SerializedNode; ctx: Ctx }): JSX.Element {
  return (
    <Show when={!props.node.hidden}>
      <Switch>
        <Match when={props.node.type === "text"}>
          <TextView node={props.node as TextNode} ctx={props.ctx} />
        </Match>
        <Match when={props.node.type === "heading"}>
          <HeadingView node={props.node as HeadingNode} ctx={props.ctx} />
        </Match>
        <Match when={props.node.type === "stack"}>
          <StackView node={props.node as StackNode} ctx={props.ctx} />
        </Match>
        <Match when={props.node.type === "row"}>
          <RowView node={props.node as RowNode} ctx={props.ctx} />
        </Match>
        <Match when={props.node.type === "list"}>
          <ListView node={props.node as ListNode} ctx={props.ctx} />
        </Match>
        <Match when={props.node.type === "tree"}>
          <TreeView node={props.node as TreeNode} ctx={props.ctx} />
        </Match>
        <Match when={props.node.type === "table"}>
          <TableView node={props.node as TableNode} ctx={props.ctx} />
        </Match>
        <Match when={props.node.type === "button"}>
          <ButtonView node={props.node as ButtonNode} ctx={props.ctx} />
        </Match>
        <Match when={props.node.type === "input"}>
          <InputView node={props.node as InputNode} ctx={props.ctx} />
        </Match>
        <Match when={props.node.type === "select"}>
          <SelectView node={props.node as SelectNode} ctx={props.ctx} />
        </Match>
        <Match when={props.node.type === "toggle"}>
          <ToggleView node={props.node as ToggleNode} ctx={props.ctx} />
        </Match>
        <Match when={props.node.type === "badge"}>
          <BadgeView node={props.node as BadgeNode} ctx={props.ctx} />
        </Match>
        <Match when={props.node.type === "progress"}>
          <ProgressView node={props.node as ProgressNode} ctx={props.ctx} />
        </Match>
        <Match when={props.node.type === "code"}>
          <CodeView node={props.node as CodeNode} ctx={props.ctx} />
        </Match>
        <Match when={props.node.type === "markdown"}>
          <MarkdownView node={props.node as MarkdownNode} ctx={props.ctx} />
        </Match>
        <Match when={props.node.type === "divider"}>
          <DividerView node={props.node as DividerNode} ctx={props.ctx} />
        </Match>
        <Match when={props.node.type === "spacer"}>
          <SpacerView node={props.node as SpacerNode} ctx={props.ctx} />
        </Match>
        <Match when={props.node.type === "sparkline"}>
          <SparklineView node={props.node as SparklineNode} ctx={props.ctx} />
        </Match>
        <Match when={props.node.type === "custom"}>
          <CustomView node={props.node as CustomNode} ctx={props.ctx} />
        </Match>
      </Switch>
    </Show>
  );
}

// ---- leaves ---------------------------------------------------------------

function TextView(props: Props<TextNode>): JSX.Element {
  const clickable = () => props.node.onClick !== undefined;
  const activate = () => invoke(props.ctx.host, props.node.onClick);
  // Two static elements instead of one with a conditional role: the clickable one is a focusable button-like span.
  return (
    <Show
      when={clickable()}
      fallback={
        <span
          class="mt-text"
          classList={{ "mt-muted": props.node.muted === true }}
          title={props.node.tooltip}
          style={styleOf(props.node.style)}
        >
          <Icon name={props.node.icon} />
          <span>{props.node.text}</span>
        </span>
      }
    >
      {/* biome-ignore lint/a11y/useSemanticElements: the mod spec asks for a button-like span (role, tabIndex, Enter/Space) */}
      <span
        class="mt-text mt-clickable"
        classList={{ "mt-muted": props.node.muted === true }}
        role="button"
        tabIndex={0}
        title={props.node.tooltip}
        style={styleOf(props.node.style)}
        onClick={activate}
        onKeyDown={(e) => activateOnKey(e, activate)}
      >
        <Icon name={props.node.icon} />
        <span>{props.node.text}</span>
      </span>
    </Show>
  );
}

function HeadingView(props: Props<HeadingNode>): JSX.Element {
  const tag = (): "h1" | "h2" | "h3" => {
    if (props.node.level === 1) return "h1";
    return props.node.level === 3 ? "h3" : "h2";
  };
  return (
    <Dynamic
      component={tag()}
      class={`mt-heading mt-heading-${props.node.level ?? 2}`}
      title={props.node.tooltip}
      style={styleOf(props.node.style)}
    >
      {props.node.text}
    </Dynamic>
  );
}

function ButtonView(props: Props<ButtonNode>): JSX.Element {
  return (
    <button
      type="button"
      class={`mt-button mt-button-${props.node.variant ?? "default"}`}
      classList={{ "mt-button-icon": !!props.node.iconOnly && !!props.node.icon }}
      disabled={props.node.disabled === true}
      title={props.node.tooltip ?? (props.node.iconOnly ? props.node.text : undefined)}
      aria-label={props.node.iconOnly ? props.node.text : undefined}
      style={styleOf(props.node.style)}
      onClick={() => invoke(props.ctx.host, props.node.onClick)}
    >
      <Icon name={props.node.icon} />
      <Show when={!props.node.iconOnly || !props.node.icon}>
        <span>{props.node.text}</span>
      </Show>
    </button>
  );
}

function InputView(props: Props<InputNode>): JSX.Element {
  return (
    <input
      class="mt-input"
      type={props.node.kind ?? "text"}
      placeholder={props.node.placeholder}
      value={props.node.value.value}
      title={props.node.tooltip}
      style={styleOf(props.node.style)}
      onInput={(e) => props.ctx.host.setSignal(props.node.value, e.currentTarget.value)}
      onKeyDown={(e) => {
        // Keys typed into a mod field must never reach the terminal.
        e.stopPropagation();
        if (e.key === "Enter") invoke(props.ctx.host, props.node.onSubmit, [e.currentTarget.value]);
      }}
    />
  );
}

function SelectView(props: Props<SelectNode>): JSX.Element {
  return (
    <select
      class="mt-select"
      title={props.node.tooltip}
      style={styleOf(props.node.style)}
      onChange={(e) => props.ctx.host.setSignal(props.node.value, e.currentTarget.value)}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <For each={props.node.options}>
        {(o) => (
          <option value={o.value} selected={o.value === props.node.value.value}>
            {o.label}
          </option>
        )}
      </For>
    </select>
  );
}

function ToggleView(props: Props<ToggleNode>): JSX.Element {
  return (
    <label class="mt-toggle" title={props.node.tooltip} style={styleOf(props.node.style)}>
      <input
        class="mt-toggle-input"
        type="checkbox"
        checked={props.node.value.value}
        onChange={(e) => props.ctx.host.setSignal(props.node.value, e.currentTarget.checked)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <span class="mt-switch" aria-hidden="true" />
      <Show when={props.node.label}>{(label) => <span class="mt-toggle-label">{label()}</span>}</Show>
    </label>
  );
}

function BadgeView(props: Props<BadgeNode>): JSX.Element {
  return (
    <span
      class={`mt-badge mt-badge-${props.node.kind ?? "neutral"}`}
      title={props.node.tooltip}
      style={styleOf(props.node.style)}
    >
      {props.node.text}
    </span>
  );
}

function ProgressView(props: Props<ProgressNode>): JSX.Element {
  const value = () => {
    const v = props.node.value;
    return v === undefined ? undefined : Math.min(1, Math.max(0, v));
  };
  return (
    <div class="mt-progress" title={props.node.tooltip} style={styleOf(props.node.style)}>
      <progress
        class="mt-progress-bar"
        max={1}
        ref={(el) =>
          createEffect(() => {
            // The `value` property would turn an absent value into 0; the attribute keeps it indeterminate.
            const v = value();
            if (v === undefined) el.removeAttribute("value");
            else el.setAttribute("value", String(v));
          })
        }
      />
      <Show when={props.node.label}>{(label) => <span class="mt-progress-label mt-muted">{label()}</span>}</Show>
    </div>
  );
}

function CodeView(props: Props<CodeNode>): JSX.Element {
  return (
    <div class="mt-code" title={props.node.tooltip} style={styleOf(props.node.style)}>
      <Show when={props.node.insertable === true || props.node.copyable === true}>
        <div class="mt-code-actions">
          <Show when={props.node.insertable === true}>
            <button
              type="button"
              class="mt-button mt-button-ghost mt-button-small"
              onClick={() => props.ctx.host.insert(props.node.code)}
            >
              {t("action-insert")}
            </button>
          </Show>
          <Show when={props.node.copyable === true}>
            <button
              type="button"
              class="mt-button mt-button-ghost mt-button-small"
              onClick={() => props.ctx.host.copy(props.node.code)}
            >
              {t("menu-copy")}
            </button>
          </Show>
        </div>
      </Show>
      <pre class="mt-code-body">
        <code data-lang={props.node.language}>{props.node.code}</code>
      </pre>
    </div>
  );
}

function DividerView(props: Props<DividerNode>): JSX.Element {
  return <hr class="mt-divider" style={styleOf(props.node.style)} />;
}

function SpacerView(props: Props<SpacerNode>): JSX.Element {
  return (
    <div class={`mt-spacer mt-spacer-${props.node.size ?? "m"}`} style={styleOf(props.node.style)} aria-hidden="true" />
  );
}

// ---- markdown (no raw HTML: text nodes only, links limited to http(s)) ----

const BLOCK_START = /^(```|#{1,3}\s|[-*]\s)/;
const INLINE_TOKEN = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

function inline(text: string): JSX.Element[] {
  const out: JSX.Element[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_TOKEN)) {
    const [whole, code, bold, label, url] = m;
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (code !== undefined) out.push(<code>{code}</code>);
    else if (bold !== undefined) out.push(<strong>{bold}</strong>);
    else if (label !== undefined && url !== undefined && /^https?:\/\//i.test(url)) {
      out.push(
        <a href={url} target="_blank" rel="noopener noreferrer">
          {label}
        </a>,
      );
    } else out.push(whole ?? "");
    last = at + (whole?.length ?? 0);
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function markdownBlocks(source: string): JSX.Element[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: JSX.Element[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) body.push(lines[i++] ?? "");
      i++; // closing fence (or end of input)
      out.push(
        <pre class="mt-md-code">
          <code>{body.join("\n")}</code>
        </pre>,
      );
    } else if (heading) {
      const hashes = heading[1] ?? "#";
      const Tag = hashes.length === 1 ? "h1" : hashes.length === 2 ? "h2" : "h3";
      out.push(<Dynamic component={Tag}>{inline(heading[2] ?? "")}</Dynamic>);
      i++;
    } else if (/^[-*]\s+/.test(line)) {
      const items: JSX.Element[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i] ?? "")) {
        items.push(<li>{inline((lines[i++] ?? "").replace(/^[-*]\s+/, ""))}</li>);
      }
      out.push(<ul>{items}</ul>);
    } else if (line.trim() === "") {
      i++;
    } else {
      const para: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trim() !== "" && !BLOCK_START.test(lines[i] ?? "")) {
        para.push(lines[i++] ?? "");
      }
      out.push(<p>{inline(para.join(" "))}</p>);
    }
  }
  return out;
}

function MarkdownView(props: Props<MarkdownNode>): JSX.Element {
  return (
    <div class="mt-markdown" title={props.node.tooltip} style={styleOf(props.node.style)}>
      {markdownBlocks(props.node.source)}
    </div>
  );
}

// ---- sparkline ------------------------------------------------------------

function SparklineView(props: Props<SparklineNode>): JSX.Element {
  const w = () => (props.ctx.status ? 64 : 100);
  const h = () => (props.ctx.status ? 16 : 32);
  const points = () => {
    const vs = props.node.values;
    if (vs.length === 0) return "";
    const lo = props.node.min ?? vs.reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
    const hi = props.node.max ?? vs.reduce((a, b) => Math.max(a, b), Number.NEGATIVE_INFINITY);
    const span = hi - lo || 1;
    const n = vs.length;
    return vs
      .map((v, i) => {
        const x = n > 1 ? (i / (n - 1)) * w() : w() / 2;
        const y = h() - 1 - ((v - lo) / span) * (h() - 2);
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  };
  const stroke = `var(--ot-${props.node.color ?? "accent"}, currentColor)`;
  return (
    <svg
      class={`mt-spark ${props.ctx.status ? "mt-spark-status" : "mt-spark-panel"}`}
      viewBox={`0 0 ${w()} ${h()}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ ...styleOf(props.node.style), stroke }}
    >
      <polyline points={points()} />
    </svg>
  );
}

// ---- custom (sandboxed iframe, HTML and CSS only: decision D7) -------------

/** Theme variables the frame needs: the base colors plus every `--ot-*` set on the page. */
function themeCss(): string {
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const decls: string[] = [];
  const clean = (v: string) => v.trim().replace(/[<>{};]/g, "");
  for (const name of ["--bg", "--fg", "--muted"]) {
    const v = clean(computed.getPropertyValue(name));
    if (v) decls.push(`${name}:${v}`);
  }
  for (let i = 0; i < root.style.length; i++) {
    const name = root.style.item(i);
    if (!name.startsWith("--ot-") || name === "--ot-bg-image") continue;
    const v = clean(root.style.getPropertyValue(name));
    if (v) decls.push(`${name}:${v}`);
  }
  return `:root{${decls.join(";")}}`;
}

/**
 * The content policy of a `custom` frame (docs/05 §5.4 B, decision D7): no scripts, and assets only from `otmod:`.
 * On Windows WebView2 serves the scheme as `http://otmod.localhost`, so that origin is listed as well.
 */
function contentPolicy(): string {
  const src = platform === "windows" ? "otmod: http://otmod.localhost" : "otmod:";
  return `default-src 'none'; style-src 'unsafe-inline' ${src}; img-src data: ${src}; font-src ${src}; media-src ${src}`;
}

/** The address of a mod's assets: `otmod:` is served as `http://otmod.localhost/<mod>/` on Windows. */
function assetBase(mod: string): string {
  return platform === "windows"
    ? `http://otmod.localhost/${encodeURIComponent(mod)}/`
    : `otmod://${encodeURIComponent(mod)}/`;
}

/** Point `otmod:a.png`, `otmod:/a.png`, `otmod://a.png` and `url(otmod:...)` at the mod's asset address. */
function resolveAssets(html: string, mod: string): string {
  return html.replace(/otmod:(?:\/\/|\/)?([^\s"'()<>]*)/g, (_, path: string) => assetBase(mod) + path);
}

function buildSrcdoc(html: string, mod: string | undefined): string {
  const body = mod === undefined ? html : resolveAssets(html, mod);
  return (
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${contentPolicy()}">` +
    `<style>:root{color-scheme:light dark}${themeCss()}body{margin:0;font:12px system-ui;color:var(--fg);}</style>` +
    body
  );
}

function CustomView(props: Props<CustomNode>): JSX.Element {
  // Recomputed only when the HTML changes, so an unrelated re-render does not reload the frame.
  const doc = createMemo(() => buildSrcdoc(props.node.html, props.ctx.mod));
  const height = () => {
    const h = props.node.height;
    if (typeof h === "number") return `${h}px`;
    return h === "auto" ? "200px" : "120px";
  };
  // `onMessage` is not wired: with no scripts in the frame nothing can post to us yet.
  return (
    <iframe
      class="mt-custom"
      title={props.node.tooltip}
      aria-label="Mod view"
      sandbox=""
      referrerpolicy="no-referrer"
      srcdoc={doc()}
      style={{ height: height() }}
    />
  );
}

// ---- containers -----------------------------------------------------------

function StackView(props: Props<StackNode>): JSX.Element {
  return (
    <div
      class={`mt-stack mt-gap-${props.node.gap ?? "s"}`}
      title={props.node.tooltip}
      style={styleOf(props.node.style)}
    >
      <For each={props.node.children}>{(child) => <NodeView node={child} ctx={props.ctx} />}</For>
    </div>
  );
}

function RowView(props: Props<RowNode>): JSX.Element {
  return (
    <div
      class={`mt-row mt-gap-${props.node.gap ?? "s"} mt-justify-${props.node.align ?? "start"}`}
      title={props.node.tooltip}
      style={styleOf(props.node.style)}
    >
      <For each={props.node.children}>{(child) => <NodeView node={child} ctx={props.ctx} />}</For>
    </div>
  );
}

// ---- list -----------------------------------------------------------------

function ListView(props: Props<ListNode>): JSX.Element {
  // Selection is local: a list is not backed by a Signal.
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set());
  const keyOf = (item: ListItem, i: number) => item.key ?? String(i);
  const clickable = (item: ListItem) => item.onClick !== undefined || props.node.selectable === true;
  const overflow = () => props.node.items.length - ROW_CAP;

  const pick = (item: ListItem, i: number) => {
    if (props.node.selectable) {
      const k = keyOf(item, i);
      const next = new Set(picked());
      if (next.has(k)) next.delete(k);
      else next.add(k);
      setPicked(next);
      invoke(props.ctx.host, props.node.onSelect, [[...next]]);
    }
    invoke(props.ctx.host, item.onClick);
  };

  return (
    <ul class="mt-list" title={props.node.tooltip} style={styleOf(props.node.style)}>
      <Show when={props.node.items.length === 0 && props.node.emptyText}>
        {(text) => <li class="mt-empty mt-muted">{text()}</li>}
      </Show>
      {/* `virtual` is accepted but ignored for now: the list renders up to ROW_CAP rows. */}
      <For each={props.node.items.slice(0, ROW_CAP)}>
        {(item, i) => (
          <li
            class="mt-item"
            classList={{
              "mt-clickable": clickable(item),
              "mt-selected": picked().has(keyOf(item, i())),
            }}
            tabIndex={clickable(item) ? 0 : undefined}
            onClick={() => pick(item, i())}
            onKeyDown={(e) => {
              if (clickable(item)) activateOnKey(e, () => pick(item, i()));
            }}
            onContextMenu={(e) => openMenu(e, props.ctx.host, item.contextMenu)}
          >
            <Icon name={item.icon} />
            <span class="mt-item-text">{item.text}</span>
            <Show when={item.secondary}>
              {(secondary) => <span class="mt-item-secondary mt-muted">{secondary()}</span>}
            </Show>
            <ItemBadge text={item.badge} />
          </li>
        )}
      </For>
      <Show when={overflow() > 0}>
        <li class="mt-more mt-muted">…</li>
      </Show>
    </ul>
  );
}

// ---- tree -----------------------------------------------------------------

interface TreeState {
  readonly ctx: Ctx;
  isOpen(key: string): boolean;
  isSelected(key: string): boolean;
  loaded(): Readonly<Record<string, TreeItem[]>>;
  toggle(item: TreeItem): void;
  activate(item: TreeItem): void;
  load(key: string): void;
}

function TreeView(props: Props<TreeNode>): JSX.Element {
  const [open, setOpen] = createSignal<ReadonlySet<string>>(new Set(props.node.expanded?.value ?? []));
  const [sel, setSel] = createSignal<string | undefined>(props.node.selected?.value);
  const [loadedMap, setLoadedMap] = createSignal<Readonly<Record<string, TreeItem[]>>>({});
  const pending = new Set<string>();

  // The mod owns these Signals: follow their value whenever the tree is re-rendered.
  createEffect(() => setOpen(new Set(props.node.expanded?.value ?? [])));
  createEffect(() => setSel(props.node.selected?.value));

  const load = (key: string) => {
    const fn = props.node.loadChildren;
    if (!fn || pending.has(key)) return;
    pending.add(key);
    props.ctx.host
      .invoke(fn, [key])
      .then((res) => setLoadedMap((prev) => ({ ...prev, [key]: Array.isArray(res) ? res : [] })))
      .catch((err: unknown) => console.error("[mod-ui] loadChildren failed", err))
      .finally(() => pending.delete(key));
  };

  const toggle = (item: TreeItem) => {
    const next = new Set(open());
    const willOpen = !next.has(item.key);
    if (willOpen) next.add(item.key);
    else next.delete(item.key);
    setOpen(next);
    if (props.node.expanded) props.ctx.host.setSignal(props.node.expanded, [...next]);
    // Refresh lazy children on every expand; the row effect only fills the first load.
    if (willOpen && item.children === true) load(item.key);
  };

  const activate = (item: TreeItem) => {
    setSel(item.key);
    if (props.node.selected) props.ctx.host.setSignal(props.node.selected, item.key);
    invoke(props.ctx.host, item.onClick);
  };

  const state: TreeState = {
    ctx: props.ctx,
    isOpen: (key) => open().has(key),
    isSelected: (key) => sel() === key,
    loaded: () => loadedMap(),
    toggle,
    activate,
    load,
  };

  return (
    <div class="mt-tree mt-tree-root" role="tree" title={props.node.tooltip} style={styleOf(props.node.style)}>
      <For each={props.node.roots}>{(item) => <TreeRow item={item} depth={0} state={state} />}</For>
    </div>
  );
}

function TreeRow(props: { item: TreeItem; depth: number; state: TreeState }): JSX.Element {
  const s = props.state;
  const hasKids = () =>
    props.item.children === true || (Array.isArray(props.item.children) && props.item.children.length > 0);
  const open = () => s.isOpen(props.item.key);
  const kids = (): TreeItem[] | undefined =>
    Array.isArray(props.item.children) ? props.item.children : s.loaded()[props.item.key];

  // First expansion (including keys already expanded on mount) loads the children once.
  createEffect(() => {
    if (open() && props.item.children === true && s.loaded()[props.item.key] === undefined) {
      s.load(props.item.key);
    }
  });

  return (
    <div class="mt-tree-item">
      <div
        class="mt-tree-row mt-clickable"
        classList={{ "mt-selected": s.isSelected(props.item.key) }}
        role="treeitem"
        aria-expanded={hasKids() ? open() : undefined}
        aria-selected={s.isSelected(props.item.key)}
        tabIndex={0}
        style={{ "padding-left": `${props.depth * 12 + 4}px` }}
        draggable={props.item.drag !== undefined}
        onClick={() => s.activate(props.item)}
        onDblClick={() => invoke(s.ctx.host, props.item.onDoubleClick)}
        onContextMenu={(e) => openMenu(e, s.ctx.host, props.item.contextMenu)}
        onDragStart={(e) => {
          const drag = props.item.drag;
          if (!drag) return;
          e.dataTransfer?.setData("text/plain", drag.kind === "path" ? drag.path : drag.text);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            activateOnKey(e, () => s.activate(props.item));
          } else if (e.key === "ArrowRight" && hasKids() && !open()) {
            e.preventDefault();
            s.toggle(props.item);
          } else if (e.key === "ArrowLeft" && open()) {
            e.preventDefault();
            s.toggle(props.item);
          }
        }}
      >
        <span
          class="mt-tree-toggle"
          aria-hidden="true"
          onClick={(e) => {
            e.stopPropagation();
            if (hasKids()) s.toggle(props.item);
          }}
        >
          {hasKids() ? (open() ? "▾" : "▸") : ""}
        </span>
        <Icon name={props.item.icon} />
        <span class="mt-tree-text">{props.item.text}</span>
        <ItemBadge text={props.item.badge} />
      </div>
      <Show when={open() && hasKids()}>
        <div class="mt-tree">
          <For each={kids() ?? []}>{(child) => <TreeRow item={child} depth={props.depth + 1} state={s} />}</For>
          <Show when={kids() === undefined}>
            <div class="mt-more mt-muted">…</div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

// ---- table ----------------------------------------------------------------

function TableView(props: Props<TableNode>): JSX.Element {
  const sortState = () => props.node.sort?.value;
  const dirOf = (key: string) => {
    const s = sortState();
    return s && s.key === key ? s.dir : undefined;
  };

  const onHeader = (col: TableColumn) => {
    const sig = props.node.sort;
    if (!sig) return;
    const cur = sig.value;
    const dir = cur?.key === col.key && cur.dir === "asc" ? "desc" : "asc";
    props.ctx.host.setSignal(sig, { key: col.key, dir });
  };

  return (
    <div class="mt-table-wrap" title={props.node.tooltip} style={styleOf(props.node.style)}>
      <table class="mt-table">
        <colgroup>
          <For each={props.node.columns}>
            {(col) => <col style={{ width: col.width !== undefined ? `${col.width}px` : undefined }} />}
          </For>
        </colgroup>
        <thead>
          <tr>
            <For each={props.node.columns}>
              {(col) => (
                <th
                  scope="col"
                  classList={{
                    "mt-sortable": props.node.sort !== undefined && col.sortable === true,
                    "mt-align-right": col.align === "right",
                    "mt-sort-asc": dirOf(col.key) === "asc",
                    "mt-sort-desc": dirOf(col.key) === "desc",
                  }}
                  aria-sort={
                    dirOf(col.key) === "asc" ? "ascending" : dirOf(col.key) === "desc" ? "descending" : undefined
                  }
                  onClick={() => {
                    if (col.sortable === true) onHeader(col);
                  }}
                >
                  {col.title}
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={props.node.rows.slice(0, ROW_CAP)}>
            {(row) => (
              <tr
                classList={{ "mt-clickable": props.node.onRowClick !== undefined }}
                onClick={() => invoke(props.ctx.host, props.node.onRowClick, [row])}
              >
                <For each={props.node.columns}>
                  {(col) => (
                    <td classList={{ "mt-align-right": col.align === "right" }}>
                      <CellValue value={row[col.key]} ctx={props.ctx} />
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
          <Show when={props.node.rows.length > ROW_CAP}>
            <tr class="mt-more">
              <td colSpan={props.node.columns.length} class="mt-muted">
                …
              </td>
            </tr>
          </Show>
        </tbody>
      </table>
    </div>
  );
}

/** A table cell: a plain value as text, or a node rendered in place. */
function CellValue(props: { value: string | number | SerializedNode | undefined; ctx: Ctx }): JSX.Element {
  return (
    <Show when={typeof props.value === "object"} fallback={cellText(props.value)}>
      <NodeView node={props.value as SerializedNode} ctx={props.ctx} />
    </Show>
  );
}

function cellText(v: string | number | SerializedNode | undefined): string {
  return typeof v === "object" ? "" : String(v ?? "");
}
