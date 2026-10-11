/**
 * The declarative UI (docs/05 §5.3) as it crosses the Worker boundary. A mod builds a `UiNode`
 * tree inside its sandbox (`@otterm/api`); the sandbox resolves every `Reactive` getter and
 * `LocalizedString`, swaps each function for a handler id and each `Signal` for a signal id, and
 * posts the result here as plain JSON. The UI renders it and reports clicks and edits back by id.
 */

/** A callback the mod passed (onClick, onSubmit, …): the UI invokes it by id. */
export interface FnRef {
  $fn: number;
}

/** A `Signal` the mod passed (input value, toggle state, …): the UI edits it by id. */
export interface SigRef<T = unknown> {
  $sig: number;
  value: T;
}

export type SerializedNode =
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

export type Gap = "none" | "s" | "m" | "l";

export interface BaseNode {
  key?: string;
  tooltip?: string;
  /** Only these properties; values are CSS strings (`--ot-*` variables allowed). */
  style?: Partial<Record<"padding" | "margin" | "width" | "height" | "flex" | "color" | "background", string>>;
  hidden?: boolean;
}

export interface TextNode extends BaseNode {
  type: "text";
  text: string;
  icon?: string;
  muted?: boolean;
  onClick?: FnRef;
}
export interface HeadingNode extends BaseNode {
  type: "heading";
  text: string;
  level?: 1 | 2 | 3;
}
export interface StackNode extends BaseNode {
  type: "stack";
  children: SerializedNode[];
  gap?: Gap;
}
export interface RowNode extends BaseNode {
  type: "row";
  children: SerializedNode[];
  gap?: Gap;
  align?: "start" | "center" | "end" | "space-between";
}
export interface MenuItemRef {
  label: string;
  icon?: string;
  onClick: FnRef;
  enabled?: boolean;
  children?: MenuItemRef[];
}
export interface ListItem {
  key?: string;
  text: string;
  secondary?: string;
  icon?: string;
  badge?: string;
  onClick?: FnRef;
  contextMenu?: MenuItemRef[];
}
export interface ListNode extends BaseNode {
  type: "list";
  items: ListItem[];
  virtual?: boolean;
  selectable?: boolean;
  onSelect?: FnRef;
  emptyText?: string;
}
export interface TreeItem {
  key: string;
  text: string;
  icon?: string;
  badge?: string;
  /** `true`: children come from `loadChildren` when expanded. */
  children?: TreeItem[] | true;
  onClick?: FnRef;
  onDoubleClick?: FnRef;
  contextMenu?: MenuItemRef[];
  drag?: { kind: "path"; path: string } | { kind: "text"; text: string };
}
export interface TreeNode extends BaseNode {
  type: "tree";
  roots: TreeItem[];
  /** Called with the item key; the mod answers through `invoke` (it resolves to `TreeItem[]`). */
  loadChildren?: FnRef;
  expanded?: SigRef<string[]>;
  selected?: SigRef<string | undefined>;
}
export interface TableColumn {
  key: string;
  title: string;
  width?: number;
  sortable?: boolean;
  align?: "left" | "right";
}
export interface TableNode extends BaseNode {
  type: "table";
  columns: TableColumn[];
  rows: Record<string, string | number | SerializedNode>[];
  rowKey?: string;
  virtual?: boolean;
  sort?: SigRef<{ key: string; dir: "asc" | "desc" } | undefined>;
  onRowClick?: FnRef;
}
export interface ButtonNode extends BaseNode {
  type: "button";
  text: string;
  icon?: string;
  variant?: "primary" | "danger" | "default" | "ghost";
  disabled?: boolean;
  /** Only the icon shows; `text` is the tooltip and accessible name. */
  iconOnly?: boolean;
  onClick: FnRef;
}
export interface InputNode extends BaseNode {
  type: "input";
  value: SigRef<string>;
  placeholder?: string;
  kind?: "text" | "password" | "number" | "search";
  onSubmit?: FnRef;
}
export interface SelectNode extends BaseNode {
  type: "select";
  value: SigRef<string>;
  options: { value: string; label: string }[];
}
export interface ToggleNode extends BaseNode {
  type: "toggle";
  value: SigRef<boolean>;
  label?: string;
}
export interface BadgeNode extends BaseNode {
  type: "badge";
  text: string;
  kind?: "info" | "success" | "warning" | "danger" | "neutral";
}
export interface ProgressNode extends BaseNode {
  type: "progress";
  /** 0..1; undefined is indeterminate. */
  value?: number;
  label?: string;
}
export interface CodeNode extends BaseNode {
  type: "code";
  code: string;
  language?: string;
  insertable?: boolean;
  copyable?: boolean;
}
export interface MarkdownNode extends BaseNode {
  type: "markdown";
  source: string;
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
  values: number[];
  min?: number;
  max?: number;
  color?: "accent" | "success" | "warning" | "danger";
}
/** A sandboxed iframe (decision D7): HTML and CSS only, no scripts. */
export interface CustomNode extends BaseNode {
  type: "custom";
  html: string;
  height?: number | "auto";
  onMessage?: FnRef;
}

/** What the renderer needs from the host, besides the tree. */
export interface TreeHost {
  /** Run a mod callback. `args` are JSON values; the result (if any) comes back as JSON. */
  invoke(fn: FnRef, args?: unknown[]): Promise<unknown>;
  /** The user edited a Signal-backed control. */
  setSignal(sig: SigRef, value: unknown): void;
  /** `code` nodes with `insertable`: put the text at the shell prompt (ctx.terminal.insert). */
  insert(text: string): void;
  /** `code` nodes with `copyable`. */
  copy(text: string): void;
  /** Open a context menu at a point with these items (the renderer calls `onClick` through `invoke`). */
  contextMenu(x: number, y: number, items: MenuItemRef[]): void;
}
