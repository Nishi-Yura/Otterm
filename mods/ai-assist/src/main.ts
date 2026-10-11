/**
 * otterm.ai-assist (docs/10, decisions F1 and F5). "Ask Pebble" on top of the provider the user chose.
 *
 * The host shows what is sent, redacts secrets, logs and rate-limits each request. This mod never sees a key
 * and never runs anything: its only write to the terminal is `insert`, which puts text at the prompt without Enter.
 *
 * Session text (output, selection, last block) travels only through `context.include`. Pasting it into the
 * prompt would skip the host's redaction, so the prompt carries only what the user typed or the command list.
 *
 * The `?` prefix (feature 7, decision F1) is off unless the host setting `ai.question_prefix` is on. It is read
 * from the host, and before-execute cancels such a line and runs the same flow as `ai.ask`.
 */

import type {
  AiCompleteRequest,
  Block,
  DialogOptions,
  ErrorHint,
  MenuClickContext,
  ModContext,
  ParsedCommand,
  SessionInfo,
  UiNode,
} from "@otterm/api";

type Choice = "send" | "cancel" | "insert" | "panel" | "close";
type Buttons = DialogOptions<Choice>["buttons"];
type BlockWithOutput = Block & { output: string };
type Part = { kind: "text"; text: string } | { kind: "code"; code: string; lang: string | undefined };
type ToastKind = "info" | "success" | "warning" | "danger";
type Danger = NonNullable<Awaited<ReturnType<ModContext["assist"]["danger"]["evaluate"]>>>;
/** What a finished stream shows in its dialog. `command` is the one line the insert button would add. */
type Final = { children: UiNode[]; command?: string };

const PANEL_ID = "ai-assist.answer";
const THINKING_MS = 30_000;
const ALERT_MS = 5_000;
const BUBBLE_MS = 3_000;
const LONG_CODE_BLOCKS = 2;
const HISTORY_LIMIT = 10;
const MAX_SUMMARY_CHARS = 120;
/** Ctrl+C. The user stopped it on purpose; no help is offered, the same as error-hint. */
const EXIT_INTERRUPTED = 130;

/**
 * Patterns error-hint already answers. A fallback that matched these would shadow a better hint, because the host
 * returns the first provider's hint. Keep in step with mods/error-hint/src/main.ts.
 */
