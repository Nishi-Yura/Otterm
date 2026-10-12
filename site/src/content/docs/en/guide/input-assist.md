---
title: Input assist and guide levels
description: Command explanations, completion, danger guard, error hints, and what each guide level shows.
sidebar:
  order: 6
---

otterm reads the command line you type and explains it, completes it, and asks before risky actions. Typing itself is still done by your shell, so Tab completion, `Ctrl+R`, and shell plugins keep working.

> Each feature on this page is a mod (`otterm.cmd-explain`, `otterm.completion`, `otterm.danger-guard`, `otterm.error-hint`, `otterm.history-search`, `otterm.multiline-editor`, and the `otterm.dictionary-core` dictionary). Turn them on in the mods screen (click "mod" in the status bar). While they are off, `Ctrl+R`, `Ctrl+Space` and `Shift+Enter` go to the shell.

## Guide levels

| Level | Name | Behavior |
| --- | --- | --- |
| 0 | Off | Almost no extra UI. Only the most dangerous actions stop. |
| 1 | Light | Explains and confirms risky commands. Shows error hints. |
| 2 | Standard (default) | Explains each command as you type. Opens the file tree. |
| 3 | Full | Adds `?` hints to UI parts and tips about GUI actions. |

Each level is a preset. You can override any item.

## Explanations

As you type, otterm splits the command into its name, subcommands, options, and arguments, and explains them from a built-in dictionary. Commands not in the dictionary are never run just to read their help while you type.

## Completion

Completion candidates come from the dictionary, executables on PATH, files in the current folder, and history. Open them with `Ctrl+Space`. At level 3, Tab accepts an otterm candidate. Below level 3, Tab goes to your shell.

## Danger guard

Commands such as `rm -rf`, `git push --force`, `git reset --hard`, piping `curl` into `sh`, and recursive deletes in PowerShell ask for confirmation. The dialog offers Run, Run the safer alternative, or Cancel.

## Error hints

When a command fails, otterm matches the output and suggests a cause and a next step. The hint button places a command in the input line. It never runs it for you.

## Password prompts

While a program asks for a password without echo, otterm pauses input assist and does not record what you type.
