/**
 * nishi-yura.bookmarks (community mod).
 *
 * A side panel with folders you saved. Clicking one puts a `cd` to it into the input line of the
 * focused terminal (quoted for that shell); you press Enter. "Bookmark this folder" saves the focused
 * terminal's current folder. The list lives in the mod's storage on this PC. Uses no permissions.
 */

import type { ListItem, ModContext, SessionInfo, ShellKind, UiNode } from "@otterm/api";

const PANEL_ID = "nishi-yura.bookmarks.panel";
const ADD_COMMAND_ID = "nishi-yura.bookmarks.add";
const OPEN_COMMAND_ID = "nishi-yura.bookmarks.open";
const STORAGE_KEY = "bookmarks";
const MAX_BOOKMARKS = 100;
/** Longest parent path shown under a bookmark's name. */
const MAX_PATH_CHARS = 32;

interface Bookmark {
  path: string;
}

export async function activate(ctx: ModContext): Promise<void> {
  const t = (id: string, vars?: Record<string, string | number>): string => ctx.i18n.t(id, vars);

  const list = ctx.signal<Bookmark[]>(await load());

  async function load(): Promise<Bookmark[]> {
    const stored = await ctx.storage.get<unknown>(STORAGE_KEY).catch(() => undefined);
    if (!Array.isArray(stored)) return [];
    const out: Bookmark[] = [];
    for (const item of stored) {
      const path = (item as { path?: unknown } | null)?.path;
      if (typeof path === "string" && path !== "") out.push({ path });
    }
    return out;
  }

  async function save(next: Bookmark[]): Promise<void> {
    list.set(next);
    await ctx.storage.set(STORAGE_KEY, next).catch((e: unknown) => ctx.log.warn("bookmarks: could not save", e));
  }

  async function addCurrent(): Promise<void> {
    const session = await ctx.session.current().catch(() => undefined);
    const path = session?.cwd;
    if (!path) {
      await ctx.ui.toast({ text: t("toast-no-folder"), kind: "warning" });
      return;
    }
    const current = list.get();
    if (current.some((b) => b.path === path)) {
      await ctx.ui.toast({ text: t("toast-exists", { name: folderName(path) }), kind: "info" });
      return;
    }
    if (current.length >= MAX_BOOKMARKS) {
      await ctx.ui.toast({ text: t("toast-full", { max: MAX_BOOKMARKS }), kind: "warning" });
      return;
    }
    await save([...current, { path }]);
    await ctx.ui.toast({ text: t("toast-added", { name: folderName(path) }), kind: "success" });
  }

  async function remove(path: string): Promise<void> {
    await save(list.get().filter((b) => b.path !== path));
  }

  async function move(path: string, delta: -1 | 1): Promise<void> {
    const current = list.get().slice();
    const i = current.findIndex((b) => b.path === path);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= current.length) return;
    const a = current[i];
    const b = current[j];
    if (!a || !b) return;
    current[i] = b;
    current[j] = a;
    await save(current);
  }

  async function go(path: string): Promise<void> {
    const session = await ctx.session.current().catch(() => undefined);
    const command = cdCommand(path, session);
    await ctx.terminal.insert(command, { replaceLine: true });
  }

  function openFolder(path: string): void {
    ctx.commands.run("otterm.open", { path }).catch((e: unknown) => ctx.log.warn("bookmarks: could not open", e));
  }

  ctx.ui.panel({
    id: PANEL_ID,
    title: t("panel-title"),
    icon: "bookmark",
    slot: "sidebar.left",
    content: () => content(list.get(), t, { go, remove, move, openFolder, addCurrent }),
  });

  ctx.commands.register(ADD_COMMAND_ID, () => addCurrent(), { title: t("cmd-add"), icon: "bookmark-plus" });
  ctx.commands.register(
    OPEN_COMMAND_ID,
    async () => {
      try {
        await ctx.commands.run("otterm.panel.show", { id: PANEL_ID });
      } catch (e) {
        ctx.log.warn("bookmarks: could not show the panel", e);
      }
    },
    { title: t("cmd-open"), icon: "bookmark" },
  );
  ctx.keybindings.suggest(ADD_COMMAND_ID, "ctrl+shift+alt+b");
}

export function deactivate(): void {
  // Nothing to do: the panel and the commands are Disposables the host tracks.
}

// --- UI -----------------------------------------------------------------------

interface Actions {
  go(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  move(path: string, delta: -1 | 1): Promise<void>;
  openFolder(path: string): void;
  addCurrent(): Promise<void>;
}

function content(
  bookmarks: Bookmark[],
  t: (id: string, vars?: Record<string, string | number>) => string,
  a: Actions,
): UiNode {
  const items: ListItem[] = bookmarks.map((b, i) => ({
    key: b.path,
    text: folderName(b.path),
    secondary: shortPath(b.path),
    icon: "folder",
    onClick: () => {
      a.go(b.path).catch(() => undefined);
    },
    contextMenu: [
      { label: t("menu-go"), icon: "corner-down-left", onClick: () => void a.go(b.path) },
      { label: t("menu-open"), icon: "external-link", onClick: () => a.openFolder(b.path) },
      { label: t("menu-up"), icon: "arrow-up", enabled: i > 0, onClick: () => void a.move(b.path, -1) },
      {
        label: t("menu-down"),
        icon: "arrow-down",
        enabled: i < bookmarks.length - 1,
        onClick: () => void a.move(b.path, 1),
      },
      { label: t("menu-remove"), icon: "trash-2", onClick: () => void a.remove(b.path) },
    ],
  }));
  return {
    type: "stack",
    gap: "m",
    children: [
      {
        type: "row",
        align: "space-between",
        children: [
          { type: "text", text: t("hint"), muted: true },
          {
            type: "button",
            text: t("cmd-add"),
            icon: "bookmark-plus",
            variant: "primary",
            onClick: () => void a.addCurrent(),
          },
        ],
      },
      { type: "list", items, emptyText: t("empty") },
    ],
  };
}

// --- helpers ------------------------------------------------------------------

/** The `cd` for a folder, quoted for the focused terminal's shell. */
function cdCommand(path: string, session: SessionInfo | undefined): string {
  const shell: ShellKind = session?.shellKind ?? "other";
  if (shell === "cmd") return `cd /d "${path}"`;
  if (shell === "pwsh" || shell === "powershell") return `cd '${path.replace(/'/g, "''")}'`;
  if (shell === "nushell") return `cd "${path.replace(/["\\]/g, "\\$&")}"`;
  // bash, zsh, fish and unknown POSIX shells: single quotes, with a quote spelled '\''.
  return `cd '${path.replace(/'/g, "'\\''")}'`;
}

/** The path for the second line: the parent folders only, cut from the left to 32 characters. */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== "");
  const parent = parts.slice(0, -1).join("/");
  const chars = Array.from(parent);
  return chars.length > MAX_PATH_CHARS ? `…${chars.slice(chars.length - MAX_PATH_CHARS + 1).join("")}` : parent;
}

function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== "");
  return parts[parts.length - 1] ?? path;
}
