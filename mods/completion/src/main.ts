/**
 * otterm.completion (docs/03 §8.2).
 *
 * Offers candidates for the word under the cursor: subcommands and options from the command dictionary, and file
 * or folder names when the argument is a path (by the dictionary's argument type, a path-like word, or a path option).
 *
 * Command-name completion is not offered: the host has no "list every dictionary entry" call, and looking up each
 * prefix would not work. The shell completes command names. A first word that looks like a path (./run.sh, src/)
 * still completes files.
 */

import type {
  CompletionItem,
  CompletionProvider,
  DictionaryArg,
  DictionaryEntry,
  DictionaryOption,
  DictionarySubcommand,
  DirEntry,
  FsApi,
  InputState,
  LocalizedString,
  ModContext,
  ParsedCommand,
} from "@otterm/api";

const MAX_ITEMS = 50;
const PATH_TYPES = new Set<string>(["path", "file", "dir"]);

export async function activate(ctx: ModContext): Promise<void> {
  const fs: FsApi | undefined = ctx.fs;
  const fold = ctx.host.platform === "windows"; // Windows file names and PowerShell words are case-insensitive
  const resolve = (s: LocalizedString): string => ctx.i18n.resolve(s);
  const kindLabel = { dir: ctx.i18n.t("completion-dir"), file: ctx.i18n.t("completion-file") };

  async function complete(input: InputState, parsed: ParsedCommand): Promise<CompletionItem[]> {
    const line = input.line;
    const cursor = Math.max(0, Math.min(input.cursor, line.length));
    const start = wordStart(line, cursor);
    const word = line.slice(start, cursor);
    const tokens = (line.slice(0, start).split(/[|;&]/).at(-1) ?? "")
      .trim()
      .split(/\s+/)
      .filter((t) => t !== "");

    // The word without a leading quote; the quote is kept when the candidate is inserted.
    const quote = word.charAt(0) === '"' || word.charAt(0) === "'" ? word.charAt(0) : "";
    const bare = quote ? word.slice(1) : word;
    const pathLike = /[\\/]/.test(bare) || bare.startsWith(".") || bare.startsWith("~") || /^[A-Za-z]:/.test(bare);
    const cwd = parsed.cwd;

    if (tokens.length === 0) {
      // First word: only path-like words. Command names are left to the shell (see the file comment).
      return pathLike && fs && cwd ? fileItems(bare, quote, fs, cwd) : [];
    }

    const name = parsed.segments.at(-1)?.name ?? tokens[0] ?? "";
    const entry = await ctx.assist.dictionary.lookup(name);
    const rest = tokens.slice(1);
    const subIndex = entry ? rest.findIndex((t) => !t.startsWith("-") && findSub(entry, t, fold) !== undefined) : -1;
    const sub = entry && subIndex >= 0 ? findSub(entry, rest[subIndex] ?? "", fold) : undefined;
    const positionals = rest.slice(subIndex + 1).filter((t) => !t.startsWith("-"));

    // Subcommand position: the command is typed and nothing else (apart from options) before the word.
    const atSubcommandSlot =
      entry?.subcommands !== undefined && sub === undefined && rest.every((t) => t.startsWith("-"));

    const argDefs: DictionaryArg[] = sub?.args ?? entry?.args ?? [];
    const argDef = argDefs[positionals.length] ?? (argDefs.at(-1)?.variadic ? argDefs.at(-1) : undefined);
    const optionSources: DictionaryOption[] = [...(sub?.options ?? []), ...(entry?.options ?? [])];
    const prevToken = tokens.at(-1) ?? "";
    const prevOption = prevToken.startsWith("-") ? findOptionByFlag(optionSources, prevToken, fold) : undefined;
    const optionTakesPath = prevOption?.takesValue === true && PATH_TYPES.has(prevOption.valueType ?? "");
    const wantsFiles = !bare.startsWith("-") && (pathLike || optionTakesPath || PATH_TYPES.has(argDef?.type ?? ""));

    const items: CompletionItem[] = [];

    if (entry?.subcommands && atSubcommandSlot && !pathLike && !bare.startsWith("-")) {
      for (const [i, s] of entry.subcommands.entries()) {
        if (!matchesPrefix(s.name, bare, fold)) continue;
        items.push(subcommandItem(s, i, resolve));
      }
    }

    if (entry && (bare.startsWith("-") || (bare === "" && !wantsFiles))) {
      for (const opt of optionSources) {
        for (const flag of opt.flags) {
          if (!matchesPrefix(flag, bare, fold)) continue;
          items.push({
            label: flag,
            insertText: flag,
            detail: resolve(opt.summary),
            kind: "option",
            danger: opt.danger,
            sortText: sortKey(2, items.length),
          });
        }
      }
    }

    if (wantsFiles && fs && cwd) {
      items.push(...(await fileItems(bare, quote, fs, cwd)));
    }

    return items.slice(0, MAX_ITEMS);
  }

  async function fileItems(bare: string, quote: string, fsApi: FsApi, cwd: string): Promise<CompletionItem[]> {
    // otterm does not expand "~"; the shell does, and it is outside the fs.read grant anyway.
    if (bare.startsWith("~")) return [];
    const sep = Math.max(bare.lastIndexOf("/"), bare.lastIndexOf("\\"));
    const dirPart = bare.slice(0, sep + 1);
    const prefix = bare.slice(sep + 1);
    const absolute = /^([A-Za-z]:[\\/]|[\\/])/.test(dirPart);
    const dir = dirPart === "" ? cwd : absolute ? dirPart : `${cwd.replace(/[\\/]+$/, "")}/${dirPart}`;

    let entries: DirEntry[];
    try {
      entries = await fsApi.readDir(dir, { includeHidden: prefix.startsWith(".") });
    } catch {
      return []; // outside the fs.read grant, or not a folder
    }

    const dirs: DirEntry[] = [];
    const files: DirEntry[] = [];
    for (const e of entries) {
      if (e.kind === "other") continue;
      if (e.hidden && !prefix.startsWith(".")) continue;
      if (!matchesPrefix(e.name, prefix, fold)) continue;
      if (e.kind === "dir") dirs.push(e);
      else files.push(e);
    }
    const byName = (a: DirEntry, b: DirEntry) => a.name.localeCompare(b.name);
    dirs.sort(byName);
    files.sort(byName);

    const out: CompletionItem[] = [];
    for (const e of [...dirs, ...files]) {
      const isDir = e.kind === "dir";
      const body = dirPart + e.name + (isDir ? "/" : "");
      const insertText = quote ? quote + body : /\s/.test(body) ? `"${body}"` : body;
      out.push({
        label: isDir ? `${e.name}/` : e.name,
        insertText,
        detail: isDir ? kindLabel.dir : kindLabel.file,
        kind: isDir ? "dir" : "file",
        sortText: sortKey(3, out.length),
      });
    }
    return out;
  }

  ctx.assist.completions.provide({
    async provide(input, parsed): Promise<CompletionItem[]> {
      // Level 0 has no otterm UI (docs/03 §11.2).
      if (ctx.assist.guideLevel.get() === 0) return [];
      try {
        return await complete(input, parsed);
      } catch (err) {
        ctx.log.warn("completion failed", err);
        return [];
      }
    },
  } satisfies CompletionProvider);
}

