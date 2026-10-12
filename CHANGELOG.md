# Changelog

All notable changes to otterm. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-10-13

Re-released on 2026-10-13 over the first 1.2.0 build of 2026-10-12, with the changes from a review by a terminal-first developer. The installer and its checksum differ from the first build.

### Added

- **Shells outlive the window.** Shells now run in a session daemon (`otterm --daemon`), a process of their own. If the window crashes, or otterm restarts for an update or a setting, the shells keep running with their scrollback and the next window opens them again as tabs. Closing the window normally still ends them; `general.keep_sessions = "always"` keeps them then too, and `"never"` runs them inside the window as before. On Windows the daemon runs from a copy in the data folder, so the update installer does not stop it. No tmux needed (decision M26).
- `general.restore_session` (off by default) reopens the last tabs in their folders with new shells.
- `docs/13-positioning.md`: how otterm compares with Windows Terminal, WezTerm, Ghostty, Alacritty and others, and where it means to be different.

### Changed

- **The shell reads its own startup files.** `shell.user_startup_files` is on by default: the PowerShell profile, `~/.bashrc`, `~/.zshrc` and `config.fish` apply, so aliases, PATH and prompt themes are the same as in any other terminal. `false` starts the shell as installed, as 1.0 and 1.1 did.
- **Ctrl+V reaches programs on the alternate screen** (vim's visual block, readline's quoted-insert); `Ctrl+Shift+V`, `Shift+Insert` and the context menu paste there. `Ctrl+Shift+V` is a paste key on Windows now. Unbinding `paste` frees `Ctrl+V` on the normal screen too (the WebView's paste no longer takes it first). `Ctrl+Up` / `Ctrl+Down` go to the shell until the pane has seen a block.
- **`otterm --help` and `otterm --version`** print and exit. An unknown option or a path that does not exist is an error (exit code 2) instead of a window with a notice.
- **otterm never starts a program you did not type unless you let it.** The background `--help` read for unknown commands (decision B9) now runs only while the explanation mod is on, and `assist.learn_help = false` turns it off. Before, with no mods on, every successful command was "unknown" and got its `--help` run once.
- **New tabs and splits keep the profile** of the pane in front (a WSL or cmd tab split into a WSL or cmd pane), not only its folder. `Ctrl+Shift+N` picks another.
- **cmd gets a prompt with marks**: the folder (OSC 7) and the start of the prompt (OSC 133 A/B), so new tabs open in the same folder and `Ctrl+Up` / `Ctrl+Down` jump between prompts. **WSL** tabs get `OTTERM`, `OTTERM_HOOKS` and friends through `WSLENV`; one line in the shell's rc file inside the distribution loads the hooks (see the shell integration guide). Git Bash is also found in `Program Files (x86)`, the per-user installer's folder and scoop; MSYS2 at `C:\msys64` is a detected profile.
- **The danger guard sees every way a command runs**: a block's "run again", a paste with line breaks (each line), the multi-line editor, a workflow's Run and any mod's `terminal.write` that ends a line go through the same check as a typed Enter.
- **The AI request is shown in full every time** before it is sent (`ai.preview_first_n = 0`); a number keeps the old "first N times, then a link".
- `appearance.minimum_contrast` defaults to 1 (off): colors from programs such as `bat` and `delta` are drawn as they asked. Set 3 to get the old nudging.
- Searching a long scrollback takes the terminal lock in pieces of 2,048 lines, so output and frames keep moving while a regex runs.
- The README and `docs/bench` list memory while idle (about 460 to 480 MB for one tab, most of it WebView2), which otterm does not win.
- Docs: what is not implemented is now said so (moving tabs between windows, detaching panes, broadcast input, `otterm open`, search filters by block, sigstore signing, the per-mod "recent actions" view, e-mail and IP masking in AI requests), and the palette's `!` says it puts the text in the input line rather than running it.
- Tab titles skip `&`, `.`, `source` and `sudo` when naming the running command.
- VT parsing is a little over twice as fast on scrolling output (about 30 to 70-80 MiB/s): scrollback chunks are compressed and spilled on a background thread, runs of printable ASCII are written at once, and full-screen scrolls rotate rows instead of moving them. Compared byte for byte with the old implementation over random input, the screen, scrollback, search and copied text are the same.
- Glyph lookups for single-code-point cells no longer build a string key per cell.
- The IME composes where a program draws its own cursor: TUIs built on Ink (Claude Code and others) hide the real cursor and paint one reverse-video cell, and the candidate window used to open at the hidden cursor instead.
- AI answers are labelled "The AI's answer", not as Pebble speaking, and every suggested command says it is an AI suggestion to read before running. Pebble no longer acts out "thinking" while a model answers, and clicking Pebble always opens the command palette.
- Copy across the app, the site, the READMEs and the release notes was rewritten to be plain and specific: no emoji headings, no slogans, one word per idea (ガイドレベル, mod, エディタ).
- The default (fallback) colors are the project's own warm palette instead of One Dark, with tighter shadows.
- Store descriptions of the dictionary mods name the commands they cover and what they stop before.
- Mods have a screen of their own, over the whole window like the settings: installed mods and the store on the left, the chosen mod on the right with its description, what it may use, its settings and an on/off button. It replaces the mods list in the right sidebar and the mods page in Settings (which now opens it). The status bar's "mod" and the palette open it.
- The intro and the "recommended set" button show only while no mod is on, and not again once closed.
- The "type ls to try it" hint is gone from the window; the tutorial (the onboarding mod) covers it. A tutorial left halfway no longer opens itself at every start; starting it again carries on where it stopped.
- Mod switches say "オンにする / オフにする" (Turn on / Turn off).

### Fixed

- History redaction treated every bare `-p` as a password flag, so `mkdir -p x` and `ssh -p 22 host` were stored and inserted as `-p [REDACTED]`.

### Removed

- The unused `terminal.images` setting is no longer shown in Settings (images are not drawn yet).

## [1.1.0] - 2026-10-12

### Changed

- **otterm starts with no mods.** Every mod, the bundled ones included, is now off until you turn it on, so a fresh otterm behaves like any other terminal: no mascot, no side panel, the shell's own prompt, and `Ctrl+R`, `Ctrl+Space` and `Shift+Enter` reach the shell. Pick what you want in Settings › Mods, or press "Turn on the recommended set" (Pebble, the dictionary, explanations, completion, the danger guard, error hints, history search, the file tree).
- Built-in features that could be taken apart are now mods of a new kind, `feature`, which only switch on something that lives in otterm: `otterm.mascot` (Pebble), `otterm.history-search` (the `Ctrl+R` picker), `otterm.multiline-editor` (`Shift+Enter`) and `otterm.prompt-bar` (the prompt otterm draws). The completion popup's `Ctrl+Space` now needs `otterm.completion`.
- Turning a mod on also turns on its `[dependencies]` (the input assist mods bring the command dictionary), and turning on the AI mod sets `[ai] enabled`. The bundled outfit counts only while it is on.
- Upgrading from 1.0 keeps your setup: on the first start, the mods 1.0 had on by default are written into `[mods] enabled`, except the ones you had turned off.

### Added

- Registry: 13 more community mods (24 in the store). Themes Yuki, Yuyake and Shinkai; the outfit "Pebble in winter"; dictionaries for network tools, database clients, modern CLI tools and media tools (31 commands, 7 danger rules); the extensions exit-status, command-stats, project-scripts, bookmarks and daily-tip.
- Repository: `SECURITY.md`, issue and pull request templates, this changelog.

### Fixed

- Mod API: `ctx.terminal.insert(text, { replaceLine: true })` now clears the input line before pasting (it appended on every shell). Mod list items keep their name visible next to a long secondary text, which now ellipsizes.
- Terminal: resizing while vim or less is open keeps the shell's screen and scrollback (they were cut to the new width, and lines were lost when the height shrank) ([#9]). A character printed after a resize no longer overwrites the last one of a full line ([#12]). Combining marks are capped per cell, so a flood of them can no longer corrupt frames or crash the app when that scrollback is read ([#10]). Search skips scrollback lines it cannot read instead of hanging the tab ([#11]). `CSI 6n` in origin mode with the cursor above the scroll region answers row 1 instead of a huge number ([#13]). The start of a prompt (OSC 133;A) clears the Kitty keyboard flags a crashed program left on, so Ctrl+C works again in any shell with integration ([#6]).
- Settings: `appearance.tabbar.title_idle` / `title_running` now set the automatic tab titles, and `terminal.trim_trailing_whitespace = false` keeps line-end blanks when copying. Settings that nothing reads yet (`general.restore_session`, `terminal.cursor.smooth`, `shell.integration_install`, `assist.file_tree_cd`, `open.preview_*_limit_mb`, `mods.auto_update`, `ai.include_recent_commands`) are no longer shown in the settings screen ([#18]).
- Mod API: `session-created` passes a `SessionInfo` (string id, `shellKind`) like every other event ([#14]). Keys suggested by mods no longer take plain chords from vim, nano or less when alternate-screen passthrough is on ([#15]). Disposing a `keybindings.suggest()` result withdraws the key, and a mod that wakes from suspension no longer adds its keys twice ([#16]). A completion provider that returns something other than items no longer stops all completion ([#17]). Mascot reactions translate `say: "i18n:<id>"` ([#20]).
- Mod template: the command listed in `[[adds]]` uses the full id it is registered under ([#24]). The README example manifest has the required `author` and `[compat] otterm` ([#19]).
- Registry: project-scripts 1.0.1 drops the `block-end` event it could never receive without `terminal.read`; it rereads on folder and tab changes and with its reload command ([#22]).
- Tooling: `scripts/release.mjs` and `scripts/publish-community-mods.mjs` work from a checkout whose path has spaces or non-ASCII characters ([#21]). The dictionary validator checks every mod's dictionary, community ones included ([#23]).

### Security

- Mod file access: a path inside the mod's data folder that leads out of it with `..` is no longer allowed.
- Mod processes: `env` may not set `PATH`, `PATHEXT`, `LD_*` or `DYLD_*`, which could swap the program a listed name starts.
- `ctx.terminal.insert` turns line breaks into spaces and drops control characters, so it can never run a command. Bracketed paste drops every ESC, so pasted text cannot end the bracket early.
- `input-changed`, `before-execute` and `ctx.terminal.selection` need `terminal.read` in the host too, not only in the SDK; the SDK's glue object is no longer reachable from a mod's code.
- `.otmod` packages may not use the `otterm.` namespace, a mod counts as official only when it ships with otterm, and a registry package must hold the mod its index entry names.

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

[Unreleased]: https://github.com/Nishi-Yura/Otterm/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/Nishi-Yura/Otterm/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Nishi-Yura/Otterm/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Nishi-Yura/Otterm/releases/tag/v1.0.0
[#6]: https://github.com/Nishi-Yura/Otterm/issues/6
[#9]: https://github.com/Nishi-Yura/Otterm/issues/9
[#10]: https://github.com/Nishi-Yura/Otterm/issues/10
[#11]: https://github.com/Nishi-Yura/Otterm/issues/11
[#12]: https://github.com/Nishi-Yura/Otterm/issues/12
[#13]: https://github.com/Nishi-Yura/Otterm/issues/13
[#14]: https://github.com/Nishi-Yura/Otterm/issues/14
[#15]: https://github.com/Nishi-Yura/Otterm/issues/15
[#16]: https://github.com/Nishi-Yura/Otterm/issues/16
[#17]: https://github.com/Nishi-Yura/Otterm/issues/17
[#18]: https://github.com/Nishi-Yura/Otterm/issues/18
[#19]: https://github.com/Nishi-Yura/Otterm/issues/19
[#20]: https://github.com/Nishi-Yura/Otterm/issues/20
[#21]: https://github.com/Nishi-Yura/Otterm/issues/21
[#22]: https://github.com/Nishi-Yura/Otterm/issues/22
[#23]: https://github.com/Nishi-Yura/Otterm/issues/23
[#24]: https://github.com/Nishi-Yura/Otterm/issues/24
