---
title: Shell integration
description: How shell integration works, how each shell is handled, and what to check when blocks are missing.
sidebar:
  order: 5
---

Shell integration lets otterm see where prompts and commands start and end. Blocks, the prompt bar, history, and command explanations depend on it.

By default, otterm loads its hook through startup arguments for the shells it launches. It does not change your shell files.

| Shell | Method |
| --- | --- |
| bash | `--rcfile`, and login startup order is kept |
| zsh | `ZDOTDIR` points to otterm's folder, which loads your own files |
| fish | Loaded after your config |
| PowerShell 7 / Windows PowerShell | Hook passed at startup. PSReadLine is required. |
| cmd, WSL launcher | No integration. Works as a plain terminal. |

## The shell's own startup files

otterm reads your usual startup files before the shell starts: the PowerShell profile, `~/.bashrc`, `~/.zshrc`, `config.fish` and cmd's AutoRun all apply, so your aliases and prompt theme are the same as in any other terminal. otterm's own hooks load after them.

To start the shell **as installed** instead, set `shell.user_startup_files = false` (applies to new tabs): PowerShell runs with `-NoProfile`, bash with `--norc`, fish with `--no-config`, and only otterm's integration is loaded. This was the default up to 1.2.

## WSL and cmd

A WSL tab has `wsl.exe` in between, so otterm cannot hand its hooks to the shell inside. It passes `OTTERM`, `OTTERM_SESSION_ID`, `OTTERM_HOOKS` (the hooks folder as a Linux path) and a few others through `WSLENV` instead. One line in the shell's startup file inside WSL turns the integration on (blocks, and new tabs in the same folder):

```bash
# ~/.bashrc
[ -n "$OTTERM_HOOKS" ] && OTTERM_USER_STARTUP=0 . "$OTTERM_HOOKS/otterm.bash"
```

```zsh
# ~/.zshrc
[ -n "$OTTERM_HOOKS" ] && source "$OTTERM_HOOKS/otterm.zsh"
```

```fish
# ~/.config/fish/config.fish
set -q OTTERM_HOOKS; and source $OTTERM_HOOKS/otterm.fish
```

cmd takes no hooks, but otterm puts the current folder and the start of the prompt into its prompt. New tabs and splits open in the same folder, and Ctrl+Up / Ctrl+Down move between prompts. Exit codes and durations are not available. A look set with the `PROMPT` variable is replaced by `$P$G` (the folder and `>`).

nushell has no integration yet.

## Prompt

`shell.prompt = "otterm"` (default) draws the prompt bar in otterm. `"shell"` keeps your own prompt, such as Oh My Posh, and blocks still work.

## When blocks do not appear

The notice "shell integration is disabled" appears when integration is not working. Check that the profile is not cmd or a WSL launcher, that `shell.integration` is `true`, that PSReadLine is installed for PowerShell, and that the profile does not pass `-c` or `-File`.
