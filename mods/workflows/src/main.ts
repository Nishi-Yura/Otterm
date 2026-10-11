/**
 * otterm.workflows (docs/03 §10). Command templates with a small form. Built-in sets come from builtin.ts,
 * user workflows from ${data}/workflows.json. The default action inserts the command at the prompt;
 * running it needs the `autorun` setting or a workflow with `autorun: true`.
 *
 * Permissions and settings are declared in ../otmod.toml.
 */

import type {
  Disposable,
  FsApi,
  ListItem,
  LocalizedString,
  ModContext,
  SessionInfo,
  Signal,
  UiNode,
} from "@otterm/api";
import { BUILTIN_SETS } from "./builtin";
import {
  type ArgEntry,
  argsOf,
  checkValues,
  commandFor,
  fillCommand,
  initialValueOf,
  parseUserWorkflows,
  type WorkflowDef,
} from "./workflows";

const PANEL_ID = "workflows.panel";
const OPEN_FILE_ID = "workflows.open-file";
/** Written this way so the literals are not mistaken for template strings. */
const DATA_DIR = `\${data}`;
const DATA_FILE = `\${data}/workflows.json`;
const MAX_FILE_BYTES = 1024 * 1024;

type Choice = "insert" | "run" | "cancel";
type ToastKind = "info" | "success" | "warning" | "danger";

