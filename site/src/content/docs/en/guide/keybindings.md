---
title: Key bindings
description: Default keys, how to write them, when conditions, and how to change them.
sidebar:
  order: 4
---

Change keys in the Key bindings tab of the settings screen, or edit `config.toml`.

## Syntax

- Single key: `ctrl+shift+t`, `alt+arrowleft`, `f1`
- macOS: `cmd+k`
- Chord (two steps, separated by a space): `ctrl+k ctrl+s`
- `mod` means `ctrl` on Windows and Linux, and `cmd` on macOS.

## Config

```toml
[keybindings.bindings]
"tab.new" = "ctrl+shift+t"
"pane.split.vertical" = ["ctrl+shift+d", "ctrl+alt+d"]
"guide.help_mode" = []          # an empty list removes the binding

[[keybindings.custom]]
key = "ctrl+enter"
command = "workflow.run"
args = { name = "deploy" }
when = "terminalFocus && !altScreen"
```

## When conditions

Common names: `terminalFocus`, `altScreen`, `inputEmpty`, `paletteOpen`, `panelFocus`, `hasSelection`, and `guideLevel >= 2`. You can use `!`, `&&`, `||`, parentheses, and comparisons. Unknown names are false.

## Conflicts

Keys used by full-screen programs such as vim go to the program inside the alternate screen. Bindings that start with `Ctrl+Shift` or `Cmd` always stay with otterm. Set `keybindings.alt_screen_passthrough = false` to give otterm priority at all times.

Mod suggestions are disabled when they conflict with your own binding.
