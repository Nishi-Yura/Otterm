# Cross-language tasks. Rust uses Cargo, TypeScript uses pnpm + Turborepo (decision L4).

set windows-shell := ["pwsh", "-NoLogo", "-NoProfile", "-Command"]

# otterm has no telemetry; keep build tools quiet too.
export TURBO_TELEMETRY_DISABLED := "1"

default:
    @just --list

# Install JS dependencies.
setup:
    pnpm install --frozen-lockfile

# Everything CI runs.
check: fmt-check lint typecheck test validate

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

# Validate the command dictionary against its schema.
validate:
    node tests/dictionary/validate-dictionary.js
