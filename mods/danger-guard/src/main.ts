/**
 * otterm.danger-guard (docs/03 §8.3, decisions B8 and G5).
 *
 * At Enter, the command is checked against the host's danger rules (dictionary dangers, rules/core.json, and the
 * rule added here). Then: block -> cancel and toast; confirm -> a dialog with alternatives (level 1 and up);
 * warn -> a toast (level 2 and up). Rules the user muted with "don't ask again" are not shown again.
 */

import type { BeforeExecuteResult, DangerRule, LocalizedString, ModContext, ParsedCommand } from "@otterm/api";

type Segment = ParsedCommand["segments"][number];
type Alternative = { label: string; command: string };

/** `iex (iwr <url>)` and its variants. The pipe form `iwr <url> | iex` is in rules/core.json. */
const IEX_DOWNLOAD = "^\\s*(iex|IEX|Invoke-Expression)\\s*\\(\\s*(iwr|IWR|Invoke-WebRequest)\\b";

export async function activate(ctx: ModContext): Promise<void> {
  const muted = new Set<string>((await ctx.storage.get<string[]>("muted")) ?? []);
  /** The rule of the last confirm dialog, for "danger-guard.mute-last". */
  let lastConfirmed: string | undefined;
  const resolve = (s: LocalizedString): string => ctx.i18n.resolve(s);

  // Rules that rules/core.json and the dictionaries do not cover (see the Windows rows of docs/03 §8.3).
  ctx.assist.danger.addRules([
    {
      id: "danger-guard.iex-download",
      level: "confirm",
      platforms: ["windows"],
      match: { regex: IEX_DOWNLOAD },
      message: ctx.i18n.t("rule-iex-message"),
      alternatives: [
        {
          label: ctx.i18n.t("rule-iex-alt-label"),
          command: "{download} | Select-Object -ExpandProperty Content",
        },
      ],
    },
  ]);

  async function decide(command: string, cwd: string): Promise<BeforeExecuteResult> {
    if (command.trim() === "") return undefined;
    const parsed = await ctx.assist.parse(command, { cwd });
    const hit = await ctx.assist.danger.evaluate(parsed);
    if (!hit) return undefined;

    const { level: severity, rule } = hit;
    const guide = ctx.assist.guideLevel.get();
    const message = resolve(rule.message);

    // Block applies at every guide level and cannot be muted.
    if (severity === "block") {
      void ctx.ui.toast({ text: ctx.i18n.t("danger-blocked", { message }), kind: "danger" });
      return { action: "cancel" };
    }
    if (muted.has(rule.id)) return undefined;

    if (severity === "confirm") {
      if (guide === 0) return undefined; // level 0: block rules only
      lastConfirmed = rule.id;
      const alternatives = expandAlternatives(rule, parsed, resolve);
      const hasAlternatives = alternatives.length > 0;
      return {
        action: "confirm",
        title: message,
        body: hasAlternatives ? ctx.i18n.t("danger-alt-hint") : undefined,
        alternatives: hasAlternatives ? alternatives : undefined,
      };
    }

    // warn: a toast at level 2 and up; the command runs either way.
    if (guide >= 2) void ctx.ui.toast({ text: ctx.i18n.t("danger-warn", { message }), kind: "warning" });
    return undefined;
  }

  ctx.terminal.onBeforeExecute?.(async (e) => {
    try {
      return await decide(e.command, e.cwd);
    } catch (err) {
      // A failing check must not block the user's command.
      ctx.log.warn("danger check failed", err);
      return undefined;
    }
  });

  ctx.commands.register(
    "danger-guard.mute-last",
    async () => {
      if (!lastConfirmed) {
        void ctx.ui.toast({ text: ctx.i18n.t("danger-nothing"), kind: "info" });
        return;
      }
      muted.add(lastConfirmed);
      lastConfirmed = undefined;
      await ctx.storage.set("muted", [...muted]);
      void ctx.ui.toast({ text: ctx.i18n.t("danger-muted"), kind: "info" });
    },
    { title: ctx.i18n.t("cmd-mute-last"), icon: "bell-off" },
  );

  ctx.commands.register(
    "danger-guard.unmute-all",
    async () => {
      muted.clear();
      await ctx.storage.delete("muted");
      void ctx.ui.toast({ text: ctx.i18n.t("danger-unmuted"), kind: "success" });
    },
    { title: ctx.i18n.t("cmd-unmute-all"), icon: "bell" },
  );
}

