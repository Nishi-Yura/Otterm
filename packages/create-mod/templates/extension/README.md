# __NAME__

An otterm extension mod (`__ID__`). Written in TypeScript, bundled with esbuild into one ESM file.

## Files

- `otmod.toml`: manifest. Identity, compatibility, what the mod adds, permissions, and settings.
- `src/main.ts`: entry point. Exports `activate(ctx)` and `deactivate()`.
- `locales/en.ftl`, `locales/ja.ftl`: messages, referenced from code as `i18n:<key>`.
- `scripts/build.mjs`: bundles `src/main.ts` into `dist/main.js`.
- `scripts/link.mjs`: links this folder into otterm's mods folder.
- `tsconfig.json`: type checking only. esbuild does the bundling.

## Develop

```sh
pnpm install
pnpm dev
```

`pnpm dev` rebuilds on every change and links the mod into otterm once at start. otterm reloads a linked mod when `dist/main.js` changes.

A mod that is not official is off until you turn it on: run `otterm mod enable __ID__`, or open the mods list from the gear at the right of otterm's status bar. otterm then shows the permission list once and starts the mod.

Other scripts: `pnpm build`, `pnpm typecheck`, `pnpm link` (link only), `node scripts/link.mjs --unlink` (remove the link).

## Permissions

Declare every permission in `otmod.toml` under `[permissions]`. A permission that is not declared is not in `ctx` at runtime, so calling it fails. The user approves the list when they install the mod.

## Types

The API types come from `@otterm/api`. See `node_modules/@otterm/api/src/index.d.ts` for the full `ModContext`.

## For otterm contributors

Until `@otterm/api` is on npm, run the CLI from the repo and point it at the local package. The generated `package.json` then depends on that checkout instead of the npm version:

```sh
OTTERM_API_LOCAL=/path/to/otterm/packages/api node /path/to/otterm/packages/create-mod/index.js my-mod --yes
```

`scripts/link.mjs` honors `OTTERM_DATA_DIR`, which replaces otterm's data folder. Set it to a temporary folder to test the link without touching a real install.
