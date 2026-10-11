/**
 * otterm.file-tree (docs/03 §9). A sidebar tree that follows the shell's folder unless pinned.
 * Folder double-click sends `cd` to the shell at guide level 2+ (decision B10); otherwise it only moves the tree.
 *
 * Permissions and settings are declared in ../otmod.toml.
 */

import type {
  DirEntry,
  FsApi,
  MenuItem,
  ModContext,
  ProcessApi,
  SessionId,
  SessionInfo,
  TreeItem,
  UiNode,
} from "@otterm/api";
import { prettyJson, TABLE_ROW_LIMIT, tableData } from "./data";
import { buildDecorations, decorationsSignature, parsePorcelainZ, pathKey } from "./git";
import {
  base64Encode,
  baseName,
  breadcrumb,
  delimiterOf,
  extOf,
  formatBytes,
  IMAGE_LIMIT_BYTES,
  IMAGE_MIME,
  iconFor,
  isTableExt,
  isTextExt,
  isValidName,
  joinPath,
  languageOf,
  parentOf,
  relativeTo,
  runPrefixFor,
  TEXT_LIMIT_BYTES,
} from "./paths";

const PANEL_ID = "file-tree.panel";
const PREVIEW_ID = "file-tree.preview";
/** Written this way so the literal is not mistaken for a template string. */
const HOME_TOKEN = `\${home}`;
/** Caps how deep eagerly-built children nest in the tree. */
const MAX_DEPTH = 16;
/** How often git status is re-read while the tree panel is shown. */
const GIT_INTERVAL_MS = 5000;
/** Per git call. A slower repository shows no decoration rather than blocking. */
const GIT_TIMEOUT_MS = 3000;

type ToastKind = "info" | "success" | "warning" | "danger";

type Preview =
  | { kind: "none" }
  | { kind: "text"; path: string; text: string; language: string }
  | { kind: "markdown"; path: string; text: string }
  | { kind: "image"; path: string; src: string }
  | { kind: "table"; path: string; header: string[]; body: string[][]; total: number; columns: number }
  | { kind: "json"; path: string; text: string; error?: string }
  /** The sandboxed preview iframe cannot render PDF, so only the default-app button is offered (v1). */
  | { kind: "pdf"; path: string; size: number }
  | { kind: "large"; path: string }
  | { kind: "unsupported"; path: string }
  | { kind: "error"; path: string; message: string };

let gitTimer: ReturnType<typeof setInterval> | undefined;

