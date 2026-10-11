---
title: Using the API
description: The entry points, the main namespaces, and a short example.
sidebar:
  order: 4
---

```ts
import type { ModContext } from "@otterm/api";

export function activate(ctx: ModContext) {
  ctx.commands.register(
    "git-status-bar.refresh",
    async () => {
      ctx.log.info("Branch info refreshed");
    },
    { title: { ja: "ブランチ情報を更新", en: "Refresh branch info" } },
  );
}

export function deactivate() {}
```

- Every API call is asynchronous.
- Anything you register returns a `Disposable`. otterm disposes everything when the mod is deactivated.
- Capabilities that are not declared are absent from `ctx`, so use optional access such as `ctx.fs?.`.

Main namespaces: `ctx.ui` (slots, panels, toasts, dialogs), `ctx.commands`, `ctx.keybindings`, `ctx.terminal`, `ctx.session`, `ctx.assist`, `ctx.settings`, `ctx.storage`, `ctx.theme`, `ctx.i18n`, and `ctx.mascot`. See the [API reference](/en/api/) for every type.

UI can be declared as a tree of components, which follows the theme automatically, or written as a sandboxed iframe with HTML and CSS. Scripts do not run in the iframe.
