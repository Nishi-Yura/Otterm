---
title: Creating a mod
description: Scaffolding an extension or theme mod with create-otterm-mod.
sidebar:
  order: 5
---

```sh
npm create otterm-mod@latest my-mod
```

The generator asks for the kind (`extension` or `theme`) and the mod ID, or accepts them as options:

```sh
create-otterm-mod my-mod --kind extension --id example.my-mod --yes
```

Before v1.0 the package is not published. Run it from `packages/create-mod` in the repository.

An `extension` gets TypeScript, esbuild, and two scripts. `pnpm dev` rebuilds on every change and links the mod into otterm once. Enable the mod with `otterm mod enable <id>`, approve its permissions, and it starts. `otterm mod doctor <id>` checks the manifest.
