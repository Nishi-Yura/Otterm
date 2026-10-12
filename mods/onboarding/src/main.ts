/**
 * otterm.onboarding: the first-run setup (docs/03 §11.1) and the first-terminal tutorial (§11.3).
 *
 * Kotsume's lines live in locales/*.ftl. This file decides what to ask, what to change and when to judge.
 */

import type {
  Block,
  GuideLevel,
  HostSettingKey,
  ModContext,
  Mood,
  SessionId,
  SessionInfo,
  ShellKind,
  UiNode,
} from "@otterm/api";
import {
  CHAPTERS,
  FOLDER_NAME,
  INSIDE_NAME,
  JS_FILE,
  type JudgeState,
  join,
  PY_FILE,
  type ShellFamily,
  samePath,
} from "./tutorial.js";

const SKIP = "skip";
const PANEL_ID = "onboarding.tutorial";
const KNOWN_SHELLS = new Set<ShellKind>(["pwsh", "powershell", "cmd", "bash", "zsh", "fish"]);

interface Progress {
  chapter: number;
  step: number;
  finished: boolean;
}

interface View extends Progress {
  hint: "none" | "alt";
  family: ShellFamily;
}

interface Button {
  id: string;
  label: string;
  variant?: "primary" | "danger" | "default";
}

interface CwdEvent {
  sessionId: SessionId;
  cwd: string;
  hostCwd?: string;
}