export async function activate(ctx: ModContext): Promise<void> {
  if (!ctx.fs) throw new Error("file-tree: fs permission is missing");
  const files: FsApi = ctx.fs;

  const t = (id: string, vars?: Record<string, string | number>): string => ctx.i18n.t(id, vars);
  const say = (text: string, kind: ToastKind = "info"): void => {
    ctx.ui.toast({ text, kind }).catch(() => undefined);
  };
  const fail = (e: unknown): void => {
    const message = e instanceof Error ? e.message : String(e);
    ctx.log.warn(message);
    say(t("error-generic", { message }), "danger");
  };
  const unsupported = (): void => say(t("error-no-write"), "danger");
  const guide = (): number => ctx.assist.guideLevel.get();
  const setting = async <T>(key: string, fallback: T): Promise<T> => {
    try {
      const value = await ctx.settings.get<T | undefined>(key);
      return value ?? fallback;
    } catch {
      return fallback;
    }
  };
  const currentSession = (): Promise<SessionInfo | undefined> => ctx.session.current().catch(() => undefined);

  const home = await files.resolve(HOME_TOKEN).catch(() => "");
  const startSession = await currentSession();
  const startDir = startSession?.hostCwd || startSession?.cwd || home;

  const showHidden = ctx.signal<boolean>(await setting("show_hidden", false));
  const pinned = ctx.signal<boolean>(!(await setting("follow_cwd", true)));
  const rootPath = ctx.signal<string>("");
  /** Listings already read, keyed by absolute folder path. The tree is built from this, so a re-read shows up. */
  const listing = ctx.signal<Map<string, DirEntry[]>>(new Map());
  const expanded = ctx.signal<Set<string>>(new Set());
  const selected = ctx.signal<string | undefined>(undefined);
  const preview = ctx.signal<Preview>({ kind: "none" });
  /** Git badge per `pathKey`. The tree getters read it, so a change re-renders the tree. */
  const gitBadges = ctx.signal<Map<string, string>>(new Map());
  let gitSig = "";
  let gitBusy = false;
  let gitQueued = false;
  let panelVisible = false;
  let cdHintShown = false;

  // --- listing ----------------------------------------------------------------

  async function readInto(dir: string): Promise<void> {
    const entries = await files.readDir(dir, { includeHidden: true });
    const next = new Map(listing.get());
    next.set(dir, entries);
    listing.set(next);
  }

  async function setRoot(dir: string): Promise<void> {
    if (!dir) return;
    if (dir !== rootPath.get()) {
      expanded.set(new Set<string>());
      listing.set(new Map());
    }
    rootPath.set(dir);
    void refreshGit(true);
    try {
      await readInto(dir);
    } catch (e) {
      fail(e);
    }
  }

  async function refreshDir(dir: string): Promise<void> {
    void refreshGit(true);
    try {
      await readInto(dir);
    } catch (e) {
      fail(e);
    }
    ctx.ui.refresh();
  }

  function itemFor(entry: DirEntry, badges: Map<string, string>): TreeItem {
    const isDir = entry.kind === "dir";
    const item: TreeItem = {
      key: entry.path,
      text: entry.name,
      icon: isDir ? "folder" : iconFor(extOf(entry.name)),
      onClick: () => {
        selected.set(entry.path);
        if (!isDir) void showPreview(entry);
      },
      onDoubleClick: () => {
        if (isDir) void openFolder(entry.path).catch(fail);
        else openPath(entry.path);
      },
      contextMenu: menuFor(entry),
      drag: { kind: "path", path: entry.path },
    };
    if (isDir) item.children = true;
    const badge = badges.get(pathKey(entry.path));
    if (badge !== undefined) item.badge = badge;
    return item;
  }

  /** Builds tree items from the cache. Folders already read get their children inline. */
  function nodesFor(dir: string, map: Map<string, DirEntry[]>, hidden: boolean, depth: number): TreeItem[] {
    const items: TreeItem[] = [];
    const badges = gitBadges.get();
    for (const entry of sortEntries(map.get(dir) ?? [])) {
      if (entry.hidden && !hidden) continue;
      const item = itemFor(entry, badges);
      if (entry.kind === "dir" && map.has(entry.path) && depth < MAX_DEPTH) {
        item.children = nodesFor(entry.path, map, hidden, depth + 1);
      }
      items.push(item);
    }
    return items;
  }

  // --- git status -------------------------------------------------------------

  /**
   * Re-reads git status under the tree root and publishes the badges. A run that is already in flight
   * is skipped; `force` (root change, file operation) queues one more run after it instead.
   */
  async function refreshGit(force: boolean): Promise<void> {
    const proc = ctx.process;
    if (!proc) return;
    if (gitBusy) {
      if (force) gitQueued = true;
      return;
    }
    const root = rootPath.get();
    if (!root) return;
    gitBusy = true;
    try {
      const next = await readGitDecorations(proc, root);
      // The root may have moved while git ran. In that case the queued run below reads the new one.
      if (root === rootPath.get()) {
        const sig = decorationsSignature(next);
        if (sig !== gitSig) {
          gitSig = sig;
          gitBadges.set(next);
        }
      }
    } finally {
      gitBusy = false;
    }
    if (gitQueued) {
      gitQueued = false;
      await refreshGit(true);
    }
  }

  async function loadChildren(key: string): Promise<TreeItem[]> {
    try {
      await readInto(key);
    } catch (e) {
      fail(e);
      return [];
    }
    return nodesFor(key, listing.get(), showHidden.get(), 0);
  }

  // --- navigation -------------------------------------------------------------

  /** Double-click on a folder: move the tree there and, at the right guide level, `cd` the shell. */
  async function openFolder(path: string): Promise<void> {
    await setRoot(path);
    const mode = await setting("cd_on_open", "auto");
    const level = guide();
    const wantsCd = mode === "always" || (mode === "auto" && level >= 2);
    if (!wantsCd) return;
    try {
      if (!(await sendCd(path))) return;
    } catch (e) {
      fail(e);
      return;
    }
    if (level >= 3 || (level === 2 && !cdHintShown)) {
      cdHintShown = true;
      say(t("hint-cd"));
    }
  }

  async function sendCd(path: string): Promise<boolean> {
    const session = await currentSession();
    if (!session || !ctx.terminal.write) return false;
    if (session.altScreen || session.echoOff) {
      say(t("error-busy"), "warning");
      return false;
    }
    await ctx.terminal.write(session.id, `cd "${shellPath(session, path)}"\r`);
    return true;
  }

  async function goUp(): Promise<void> {
    const current = rootPath.get();
    const parent = parentOf(current);
    if (parent && parent !== current) await setRoot(parent);
  }

  async function revealCwd(): Promise<void> {
    const session = await currentSession();
    const dir = session?.hostCwd || session?.cwd;
    if (dir) await setRoot(dir);
    await ctx.commands.run("otterm.panel.show", { id: PANEL_ID }).catch(fail);
  }

  /** Follows the focused session's folder when it changes, unless pinned. */
  async function followEvent(e: { sessionId: SessionId; cwd: string; hostCwd?: string }): Promise<void> {
    if (pinned.get()) return;
    const session = await currentSession();
    if (session && session.id !== e.sessionId) return;
    const dir = e.hostCwd || e.cwd;
    if (dir && dir !== rootPath.get()) await setRoot(dir);
  }

  async function followFocused(): Promise<void> {
    if (pinned.get()) return;
    const session = await currentSession();
    const dir = session?.hostCwd || session?.cwd;
    if (dir && dir !== rootPath.get()) await setRoot(dir);
  }

  function openPath(path: string): void {
    ctx.commands.run("otterm.open", { path }).catch(fail);
  }

  // --- preview ----------------------------------------------------------------

  async function showPreview(entry: DirEntry): Promise<void> {
    const ext = extOf(entry.name);
    const size = entry.size ?? 0;
    const path = entry.path;
    const mime = IMAGE_MIME.get(ext);
    try {
      if (mime) {
        if (size > IMAGE_LIMIT_BYTES) {
          preview.set({ kind: "large", path });
        } else {
          const bytes = await files.readBytes(path, { maxBytes: IMAGE_LIMIT_BYTES });
          preview.set({ kind: "image", path, src: `data:${mime};base64,${base64Encode(bytes)}` });
        }
      } else if (ext === "pdf") {
        // v1: the preview cannot render PDF (its iframe runs without scripts). The host opens it with
        // the system app per [open.rules], so the panel only offers that button.
        preview.set({ kind: "pdf", path, size });
      } else if (isTextExt(ext)) {
        if (size > TEXT_LIMIT_BYTES) {
          preview.set({ kind: "large", path });
        } else {
          const text = await files.readText(path, { maxBytes: TEXT_LIMIT_BYTES });
          if (isTableExt(ext)) {
            preview.set({ kind: "table", path, ...tableData(text, delimiterOf(ext)) });
          } else if (ext === "json") {
            const view = prettyJson(text);
            if (view.ok) preview.set({ kind: "json", path, text: view.text });
            else preview.set({ kind: "json", path, text, error: view.message });
          } else if (ext === "md") {
            preview.set({ kind: "markdown", path, text });
          } else {
            preview.set({ kind: "text", path, text, language: languageOf(ext) });
          }
        }
      } else {
        preview.set({ kind: "unsupported", path });
      }
    } catch (e) {
      preview.set({ kind: "error", path, message: e instanceof Error ? e.message : String(e) });
    }
    await ctx.commands.run("otterm.panel.show", { id: PREVIEW_ID }).catch(fail);
  }

  function previewNode(p: Preview): UiNode {
    if (p.kind === "none") return { type: "text", text: t("preview-empty"), muted: true };
    const target = p.path;
    const body: UiNode[] = [{ type: "heading", text: baseName(target), level: 3 }];
    switch (p.kind) {
      case "text":
        body.push({ type: "code", code: p.text, language: p.language, copyable: true });
        break;
      case "markdown":
        body.push({ type: "markdown", source: p.text });
        break;
      case "image":
        body.push({ type: "custom", html: imageHtml(p.src), height: "auto" });
        break;
      case "table":
        if (p.columns === 0) {
          body.push({ type: "text", text: t("preview-table-empty"), muted: true });
        } else {
          body.push(tableNode(p));
          if (p.total > TABLE_ROW_LIMIT) {
            body.push({
              type: "text",
              text: t("preview-table-cut", { count: TABLE_ROW_LIMIT, total: p.total }),
              muted: true,
            });
          }
        }
        break;
      case "json":
        body.push({
          type: "code",
          code: p.text,
          language: p.error === undefined ? "json" : "plaintext",
          copyable: true,
        });
        if (p.error !== undefined) {
          body.push({ type: "text", text: t("preview-json-error", { message: p.error }), muted: true });
        }
        break;
      case "pdf":
        body.push({ type: "text", text: t("preview-size", { size: formatBytes(p.size) }), muted: true });
        body.push({
          type: "button",
          text: t("preview-pdf-open"),
          icon: "external-link",
          variant: "primary",
          onClick: () => openPath(target),
        });
        return { type: "stack", gap: "s", children: body };
      case "large":
        body.push({ type: "text", text: t("preview-large") });
        break;
      case "unsupported":
        body.push({ type: "text", text: t("preview-unsupported"), muted: true });
        break;
      case "error":
        body.push({ type: "text", text: t("preview-error", { message: p.message }) });
        break;
    }
    body.push({
      type: "button",
      text: t("preview-open-editor"),
      icon: "external-link",
      variant: "ghost",
      onClick: () => openPath(target),
    });
    return { type: "stack", gap: "s", children: body };
  }

  // --- file operations --------------------------------------------------------

  async function askName(title: string, initial: string, okLabel: string): Promise<string | undefined> {
    const value = ctx.signal<string>(initial);
    const choice = await ctx.ui.dialog<"ok" | "cancel">({
      title,
      body: {
        type: "stack",
        gap: "s",
        children: [{ type: "input", value, placeholder: t("dialog-name-placeholder") }],
      },
      buttons: [
        { id: "ok", label: okLabel, variant: "primary" },
        { id: "cancel", label: t("cancel") },
      ],
      cancelId: "cancel",
    });
    if (choice !== "ok") return undefined;
    const name = value.get().trim();
    if (!isValidName(name)) {
      say(t("error-name"), "warning");
      return undefined;
    }
    return name;
  }

  async function createEntry(dir: string, kind: "file" | "folder"): Promise<void> {
    const name = await askName(
      kind === "file" ? t("dialog-new-file") : t("dialog-new-folder"),
      "",
      t("dialog-create-ok"),
    );
    if (!name) return;
    try {
      const target = joinPath(dir, name);
      if (await files.exists(target)) {
        say(t("error-exists"), "warning");
        return;
      }
      if (kind === "file") {
        if (!files.writeText) return unsupported();
        await files.writeText(target, "");
      } else {
        if (!files.mkdir) return unsupported();
        await files.mkdir(target);
      }
      if (guide() >= 2) say(t("hint-create"));
      await refreshDir(dir);
    } catch (e) {
      fail(e);
    }
  }

  async function renameEntry(entry: DirEntry): Promise<void> {
    const name = await askName(t("dialog-rename-title"), entry.name, t("dialog-rename-ok"));
    if (!name || name === entry.name) return;
    const dir = parentOf(entry.path);
    const target = joinPath(dir, name);
    try {
      if (await files.exists(target)) {
        say(t("error-exists"), "warning");
        return;
      }
      if (!files.rename) return unsupported();
      await files.rename(entry.path, target);
      if (selected.get() === entry.path) selected.set(target);
      if (guide() >= 2) say(t("hint-rename"));
      await refreshDir(dir);
    } catch (e) {
      fail(e);
    }
  }

  async function trashEntry(entry: DirEntry): Promise<void> {
    const choice = await ctx.ui.dialog<"ok" | "cancel">({
      title: t("dialog-trash-title"),
      body: { type: "text", text: t("dialog-trash-body", { name: entry.name }) },
      buttons: [
        { id: "ok", label: t("trash-ok"), variant: "danger" },
        { id: "cancel", label: t("cancel") },
      ],
      cancelId: "cancel",
    });
    if (choice !== "ok") return;
    const dir = parentOf(entry.path);
    try {
      if (!files.trash) return unsupported();
      await files.trash(entry.path);
      if (selected.get() === entry.path) selected.set(undefined);
      if (guide() >= 2) say(t("hint-trash"));
      await refreshDir(dir);
    } catch (e) {
      fail(e);
    }
  }

  async function copyText(text: string): Promise<void> {
    const clipboard = ctx.clipboard;
    if (!clipboard) return;
    try {
      await clipboard.write(text);
      say(t("toast-copied"));
    } catch (e) {
      fail(e);
    }
  }

  async function insertRun(prefix: string, path: string): Promise<void> {
    try {
      await ctx.terminal.insert(`${prefix} "${shellPath(await currentSession(), path)}"`);
    } catch (e) {
      fail(e);
    }
  }

  function menuFor(entry: DirEntry): MenuItem[] {
    const isDir = entry.kind === "dir";
    const parent = parentOf(entry.path);
    const runCmd = isDir ? undefined : runPrefixFor(extOf(entry.name));
    const menu: MenuItem[] = [{ label: t("menu-open"), icon: "external-link", onClick: () => openPath(entry.path) }];
    if (runCmd) {
      menu.push({ label: t("menu-run"), icon: "terminal", onClick: () => void insertRun(runCmd, entry.path) });
    }
    menu.push(
      {
        label: t("menu-copy-abs"),
        icon: "clipboard",
        onClick: () => void copyText(entry.path),
      },
      {
        label: t("menu-copy-rel"),
        icon: "clipboard",
        onClick: () => void copyText(relativeTo(rootPath.get(), entry.path)),
      },
      {
        label: t("menu-new-file"),
        icon: "file-plus",
        onClick: () => void createEntry(isDir ? entry.path : parent, "file"),
      },
      {
        label: t("menu-new-folder"),
        icon: "folder-plus",
        onClick: () => void createEntry(isDir ? entry.path : parent, "folder"),
      },
      { label: t("menu-rename"), icon: "pencil", onClick: () => void renameEntry(entry) },
      { label: t("menu-trash"), icon: "trash-2", onClick: () => void trashEntry(entry) },
    );
    return menu;
  }

  // --- UI ---------------------------------------------------------------------

  function rootNodes(): TreeItem[] {
    return nodesFor(rootPath.get(), listing.get(), showHidden.get(), 0);
  }

  const panelContent = (): UiNode => ({
    type: "stack",
    gap: "s",
    children: [
      {
        type: "row",
        gap: "s",
        align: "space-between",
        children: [
          { type: "text", text: () => breadcrumb(rootPath.get(), home), icon: "folder-open" },
          { type: "button", text: t("up-button"), icon: "arrow-up", variant: "ghost", onClick: () => void goUp() },
        ],
      },
      {
        type: "row",
        gap: "m",
        children: [
          { type: "toggle", value: pinned, label: t("pin-label") },
          { type: "toggle", value: showHidden, label: t("hidden-label") },
        ],
      },
      {
        type: "button",
        text: t("reveal-button"),
        icon: "locate-fixed",
        variant: "ghost",
        onClick: () => void revealCwd(),
      },
      {
        type: "tree",
        roots: rootNodes,
        loadChildren,
        expanded,
        selected,
      },
    ],
  });

  ctx.ui.panel({
    id: PANEL_ID,
    title: t("panel-title"),
    icon: "folder",
    slot: "sidebar.left",
    content: panelContent,
    onShow: () => {
      panelVisible = true;
      void refreshGit(true);
    },
    onHide: () => {
      panelVisible = false;
    },
  });

  ctx.ui.panel({
    id: PREVIEW_ID,
    title: t("preview-title"),
    icon: "eye",
    slot: "sidebar.left",
    content: () => previewNode(preview.get()),
  });

  // --- commands, keys, events, settings ---------------------------------------

  ctx.commands.register(
    "file-tree.toggle",
    async () => {
      try {
        await ctx.commands.run(panelVisible ? "otterm.panel.hide" : "otterm.panel.show", { id: PANEL_ID });
      } catch (e) {
        fail(e);
      }
    },
    { title: t("cmd-toggle"), icon: "folder" },
  );
  ctx.commands.register("file-tree.reveal-cwd", () => revealCwd(), {
    title: t("cmd-reveal"),
    icon: "locate-fixed",
  });
  ctx.keybindings.suggest("file-tree.toggle", "ctrl+shift+b");

  ctx.session.onCwdChanged((e) => {
    followEvent(e).catch(fail);
  });

  ctx.settings.onChange((e) => {
    if (e.key === "show_hidden") showHidden.set(e.value === true);
    if (e.key === "follow_cwd") {
      pinned.set(e.value !== true);
      followFocused().catch(fail);
    }
  });

  // --- start ------------------------------------------------------------------

  // Git status is polled only while the tree panel is visible (see refreshGit).
  gitTimer = setInterval(() => {
    if (panelVisible) void refreshGit(false);
  }, GIT_INTERVAL_MS);

  await setRoot(startDir);
  if (guide() >= 2) {
    await ctx.commands.run("otterm.panel.show", { id: PANEL_ID }).catch(fail);
  }
}

