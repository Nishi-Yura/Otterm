/**
 * otterm.cmd-explain (docs/03 §8.1): explains the command on the input line in the assist bar.
 * Dictionary lookups only. The mod never runs the command or its --help while the user is typing (decision B9).
 */

import type {
  DangerLevel,
  DictionaryEntry,
  DictionaryOption,
  DictionarySubcommand,
  Explanation,
  LocalizedString,
  ModContext,
  ParsedCommand,
} from "@otterm/api";

type Part = NonNullable<Explanation["parts"]>[number];

const DANGER_RANK: Record<DangerLevel, number> = { warn: 1, confirm: 2, block: 3 };
/** Characters that end a token in a command line (pipes and separators included). */
const BOUNDARY = /[\s|;&()]/;

export async function activate(ctx: ModContext): Promise<void> {
  const hidden = ctx.signal<boolean>((await ctx.storage.get<boolean>("hidden")) === true);
  const resolve = (s: LocalizedString): string => ctx.i18n.resolve(s);

  async function explain(parsed: ParsedCommand): Promise<Explanation | undefined> {
    const level = ctx.assist.guideLevel.get();
    if (level === 0 || hidden.get()) return undefined;

    const seg = parsed.segments.at(-1);
    if (!seg || seg.name === "") return undefined;
    // PowerShell matches command and parameter names case-insensitively.
    const ci = parsed.shellKind === "pwsh" || parsed.shellKind === "powershell";
    const hasArgs = /\s/.test(parsed.raw.trim());

    const entry = await ctx.assist.dictionary.lookup(seg.name);
    if (!entry) {
      // Not a danger, so level 1 stays quiet. Only shown once an argument is typed, so "gi" on its own stays quiet.
      return level >= 2 && hasArgs ? { summary: ctx.i18n.t("explain-unknown") } : undefined;
    }

    const sub = seg.subcommand ? findSub(entry, seg.subcommand, ci) : undefined;
    const used: { flag: string; opt: DictionaryOption }[] = [];
    for (const o of seg.options) {
      const opt = findOption(sub?.options, o.flag, ci) ?? findOption(entry.options, o.flag, ci);
      if (opt) used.push({ flag: o.flag, opt });
    }
    const danger = maxDanger([entry.danger, sub?.danger, ...used.map((u) => u.opt.danger)]);
    // Level 1 explains only dangerous commands.
    if (level === 1 && danger === undefined) return undefined;

    const sentences: string[] = [resolve(sub ? sub.summary : entry.summary)];
    for (const { flag, opt } of used) {
      sentences.push(
        ctx.i18n.t(opt.danger ? "explain-option-danger" : "explain-option", {
          flag,
          summary: resolve(opt.summary),
        }),
      );
    }
    const example = sub?.examples?.[0] ?? entry.examples?.[0];
    if (level >= 3 && example) {
      sentences.push(ctx.i18n.t("explain-example", { command: example.command, summary: resolve(example.summary) }));
    }

    // Hover notes: the command, the subcommand and each option, found as whole tokens in the raw line.
    const raw = parsed.raw;
    const parts: Part[] = [];
    const cmdRange = findToken(raw, seg.name, seg.range[0], seg.range[1]);
    if (cmdRange) parts.push({ range: cmdRange, text: resolve(entry.summary), danger: entry.danger });
    if (sub && seg.subcommand) {
      const r = findToken(raw, seg.subcommand, cmdRange?.[1] ?? seg.range[0], seg.range[1]);
      if (r) parts.push({ range: r, text: resolve(sub.summary), danger: sub.danger });
    }
    for (const { flag, opt } of used) {
      const r = findToken(raw, flag, seg.range[0], seg.range[1]);
      if (r) {
        const text = opt.danger && opt.dangerMessage ? opt.dangerMessage : opt.summary;
        parts.push({ range: r, text: resolve(text), danger: opt.danger });
      }
    }

    // One line each: what the command does, then each option (the bar keeps line breaks).
    return { summary: sentences.join("\n"), parts, danger };
  }

  ctx.assist.explain.provide({
    async provide(parsed) {
      try {
        return await explain(parsed);
      } catch (err) {
        ctx.log.warn("explain failed", err);
        return undefined;
      }
    },
  });

  ctx.commands.register(
    "explain.toggle",
    async () => {
      const next = !hidden.get();
      hidden.set(next);
      await ctx.storage.set("hidden", next);
      void ctx.ui.toast({ text: ctx.i18n.t(next ? "toggle-hidden" : "toggle-shown"), kind: "info" });
    },
    { title: ctx.i18n.t("cmd-toggle"), icon: "message-square" },
  );
}

export function deactivate(): void {
  // Nothing to do: the provider and the command are Disposables the host tracks.
}

// --- helpers ------------------------------------------------------------------

function same(a: string, b: string, ci: boolean): boolean {
  return ci ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function findSub(entry: DictionaryEntry, name: string, ci: boolean): DictionarySubcommand | undefined {
  return entry.subcommands?.find((s) => same(s.name, name, ci) || (s.aliases ?? []).some((a) => same(a, name, ci)));
}

function findOption(list: DictionaryOption[] | undefined, flag: string, ci: boolean): DictionaryOption | undefined {
  return list?.find((o) => o.flags.some((f) => same(f, flag, ci)));
}

function maxDanger(levels: (DangerLevel | undefined)[]): DangerLevel | undefined {
  let best: DangerLevel | undefined;
  for (const l of levels) {
    if (l !== undefined && (best === undefined || DANGER_RANK[l] > DANGER_RANK[best])) best = l;
  }
  return best;
}

/** Finds `token` as a whole word inside raw[from, to). Returns its character range in raw. */
function findToken(raw: string, token: string, from: number, to: number): [number, number] | undefined {
  if (token === "") return undefined;
  let i = raw.indexOf(token, from);
  while (i >= 0 && i + token.length <= to) {
    const before = i === 0 || BOUNDARY.test(raw.charAt(i - 1));
    const after = i + token.length >= raw.length || BOUNDARY.test(raw.charAt(i + token.length));
    if (before && after) return [i, i + token.length];
    i = raw.indexOf(token, i + 1);
  }
  return undefined;
}