export async function activate(ctx: ModContext) {
  const tr = (id: string, vars?: Record<string, string | number>): string => ctx.i18n.t(id, vars);
  const fallbackFamily: ShellFamily = ctx.host.platform === "windows" ? "pwsh" : "posix";

  const view = ctx.signal<View>({ chapter: 1, step: 0, finished: false, hint: "none", family: fallbackFamily });
  const cleanupDone = ctx.signal<boolean>(false);

  let folder = "";
  let bound: SessionId | undefined;
  let lastCwd: string | undefined;
  let judging = false;
  let onboardingRunning = false;

  // --- helpers ----------------------------------------------------------------

  const say = (text: string, mood?: Mood): void => {
    void ctx.mascot.say(text, mood ? { mood } : undefined).catch((err: unknown) => ctx.log.warn("say failed", err));
  };

  const currentSession = async (): Promise<SessionInfo | undefined> => {
    try {
      return await ctx.session.current();
    } catch (err) {
      ctx.log.warn("session.current failed", err);
      return undefined;
    }
  };

  async function resolveFolder(): Promise<boolean> {
    const fs = ctx.fs;
    if (!fs) return false;
    try {
      folder = await fs.resolve(`\${home}/${FOLDER_NAME}`);
      return folder !== "";
    } catch (err) {
      ctx.log.warn("could not resolve the tutorial folder", err);
      return false;
    }
  }

  async function ensureFolders(): Promise<void> {
    const fs = ctx.fs;
    if (!fs?.mkdir) return;
    for (const dir of [folder, join(folder, INSIDE_NAME)]) {
      try {
        if (!(await fs.exists(dir))) await fs.mkdir(dir);
      } catch (err) {
        ctx.log.warn("could not create the folder", dir, err);
      }
    }
  }

  async function writeIfMissing(path: string, text: string): Promise<void> {
    const fs = ctx.fs;
    if (!fs?.writeText) return;
    try {
      if (!(await fs.exists(path))) await fs.writeText(path, text);
    } catch (err) {
      ctx.log.warn("could not write", path, err);
    }
  }

  async function prepareChapter(chapter: number): Promise<void> {
    if (!CHAPTERS[chapter - 1]?.prepare || folder === "") return;
    await writeIfMissing(join(folder, PY_FILE), 'print("hello from python")\n');
    await writeIfMissing(join(folder, JS_FILE), 'console.log("hello from node");\n');
  }

  async function persist(p: Progress): Promise<void> {
    try {
      await ctx.storage.set("tutorial", p);
    } catch (err) {
      ctx.log.warn("could not save tutorial progress", err);
    }
  }

  async function loadProgress(): Promise<Progress | undefined> {
    try {
      const raw = await ctx.storage.get<unknown>("tutorial");
      if (!isProgress(raw)) return undefined;
      const chapter = Math.min(Math.max(1, Math.trunc(raw.chapter)), CHAPTERS.length);
      const steps = CHAPTERS[chapter - 1]?.steps.length ?? 1;
      const step = Math.min(Math.max(0, Math.trunc(raw.step)), steps - 1);
      return { chapter, step, finished: raw.finished };
    } catch (err) {
      ctx.log.warn("could not read tutorial progress", err);
      return undefined;
    }
  }

  function judgeState(): JudgeState {
    const fs = ctx.fs;
    return {
      folder,
      family: view.get().family,
      exists: async (path: string) => {
        if (!fs) return false;
        try {
          return await fs.exists(path);
        } catch {
          return false;
        }
      },
      hint: "none",
    };
  }

  function currentStep() {
    const v = view.get();
    return CHAPTERS[v.chapter - 1]?.steps[v.step];
  }

  // --- tutorial: progress -----------------------------------------------------

  async function advance(celebrate: boolean): Promise<void> {
    const v = view.get();
    if (v.finished) return;
    const steps = CHAPTERS[v.chapter - 1]?.steps.length ?? 0;
    let next: Progress;
    if (v.step + 1 < steps) next = { chapter: v.chapter, step: v.step + 1, finished: false };
    else if (v.chapter < CHAPTERS.length) next = { chapter: v.chapter + 1, step: 0, finished: false };
    else next = { chapter: v.chapter, step: v.step, finished: true };

    view.set({ ...v, ...next, hint: "none" });
    await persist(next);

    if (next.finished) {
      judging = false;
      const commands = tr(v.family === "pwsh" ? "tutorial-commands-pwsh" : "tutorial-commands-posix");
      say(tr("tutorial-complete", { commands }), "happy");
      return;
    }
    if (celebrate) say(tr("tutorial-step-done"), "happy");
    if (next.step === 0) await prepareChapter(next.chapter);
  }

  // --- tutorial: judging ------------------------------------------------------

  async function onBlockEnd(b: Block): Promise<void> {
    if (!judging) return;
    if (bound === undefined) bound = b.sessionId;
    if (b.sessionId !== bound) return;

    const v = view.get();
    const step = currentStep();
    if (step?.kind !== "block" || !step.judge || !step.pattern?.test(b.command)) return;

    const state = judgeState();
    try {
      const passed = await step.judge(b, state);
      if (state.hint === "alt") view.set({ ...view.get(), hint: "alt" });
      if (passed) await advance(true);
      else if (state.hint === "none") {
        say(tr("tutorial-step-retry", { expected: step.command?.[v.family] ?? "" }), "alert");
      }
    } catch (err) {
      ctx.log.warn("could not judge the step", err);
    }
  }

  async function onCwdChanged(e: CwdEvent): Promise<void> {
    if (!judging) return;
    if (bound === undefined) bound = e.sessionId;
    if (e.sessionId !== bound) return;

    const here = e.hostCwd ?? e.cwd;
    const previous = lastCwd;
    lastCwd = here;

    const step = currentStep();
    if (step?.kind !== "cwd" || !step.expectCwd) return;
    try {
      if (!samePath(here, step.expectCwd(folder))) return;
      if (step.fromCwd && (previous === undefined || !samePath(previous, step.fromCwd(folder)))) return;
      await advance(true);
    } catch (err) {
      ctx.log.warn("could not judge the cwd", err);
    }
  }

  // --- tutorial: panel --------------------------------------------------------

  function codeNode(code: string, family: ShellFamily): UiNode {
    return {
      type: "code",
      code,
      language: family === "pwsh" ? "powershell" : "bash",
      insertable: true,
      copyable: true,
    };
  }

  function panelNode(): UiNode {
    const v = view.get();
    if (v.finished) return finishedNode(v);

    const chapter = CHAPTERS[v.chapter - 1];
    const step = chapter?.steps[v.step];
    if (!chapter || !step) return { type: "text", text: tr("tutorial-title") };

    const command = step.command?.[v.family] ?? "";
    const children: UiNode[] = [
      { type: "text", text: tr("tutorial-progress", { n: v.chapter }), muted: true },
      { type: "heading", text: tr(chapter.title), level: 2 },
      { type: "markdown", source: step.lines.map((id) => tr(id, { command })).join("\n\n") },
    ];
    if (command) children.push(codeNode(command, v.family));
    if (v.hint === "alt") {
      children.push({ type: "text", text: tr("tutorial-alt-hint") });
      for (const alt of step.alt?.[v.family] ?? []) children.push(codeNode(alt, v.family));
    }

    const actions: UiNode[] = [];
    if (step.kind === "manual") {
      actions.push({ type: "button", text: tr("btn-done"), variant: "primary", onClick: () => void advance(true) });
    }
    actions.push({ type: "button", text: tr("btn-skip"), variant: "ghost", onClick: () => void advance(false) });
    children.push({ type: "row", gap: "s", children: actions });
    return { type: "stack", gap: "m", children };
  }

  function finishedNode(v: View): UiNode {
    const commands = tr(v.family === "pwsh" ? "tutorial-commands-pwsh" : "tutorial-commands-posix");
    const children: UiNode[] = [
      { type: "heading", text: tr("tutorial-title"), level: 2 },
      { type: "markdown", source: tr("tutorial-complete", { commands }) },
    ];
    if (!cleanupDone.get()) {
      children.push(
        { type: "text", text: tr("tutorial-cleanup", { path: folder }), muted: true },
        {
          type: "row",
          gap: "s",
          children: [
            { type: "button", text: tr("btn-trash"), variant: "danger", onClick: () => void trashFolder() },
            {
              type: "button",
              text: tr("btn-keep"),
              variant: "ghost",
              onClick: () => cleanupDone.set(true),
            },
          ],
        },
      );
    }
    return { type: "stack", gap: "m", children };
  }

  async function trashFolder(): Promise<void> {
    const fs = ctx.fs;
    if (!fs?.trash) return;
    try {
      judging = false;
      await fs.trash(folder);
      cleanupDone.set(true);
      void ctx.ui.toast({ text: tr("tutorial-cleaned"), kind: "success" });
    } catch (err) {
      ctx.log.warn("could not move the tutorial folder to the trash", err);
    }
  }

  // --- tutorial: start, resume, reset ------------------------------------------

  async function startTutorial(): Promise<void> {
    const session = await currentSession();
    if (!session) {
      void ctx.ui.toast({ text: tr("tutorial-no-session"), kind: "warning" });
      return;
    }
    try {
      if (!(await resolveFolder())) return;
      const saved = await loadProgress();
      const start: Progress = saved && !saved.finished ? saved : { chapter: 1, step: 0, finished: false };

      bound = session.id;
      lastCwd = undefined;
      view.set({ ...start, hint: "none", family: familyOf(session.shellKind) });
      cleanupDone.set(false);
      judging = true;

      await ensureFolders();
      await persist(start);
      await prepareChapter(start.chapter);
      // Resuming at "cd .." starts from inside, so that the step still needs the user's own cd.
      const atInside = start.chapter === 2 && start.step === 1;
      const target = atInside ? join(folder, INSIDE_NAME) : folder;
      // The one command the tutorial types for the user; everything else is typed by the user.
      await ctx.terminal.write?.(session.id, `cd "${target}"\r`);
      await ctx.commands.run("otterm.panel.show", { id: PANEL_ID });
    } catch (err) {
      ctx.log.error("could not start the tutorial", err);
    }
  }

  async function resetTutorial(): Promise<void> {
    judging = false;
    bound = undefined;
    view.set({ chapter: 1, step: 0, finished: false, hint: "none", family: view.get().family });
    cleanupDone.set(false);
    try {
      await ctx.storage.delete("tutorial");
    } catch (err) {
      ctx.log.warn("could not clear tutorial progress", err);
    }
    void ctx.ui.toast({ text: tr("tutorial-reset-done") });
  }

  function familyOf(kind: ShellKind | undefined): ShellFamily {
    if (kind === undefined) return fallbackFamily;
    return kind === "pwsh" || kind === "powershell" || kind === "cmd" ? "pwsh" : "posix";
  }

  // --- first-run onboarding ---------------------------------------------------

  async function runOnboarding(): Promise<void> {
    if (onboardingRunning) return;
    onboardingRunning = true;

    const answers: { level?: GuideLevel; tutorial: boolean } = { tutorial: false };
    let skipped = false;

    const steps: (() => Promise<"next" | "skip">)[] = [
      // 1. language
      async () => {
        const picked = await ask(ctx, tr("onboarding-greeting"), tr("onboarding-language-question"), [
          { id: "ja", label: tr("onboarding-lang-ja"), variant: "primary" },
          { id: "en", label: tr("onboarding-lang-en") },
        ]);
        if (picked === SKIP) return "skip";
        if (picked === "ja" || picked === "en") await setHost(ctx, "general.language", picked);
        return "next";
      },
      // 2. guide level (decision B7)
      async () => {
        const body: UiNode = {
          type: "stack",
          gap: "s",
          children: [
            { type: "text", text: tr("onboarding-level-first-desc") },
            { type: "text", text: tr("onboarding-level-sometimes-desc") },
            { type: "text", text: tr("onboarding-level-daily-desc") },
          ],
        };
        const picked = await ask(ctx, tr("onboarding-level-question"), body, [
          { id: "first", label: tr("onboarding-level-first"), variant: "primary" },
          { id: "sometimes", label: tr("onboarding-level-sometimes") },
          { id: "daily", label: tr("onboarding-level-daily") },
        ]);
        if (picked === SKIP) return "skip";
        const level = levelFor(picked);
        if (level === undefined) return "next";
        answers.level = level;
        await setHost(ctx, "general.guide_level", level);
        return "next";
      },
      // 3. shell (the recommended one is kept; there is no profile API yet)
      async () => {
        const kind = (await currentSession())?.shellKind;
        const lines: UiNode[] = [
          {
            type: "text",
            text: kind ? tr("onboarding-shell-body", { shell: tr(shellNameId(kind)) }) : tr("onboarding-shell-unknown"),
          },
        ];
        if (kind === "cmd") lines.push({ type: "text", text: tr("onboarding-shell-cmd") });
        const picked = await ask(ctx, tr("onboarding-shell-question"), { type: "stack", gap: "s", children: lines }, [
          { id: "keep", label: tr("btn-keep-default"), variant: "primary" },
        ]);
        return picked === SKIP ? "skip" : "next";
      },
      // 4. shell integration (explanation only)
      async () => {
        const body: UiNode = {
          type: "stack",
          gap: "s",
          children: [
            { type: "text", text: tr("onboarding-integration-body") },
            { type: "text", text: tr("onboarding-integration-rc-note"), muted: true },
          ],
        };
        const picked = await ask(ctx, tr("onboarding-integration-title"), body, [
          { id: "ok", label: tr("btn-ok"), variant: "primary" },
        ]);
        return picked === SKIP ? "skip" : "next";
      },
      // 5. theme
      async () => {
        const picked = await ask(ctx, tr("onboarding-theme-question"), undefined, [
          { id: "light", label: tr("onboarding-theme-light") },
          { id: "dark", label: tr("onboarding-theme-dark") },
          { id: "system", label: tr("onboarding-theme-system"), variant: "primary" },
        ]);
        if (picked === SKIP) return "skip";
        if (picked === "system") {
          await setHost(ctx, "appearance.follow_system", true);
        } else if (picked === "light" || picked === "dark") {
          await setHost(ctx, "appearance.theme", picked === "light" ? "otterm Light" : "otterm Dark");
          await setHost(ctx, "appearance.follow_system", false);
        }
        return "next";
      },
      // 6. update check
      async () => {
        const picked = await ask(ctx, tr("onboarding-network-question"), tr("onboarding-network-body"), [
          { id: "yes", label: tr("btn-yes"), variant: "primary" },
          { id: "no", label: tr("btn-no") },
        ]);
        if (picked === SKIP) return "skip";
        await setHost(ctx, "general.check_updates", picked === "yes");
        return "next";
      },
      // 7. tutorial offer
      async () => {
        const picked = await ask(ctx, tr("tutorial-title"), tr("onboarding-tutorial-offer"), [
          { id: "start", label: tr("btn-start"), variant: "primary" },
          { id: "later", label: tr("btn-later") },
        ]);
        if (picked === SKIP) return "skip";
        answers.tutorial = picked === "start";
        return "next";
      },
      // 8. AI (nothing is changed; it can be enabled in settings later)
      async () => {
        const picked = await ask(ctx, tr("onboarding-ai-title"), tr("onboarding-ai-offer"), [
          { id: "later", label: tr("btn-later"), variant: "primary" },
        ]);
        return picked === SKIP ? "skip" : "next";
      },
    ];

    try {
      for (const step of steps) {
        if ((await step()) === "skip") {
          skipped = true;
          break;
        }
      }
    } catch (err) {
      ctx.log.error("onboarding stopped by an error", err);
      skipped = true;
    } finally {
      onboardingRunning = false;
      try {
        await ctx.storage.set("onboarded", true);
      } catch (err) {
        ctx.log.warn("could not mark onboarding as done", err);
      }
    }

    if (skipped) {
      // Skipping ends the flow. Keep an answer already given; otherwise use level 1 (decision B7).
      await setHost(ctx, "general.guide_level", answers.level ?? 1);
      return;
    }
    say(tr("onboarding-done"), "happy");
    if (answers.tutorial) await startTutorial();
  }

  // --- registration -----------------------------------------------------------

  ctx.ui.panel({
    id: PANEL_ID,
    title: tr("tutorial-panel-title"),
    icon: "book",
    slot: "sidebar.right",
    content: () => panelNode(),
  });

  ctx.commands.register("onboarding.restart", () => runOnboarding(), {
    title: tr("cmd-restart-title"),
    icon: "compass",
  });
  ctx.commands.register("tutorial.start", () => startTutorial(), {
    title: tr("cmd-tutorial-start-title"),
    icon: "play",
  });
  ctx.commands.register("tutorial.reset", () => resetTutorial(), {
    title: tr("cmd-tutorial-reset-title"),
    icon: "rotate-ccw",
  });

  ctx.terminal.onBlockEnd?.((b: Block) => void onBlockEnd(b));
  ctx.session.onCwdChanged((e: CwdEvent) => void onCwdChanged(e));

  // --- start -------------------------------------------------------------------

  let onboarded: unknown;
  try {
    onboarded = await ctx.storage.get("onboarded");
  } catch (err) {
    ctx.log.warn("could not read onboarding state", err);
  }
  if (onboarded === undefined) {
    void runOnboarding();
  } else {
    // A tutorial left halfway does not open itself again: someone who stopped may not want it.
    // The panel shows where it stopped, and "start the tutorial" carries on from there.
    const saved = await loadProgress();
    if (saved && !saved.finished) view.set({ ...saved, hint: "none", family: view.get().family });
  }
}

