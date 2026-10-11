---
title: Themes and appearance
description: Choosing themes, writing theme files, fonts, layouts, and CSS overrides.
sidebar:
  order: 7
---

Built-in themes include otterm Dark (default), otterm Light, High Contrast, and several popular palettes. With `appearance.follow_system = true`, otterm switches between `theme` and `theme_light` with the OS setting.

`otterm theme import <file>` converts palettes from iTerm2, Windows Terminal, VS Code, Alacritty, and WezTerm.

## Layouts

`minimal` shows only the terminal. `classic` adds tabs and a status bar. `guided` (default) adds the file tree and the input assist bar. `ide` adds a right and bottom panel.

## Theme files

```toml
[theme]
name = "my-theme"
appearance = "dark"

[theme.terminal]
foreground = "#d4d4d4"
background = "#1e1e1e"

[theme.ui]
bg = "#181818"
fg = "#e6e6e6"
accent = "#4f8cff"
```

Each UI key is exposed as a CSS variable named `--ot-<key>`, so mods follow the theme automatically.

## Opacity and fonts

The window is opaque by default. Transparency and background images are set by the theme. Fonts are tried in the order you list them; include a Japanese monospace font in the list.

```toml
[font]
family = ["Cascadia Code", "Noto Sans Mono CJK JP"]
size = 14
```

## CSS overrides

Theme CSS can target stable `data-ot` attributes, such as `[data-ot="tab"]`. If CSS breaks the screen, start with `otterm --safe-mode`.
