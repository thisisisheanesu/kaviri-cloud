#!/usr/bin/env bash
# CI, run here, because GitHub will not run it.
#
# The account has no payment method, so billing is locked, so Actions is disabled on private
# repositories. .github/workflows/ci.yml is correct and will run the day that changes. Until
# then the checks still have to happen on every change.
#
# This runs the parts of ci.yml that need nothing but this machine: the seam guards, the
# TypeScript, and the render worker. The database half of ci.yml needs a Postgres to apply
# every migration to from scratch, and there is none here, so it is skipped and SAID to be
# skipped rather than quietly passing. That half is the one that most needs a real CI runner,
# and it is the honest cost of this workaround.
#
#   scripts/ci.sh
#
# Exit code is the verdict, so it works in the pre-push hook installed by
# scripts/install-hooks.sh.

set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# A git hook gets a short PATH, without ~/.cargo/bin or a node from a version manager.
for dir in "$HOME/.cargo/bin" "$HOME/.nvm/versions/node/v24.18.0/bin" "$HOME/.local/bin" /usr/local/bin; do
  case ":$PATH:" in
    *":$dir:"*) ;;
    *) [ -d "$dir" ] && PATH="$dir:$PATH" ;;
  esac
done
export PATH
export TMPDIR="${TMPDIR:-$PWD/render-worker/target/tmp}"
mkdir -p "$TMPDIR"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
skip() { printf '\033[33m    skipped: %s\033[0m\n' "$1"; }

step "the seam: nothing in this repo may reach into billing"
./scripts/check-seam.sh

step "TypeScript, the api and dl Workers"
if command -v npx >/dev/null; then
  for w in workers/api workers/dl; do
    [ -d "$w" ] || continue
    ( cd "$w" && [ -d node_modules ] || npm install --silent ) || true
    ( cd "$w" && npx --yes tsc --noEmit ) && echo "  $w typechecks"
  done
else
  skip "no npx on PATH"
fi

step "the render worker"
if command -v cargo >/dev/null; then
  cargo fmt --manifest-path render-worker/Cargo.toml --check
  cargo clippy --manifest-path render-worker/Cargo.toml --all-targets -- -D warnings
  cargo test --manifest-path render-worker/Cargo.toml
else
  skip "no cargo on PATH"
fi

step "the database"
if command -v psql >/dev/null; then
  ./scripts/reset.sh --no-seed
  psql -v ON_ERROR_STOP=1 -f supabase/tests/seam_none.sql
  ./scripts/test-isolation.sh
else
  skip "no psql here, so applying every migration from scratch is NOT checked. This is the
             part of ci.yml a real runner is most needed for: the migrations are applied to
             the live project by hand, and nothing on this machine proves they would apply
             cleanly to an empty database."
fi

step "house style"
if git grep -nP '\xe2\x80\x94' -- '*.rs' '*.ts' '*.md' '*.sql' '*.sh' '*.toml'; then
  printf '\033[31mci: em dashes, which this project does not use.\033[0m\n' >&2
  exit 1
fi
echo "  no em dashes"

printf '\n\033[32mci: everything that can be checked here passed\033[0m\n'
