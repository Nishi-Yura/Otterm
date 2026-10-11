/**
 * otterm.error-hint (docs/03 §8.4, decision B11).
 *
 * When a block ends with a non-zero exit code, look for a known error in its output and return a hint card.
 * The fix is only offered as an "insert" button; the mod never runs anything the user did not type.
 * Dictionary errors come first (`errors[]` of each command in the line); generic patterns are the fallback.
 */

import type { Block, DictionaryEntry, ErrorHint, LocalizedString, ModContext, Platform } from "@otterm/api";

type Manager = "winget" | "scoop" | "choco" | "brew" | "apt" | "dnf" | "pacman" | "nix";
type Install = NonNullable<DictionaryEntry["install"]>;
type BlockWithOutput = Block & { output: string };

/** Package managers to probe per platform, in preference order (docs/03 §8.4). */
const MANAGERS: Record<Platform, Manager[]> = {
  windows: ["winget", "scoop", "choco"],
  macos: ["brew"],
  linux: ["apt", "dnf", "pacman", "nix", "brew"],
};

/** Program names reported by the shells when a command is missing (bash, zsh, fish, cmd, PowerShell). */
const MISSING_COMMAND: RegExp[] = [
  /'(?<program>[^'\r\n]+)' is not recognized as/,
  /(?:^|\s)(?<program>[^\s:'"]+): command not found/m,
  /command not found: (?<program>[^\s'"]+)/,
  /Unknown command: (?<program>[^\s'"]+)/,
];
const PERMISSION = /Permission denied|Access is denied/;
const NO_PATH = /No such file or directory|Cannot find path/;
const NOT_A_REPO = /fatal: not a git repository/;
const PORT_IN_USE: RegExp[] = [/EADDRINUSE[^\n]*?:(?<port>\d{2,5})\b/, /port (?<port>\d{2,5}) is already in use/i];
const PIP_MODULE = /ModuleNotFoundError: No module named '(?<module>[^'.\s]+)/;
const NPM_MODULE = /Cannot find module '(?<module>[^']+)'/;

/** Ctrl+C. The user stopped it on purpose; no hint. */
const EXIT_INTERRUPTED = 130;

export async function activate(ctx: ModContext): Promise<void> {
  if (!ctx.process) throw new Error("process permission missing");
  const proc = ctx.process;
  const platform = ctx.host.platform;
  const probe = platform === "windows" ? "where" : "which";

  // One probe per manager name, cached for the session. Started now so the first hint does not wait for it.
  const probes = new Map<Manager, Promise<boolean>>();
  function hasManager(name: Manager): Promise<boolean> {
    let found = probes.get(name);
    if (!found) {
      found = proc.run(probe, [name], { timeoutMs: 3000 }).then(
        (r) => r.code === 0,
        () => false,
      );
      probes.set(name, found);
    }
    return found;
  }
  async function detectedManagers(): Promise<Manager[]> {
    const names = MANAGERS[platform];
    const ok = await Promise.all(names.map((n) => hasManager(n)));
    return names.filter((_, i) => ok[i] === true);
  }
  void detectedManagers();

  const resolve = (s: LocalizedString): string => ctx.i18n.resolve(s);

  async function dictionaryHint(block: BlockWithOutput): Promise<ErrorHint | undefined> {
    const parsed = await ctx.assist.parse(block.command, { cwd: block.cwd });
    // The last command of a pipeline or chain is the one whose exit code the block reports.
    const names = [...new Set(parsed.segments.map((s) => s.name))].reverse().slice(0, 4);
    for (const name of names) {
      const entry = await ctx.assist.dictionary.lookup(name);
      for (const err of entry?.errors ?? []) {
        const m = compile(err.pattern)?.exec(block.output);
        if (!m) continue;
        const groups = m.groups ?? {};
        return {
          title: entry?.name ?? name,
          body: fill(resolve(err.hint), groups),
          fixCommand: err.fix ? fill(err.fix, groups) : undefined,
        };
      }
    }
    return undefined;
  }

  async function missingCommandHint(program: string): Promise<ErrorHint> {
    const entry = await ctx.assist.dictionary.lookup(program);
    const install: Install = entry?.install ?? {};
    const missing = ctx.i18n.t("hint-missing", { program });

    // Installers found on this PATH come first. Several -> all are listed, the first is the fix.
    const choices = (await detectedManagers()).map((m) => install[m]).filter(isString);
    if (choices.length > 0) {
      const [first] = choices;
      const line =
        choices.length === 1
          ? ctx.i18n.t("hint-install-one", { command: choices[0] ?? "" })
          : ctx.i18n.t("hint-install-many", { list: choices.join(" / ") });
      return { title: program, body: `${missing} ${line}`, fixCommand: first };
    }

    // No installer detected: list whatever the dictionary knows. A URL is shown but never offered as a fix.
    const all = Object.values(install).filter(isString);
    if (all.length > 0) {
      const first = all[0];
      return {
        title: program,
        body: `${missing} ${ctx.i18n.t("hint-install-any", { list: all.join(" / ") })}`,
        fixCommand: first && !/^https?:/.test(first) ? first : undefined,
      };
    }
    return { title: program, body: missing };
  }

  async function genericHint(block: BlockWithOutput): Promise<ErrorHint | undefined> {
    const out = block.output;
    const cmd = block.command.trim().split(/\s+/)[0] ?? "";

    for (const re of MISSING_COMMAND) {
      const program = re.exec(out)?.groups?.program;
      if (program) return missingCommandHint(program);
    }
    if (PERMISSION.test(out)) return { title: cmd, body: ctx.i18n.t("hint-permission") };
    if (NO_PATH.test(out)) return { title: cmd, body: ctx.i18n.t("hint-no-path"), fixCommand: "ls" };
    if (NOT_A_REPO.test(out)) return { title: cmd, body: ctx.i18n.t("hint-not-repo"), fixCommand: "git init" };

    for (const re of PORT_IN_USE) {
      const port = re.exec(out)?.groups?.port;
      if (port) {
        const windows = platform === "windows";
        return {
          title: cmd,
          body: ctx.i18n.t("hint-port", { port, tool: windows ? "netstat -ano" : "lsof -i" }),
          fixCommand: windows ? `netstat -ano | findstr :${port}` : `lsof -i :${port}`,
        };
      }
    }

    const pip = PIP_MODULE.exec(out)?.groups?.module;
    if (pip) {
      return { title: cmd, body: ctx.i18n.t("hint-pip", { module: pip }), fixCommand: `pip install ${pip}` };
    }

    const npm = NPM_MODULE.exec(out)?.groups?.module;
    // Relative and absolute paths are the user's own files, not packages.
    if (npm && !npm.startsWith(".") && !npm.startsWith("/")) {
      const pkg = packageName(npm);
      return { title: cmd, body: ctx.i18n.t("hint-npm", { module: pkg }), fixCommand: `npm install ${pkg}` };
    }
    return undefined;
  }

  async function hint(block: BlockWithOutput): Promise<ErrorHint | undefined> {
    if (ctx.assist.guideLevel.get() === 0) return undefined;
    const code = block.exitCode;
    if (code === undefined || code === 0 || code === EXIT_INTERRUPTED) return undefined;
    if (block.output.trim() === "") return undefined;
    return (await dictionaryHint(block)) ?? (await genericHint(block));
  }

  ctx.assist.errorHints.provide({
    async provide(block) {
      try {
        return await hint(block);
      } catch (err) {
        ctx.log.warn("error hint failed", err);
        return undefined;
      }
    },
  });
}

export function deactivate(): void {
  // Nothing to do: the provider is a Disposable the host tracks.
}

// --- helpers ------------------------------------------------------------------

function isString(s: string | undefined): s is string {
  return typeof s === "string";
}

function compile(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

/** Replaces `{name}` with the named group's text. Unknown names stay as they are. */
function fill(template: string, groups: Record<string, string | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => groups[key] ?? whole);
}

/** `@scope/pkg/sub` -> `@scope/pkg`; `pkg/sub` -> `pkg`. */
function packageName(module: string): string {
  const parts = module.split("/");
  if (module.startsWith("@")) return parts.slice(0, 2).join("/");
  return parts[0] ?? module;
}
