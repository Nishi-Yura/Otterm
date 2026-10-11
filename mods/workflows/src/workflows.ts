/**
 * Workflow model and pure helpers (docs/03 §10): argument discovery, shell-specific command choice,
 * filling `{{arg}}` placeholders, value checks, and parsing of ${data}/workflows.json.
 * No ctx access here, so the logic is easy to read on its own.
 */

import type { LocalizedString } from "@otterm/api";

export type ArgType = "string" | "number" | "path" | "enum";

export interface ArgDef {
  label: LocalizedString;
  type: ArgType;
  placeholder?: LocalizedString;
  default?: string;
  values?: { value: string; label?: LocalizedString }[];
}

export interface WorkflowDef {
  /** Stable id; the command is `workflows.run.<id>`. */
  id: string;
  name: LocalizedString;
  description?: LocalizedString;
  /** Command template with `{{arg}}` placeholders. */
  command: string;
  /** Used instead of `command` when the session shell is PowerShell. */
  pwshCommand?: string;
  args?: Record<string, ArgDef>;
  autorun?: boolean;
}

export interface WorkflowSet {
  id: string;
  title: LocalizedString;
  workflows: WorkflowDef[];
}

export interface ArgEntry {
  name: string;
  def: ArgDef;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g;

export function placeholdersIn(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Declared args, plus a plain string arg for every placeholder that has no declaration. */
export function argsOf(wf: WorkflowDef): ArgEntry[] {
  const entries: ArgEntry[] = Object.entries(wf.args ?? {}).map(([name, def]) => ({ name, def }));
  for (const name of [...placeholdersIn(wf.command), ...placeholdersIn(wf.pwshCommand ?? "")]) {
    if (!entries.some((entry) => entry.name === name)) {
      entries.push({ name, def: { label: name, type: "string" } });
    }
  }
  return entries;
}

export function commandFor(wf: WorkflowDef, shellKind: string): string {
  const onPowerShell = shellKind === "pwsh" || shellKind === "powershell";
  return onPowerShell && wf.pwshCommand ? wf.pwshCommand : wf.command;
}

export function initialValueOf(def: ArgDef): string {
  if (def.default !== undefined) return def.default;
  if (def.type === "enum") return def.values?.[0]?.value ?? "";
  return "";
}

function quotePath(value: string): string {
  return /\s/.test(value) && !/^(["']).*\1$/.test(value) ? `"${value}"` : value;
}

/** Replaces `{{name}}` with the value. Path args containing spaces are quoted. */
export function fillCommand(template: string, args: ArgEntry[], read: (name: string) => string): string {
  return template.replace(PLACEHOLDER, (_match: string, name: string) => {
    const isPath = args.find((entry) => entry.name === name)?.def.type === "path";
    const value = read(name);
    return isPath ? quotePath(value) : value;
  });
}

/** First problem with the current values, or undefined when the command can be built. */
export function checkValues(
  args: ArgEntry[],
  read: (name: string) => string,
): { kind: "empty" | "number"; entry: ArgEntry } | undefined {
  for (const entry of args) {
    const value = read(entry.name);
    if (value === "") return { kind: "empty", entry };
    if (entry.def.type === "number" && !Number.isFinite(Number(value))) return { kind: "number", entry };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseValues(list: unknown[]): { value: string; label?: LocalizedString }[] {
  const out: { value: string; label?: LocalizedString }[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      out.push({ value: item });
    } else if (isRecord(item)) {
      const { value, label } = item;
      if (typeof value === "string") out.push({ value, label: typeof label === "string" ? label : value });
    }
  }
  return out;
}

function parseArgs(raw: Record<string, unknown>): Record<string, ArgDef> {
  const out: Record<string, ArgDef> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const { label, type, placeholder, default: fallback, values } = value;
    const kind: ArgType = type === "number" || type === "path" || type === "enum" ? type : "string";
    const def: ArgDef = { label: typeof label === "string" ? label : name, type: kind };
    if (typeof placeholder === "string") def.placeholder = placeholder;
    if (typeof fallback === "string" || typeof fallback === "number") def.default = String(fallback);
    if (Array.isArray(values)) def.values = parseValues(values);
    out[name] = def;
  }
  return out;
}

function toWorkflow(raw: unknown, index: number, taken: WorkflowDef[]): WorkflowDef | undefined {
  if (!isRecord(raw)) return undefined;
  const { name, command } = raw;
  if (typeof name !== "string" || name.trim() === "" || typeof command !== "string" || command.trim() === "") {
    return undefined;
  }
  const base = `user-${slugify(name) || String(index + 1)}`;
  let id = base;
  for (let n = 2; taken.some((wf) => wf.id === id); n += 1) id = `${base}-${n}`;
  const wf: WorkflowDef = { id, name, command };
  if (typeof raw.description === "string") wf.description = raw.description;
  if (typeof raw.pwshCommand === "string") wf.pwshCommand = raw.pwshCommand;
  if (raw.autorun === true) wf.autorun = true;
  if (isRecord(raw.args)) {
    const args = parseArgs(raw.args);
    if (Object.keys(args).length > 0) wf.args = args;
  }
  return wf;
}

/** Parses workflows.json. Throws on malformed JSON; entries without name/command are counted as skipped. */
export function parseUserWorkflows(text: string): { workflows: WorkflowDef[]; skipped: number } {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error("workflows.json must contain a JSON array");
  const list: unknown[] = data;
  const workflows: WorkflowDef[] = [];
  let skipped = 0;
  for (let index = 0; index < list.length; index += 1) {
    const wf = toWorkflow(list[index], index, workflows);
    if (wf) workflows.push(wf);
    else skipped += 1;
  }
  return { workflows, skipped };
}
