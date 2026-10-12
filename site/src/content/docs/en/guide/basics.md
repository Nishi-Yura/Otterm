---
title: Basics
description: Tabs, panes, blocks, search, and copy and paste.
sidebar:
  order: 2
---

The keys below are the Windows and Linux defaults. On macOS, use `Cmd` instead of `Ctrl+Shift`. See [Key bindings](/en/guide/keybindings/) for the full list.

## Tabs

| Action | Key |
| --- | --- |
| New tab | `Ctrl+Shift+T` |
| New tab with a profile | `Ctrl+Shift+N` |
| Close tab | `Ctrl+Shift+W` |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Go to tab 1 to 9 | `Ctrl+1` to `Ctrl+9` |

## Shells keep running until you close them

Shells run in a process of their own, apart from the otterm window. If the window crashes, or otterm restarts for an update or a setting, the shells keep running with their scrollback, and the next window opens the same tabs again.

Closing the window normally ends the shells. To keep them even then, set `general.keep_sessions = "always"`. `"never"` runs them inside the window as before (takes effect after a restart).

## Panes

| Action | Key |
| --- | --- |
| Split vertically | `Ctrl+Shift+D` |
| Split horizontally | `Ctrl+Shift+E` |
| Move between panes | `Alt+Arrow` |
| Resize | `Alt+Shift+Arrow`, or drag |
| Zoom (maximize) | `Ctrl+Shift+Z` |

## Blocks

Each command, its output, and its exit code form a block. A thin gutter on the left shows success (plain), failure (red), or a running command (blue). Use `Ctrl+Up` and `Ctrl+Down` to jump between blocks, and `Ctrl+Shift+[` to collapse the last output. Right-click a block to rerun it or copy its command or output.

Blocks need [shell integration](/en/guide/shell-integration/).

## Search

`Ctrl+Shift+F` opens search. You can use plain text or regular expressions, and filter by failed blocks or by one command.

## Copy and paste

| Action | Windows | Linux | macOS |
| --- | --- | --- | --- |
| Copy | `Ctrl+C` (when text is selected) | `Ctrl+Shift+C` | `Cmd+C` |
| Paste | `Ctrl+V` | `Ctrl+Shift+V` | `Cmd+V` |

## Command palette

`Ctrl+Shift+P` opens the palette. Type to search commands; use `:` for line numbers, `?` for the dictionary, `@` for files, `#` for blocks, and `!` to put what follows into the shell's input line (it is not run; you press Enter).
