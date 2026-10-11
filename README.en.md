# otterm

**A terminal anyone can use, and anyone can shape.**

otterm is a new terminal emulator built without the assumption that you already know the commands. For someone opening a terminal for the first time, it is a friendly app rather than a black screen. For someone who lives in a terminal all day, it is a fast, light tool that can be modified without limit.

The name is otter + term. Otters pry shells open with their nimble paws; otterm cracks the shell open for you. A river otter named **Pebble** (コツメ in Japanese; both names provisional) lives in the UI as your guide.

## What makes it different

- **Guide levels 0–3.** At level 0 it is a plain, fast terminal. At level 3 it explains every command before you run it, stops dangerous ones, and turns file-tree clicks into lessons. The same product serves both ends.
- **Mods, like a game.** Install one mod and something changes: a theme, a status bar item, a panel, a workflow, a new outfit for Pebble. Mods declare permissions, run sandboxed, and cannot crash the terminal. The built-in features are mods too, using the same API.
- **Shell integration and blocks.** Each command becomes a block you can fold, re-run, copy, or share, while the display stays a normal continuous terminal.
- **Pebble lives in the UI.** The mascot reacts to what you do: calm, thinking, alert, happy. It suggests, but never presses Enter for you. You can hide it completely.
- **AI you can trust.** Optional, off by default. Bring your own key or run a local model. Everything sent is previewed and redacted. The AI proposes commands; you run them.
- **No telemetry, no server, no account.**

## Status

Milestone M1 (a working terminal) is under way. On Windows it is usable day to day: tabs and splits, scrollback and search, selection and copy, links (URLs and file paths), dropping files to type their paths, Japanese input (IME), config file and themes, mouse reporting, the Kitty keyboard protocol. Rendering is Canvas 2D for now (WebGL not started). macOS and Linux build and pass the automated tests in CI but have not been checked by hand. Progress: [docs/07-roadmap.md](docs/07-roadmap.md). Run `just setup`, then `just dev` to start the app or `just check` (needs Rust stable, Node.js 22+, pnpm and [just](https://github.com/casey/just)).

The Japanese specification in [`docs/`](docs/) is the source of truth; English translations will follow (overview first, the rest by milestone M3).

| Document | Contents |
| --- | --- |
| [docs/00-overview.md](docs/00-overview.md) | Concept, audience, principles, positioning against other terminals |
| [docs/01-requirements.md](docs/01-requirements.md) | Functional and non-functional requirements |
| [docs/02-architecture.md](docs/02-architecture.md) | Tauri 2 + Rust core + TypeScript UI; process model |
| [docs/03-core-features.md](docs/03-core-features.md) | PTY, rendering, blocks, assist features, file tree, onboarding |
| [docs/04-ui-theme.md](docs/04-ui-theme.md) | Layout slots, themes, fonts |
| [docs/05-mod-system.md](docs/05-mod-system.md) | Mod kinds, manifest, API, permissions, registry |
| [docs/06-config-keybind.md](docs/06-config-keybind.md) | `config.toml`, CLI, keybindings |
| [docs/07-roadmap.md](docs/07-roadmap.md) | Milestones M0–M6 and v1.x |
| [docs/08-character.md](docs/08-character.md) | Pebble: design, moods, lines, outfit mods |
| [docs/09-performance.md](docs/09-performance.md) | Latency budget, renderer backends, benchmarks |
| [docs/10-ai-assist.md](docs/10-ai-assist.md) | Three-tier AI assist, privacy, step mode |
| [docs/11-decisions.md](docs/11-decisions.md) | Decision log (108 decisions) |
| [packages/api/](packages/api/) | `@otterm/api` type definitions (source of truth for the mod API), dictionary JSON Schema |
| [mods/dictionary-core/](mods/dictionary-core/) | Built-in command dictionary (164 commands) and danger rules |
| [crates/otterm-config/](crates/otterm-config/) | Config model in Rust |

## License

- Code: Apache-2.0 (see [LICENSE](LICENSE)). The mod SDK `@otterm/api` will be MIT.
- Pebble artwork and name: [Character Guidelines](assets/mascot/LICENSE.md).

## Contributing

Code, comments, commit messages and issues are in English. Specs are written in Japanese first. Conventional Commits, `rustfmt` + `clippy`, Biome. More in `CONTRIBUTING.md` once M0 begins.