export function deactivate(): void {
  // Nothing to do: the provider is a Disposable the host tracks.
}

// --- helpers ------------------------------------------------------------------

function subcommandItem(
  s: DictionarySubcommand,
  index: number,
  resolve: (x: LocalizedString) => string,
): CompletionItem {
  return {
    label: s.name,
    insertText: s.name,
    detail: resolve(s.summary),
    kind: "subcommand",
    danger: s.danger,
    // The first subcommand of the dictionary entry is the usual one.
    recommended: index === 0 ? true : undefined,
    sortText: sortKey(1, index),
  };
}

function sortKey(group: number, index: number): string {
  return `${group}-${String(index).padStart(4, "0")}`;
}

function matchesPrefix(candidate: string, prefix: string, fold: boolean): boolean {
  return fold ? candidate.toLowerCase().startsWith(prefix.toLowerCase()) : candidate.startsWith(prefix);
}

function findSub(entry: DictionaryEntry, token: string, fold: boolean): DictionarySubcommand | undefined {
  return entry.subcommands?.find(
    (s) => matchesExact(s.name, token, fold) || (s.aliases ?? []).some((a) => matchesExact(a, token, fold)),
  );
}

function matchesExact(a: string, b: string, fold: boolean): boolean {
  return fold ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function findOptionByFlag(list: DictionaryOption[], flag: string, fold: boolean): DictionaryOption | undefined {
  return list.find((o) => o.flags.some((f) => matchesExact(f, flag, fold)));
}

/** Start index of the word that contains the cursor. Quotes keep spaces inside one word; `|`, `;`, `&` end one. */
function wordStart(line: string, cursor: number): number {
  let quote = "";
  let start = 0;
  for (let i = 0; i < cursor; i++) {
    const c = line.charAt(i);
    if (quote !== "") {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === " " || c === "\t" || c === "|" || c === ";" || c === "&") {
      start = i + 1;
    }
  }
  return start;
}
