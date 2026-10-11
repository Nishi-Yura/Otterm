---
title: Command line
description: otterm command-line options and subcommands.
sidebar:
  order: 11
---

```sh
otterm [path]              # start with path as the working folder
otterm -e <command...>     # start with a tab that runs the command
otterm --profile <id>      # start with a profile
otterm --safe-mode         # start with themes and mods disabled
otterm --config <file>     # use another config file
otterm --new-window        # start a separate window
```

If otterm is already running, these open a new tab in that window. Subcommands include `otterm mod install|remove|list|enable|disable|update|publish|doctor|link`, `otterm theme import`, `otterm config get|set|path|reset|export|import`, `otterm workflow run <name>`, `otterm trash <path...>`, and `otterm ask [question]`.

On Windows, `otterm.com` sits next to `otterm.exe` so that `otterm` works in PowerShell and cmd. It forwards output to the console and returns the exit code.
