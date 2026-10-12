/**
 * nishi-yura.project-scripts (community mod).
 *
 * A side panel listing the runnable things in the focused terminal's folder: the `scripts` of
 * package.json (run with the package manager the lock file points at), the recipes of a justfile and the
 * targets of a Makefile. Clicking an entry puts its command into the input line; nothing runs until you
 * press Enter. It reads only those files in the terminal's folder (`fs.read = ["${cwd}/**"]`).
 * Permissions are declared in ../otmod.toml.
 */

import type { ListItem, ModContext, UiNode } from "@otterm/api";

const PANEL_ID = "nishi-yura.project-scripts.panel";
const OPEN_COMMAND_ID = "nishi-yura.project-scripts.open";
const REFRESH_COMMAND_ID = "nishi-yura.project-scripts.refresh";
/** A finished command may have edited the files; wait a moment so several blocks fold into one read. */
const REFRESH_DELAY_MS = 400;
/** package.json beyond this is not a project file we want to parse. */
const MAX_FILE_BYTES = 512 * 1024;
/** Longest script body shown next to its name. */
const MAX_DETAIL_CHARS = 40;

interface Entry {
  name: string;
  command: string;
  /** What the entry does: the script body, or the recipe's parameters. */
  detail?: string;
}

interface Group {
  /** Fluent id suffix: group-<id>. */
  id: "package" | "just" | "make";
  /** The file the entries came from, for the heading. */
  file: string;
  entries: Entry[];
}

interface Shown {
  folder: string;
  groups: Group[];
}

let pending: ReturnType<typeof setTimeout> | undefined;

export async function activate(ctx: ModContext): Promise<void> {
  if (!ctx.fs) throw new Error("project-scripts: fs.read permission is missing");
  const fs = ctx.fs;
  const t = (id: string, vars?: Record<string, string | number>): string => ctx.i18n.t(id, vars);

  const shown = ctx.signal<Shown>({ folder: "", groups: [] });

  // One read at a time; a request that arrives during a read starts one more read after it.
  let busy = false;
  let again = false;
  async function refresh(): Promise<void> {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        await read();
      } while (again);
    } finally {
      busy = false;
    }
  }

  async function read(): Promise<void> {
    const session = await ctx.session.current().catch(() => undefined);
    const dir = session ? (session.hostCwd ?? session.cwd) : undefined;
    if (!dir) {
      shown.set({ folder: "", groups: [] });
      return;
    }
    const groups: Group[] = [];
    const pkg = await readPackage(dir);
    if (pkg) groups.push(pkg);
    const just = await readJustfile(dir);
    if (just) groups.push(just);
    const make = await readMakefile(dir);
    if (make) groups.push(make);
    shown.set({ folder: dir, groups });
  }

  async function text(path: string): Promise<string | undefined> {
    if (!(await fs.exists(path).catch(() => false))) return undefined;
    return fs.readText(path, { maxBytes: MAX_FILE_BYTES }).catch(() => undefined);
  }

  async function firstExisting(dir: string, names: string[]): Promise<string | undefined> {
    for (const name of names) {
      const path = join(dir, name);
      if (await fs.exists(path).catch(() => false)) return path;
    }
    return undefined;
  }

  async function readPackage(dir: string): Promise<Group | undefined> {
    const source = await text(join(dir, "package.json"));
    if (source === undefined) return undefined;
    let scripts: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(source);
      if (!parsed || typeof parsed !== "object") return undefined;
      const value = (parsed as { scripts?: unknown }).scripts;
      if (!value || typeof value !== "object") return undefined;
      scripts = value as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const runner = await packageRunner(dir);
    const entries: Entry[] = [];
    for (const [name, body] of Object.entries(scripts)) {
      if (typeof body !== "string") continue;
      entries.push({ name, command: `${runner} ${name}`, detail: shorten(body) });
    }
    return entries.length > 0 ? { id: "package", file: "package.json", entries } : undefined;
  }

  /** "pnpm run", "yarn", "bun run" or "npm run", by the lock file next to package.json. */
  async function packageRunner(dir: string): Promise<string> {
    if (await firstExisting(dir, ["pnpm-lock.yaml"])) return "pnpm run";
    if (await firstExisting(dir, ["yarn.lock"])) return "yarn";
    if (await firstExisting(dir, ["bun.lock", "bun.lockb"])) return "bun run";
    return "npm run";
  }

  async function readJustfile(dir: string): Promise<Group | undefined> {
    const path = await firstExisting(dir, ["justfile", "Justfile", ".justfile"]);
    if (!path) return undefined;
    const source = await text(path);
    if (source === undefined) return undefined;
    const entries = justRecipes(source);
    return entries.length > 0 ? { id: "just", file: path.slice(dir.length + 1), entries } : undefined;
  }

  async function readMakefile(dir: string): Promise<Group | undefined> {
    const path = await firstExisting(dir, ["Makefile", "makefile", "GNUmakefile"]);
    if (!path) return undefined;
    const source = await text(path);
    if (source === undefined) return undefined;
    const entries = makeTargets(source);
    return entries.length > 0 ? { id: "make", file: path.slice(dir.length + 1), entries } : undefined;
  }

  function insert(command: string): void {
    ctx.terminal
      .insert(command, { replaceLine: true })
      .catch((e: unknown) => ctx.log.warn("project-scripts: insert failed", e));
  }

  ctx.ui.panel({
    id: PANEL_ID,
    title: t("panel-title"),
    icon: "play",
    slot: "sidebar.left",
    content: () => content(shown.get(), t, insert, () => refresh()),
    badge: () => {
      const n = shown.get().groups.reduce((sum, g) => sum + g.entries.length, 0);
      return n > 0 ? n : undefined;
    },
    onShow: () => {
      refresh().catch(() => undefined);
    },
  });

  ctx.commands.register(
    OPEN_COMMAND_ID,
    async () => {
      try {
        await ctx.commands.run("otterm.panel.show", { id: PANEL_ID });
      } catch (e) {
        ctx.log.warn("project-scripts: could not show the panel", e);
      }
    },
    { title: t("cmd-open"), icon: "play" },
  );
  ctx.commands.register(REFRESH_COMMAND_ID, () => refresh(), { title: t("cmd-refresh"), icon: "refresh-cw" });

  const later = (): void => {
    if (pending !== undefined) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = undefined;
      refresh().catch(() => undefined);
    }, REFRESH_DELAY_MS);
  };
  ctx.session.onCwdChanged(later);
  ctx.session.onFocusChanged(later);
  if (ctx.terminal.onBlockEnd) ctx.terminal.onBlockEnd(later);

  await refresh();
}

