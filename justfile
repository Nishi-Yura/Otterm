# Cross-language tasks. Rust uses Cargo, TypeScript uses pnpm + Turborepo (decision L4).

set windows-shell := ["pwsh", "-NoLogo", "-NoProfile", "-Command"]

# otterm has no telemetry; keep build tools quiet too.
export TURBO_TELEMETRY_DISABLED := "1"

default:
    @just --list

# Install JS dependencies and, on Windows, the bundled ConPTY (decision M3).
setup:
    pnpm install --frozen-lockfile
    node scripts/fetch-conpty.js

# Everything CI runs. The UI is built first because the app embeds packages/ui/dist at compile time.
check: fmt-check build-ui lint typecheck test validate

# Run the app with hot reload.
dev:
    pnpm tauri dev

build-ui:
    pnpm --filter @otterm/ui build

fmt:
    cargo fmt --all
    pnpm format

fmt-check:
    cargo fmt --all --check

lint:
    cargo clippy --workspace --all-targets -- -D warnings
    pnpm lint

typecheck:
    pnpm typecheck

test:
    cargo test --workspace
    pnpm test

# Run benchmarks (tests/bench/README.md). Example: just bench --suite pty --quick
bench *ARGS:
    node tests/bench/run.js {{ARGS}}

# Validate the command dictionary against its schema and the UI translations against each other.
validate:
    node tests/dictionary/validate-dictionary.js
    node tests/i18n/check-locales.mjs
