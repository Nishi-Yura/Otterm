---
title: Mod author guide
description: Mod kinds, structure, and the development workflow.
sidebar:
  order: 1
---

Built-in features such as completion, the danger guard, and the file tree are written as bundled mods using the same public API. Anything a mod can do through the API is available to everyone.

> v1.0 is not released yet. The [API reference](/en/api/) is the source of truth for types.

## Mod kinds

| Kind | What it contains | Code needed |
| --- | --- | --- |
| `theme` | Colors, fonts, CSS overrides | No |
| `layout` | Layout presets | No |
| `dictionary` | Explanations, completions, danger rules, error hints | No (JSON) |
| `workflows` | Saved commands | No (TOML) |
| `outfit` | Kotsume outfits | No (TOML and images) |
| `extension` | UI, events, integrations | Yes (TypeScript) |
| `pack` | Several mods with recommended settings | No |

## Workflow

1. Run `npm create otterm-mod@latest my-mod`.
2. Declare the mod and its permissions in `otmod.toml`.
3. Implement `activate(ctx)` in `src/main.ts`.
4. Run `pnpm dev` while you work.
5. Check with `otterm mod doctor <id>`.
6. Package and publish with `otterm mod publish`.

Next, read [Manifest](/en/mods/manifest/) and [Permissions](/en/mods/permissions/).