export async function activate(ctx: ModContext): Promise<void> {
  if (!ctx.fs) throw new Error("workflows: fs permission is missing");
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
  const setting = async (key: string, fallback: boolean): Promise<boolean> => {
    try {
      const value = await ctx.settings.get<boolean | undefined>(key);
      return value ?? fallback;
    } catch {
      return fallback;
    }
  };
  const currentSession = (): Promise<SessionInfo | undefined> => ctx.session.current().catch(() => undefined);

  const userWorkflows = ctx.signal<WorkflowDef[]>([]);
  let registrations: Disposable[] = [];

  // --- user file ----------------------------------------------------------------

  function exampleFile(): string {
    const example = [
      {
        name: t("example-name"),
        description: t("example-description"),
        command: "mkdir {{folder}}",
        args: { folder: { label: t("example-label"), type: "string", placeholder: "work" } },
      },
    ];
    return `${JSON.stringify(example, null, 2)}\n`;
  }

  /** Returns the path of workflows.json, creating the folder and a sample file if they are missing. */
  async function ensureUserFile(): Promise<string> {
    const file = await files.resolve(DATA_FILE);
    if (await files.exists(file)) return file;
    const dir = await files.resolve(DATA_DIR);
    if (!(await files.exists(dir)) && files.mkdir) await files.mkdir(dir);
    if (!files.writeText) throw new Error(t("error-no-write"));
    await files.writeText(file, exampleFile());
    say(t("user-file-created"));
    return file;
  }

  async function loadUser(): Promise<void> {
    try {
      const file = await ensureUserFile();
      const parsed = parseUserWorkflows(await files.readText(file, { maxBytes: MAX_FILE_BYTES }));
      userWorkflows.set(parsed.workflows);
      if (parsed.skipped > 0) say(t("user-file-skipped", { count: parsed.skipped }), "warning");
    } catch (e) {
      userWorkflows.set([]);
      fail(e);
    }
    registerCommands();
  }

  async function openDefinitions(): Promise<void> {
    try {
      const file = await ensureUserFile();
      await ctx.commands.run("otterm.open", { path: file });
    } catch (e) {
      fail(e);
    }
  }

  // --- commands -----------------------------------------------------------------

  function allWorkflows(): WorkflowDef[] {
    return [...BUILTIN_SETS.flatMap((set) => set.workflows), ...userWorkflows.get()];
  }

  /** One command per workflow, so the palette lists them by name. Re-registered when the user file changes. */
  function registerCommands(): void {
    for (const d of registrations) d.dispose();
    registrations = allWorkflows().map((wf) =>
      ctx.commands.register(`workflows.run.${wf.id}`, () => openWorkflow(wf), {
        title: wf.name,
        description: wf.description,
        icon: "play",
      }),
    );
  }

  ctx.commands.register(OPEN_FILE_ID, () => openDefinitions(), {
    title: t("cmd-open-file"),
    icon: "file-json",
  });

  // --- running ------------------------------------------------------------------

  async function runIn(command: string): Promise<void> {
    const session = await currentSession();
    if (!session) {
      say(t("error-no-session"), "danger");
      return;
    }
    if (session.altScreen || session.echoOff) {
      say(t("error-busy"), "warning");
      return;
    }
    if (!ctx.terminal.write) {
      say(t("error-no-write"), "danger");
      return;
    }
    await ctx.terminal.write(session.id, `${command}\r`);
  }

  function argNode(entry: ArgEntry, value: Signal<string>): UiNode {
    const { def } = entry;
    const control: UiNode =
      def.type === "enum"
        ? {
            type: "select",
            value,
            options: (def.values ?? []).map((v) => ({ value: v.value, label: v.label ?? v.value })),
          }
        : {
            type: "input",
            value,
            kind: def.type === "number" ? "number" : "text",
            placeholder: def.placeholder,
          };
    return { type: "stack", gap: "s", children: [{ type: "text", text: def.label }, control] };
  }

  async function openWorkflow(wf: WorkflowDef): Promise<void> {
    try {
      const session = await currentSession();
      const entries = argsOf(wf);
      const fields = entries.map((entry) => ({ entry, value: ctx.signal<string>(initialValueOf(entry.def)) }));
      const read = (name: string): string => (fields.find((f) => f.entry.name === name)?.value.get() ?? "").trim();
      const command = (): string => fillCommand(commandFor(wf, session?.shellKind ?? ""), entries, read);
      const autorun = wf.autorun === true || (await setting("autorun", false));

      const buttons: { id: Choice; label: LocalizedString; variant?: "primary" | "danger" | "default" }[] = [
        { id: "insert", label: t("dialog-insert"), variant: "primary" },
      ];
      if (autorun) buttons.push({ id: "run", label: t("dialog-run") });
      buttons.push({ id: "cancel", label: t("dialog-cancel") });

      const body = (): UiNode => ({
        type: "stack",
        gap: "m",
        children: [
          ...fields.map((f): UiNode => argNode(f.entry, f.value)),
          { type: "heading", text: t("preview-label"), level: 3 },
          { type: "code", code: () => command(), copyable: true },
        ],
      });

      // Re-open with the typed values when something is missing, instead of dropping the form.
      for (;;) {
        const choice = await ctx.ui.dialog<Choice>({ title: wf.name, body, buttons, cancelId: "cancel" });
        if (choice === null || choice === "cancel") return;
        const problem = checkValues(entries, read);
        if (problem) {
          const label = ctx.i18n.resolve(problem.entry.def.label);
          say(problem.kind === "number" ? t("error-number", { label }) : t("error-empty", { label }), "warning");
          continue;
        }
        if (choice === "insert") {
          await ctx.terminal.insert(command());
        } else {
          await runIn(command());
        }
        return;
      }
    } catch (e) {
      fail(e);
    }
  }

  // --- panel --------------------------------------------------------------------

  const listItemFor = (wf: WorkflowDef): ListItem => ({
    key: wf.id,
    text: wf.name,
    secondary: wf.description,
    icon: "play",
    onClick: () => void openWorkflow(wf),
  });

  function panelNode(): UiNode {
    const sections: UiNode[] = BUILTIN_SETS.map(
      (set): UiNode => ({
        type: "stack",
        gap: "s",
        children: [
          { type: "heading", text: set.title, level: 3 },
          { type: "list", items: set.workflows.map(listItemFor) },
        ],
      }),
    );
    sections.push({
      type: "stack",
      gap: "s",
      children: [
        { type: "heading", text: t("user-section"), level: 3 },
        { type: "list", items: () => userWorkflows.get().map(listItemFor), emptyText: t("user-empty") },
      ],
    });
    sections.push({
      type: "button",
      text: t("open-file"),
      icon: "file-json",
      variant: "ghost",
      onClick: () => void openDefinitions(),
    });
    return { type: "stack", gap: "m", children: sections };
  }

  ctx.ui.panel({
    id: PANEL_ID,
    title: t("panel-title"),
    icon: "play",
    slot: "sidebar.right",
    content: panelNode,
    // Re-read the file each time the panel opens, so edits made in the editor show up.
    onShow: () => {
      void loadUser();
    },
  });

  await loadUser();
}

export function deactivate(): void {
  // Every registration is a Disposable the host tracks; nothing to do here.
}