export function deactivate(): void {
  if (pending !== undefined) clearTimeout(pending);
  pending = undefined;
}

// --- UI -----------------------------------------------------------------------

function content(
  s: Shown,
  t: (id: string, vars?: Record<string, string | number>) => string,
  insert: (command: string) => void,
  refresh: () => void,
): UiNode {
  const children: UiNode[] = [];
  children.push({
    type: "row",
    align: "space-between",
    children: [
      { type: "text", text: s.folder === "" ? t("no-folder") : folderName(s.folder), muted: true, tooltip: s.folder },
      {
        type: "button",
        text: t("cmd-refresh"),
        icon: "refresh-cw",
        variant: "ghost",
        iconOnly: true,
        onClick: refresh,
      },
    ],
  });
  if (s.groups.length === 0) {
    children.push({ type: "text", text: t("empty"), muted: true });
  }
  for (const group of s.groups) {
    const items: ListItem[] = group.entries.map((entry) => ({
      key: entry.name,
      text: entry.name,
      secondary: entry.detail,
      icon: "play",
      onClick: () => insert(entry.command),
    }));
    children.push({ type: "heading", text: t(`group-${group.id}`, { file: group.file }), level: 3 });
    children.push({ type: "list", items });
  }
  children.push({ type: "spacer", size: "s" });
  children.push({ type: "text", text: t("note-insert"), muted: true });
  return { type: "stack", gap: "m", children };
}

// --- parsers ------------------------------------------------------------------

/**
 * Recipes of a justfile: lines that start at column 0 with a name followed by optional parameters
 * and a colon. Settings, aliases, imports, modules, variables (`x := ...`) and private recipes
 * (`_name`, `[private]`) are skipped.
 */
function justRecipes(source: string): Entry[] {
  const entries: Entry[] = [];
  let privateNext = false;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (line === "") continue;
    if (/^\[private\]/.test(line)) {
      privateNext = true;
      continue;
    }
    if (/^\[/.test(line)) continue;
    const m = /^(?:@)?([A-Za-z_][\w-]*)((?:\s+[^:=]+?)?)\s*:(?!=)/.exec(line);
    if (!m) {
      if (!/^\s/.test(line)) privateNext = false;
      continue;
    }
    const name = m[1] ?? "";
    const params = (m[2] ?? "").trim();
    const skip = privateNext || name.startsWith("_") || ["set", "export", "alias", "import", "mod"].includes(name);
    privateNext = false;
    if (skip) continue;
    entries.push({ name, command: `just ${name}`, detail: params === "" ? undefined : params });
  }
  return entries;
}

/**
 * Targets of a Makefile: `name:` at column 0 that is not a variable assignment, a pattern (`%`),
 * a special target (`.PHONY`) or a variable reference (`$(...)`).
 */
function makeTargets(source: string): Entry[] {
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "");
    const m = /^([A-Za-z0-9_][\w./+-]*)\s*:(?![=:])/.exec(line);
    if (!m) continue;
    const name = m[1] ?? "";
    if (name === "" || name.includes("$") || name.includes("%") || seen.has(name)) continue;
    seen.add(name);
    entries.push({ name, command: `make ${name}` });
  }
  return entries;
}

// --- helpers ------------------------------------------------------------------

function join(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** A script body on one line, at most 40 characters, so the name next to it keeps its room. */
function shorten(body: string): string {
  const line = body.replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  return chars.length > MAX_DETAIL_CHARS ? `${chars.slice(0, MAX_DETAIL_CHARS - 1).join("")}…` : line;
}

function folderName(dir: string): string {
  const parts = dir.split(/[\\/]/).filter((p) => p !== "");
  return parts[parts.length - 1] ?? dir;
}
