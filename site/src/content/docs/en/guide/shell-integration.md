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

By default otterm starts the shell **as installed**: it does not read the PowerShell profile, `~/.bashrc`, `~/.zshrc`, `config.fish` or cmd's AutoRun. Customizations made for other terminals (prompt themes, completion add-ons) stay out of otterm; conveniences come from otterm's settings and mods instead.

To load your usual startup files, set `shell.user_startup_files = true` (applies to new tabs). otterm's own shell integration loads either way.

## Prompt

`shell.prompt = "otterm"` (default) draws the prompt bar in otterm. `"shell"` keeps your own prompt, such as Oh My Posh, and blocks still work.

## When blocks do not appear

The notice "shell integration is disabled" appears when integration is not working. Check that the profile is not cmd or a WSL launcher, that `shell.integration` is `true`, that PSReadLine is installed for PowerShell, and that the profile does not pass `-c` or `-File`.
