/**
 * Example mod: Git Status Bar.
 *
 * Template for `create-otterm-mod` (kind = "extension"). Completes the example from
 * docs/05-mod-system.md §5. Permissions and settings are declared in ../otmod.toml.
 */

import type { Block, Disposable, ModContext, UiNode } from "@otterm/api";

interface GitState {
  branch?: string;
  ahead: number;
  behind: number;
  dirty: number;
  files: { path: string; status: string }[];
}

export async function activate(ctx: ModContext) {
  // `process` is declared in the manifest, so it is present. Narrow once for type safety.
  if (!ctx.process) throw new Error("process permission missing");
  const proc = ctx.process;

  const state = ctx.signal<GitState | undefined>(undefined);
  const showDirty = ctx.signal<boolean>(await ctx.settings.get<boolean>("show_dirty_count"));

  // --- data -----------------------------------------------------------------

  async function refresh() {
    const session = await ctx.session.current();
    // The shell reports its folder a moment after it starts (OSC 7); until then there is nothing to ask git about.
    const cwd = session?.hostCwd ?? session?.cwd;
    if (!cwd) return;

    const res = await proc.run("git", ["status", "--porcelain=v2", "--branch"], { cwd, timeoutMs: 3000 });
    if (res.code !== 0) {
      state.set(undefined); // not a repo
      return;
    }
    state.set(parsePorcelain(res.stdout));
  }

  // --- UI -------------------------------------------------------------------

  // Status bar item (declarative, reactive).
  ctx.ui.slot("statusbar.left").add(
    (): UiNode => {
      const s = state.get();
      if (!s) return { type: "text", text: "", hidden: true };
      const dirty = showDirty.get() && s.dirty > 0 ? ` ·${s.dirty}` : "";
      const sync = s.ahead || s.behind ? ` ↑${s.ahead} ↓${s.behind}` : "";
      return {
        type: "text",
        icon: "git-branch",
        text: `${s.branch ?? "(detached)"}${dirty}${sync}`,
        tooltip: {
          ja: "現在のブランチ。クリックで Git パネルを開く",
          en: "Current branch. Click to open the Git panel",
        },
        onClick: () => ctx.commands.run("open-panel"),
      };
    },
    { order: 10 },
  );

  // Side panel listing changed files.
  ctx.ui.panel({
    id: "__SHORT__.panel",
    title: "Git",
    icon: "git",
    slot: "sidebar.right",
    badge: () => state.get()?.dirty || undefined,
    content: (): UiNode => {
      const s = state.get();
      if (!s)
        return { type: "text", text: { ja: "Git リポジトリではありません", en: "Not a git repository" }, muted: true };
      return {
        type: "stack",
        gap: "m",
        children: [
          { type: "heading", text: { ja: "変更ファイル", en: "Changed files" }, level: 2 },
          {
            type: "list",
            emptyText: { ja: "変更はありません", en: "No changes" },
            items: s.files.map((f) => ({
              key: f.path,
              text: f.path,
              badge: f.status,
              onClick: () => ctx.terminal.insert(`git diff -- "${f.path}"`),
            })),
          },
          {
            type: "row",
            gap: "s",
            children: [
              {
                type: "button",
                text: { ja: "すべてステージ", en: "Stage all" },
                variant: "primary",
                disabled: () => (state.get()?.dirty ?? 0) === 0,
                // Insert, never execute: the user presses Enter (docs/08 §2 "does not press Enter").
                onClick: () => ctx.terminal.insert("git add -A"),
              },
              {
                type: "button",
                text: { ja: "更新", en: "Refresh" },
                icon: "refresh-cw",
                variant: "ghost",
                onClick: () => void refresh(),
              },
            ],
          },
        ],
      };
    },
  });

  // --- commands -------------------------------------------------------------

  ctx.commands.register("refresh", () => refresh(), {
    title: { ja: "Git: ブランチ情報を更新", en: "Git: refresh branch info" },
    icon: "refresh-cw",
  });
  ctx.commands.register("open-panel", () => ctx.commands.run("otterm.panel.show", { id: "__SHORT__.panel" }), {
    title: { ja: "Git: パネルを開く", en: "Git: open panel" },
    hidden: true,
  });
  ctx.keybindings.suggest("refresh", "ctrl+shift+g", "terminalFocus && !altScreen");

  // --- events ---------------------------------------------------------------

  ctx.session.onCwdChanged(() => void refresh());
  ctx.session.onFocusChanged(() => void refresh());

  // Refresh after any git command finishes. terminal.read is declared, so onBlockEnd exists.
  ctx.terminal.onBlockEnd?.((b: Block) => {
    if (/^\s*git\b/.test(b.command)) void refresh();
  });

  // Let the mascot celebrate a successful push (once per session).
  ctx.mascot.reactions.add({
    on: "block-end",
    when: (p) => "command" in p && /^\s*git\s+push\b/.test(p.command) && p.exitCode === 0,
    mood: "happy",
    say: "i18n:pushed", // locales/ja.ftl: pushed = プッシュしました
    once: "per-session",
  });

  ctx.settings.onChange(async (e) => {
    if (e.key === "show_dirty_count") showDirty.set(e.value as boolean);
    if (e.key === "refresh_interval") restartTimer();
  });

  // Periodic refresh (interval from settings).
  let timer: Disposable | undefined;
  async function restartTimer() {
    timer?.dispose();
    const seconds = await ctx.settings.get<number>("refresh_interval");
    const handle = setInterval(() => void refresh(), seconds * 1000);
    timer = { dispose: () => clearInterval(handle) };
  }
  await restartTimer();
  await refresh();
}

export function deactivate() {
  // Nothing to do: every registration above is a Disposable tracked by the host.
}

// --- helpers ------------------------------------------------------------------

function parsePorcelain(out: string): GitState {
  const s: GitState = { ahead: 0, behind: 0, dirty: 0, files: [] };
  for (const line of out.split("\n")) {
    if (line.startsWith("# branch.head ")) s.branch = line.slice(14).trim();
    else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        s.ahead = Number(m[1]);
        s.behind = Number(m[2]);
      }
    } else if (/^[12u?] /.test(line)) {
      const parts = line.split(" ");
      const status = line[0] === "?" ? "??" : (parts[1] ?? "");
      const path = parts[parts.length - 1] ?? "";
      s.files.push({ path, status });
      s.dirty++;
    }
  }
  return s;
}