export function deactivate(): void {
  // The registrations are Disposables the host tracks. The git poll timer is ours, so stop it here.
  if (gitTimer !== undefined) clearInterval(gitTimer);
  gitTimer = undefined;
}

// --- helpers ------------------------------------------------------------------

/**
 * Runs `git rev-parse --show-toplevel` and `git status` under `root`. Not a repository, a non-zero exit,
 * a timeout, or a refused process permission all give an empty map (no decoration).
 */
async function readGitDecorations(proc: ProcessApi, root: string): Promise<Map<string, string>> {
  try {
    const top = await proc.run("git", ["rev-parse", "--show-toplevel"], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
    if (top.code !== 0 || top.timedOut) return new Map();
    const status = await proc.run("git", ["status", "--porcelain=v1", "-z", "--ignored=no", "--untracked-files=all"], {
      cwd: root,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (status.code !== 0 || status.timedOut) return new Map();
    return buildDecorations(top.stdout.trim(), parsePorcelainZ(status.stdout));
  } catch {
    return new Map();
  }
}

/** Table preview node. Columns are keyed c0..cN; a missing cell is an empty string. */
function tableNode(p: { header: string[]; body: string[][]; columns: number }): UiNode {
  const keys = Array.from({ length: p.columns }, (_, i) => `c${i}`);
  return {
    type: "table",
    columns: keys.map((key, i) => ({ key, title: p.header[i] || `#${i + 1}` })),
    rows: p.body.map((row) => Object.fromEntries(keys.map((key, i) => [key, row[i] ?? ""]))),
  };
}

/** Folders first, then files; case-insensitive by name. */
function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    const rankA = a.kind === "dir" ? 0 : 1;
    const rankB = b.kind === "dir" ? 0 : 1;
    if (rankA !== rankB) return rankA - rankB;
    const nameA = a.name.toLowerCase();
    const nameB = b.name.toLowerCase();
    if (nameA === nameB) return 0;
    return nameA < nameB ? -1 : 1;
  });
}

/**
 * The path as the shell sees it. For WSL (or Git Bash) sessions the tree shows the Windows path
 * (`hostCwd`); the shell needs its own path (`cwd`). Only the part under hostCwd is mapped.
 */
function shellPath(session: SessionInfo | undefined, path: string): string {
  if (!session?.hostCwd || session.hostCwd === session.cwd || !path.startsWith(session.hostCwd)) {
    return path;
  }
  const rest = path.slice(session.hostCwd.length).replace(/\\/g, "/");
  return `${session.cwd.replace(/\/+$/, "")}${rest}`;
}

function imageHtml(src: string): string {
  return `<style>html,body{margin:0;background:transparent}img{max-width:100%;height:auto}</style><img alt="" src="${src}">`;
}
