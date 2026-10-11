/**
 * Reading the JSON Schema of `config.toml` (schemars, from crates/otterm-config/src/schema.rs) for
 * the settings form (docs/06 §3, decision C6): each node becomes one kind of control.
 */
import { hasMessage, t, tAttr } from "../i18n";

// biome-ignore lint/suspicious/noExplicitAny: JSON Schema is open-ended
export type Schema = Record<string, any>;

export type FieldKind =
  | "bool"
  | "number"
  | "string"
  | "color"
  | "enum"
  | "strings"
  | "object"
  | "map"
  | "objects"
  | "unknown";

export interface Field {
  kind: FieldKind;
  /** `auto` is one of the values (`Auto<T>`). */
  auto: boolean;
  /** The value may be absent (`Option<T>`): an empty input removes it. */
  nullable: boolean;
  options?: string[];
  min?: number;
  max?: number;
  integer?: boolean;
  /** Properties of an object, in display order. */
  props?: [string, Schema][];
  /** Item schema of a list of objects, or value schema of a map. */
  item?: Schema;
  description?: string;
  advanced: boolean;
  restart: boolean;
}

/** Follow `$ref` into `$defs`. */
export function resolve(root: Schema, node: Schema | undefined): Schema {
  let n = node ?? {};
  for (let i = 0; i < 8 && typeof n.$ref === "string"; i++) {
    const name = n.$ref.replace("#/$defs/", "");
    const { $ref: _, ...rest } = n;
    n = { ...(root.$defs?.[name] ?? {}), ...rest };
  }
  return n;
}

function enumOf(root: Schema, node: Schema): string[] | undefined {
  const n = resolve(root, node);
  if (Array.isArray(n.enum)) return n.enum.map(String);
  if (typeof n.const === "string") return [n.const];
  const alts = n.oneOf ?? n.anyOf;
  if (Array.isArray(alts)) {
    const all: string[] = [];
    for (const a of alts) {
      const e = enumOf(root, a);
      if (!e) return undefined;
      all.push(...e);
    }
    return all;
  }
  return undefined;
}

/** What control a schema node needs. */
export function describe(root: Schema, node: Schema): Field {
  const n = resolve(root, node);
  const field: Field = {
    kind: "unknown",
    auto: false,
    nullable: false,
    description: n.description ?? node.description,
    advanced: n["x-advanced"] === true || node["x-advanced"] === true,
    restart: n["x-restart"] === true || node["x-restart"] === true,
  };
  let core = n;
  const alts: Schema[] | undefined = n.anyOf ?? (n.oneOf && !enumOf(root, n) ? n.oneOf : undefined);
  if (Array.isArray(alts)) {
    const rest: Schema[] = [];
    for (const a of alts) {
      const r = resolve(root, a);
      if (r.type === "null") field.nullable = true;
      else if (Array.isArray(r.enum) && r.enum.length === 1 && r.enum[0] === "auto") field.auto = true;
      else rest.push(a);
    }
    if (rest.length === 1) core = resolve(root, rest[0] as Schema);
    else if (rest.length > 1) {
      const e = enumOf(root, { anyOf: rest });
      if (e) return { ...field, kind: "enum", options: e };
      return field;
    }
  }
  let type = core.type;
  if (Array.isArray(type)) {
    if (type.includes("null")) field.nullable = true;
    type = type.find((x: string) => x !== "null");
  }
  const options = enumOf(root, core);
  if (options) {
    // `Language` and the like spell auto out as a plain value.
    return { ...field, kind: "enum", options };
  }
  switch (type) {
    case "boolean":
      return { ...field, kind: "bool" };
    case "integer":
    case "number":
      return { ...field, kind: "number", integer: type === "integer", min: core.minimum, max: core.maximum };
    case "string":
      return { ...field, kind: core.pattern?.includes("[0-9a-fA-F]{6}") ? "color" : "string" };
    case "array": {
      const item = resolve(root, core.items);
      if (item.type === "string") return { ...field, kind: "strings" };
      if (item.type === "object") return { ...field, kind: "objects", item };
      return field;
    }
    case "object":
      if (core.properties) {
        return { ...field, kind: "object", props: Object.entries(core.properties) as [string, Schema][] };
      }
      if (core.additionalProperties && typeof core.additionalProperties === "object") {
        return { ...field, kind: "map", item: resolve(root, core.additionalProperties) };
      }
      return field;
    default:
      return field;
  }
}

/** Fluent id of a setting (`set-a--b--c`; locales/*.ftl). */
export const labelId = (path: string[]) => `set-${path.join("--")}`;

/** The label of a setting: translated, else its last key made readable. */
export function label(path: string[]): string {
  const id = labelId(path);
  if (hasMessage(id)) return t(id);
  const last = path[path.length - 1] ?? "";
  return last.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
}

/** One line of help: the translation, else the schema's (English) description. */
export function help(path: string[], f: Field): string | undefined {
  return tAttr(labelId(path), "desc") ?? f.description;
}

/** The label of an enum value. */
export function optionLabel(value: string): string {
  const id = `setv-${value}`;
  return hasMessage(id) ? t(id) : value;
}

/** The value at `path` in the configuration's JSON. */
export function valueAt(values: unknown, path: string[]): unknown {
  let v: unknown = values;
  for (const p of path) v = v && typeof v === "object" ? (v as Record<string, unknown>)[p] : undefined;
  return v;
}

/** f32 settings arrive as 0.30000001192092896; show what was meant. */
export function tidy(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Every leaf setting under `node`, with its path, for search. */
export function leaves(root: Schema, node: Schema, path: string[] = []): { path: string[]; field: Field }[] {
  const f = describe(root, node);
  if (f.kind === "object" && f.props) return f.props.flatMap(([k, s]) => leaves(root, s, [...path, k]));
  return [{ path, field: f }];
}
