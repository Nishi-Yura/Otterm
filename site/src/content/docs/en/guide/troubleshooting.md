---
title: Troubleshooting
description: Safe mode, crash logs, and common problems.
sidebar:
  order: 10
---

## Safe mode

If a theme or mod breaks the screen, start otterm in safe mode. The bundled default theme is used, and theme CSS and mods are disabled.

```sh
otterm --safe-mode
```

From inside otterm, use "Restart in safe mode" in the command palette or in settings under Advanced.

## Crash logs

After a crash, logs are saved to `%LOCALAPPDATA%\otterm\logs\crash-*.log` on Windows. On the next launch, otterm offers an "Create issue" button and a button to copy the log. Logs are never sent automatically. Check the log for personal or secret data before you post it.

## Mods

A mod that throws errors or stops responding for 5 seconds is deactivated, and the status bar shows a notice. Three consecutive crashes disable the mod automatically.

## Common problems

- **No block gutter, "shell integration is disabled"**: see [Shell integration](/en/guide/shell-integration/).
- **Japanese text shows as boxes**: add a Japanese font to `font.family`.
- **Characters misaligned**: try `terminal.ambiguous_width = "wide"`.
- **Workspace commands do not run**: the workspace may not be trusted yet. See [Settings](/en/guide/settings/).

To reset all settings, run `otterm config reset`.
