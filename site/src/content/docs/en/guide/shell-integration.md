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

To use integration in shells started outside otterm, set `shell.integration_install = "rc"`. This adds one line to your startup file and can be undone.

## Prompt

`shell.prompt = "otterm"` (default) draws the prompt bar in otterm. `"shell"` keeps your own prompt, such as Oh My Posh, and blocks still work.

## When blocks do not appear

The notice "shell integration is disabled" appears when integration is not working. Check that the profile is not cmd or a WSL launcher, that `shell.integration` is `true`, that PSReadLine is installed for PowerShell, and that the profile does not pass `-c` or `-File`.
