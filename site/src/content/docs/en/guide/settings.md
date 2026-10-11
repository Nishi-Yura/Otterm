---
title: Settings
description: Where config.toml lives, the CLI, and workspace settings with trust.
sidebar:
  order: 3
---

You can change settings in the settings screen (`Ctrl+,`). Changes are written back to `config.toml`, and editing the file by hand also updates the screen.

## Location

| OS | User settings | Data (mods, state, logs) |
| --- | --- | --- |
| Windows | `%APPDATA%\otterm\config.toml` | `%LOCALAPPDATA%\otterm\` |
| macOS | `~/Library/Application Support/otterm/config.toml` | Same |
| Linux | `$XDG_CONFIG_HOME/otterm/config.toml` | `$XDG_DATA_HOME/otterm/` |
| Portable | `<executable folder>/portable/config.toml` | `<executable folder>/portable/` |

## Precedence

Defaults, then user settings, then workspace settings (`.otterm/workspace.toml`), then command-line arguments. Later sources win.

## CLI

```sh
otterm config get font.size
otterm config set font.size 16
otterm config path
otterm config reset
otterm config export
otterm config import <file>
```

`reset` keeps a backup as `config.toml.bak-reset-<time>`. `import` keeps the current file as `config.toml.bak-import-<time>`.

## Workspace settings

Put `.otterm/workspace.toml` in a project folder to share its tabs and settings with a team.

When you open a workspace for the first time, otterm asks whether to trust it. Before you trust it, only the theme override applies, and tab commands do not run. After you trust it, some keys (such as `shell`, `profiles`, and `keybindings.custom`) still cannot be changed from the workspace, because they can start programs or send data. Trust can be revoked in the settings screen.

Mods with `terminal.write` cannot be enabled from a workspace.

## Privacy

otterm does not send usage data. It contacts the network only for the update check you allowed, and when you open the mod store.