export function deactivate() {
  // Nothing to do: every registration above is a Disposable tracked by the host.
}

// --- module helpers -----------------------------------------------------------

function isProgress(v: unknown): v is Progress {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Partial<Progress>;
  return typeof p.chapter === "number" && typeof p.step === "number" && typeof p.finished === "boolean";
}

function levelFor(choice: string): GuideLevel | undefined {
  if (choice === "first") return 3;
  if (choice === "sometimes") return 2;
  if (choice === "daily") return 1;
  return undefined;
}

function shellNameId(kind: ShellKind): string {
  return KNOWN_SHELLS.has(kind) ? `shell-name-${kind}` : "shell-name-other";
}

/** Shows a dialog. Every dialog has a skip button, which is also the cancel path (Escape, close). */
async function ask(
  ctx: ModContext,
  title: string,
  body: UiNode | string | undefined,
  buttons: Button[],
): Promise<string> {
  try {
    const picked = await ctx.ui.dialog<string>({
      title,
      body,
      buttons: [...buttons, { id: SKIP, label: ctx.i18n.t("btn-skip") }],
      cancelId: SKIP,
    });
    return picked ?? SKIP;
  } catch (err) {
    ctx.log.warn("dialog failed", err);
    return SKIP;
  }
}

async function setHost(ctx: ModContext, key: HostSettingKey, value: unknown): Promise<void> {
  try {
    await ctx.settings.host.set(key, value);
  } catch (err) {
    ctx.log.warn(`could not set ${key}`, err);
  }
}
