#!/usr/bin/env bash
# Run the tenant isolation test, and prove it can fail.
#
# A passing isolation test is worth very little on its own. The failure it is guarding
# against, a policy that does not fence, produces a database where every query still works
# and every screen still renders, so a test that has silently stopped asserting looks
# exactly like a test that is passing. The usual way it stops asserting is that the session
# never actually leaves the role that bypasses RLS.
#
# So this runs the test twice. Once as written, which must pass. Then once against a
# deliberately widened policy, which must fail. Only the second run distinguishes "the
# policies hold" from "the test is not looking".
#
# The negative control is applied inside the same transaction the test rolls back, so the
# real policy is never altered on disk and this is safe to run against the live project.
#
#   SUPABASE_PROJECT_REF=xxxxxxxxxxxx scripts/test-isolation.sh
#   DATABASE_URL=postgres://...       scripts/test-isolation.sh

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [ -z "${DATABASE_URL:-}" ] && [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
  echo "test-isolation: set DATABASE_URL or SUPABASE_PROJECT_REF" >&2
  exit 2
fi

test_file=supabase/tests/isolation.sql
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "=== isolation, as written: expected to pass ==="
python3 scripts/run-sql.py "$test_file"

echo
echo "=== negative control: the same test against a widened policy, expected to fail ==="

# The hole is planted immediately after the opening BEGIN, so it is inside the transaction
# the file already rolls back. render_jobs is the right table to widen because its select
# policy is the one every other assertion's shape is modelled on.
awk '
  /^begin;$/ && !done {
    print
    print ""
    print "-- NEGATIVE CONTROL, injected by scripts/test-isolation.sh."
    print "-- Every tenant can now see every job. The test must notice."
    print "alter policy render_jobs_select_member on public.render_jobs using (true);"
    done = 1
    next
  }
  { print }
' "$test_file" >"$work/holed.sql"

if ! grep -q 'NEGATIVE CONTROL' "$work/holed.sql"; then
  echo "test-isolation: could not plant the negative control; has the BEGIN moved?" >&2
  exit 1
fi

python3 scripts/run-sql.py --expect-failure "$work/holed.sql"

echo
echo "test-isolation: the policies hold, and the test can tell when they do not"