export function deactivate(): void {
  // Nothing to do: the rules, providers and commands are Disposables the host tracks.
}

// --- helpers ------------------------------------------------------------------

/**
 * Expands the placeholders of a rule's alternatives:
 * - `{args}`: the arguments after the command (and subcommand) of the segment the rule matched
 * - `{download}`: for pipe-to-shell, the part before the first pipe; for `iex (...)`, the expression inside
 * - `{key}`: a registry key (reg / Remove-ItemProperty); an alternative without one is dropped
 * Also removes `--force` / `-f` when the replacement is `--force-with-lease` (the dictionary's git push alternative
 * would otherwise keep both flags).
 */
function expandAlternatives(
  rule: DangerRule,
  parsed: ParsedCommand,
  resolve: (s: LocalizedString) => string,
): Alternative[] {
  const alts = rule.alternatives ?? [];
  if (alts.length === 0) return [];
  const seg = pickSegment(rule, parsed);
  const values = {
    args: seg ? argsText(parsed.raw, seg) : "",
    download: downloadPart(parsed.raw),
    key: registryKey(parsed.raw),
  };
  const out: Alternative[] = [];
  for (const alt of alts) {
    const command = expandTemplate(alt.command, values);
    if (command !== undefined) out.push({ label: resolve(alt.label), command });
  }
  return out;
}

function pickSegment(rule: DangerRule, parsed: ParsedCommand): Segment | undefined {
  const m = rule.match;
  if ("command" in m) {
    const name = m.command.toLowerCase();
    return parsed.segments.find((s) => s.name.toLowerCase() === name) ?? parsed.segments[0];
  }
  const re = safeRegex(m.regex);
  return parsed.segments.find((s) => re?.test(parsed.raw.slice(s.range[0], s.range[1])) ?? false) ?? parsed.segments[0];
}

/** The arguments of a segment: the text after the command name and the subcommand, if any. */
function argsText(raw: string, seg: Segment): string {
  const nameAt = raw.indexOf(seg.name, seg.range[0]);
  let start = nameAt >= 0 ? nameAt + seg.name.length : seg.range[0];
  if (seg.subcommand) {
    const subAt = raw.indexOf(seg.subcommand, start);
    if (subAt >= 0 && subAt < seg.range[1]) start = subAt + seg.subcommand.length;
  }
  return raw.slice(start, seg.range[1]).trim();
}

function downloadPart(raw: string): string {
  const inner = /^\s*(?:iex|IEX|Invoke-Expression)\s*\(\s*([^)]*?)\s*\)/.exec(raw)?.[1];
  if (inner) return inner;
  return (raw.split("|")[0] ?? raw).trim();
}

function registryKey(raw: string): string | undefined {
  return /\b(HK(?:EY_[A-Z_]+|LM|CU|CR|U|CC)(?:[:\\][^\s"']*)?)/.exec(raw)?.[1];
}

function expandTemplate(
  template: string,
  v: { args: string; download: string; key: string | undefined },
): string | undefined {
  let out = template.replaceAll("{args}", v.args).replaceAll("{download}", v.download);
  if (out.includes("{key}")) {
    if (!v.key) return undefined;
    out = out.replaceAll("{key}", v.key);
  }
  if (out.includes("--force-with-lease")) {
    out = out
      .split(/\s+/)
      .filter((t) => t !== "--force" && t !== "-f")
      .join(" ");
  }
  return out.trim();
}

function safeRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}
