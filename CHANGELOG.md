# Changelog

All notable changes to otterm. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Registry: 13 more community mods (24 in the store). Themes Yuki, Yuyake and Shinkai; the outfit "Pebble in winter"; dictionaries for network tools, database clients, modern CLI tools and media tools (31 commands, 7 danger rules); the extensions exit-status, command-stats, project-scripts, bookmarks and daily-tip.
- Repository: `SECURITY.md`, issue and pull request templates, this changelog.

## [1.0.0] - 2026-10-12

First release, Windows x64. Highlights:

- Terminal: VT parser and grid in Rust, WebGL2 renderer with a Canvas 2D fallback, tabs, splits, search, compressed scrollback, IME, Kitty keyboard protocol.
- Shell integration (OSC 133) for pwsh, bash, zsh and fish: blocks, re-run, copy output, prompt bar.
- Input assist: a dictionary of 164 commands with explanations while typing, danger guard with alternatives, completion, error hints.
- Kotsume / Pebble, the river otter mascot: moods, lines, outfits.
- Mod system: `otmod.toml` manifests, declared permissions, QuickJS sandbox, `@otterm/api` (MIT), `.otmod` packages, a signed registry and the store screen, 11 community mods.
- AI assist (off by default): local models through Ollama or your own key for Claude, OpenAI, Gemini or compatible APIs; send preview and secret masking.
- Settings screen generated from `config.toml`, keybindings with chords and `when` clauses, 15 bundled themes, workspaces.
- Signed auto-update, local crash logs with "create an issue", no telemetry.

[Unreleased]: https://github.com/Nishi-Yura/Otterm/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Nishi-Yura/Otterm/releases/tag/v1.0.0
