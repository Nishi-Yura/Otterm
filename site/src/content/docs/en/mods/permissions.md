---
title: Permissions
description: Declaring permissions, how users approve them, and runtime checks.
sidebar:
  order: 3
---

A mod can use only the permissions it declares in `[permissions]`. A permission that is not declared is not present in `ctx`, so calling it fails.

| Permission | Enables |
| --- | --- |
| `process` | `ctx.process.run` for listed executables |
| `fs.read` / `fs.write` | `ctx.fs` with glob patterns |
| `network` | `ctx.http.fetch` for listed hosts |
| `clipboard` | `ctx.clipboard` |
| `ai` | `ctx.ai` |
| `terminal.read` | Block and input events |
| `terminal.write` | `ctx.terminal.write`, which runs commands as the user. The most sensitive permission. |

`ctx.terminal.insert` only fills the input line and needs no permission. Prefer it.

Users approve the list at install time. Adding permissions in an update asks again. `terminal.write` and clipboard reads also ask the first time they are used. Approval can be revoked.

Paths can use `${cwd}`, `${home}`, `${workspace}`, `${mod}`, and `${data}`.

Writes to otterm's own folders, dotfiles in your home folder, system folders, and other mods' folders are always refused. Use `ctx.ui.pickPath` to let the user choose a location instead.
