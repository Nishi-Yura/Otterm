/**
 * nishi-yura.cheatsheet. A sidebar panel that lists otterm's main default shortcuts, grouped.
 * The tables follow docs/06-config-keybind.md §5.2 (Windows / Linux) and §5.2.1 (macOS). On macOS only the
 * shortcuts that §5.2.1 lists are shown, so nothing is guessed. The panel is static and needs no permissions.
 */

import type { ModContext, Platform, UiNode } from "@otterm/api";

const PANEL_ID = "cheatsheet.panel";
const OPEN_COMMAND_ID = "cheatsheet.open";

interface Shortcut {
  /** Suffix of the Fluent id `act-<id>` (locales/*.ftl). */
  id: string;
  windows: string;
  /** Defaults to `windows`. */
  linux?: string;
  /** Undefined = not in docs/06 §5.2.1, so it is not shown on macOS. */
  macos?: string;
}

interface Group {
  /** Suffix of the Fluent id `group-<id>`. */
  id: string;
  shortcuts: Shortcut[];
}

const GROUPS: Group[] = [
  {
    id: "tabs",
    shortcuts: [
      { id: "tab-new", windows: "ctrl+shift+t", macos: "cmd+t" },
      { id: "tab-new-profile", windows: "ctrl+shift+n", macos: "cmd+n" },
      { id: "tab-close", windows: "ctrl+shift+w", macos: "cmd+w" },
      { id: "tab-next", windows: "ctrl+tab" },
      { id: "tab-prev", windows: "ctrl+shift+tab" },
      { id: "tab-goto", windows: "ctrl+1 〜 ctrl+9", macos: "cmd+1 〜 cmd+9" },
    ],
  },
  {
    id: "panes",
    shortcuts: [
      { id: "pane-split-v", windows: "ctrl+shift+d", macos: "cmd+d" },
      { id: "pane-split-h", windows: "ctrl+shift+e", macos: "cmd+shift+d" },
      { id: "pane-focus", windows: "alt+arrow", macos: "cmd+alt+arrow" },
      { id: "pane-resize", windows: "alt+shift+arrow", macos: "cmd+alt+shift+arrow" },
      { id: "pane-zoom", windows: "ctrl+shift+z", macos: "cmd+shift+enter" },
      { id: "pane-close", windows: "ctrl+shift+q", macos: "cmd+shift+w" },
    ],
  },
  {
    id: "edit",
    shortcuts: [
      { id: "copy", windows: "ctrl+c", linux: "ctrl+shift+c", macos: "cmd+c" },
      { id: "paste", windows: "ctrl+v", linux: "ctrl+shift+v", macos: "cmd+v" },
      { id: "search", windows: "ctrl+shift+f", macos: "cmd+f" },
    ],
  },
  {
    id: "blocks",
    shortcuts: [
      { id: "block-move", windows: "ctrl+arrowup / ctrl+arrowdown" },
      { id: "block-collapse", windows: "ctrl+shift+[" },
    ],
  },
  {
    id: "panels",
    shortcuts: [
      { id: "panel-sidebar-left", windows: "ctrl+shift+b", macos: "cmd+b" },
      { id: "panel-sidebar-right", windows: "ctrl+alt+b" },
      { id: "panel-bottom", windows: "ctrl+shift+j", macos: "cmd+j" },
      { id: "focus-region", windows: "f6 / shift+f6" },
    ],
  },
  {
    id: "tools",
    shortcuts: [
      { id: "palette", windows: "ctrl+shift+p", macos: "cmd+shift+p" },
      { id: "settings", windows: "ctrl+,", macos: "cmd+," },
      { id: "history", windows: "ctrl+r", macos: "ctrl+r" },
    ],
  },
];

export function activate(ctx: ModContext): void {
  const t = (id: string, vars?: Record<string, string | number>): string => ctx.i18n.t(id, vars);
  const platform = ctx.host.platform;

  ctx.ui.panel({
    id: PANEL_ID,
    title: t("panel-title"),
    icon: "keyboard",
    slot: "sidebar.right",
    content: buildContent(ctx, platform),
  });

  ctx.commands.register(
    OPEN_COMMAND_ID,
    async () => {
      try {
        await ctx.commands.run("otterm.panel.show", { id: PANEL_ID });
      } catch (e) {
        ctx.log.warn("cheatsheet: could not show the panel", e);
      }
    },
    { title: t("command-open"), icon: "keyboard" },
  );
}

export function deactivate(): void {
  // Nothing to do: the panel and the command are Disposables the host tracks.
}

function keysFor(shortcut: Shortcut, platform: Platform): string | undefined {
  if (platform === "macos") return shortcut.macos;
  if (platform === "linux") return shortcut.linux ?? shortcut.windows;
  return shortcut.windows;
}

function buildContent(ctx: ModContext, platform: Platform): UiNode {
  const t = (id: string): string => ctx.i18n.t(id);
  const children: UiNode[] = [{ type: "text", text: t("note-default"), muted: true }];

  for (const group of GROUPS) {
    const rows = group.shortcuts.flatMap((s) => {
      const keys = keysFor(s, platform);
      return keys === undefined ? [] : [{ action: t(`act-${s.id}`), keys }];
    });
    if (rows.length === 0) continue;
    children.push({ type: "heading", level: 3, text: t(`group-${group.id}`) });
    children.push({
      type: "table",
      columns: [
        { key: "action", title: t("col-action") },
        { key: "keys", title: t("col-keys") },
      ],
      rows,
    });
  }

  return { type: "stack", gap: "m", children };
}
