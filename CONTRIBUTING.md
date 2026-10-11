# Contributing to otterm

Thank you for helping. otterm is a terminal for beginners and for people who live in a terminal; every
change should keep both of them in mind.

## Ground rules

- **Code, comments, commit messages and issues are in English.** The specification in [`docs/`](docs/) is
  written in Japanese and is the source of truth; English pull requests that touch behavior should
  point to the section they follow.
- **No telemetry, no server, no account.** otterm connects to the network only to check for updates
  (when the user allowed it), to read the mod registry (after the user agreed once) and to reach the
  AI provider the user configured. Anything else needs a decision in [docs/11-decisions.md](docs/11-decisions.md).
- **Never run a command for the user.** Suggestions go into the input line; the user presses Enter.
- **Keystrokes never wait for a mod.** Input goes straight to Rust; only `before-execute` waits, with a
  deadline ([docs/09-performance.md](docs/09-performance.md)).
- **Nothing costs money.** CI workflows are manual (`workflow_dispatch`); run the checks locally.

## Setting up

You need Rust (stable), Node.js 22+, pnpm and [just](https://github.com/casey/just). On Linux, also the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and `libdbus-1-dev`.

```bash
just setup     # JS dependencies and, on Windows, the bundled ConPTY
just dev       # run the app with hot reload
just check     # what CI runs: format, clippy, Biome, type checks, dictionary and locale checks
```

## Where things are

| Path | What |
| --- | --- |
| `crates/otterm-vt` | VT parser, grid, scrollback (compressed chunks), search, reflow |
| `crates/otterm-pty`, `crates/otterm-session` | PTY (bundled ConPTY on Windows) and sessions |
| `crates/otterm-app` | the Tauri app: config, mods, registry, updater, AI bridge, crash logs |
| `crates/otterm-config` | config structs (the settings screen is generated from them), themes, workspaces |
| `crates/otterm-modhost` | mod manifests, permissions, `.otmod` packages |
| `packages/ui` | the window (SolidJS, WebGL2 / Canvas 2D renderers), Kotsume, settings |
| `packages/api` | `@otterm/api`, the mod API types (MIT) |
| `mods/` | bundled mods — the built-in features use the same API as everyone else |
| `community-mods/` | mods published to the registry by the maintainers |
| `registry/` | the mod registry: index, entries, packages |
| `site/` | the documentation site (Starlight) |

## Tests

The repository has no automated test suites by design ([decision L2](docs/11-decisions.md)). Verify a
change by running the app, and describe what you checked in the pull request (screenshots help: the
UI, light and dark themes). Benchmarks live in `tests/bench` (`just bench`), the AI evaluation set in
`tests/ai-eval`.

## Mods

Want to add a feature? It may be a mod rather than a change to the core. See the mod author guide in
`site/` (or [docs/05-mod-system.md](docs/05-mod-system.md)) and the template in `packages/create-mod`. Publishing to
the registry: [registry/README.md](registry/README.md).

## Kotsume / Pebble

The mascot's art comes from `scripts/mascot.py`; change the grids there and rerun it. The character
has its own short guideline ([assets/mascot/LICENSE.md](assets/mascot/LICENSE.md)).

## License

By contributing you agree that your contribution is licensed under Apache-2.0 (the mod API package
`@otterm/api` under MIT).
