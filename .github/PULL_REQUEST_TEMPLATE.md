<!-- Thanks. Pull requests are in English; see CONTRIBUTING.md. -->

## What

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The problem this solves, and the section of docs/ it follows when behavior changes. -->

## How I checked it

<!-- There are no automated tests (decision L2). Say what you ran and what you saw: the app on which OS, which shell, light and dark themes; screenshots for UI changes; `just check` for the lint and type checks. -->

- [ ] `just check` passes
- [ ] Tried in the app (OS / shell):
- [ ] No new network access, telemetry or background process (or a decision is recorded in docs/11-decisions.md)
- [ ] Keystrokes still do not wait for a mod (input path unchanged)

## Registry submissions only

- [ ] `registry/mods/<id>.json` validates (`node registry/scripts/validate.mjs`)
- [ ] The id's namespace is my GitHub user name
- [ ] `reviewed` and `hidden` are left `false`