const COVERED_BY_ERROR_HINT: RegExp[] = [
  /'[^'\r\n]+' is not recognized as/,
  /(?:^|\s)[^\s:'"]+: command not found/m,
  /command not found: [^\s'"]+/,
  /Unknown command: [^\s'"]+/,
  /Permission denied|Access is denied/,
  /No such file or directory|Cannot find path/,
  /fatal: not a git repository/,
  /EADDRINUSE[^\n]*?:\d{2,5}\b/,
  /port \d{2,5} is already in use/i,
  /ModuleNotFoundError: No module named '/,
  /Cannot find module '(?!\.)(?!\/)[^']+'/,
];

// Prompts are in English (the model follows them best); the answer language follows the UI.
const COMMAND_SYSTEM = (lang: string): string =>
  `Turn the user's request into one command line for the shell named in the context. Reply with only a JSON object: {"command": string, "explanation": string, "notes": string}. "explanation" is one line in ${lang}. "notes" is optional and short. Do not chain several destructive steps. Do not wrap the JSON in code fences.`;
const FAILURE_SYSTEM = (lang: string): string =>
  `The user's last command failed. Reply with only a JSON object: {"cause": string, "fix": string, "command": string}. "cause" and "fix" are short sentences in ${lang}. "command" is the corrected command line, or an empty string if there is none. Do not wrap the JSON in code fences.`;
const FREE_SYSTEM = (lang: string): string =>
  `You are Pebble, a calm helper inside a terminal. Answer in ${lang}, briefly. Put any shell command in a fenced code block and say what it does. Never suggest that the user runs something without explaining it.`;
const SUMMARY_SYSTEM = (lang: string): string =>
  `Summarize what the user was doing from the recent commands listed (exit codes only, no output). Answer in ${lang} in at most five short lines. Mention failures.`;

export async function activate(ctx: ModContext): Promise<void> {
  if (!ctx.ai) throw new Error("ai permission missing");
  const ai = ctx.ai;

  const t = (id: string, vars?: Record<string, string | number>): string => ctx.i18n.t(id, vars);
  const lang = ctx.i18n.locale === "ja" ? "Japanese" : "English";
  /** The text the answer panel shows. Set when an answer finishes, before the panel is opened. */
  const panelText = ctx.signal<string>("");

  const say = (text: string, kind: ToastKind = "info"): void => {
    ctx.ui.toast({ text, kind }).catch(() => undefined);
  };
  const bubble = (text: string, opts?: Parameters<ModContext["mascot"]["say"]>[1]): void => {
    ctx.mascot.say(text, opts).catch(() => undefined);
  };
  /** User-triggered work. A failure is logged and shown as a plain toast, never as an error dialog. */
  const guard = (task: () => Promise<void>): void => {
    task().catch((err: unknown) => {
      ctx.log.warn("ai-assist task failed", err);
      say(t("error-generic"), "danger");
    });
  };
  const currentSession = (): Promise<SessionInfo | undefined> => ctx.session.current().catch(() => undefined);
  const openSettings = (): void => {
    ctx.commands.run("otterm.settings.open").catch(() => undefined);
  };

  /** Connection, key or rate-limit trouble. Pebble does not scold: it points at the settings. */
  function reportFailure(err: unknown): void {
    ctx.log.warn("ai request failed", err);
    const message = err instanceof Error ? err.message : String(err);
    // The host's own limit is a plain error; there is no typed code to match, so the text is checked.
    if (/rate limit|too many requests|per minute/i.test(message)) {
      say(t("error-rate"), "warning");
      return;
    }
    bubble(t("error-connection"), {
      mood: "calm",
      actions: [{ label: t("open-settings"), onClick: openSettings }],
    });
  }

  async function ready(): Promise<boolean> {
    const ok = await ai.available().catch(() => false);
    if (!ok) reportFailure(new Error("AI provider is not available"));
    return ok;
  }

  /** One streamed request. Resolves to the full text, or undefined when it failed (already reported). */
  async function request(
    purpose: string,
    req: Omit<AiCompleteRequest, "purpose">,
    onChunk?: (text: string) => void,
  ): Promise<string | undefined> {
    let streamed = "";
    try {
      const res = await ai.stream({ ...req, purpose }, (chunk) => {
        streamed += chunk;
        onChunk?.(streamed);
      });
      if (res.truncated) say(t("truncated"));
      return res.text || streamed;
    } catch (err) {
      reportFailure(err);
      return undefined;
    }
  }

  function startThinking(): void {
    ctx.mascot.setMood("thinking", { for: THINKING_MS }).catch(() => undefined);
    bubble(t("thinking"), { mood: "thinking", duration: BUBBLE_MS });
  }

  /**
   * A dialog that follows the stream. Its body is a getter over signals, so the text grows while the dialog is
   * open. When the stream ends, `finish` builds the final view. The buttons are fixed when the dialog opens, so an
   * insert pressed early waits here until the stream has finished.
   */
  async function streamDialog(o: {
    title: string;
    purpose: string;
    req: Omit<AiCompleteRequest, "purpose">;
    buttons: Buttons;
    cancelId: Choice;
    finish: (reply: string | undefined) => Promise<Final> | Final;
  }): Promise<{ choice: Choice | null; final: Final }> {
    const live = ctx.signal<string>("");
    const view = ctx.signal<UiNode[] | undefined>(undefined);
    const dialog = ctx.ui.dialog<Choice>({
      title: o.title,
      body: () => ({
        type: "stack",
        gap: "m",
        children: view.get() ?? [liveNode(live.get())],
      }),
      buttons: o.buttons,
      cancelId: o.cancelId,
    });
    const streaming = request(o.purpose, o.req, (s) => live.set(s)).then(async (reply) => {
      const done = await o.finish(reply);
      view.set(done.children);
      return done;
    });
    const choice = await dialog;
    const final = await streaming;
    return { choice, final };
  }

  function liveNode(text: string): UiNode {
    return text === "" ? { type: "text", text: t("thinking"), muted: true } : { type: "markdown", source: text };
  }

  // --- answer rendering -------------------------------------------------------------

  /** Splits a Markdown answer into prose and fenced code, so each code block gets its own insert button. */
  function splitParts(text: string): Part[] {
    const parts: Part[] = [];
    let last = 0;
    for (const m of text.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)) {
      const at = m.index ?? 0;
      if (at > last) parts.push({ kind: "text", text: text.slice(last, at) });
      parts.push({ kind: "code", code: (m[2] ?? "").replace(/\n$/, ""), lang: m[1]?.trim() || undefined });
      last = at + m[0].length;
    }
    if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
    return parts.filter((p) => p.kind === "code" || p.text.trim() !== "");
  }

  function renderParts(parts: Part[]): UiNode[] {
    return parts.map((p): UiNode => {
      if (p.kind === "code") return { type: "code", code: p.code, language: p.lang, insertable: true, copyable: true };
      return { type: "markdown", source: p.text };
    });
  }

  /** The first prose line, cut short, for the dialog of a long answer. */
  function summaryLine(text: string): string {
    const line = text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "" && !l.startsWith("```"));
    const plain = (line ?? "").replace(/[#*`_>]/g, "").trim();
    return plain.length > MAX_SUMMARY_CHARS ? `${plain.slice(0, MAX_SUMMARY_CHARS)}…` : plain;
  }

  async function openPanel(): Promise<void> {
    await ctx.commands.run("otterm.panel.show", { id: PANEL_ID }).catch(() => undefined);
  }

  /**
   * Free-text answers stream into a dialog. Short ones stay there. An answer with two or more code blocks is kept in
   * the bottom panel, and the dialog keeps one line plus a button to open it (decision F5).
   */
  async function streamAnswer(title: string, purpose: string, req: Omit<AiCompleteRequest, "purpose">): Promise<void> {
    const { choice } = await streamDialog({
      title,
      purpose,
      req,
      buttons: [
        { id: "close", label: t("button-close"), variant: "primary" },
        { id: "panel", label: t("button-panel") },
      ],
      cancelId: "close",
      finish: (reply) => {
        if (reply === undefined) return { children: [{ type: "text", text: t("error-generic") }] };
        panelText.set(reply);
        const parts = splitParts(reply);
        const long = parts.filter((p) => p.kind === "code").length >= LONG_CODE_BLOCKS;
        return { children: long ? [{ type: "text", text: summaryLine(reply) }] : renderParts(parts) };
      },
    });
    if (choice === "panel") await openPanel();
  }

  // --- parsing the model's JSON -----------------------------------------------------

  /** Finds the first JSON object in a reply, with or without code fences. Undefined when there is none. */
  function parseJsonObject(text: string): Record<string, unknown> | undefined {
    const unfenced = text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      const value: unknown = JSON.parse(unfenced.slice(start, end + 1));
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

  // --- dictionary checks ------------------------------------------------------------

  /** Options in the reply that the dictionary does not list. Only checked for commands the dictionary knows. */
  async function unknownFlags(parsed: ParsedCommand): Promise<string[]> {
    const unknown = new Set<string>();
    for (const seg of parsed.segments) {
      const entry = await ctx.assist.dictionary.lookup(seg.name);
      if (!entry) continue;
      const subName = seg.subcommand;
      const sub = subName
        ? entry.subcommands?.find((s) => s.name === subName || s.aliases?.includes(subName))
        : undefined;
      const options = [...(entry.options ?? []), ...(sub?.options ?? [])];
      if (options.length === 0) continue; // the dictionary has no option list here, so nothing can be checked
      const known = new Set<string>(["-h", "--help", "--version"]);
      for (const o of options) for (const f of o.flags) known.add(f);
      for (const o of seg.options) if (!known.has(o.flag)) unknown.add(o.flag);
    }
    return [...unknown];
  }

  async function dangerOf(parsed: ParsedCommand): Promise<Danger | undefined> {
    return ctx.assist.danger.evaluate(parsed).catch(() => undefined);
  }

  function dangerBadge(danger: Danger): UiNode[] {
    const kind = danger.level === "warn" ? "warning" : "danger";
    return [
      { type: "badge", text: t(`danger-${danger.level}`), kind },
      { type: "text", text: ctx.i18n.resolve(danger.rule.message), muted: true },
    ];
  }

  // --- 1. natural language to a command ---------------------------------------------

  /** One text field in a dialog. Undefined when the user cancels or leaves a required field empty. */
  async function askQuestion(
    title: string,
    label: string,
    placeholder: string,
    required: boolean,
  ): Promise<string | undefined> {
    const value = ctx.signal<string>("");
    const choice = await ctx.ui.dialog<Choice>({
      title,
      body: {
        type: "stack",
        gap: "s",
        children: [
          { type: "text", text: label },
          { type: "input", value, placeholder },
        ],
      },
      buttons: [
        { id: "send", label: t("button-send"), variant: "primary" },
        { id: "cancel", label: t("button-cancel") },
      ],
      cancelId: "cancel",
    });
    if (choice !== "send") return undefined;
    const question = value.get().trim();
    return required && question === "" ? undefined : question;
  }

  /** Builds the command card once the reply is complete: danger badge, dictionary notes, explanation. */
  async function commandFinal(reply: string | undefined): Promise<Final> {
    if (reply === undefined) return { children: [{ type: "text", text: t("error-generic") }] };
    const obj = parseJsonObject(reply);
    const command = str(obj?.command);
    if (!command) {
      // Not the JSON shape we asked for: show the raw reply, do not guess a command from it.
      return { children: renderParts(splitParts(reply)) };
    }
    const session = await currentSession();
    const parsed = await ctx.assist.parse(command, { cwd: session?.cwd });
    const danger = await dangerOf(parsed);
    if (danger) ctx.mascot.setMood("alert", { for: ALERT_MS }).catch(() => undefined);
    const unknown = await unknownFlags(parsed);

    const children: UiNode[] = [];
    if (danger) children.push(...dangerBadge(danger));
    children.push({ type: "code", code: command, language: "shell", copyable: true });
    const explanation = str(obj?.explanation);
    if (explanation) children.push({ type: "text", text: explanation });
    const notes = str(obj?.notes);
    if (notes) children.push({ type: "text", text: notes, muted: true });
    if (unknown.length > 0) {
      children.push({ type: "text", text: t("unknown-flag", { flags: unknown.join(" ") }), muted: true });
    }
    return { children, command };
  }

  async function askForCommand(question: string): Promise<void> {
    if (!(await ready())) return;
    startThinking();
    const { choice, final } = await streamDialog({
      title: t("command-title"),
      purpose: t("purpose-command"),
      req: {
        prompt: question,
        system: COMMAND_SYSTEM(lang),
        context: { include: ["cwd", "os", "shell"] },
        json: true,
        maxTokens: 400,
      },
      buttons: [
        { id: "insert", label: t("button-insert"), variant: "primary" },
        { id: "cancel", label: t("button-cancel") },
      ],
      cancelId: "cancel",
      finish: commandFinal,
    });
    if (choice === "insert" && final.command) await ctx.terminal.insert(final.command);
  }

  async function askCommand(args?: Record<string, unknown>): Promise<void> {
    let question = str(args?.question);
    if (!question) {
      const typed = await askQuestion(t("ask-title"), t("ask-label"), t("ask-placeholder"), true);
      if (!typed) return;
      question = typed;
    }
    await askForCommand(question);
  }

  // --- 2 and 3. explain or fix the last failed block ----------------------------------

  /** Builds the cause / fix card. A reply that is not JSON is shown as it is. */
  function failureFinal(reply: string | undefined): Final {
    if (reply === undefined) return { children: [{ type: "text", text: t("error-generic") }] };
    const obj = parseJsonObject(reply);
    if (!obj) return { children: renderParts(splitParts(reply)) };
    const command = str(obj.command);
    const children: UiNode[] = [
      { type: "heading", text: t("cause-label"), level: 3 },
      { type: "text", text: str(obj.cause) },
      { type: "heading", text: t("fix-label"), level: 3 },
      { type: "text", text: str(obj.fix) },
    ];
    if (command) {
      children.push({ type: "heading", text: t("fixed-command-label"), level: 3 });
      children.push({ type: "code", code: command, language: "shell", insertable: true, copyable: true });
    }
    return command ? { children, command } : { children };
  }

  /** Uses the host's `lastBlock`, so the caller only decides whether that block is the one to explain. */
  async function explainFailure(): Promise<void> {
    if (!(await ready())) return;
    startThinking();
    const { choice, final } = await streamDialog({
      title: t("fix-title"),
      purpose: t("purpose-explain"),
      req: {
        prompt:
          "The last command failed. Explain the cause, how to fix it, and give the corrected command if there is one.",
        system: FAILURE_SYSTEM(lang),
        context: { include: ["lastBlock", "cwd", "os", "shell"] },
        json: true,
        maxTokens: 500,
      },
      buttons: [
        { id: "insert", label: t("button-insert"), variant: "primary" },
        { id: "cancel", label: t("button-cancel") },
      ],
      cancelId: "cancel",
      finish: failureFinal,
    });
    if (choice === "insert" && final.command) await ctx.terminal.insert(final.command);
  }

  /** Fallback for the error hint: only offered when no dictionary entry or generic pattern matched. */
  async function coveredByDictionary(block: BlockWithOutput): Promise<boolean> {
    const parsed = await ctx.assist.parse(block.command, { cwd: block.cwd });
    // Same order as error-hint: the last command of a pipeline or chain first, at most four names.
    const names = [...new Set(parsed.segments.map((s) => s.name))].reverse().slice(0, 4);
    for (const name of names) {
      const entry = await ctx.assist.dictionary.lookup(name);
      for (const err of entry?.errors ?? []) {
        if (matches(err.pattern, block.output)) return true;
      }
    }
    return false;
  }

  async function fallbackHint(block: BlockWithOutput): Promise<ErrorHint | undefined> {
    if (ctx.assist.guideLevel.get() === 0) return undefined;
    const code = block.exitCode;
    if (code === undefined || code === 0 || code === EXIT_INTERRUPTED) return undefined;
    if (block.output.trim() === "") return undefined;
    if (COVERED_BY_ERROR_HINT.some((re) => re.test(block.output))) return undefined;
    if (await coveredByDictionary(block)) return undefined;
    return {
      title: block.command.trim() || "command",
      body: t("hint-ask-body"),
      actions: [{ label: t("cmd-ask"), onClick: () => guard(explainFailure) }],
    };
  }

  /** `ai.fix`: explains the last block, but only if that block failed. */
  async function fixLast(): Promise<void> {
    const session = await currentSession();
    if (!session) return say(t("no-session"), "warning");
    const blocks = await ctx.terminal.blocks?.(session.id, { limit: 1 });
    if (!blocks) return say(t("history-unavailable"), "warning");
    const last = blocks.reduce<Block | undefined>((a, b) => (!a || b.startedAt > a.startedAt ? b : a), undefined);
    if (!last) return say(t("no-block"), "warning");
    if (last.exitCode === undefined || last.exitCode === 0) return say(t("no-failure"), "warning");
    await explainFailure();
  }

  // --- 4. ask about a selection ---------------------------------------------------------

  /**
   * The selection reaches the model only through `context.include`, so the host can redact it. It is not
   * copied into the prompt.
   */
  async function askAboutSelection(menu: MenuClickContext): Promise<void> {
    const selection = menu.selection ?? (await ctx.terminal.selection?.(menu.sessionId));
    if (!selection || selection.trim() === "") return say(t("no-selection"), "warning");
    const question = await askQuestion(t("selection-title"), t("selection-label"), t("selection-placeholder"), false);
    if (question === undefined) return;
    if (!(await ready())) return;
    startThinking();
    await streamAnswer(t("selection-title"), t("purpose-selection"), {
      prompt: question || "Explain what this output shows and what matters in it.",
      system: FREE_SYSTEM(lang),
      context: { include: ["selection"] },
      maxTokens: 800,
    });
  }

  // --- 5. what was I doing ---------------------------------------------------------------

  /** Command lines and exit codes only. Output stays out of the prompt. */
  async function summarize(): Promise<void> {
    const session = await currentSession();
    if (!session) return say(t("no-session"), "warning");
    const blocks = await ctx.terminal.blocks?.(session.id, { limit: HISTORY_LIMIT });
    if (!blocks) return say(t("history-unavailable"), "warning");
    if (blocks.length === 0) return say(t("no-history"));
    if (!(await ready())) return;
    startThinking();
    const list = [...blocks]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((b) => `${b.exitCode ?? "-"}  ${b.command.slice(0, 200)}`)
      .join("\n");
    await streamAnswer(t("summary-title"), t("purpose-summary"), {
      prompt: `Recent commands, oldest first. Each line is the exit code, then the command. No output is included.\n\n${list}`,
      system: SUMMARY_SYSTEM(lang),
      context: { include: ["cwd"] },
      maxTokens: 500,
    });
  }

  // --- 7. the `?` prefix ----------------------------------------------------------------

  // Off unless the host setting is on. Read once, then kept in step with the settings screen.
  let questionPrefix = false;
  try {
    questionPrefix = (await ctx.settings.host.get<boolean>("ai.question_prefix")) === true;
  } catch {
    questionPrefix = false;
  }
  ctx.settings.host.onChange((e) => {
    if (e.key === "ai.question_prefix") questionPrefix = e.value === true;
  });

  // Before-execute is answered within 50 ms, so this only decides and starts the flow; it never waits for it.
  ctx.terminal.onBeforeExecute?.((e) => {
    if (!questionPrefix) return undefined;
    const m = /^(?:\? |？)(.*)$/s.exec(e.command);
    if (!m) return undefined;
    const question = (m[1] ?? "").trim();
    guard(() => askCommand({ question }));
    return { action: "cancel" };
  });

  // --- registration -----------------------------------------------------------------------

  ctx.commands.register("ai.ask", (args) => askCommand(args).catch(reportGuardError), {
    title: t("cmd-ask"),
    icon: "otter",
  });
  ctx.commands.register("ai.fix", () => fixLast().catch(reportGuardError), {
    title: t("cmd-fix"),
    icon: "otter",
  });
  ctx.commands.register("ai.summary", () => summarize().catch(reportGuardError), {
    title: t("cmd-summary"),
    icon: "otter",
  });
  // A suggestion only: the user's own bindings win. `ai.ask` is bound by the host.
  ctx.keybindings.suggest("ai.fix", "ctrl+shift+.");

  ctx.assist.errorHints.provide({
    async provide(block) {
      try {
        return await fallbackHint(block);
      } catch (err) {
        ctx.log.warn("ai-assist fallback hint failed", err);
        return undefined;
      }
    },
  });

  ctx.ui.contextMenu("context.terminal", [
    { label: t("menu-ask-selection"), icon: "otter", onClick: (menu) => guard(() => askAboutSelection(menu)) },
  ]);

  ctx.ui.panel({
    id: PANEL_ID,
    title: t("panel-title"),
    icon: "otter",
    slot: "panel.bottom",
    content: () => ({ type: "stack", gap: "m", children: renderParts(splitParts(panelText.get())) }),
  });

  function reportGuardError(err: unknown): void {
    ctx.log.warn("ai-assist command failed", err);
    say(t("error-generic"), "danger");
  }
}

export function deactivate(): void {
  // Every registration is a Disposable the host tracks; nothing to do here.
}

/** `pattern` is a regex from a dictionary entry. A bad pattern never matches. */
function matches(pattern: string, output: string): boolean {
  try {
    return new RegExp(pattern).test(output);
  } catch {
    return false;
  }
}
