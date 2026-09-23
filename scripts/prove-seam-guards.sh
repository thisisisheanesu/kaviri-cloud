#!/usr/bin/env bash
# The seam guards, proved by breaking them on purpose.
#
# scripts/check-seam.sh says the private repository is not a dependency of this one. For a
# long time it said that while checking nothing: it looped over package.json, Cargo.toml
# and deno.json at the repository root, none of which exists here, and skipped each one in
# turn. The check passed because it read no files, which is the worst way for a check to
# pass. A dependency on kaviri-billing in workers/api/package.json would have sailed
# through it.
#
# The fix was to ask git for the manifests instead of guessing their paths. This script is
# the other half of that fix: it plants the dependency the guard exists to catch, requires
# the guard to fail, removes it, and requires the guard to pass again. A guard nobody has
# watched fail has not been shown to guard anything, and a guard that fails whatever you
# feed it is not a guard either, so both directions are asserted.
#
# It restores the manifest on every exit path, including an interrupt, so a run that dies
# halfway does not leave a planted dependency in the working tree.
#
# The other planted control lives in supabase/tests/seam_none.sql, which writes a
# seat_price_cents key into org_entitlements.extra_limits, and a nested one, and requires
# the jsonb key guard to name them. That one needs a database, so it runs there rather
# than here.
#
# Usage: scripts/prove-seam-guards.sh

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

manifest="${1:-workers/api/package.json}"

if ! git ls-files --error-unmatch "$manifest" >/dev/null 2>&1; then
  echo "prove-seam-guards: $manifest is not tracked by git, so planting in it would prove nothing" >&2
  exit 2
fi

backup="$(mktemp)"
restore() {
  cp "$backup" "$manifest"
  rm -f "$backup"
}
cp "$manifest" "$backup"
trap restore EXIT INT TERM

run_check() {
  # The exit status is the assertion, so the check must not take the script down with it
  # under set -e. Output is captured and shown only when it is the interesting case.
  set +e
  check_out="$(scripts/check-seam.sh 2>&1)"
  check_rc=$?
  set -e
}

echo "prove-seam-guards: 1/3 the working tree as it stands must pass"
run_check
if [ "$check_rc" -ne 0 ]; then
  echo "$check_out" | sed 's/^/  /'
  echo "prove-seam-guards: the seam check already fails, so nothing below would mean anything" >&2
  exit 1
fi
echo "$check_out" | sed 's/^/  /'

echo "prove-seam-guards: 2/3 planting a dependency on kaviri-billing in $manifest"
python3 - "$manifest" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, encoding='utf-8') as fh:
    data = json.load(fh)
# A real dependency entry rather than a stray string, so the guard is being asked the
# question it actually exists to answer.
data.setdefault('dependencies', {})['kaviri-billing'] = '^1.0.0'
with open(path, 'w', encoding='utf-8') as fh:
    json.dump(data, fh, indent=2)
    fh.write('\n')
PY

run_check
if [ "$check_rc" -eq 0 ]; then
  echo "prove-seam-guards: FAILED. The seam check passed with kaviri-billing in $manifest." >&2
  echo "prove-seam-guards: the dependency guard is not reading the manifests it claims to read." >&2
  exit 1
fi
echo "$check_out" | sed 's/^/  /'
if ! printf '%s' "$check_out" | grep -q "$manifest"; then
  echo "prove-seam-guards: FAILED. The check failed but did not name $manifest," >&2
  echo "prove-seam-guards: so it failed for some other reason and the control is void." >&2
  exit 1
fi
echo "prove-seam-guards: the guard fired and named the manifest"

echo "prove-seam-guards: 3/3 removing the plant"
restore
trap - EXIT INT TERM
run_check
if [ "$check_rc" -ne 0 ]; then
  echo "$check_out" | sed 's/^/  /'
  echo "prove-seam-guards: FAILED. The check still fails after the plant was removed." >&2
  exit 1
fi
echo "$check_out" | sed 's/^/  /'

echo "prove-seam-guards: ok, the dependency guard fails on a planted dependency and passes without one"
