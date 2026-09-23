#!/usr/bin/env bash
# The seam check.
#
# The open cloud repository must contain no billing logic and no prices. That is easy to
# say in a README and easy to break in a hurry, so it is a build step.
#
# What it enforces, on code rather than on prose:
#   1. Nothing references a `billing` schema or a `billing_` object.
#   2. No identifier in the schema is about money.
#   3. org_entitlements holds limits only.
#   4. The private repository is not a dependency of this one, in any manifest or lock
#      file that git tracks.
#   5. No migration writes a key about money into the extra_limits jsonb column. The keys
#      that arrive at runtime are checked by scripts/verify-seam.sh and by
#      supabase/tests/seam_none.sql, because a jsonb key exists only in data.
#
# Comments and documentation are deliberately exempt. Explaining WHY the seam exists
# requires writing the words "billing" and "price", and a check that forbade the words
# would be satisfied by deleting the explanation, which is the opposite of the point.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

fail=0
note() { printf 'seam: %s\n' "$1" >&2; fail=1; }

# Strip comments and string literals before matching, so the check sees code and only
# code. A string literal is exempt for the same reason a comment is: an error message
# that says "billing is not configured" is not billing logic.
strip() {
  python3 - "$1" <<'PY'
import re, sys
src = open(sys.argv[1], encoding='utf-8', errors='replace').read()
out, i, n = [], 0, len(src)
while i < n:
    two = src[i:i+2]
    if two == '--' or two == '//':
        j = src.find('\n', i); i = n if j < 0 else j
    elif two == '/*':
        j = src.find('*/', i + 2); i = n if j < 0 else j + 2
    elif src[i] == "'":
        j = i + 1
        while j < n:
            if src[j] == "'":
                if src[j+1:j+2] == "'": j += 2; continue
                j += 1; break
            j += 1
        i = j
    elif src[i] == '"':
        j = src.find('"', i + 1); i = n if j < 0 else j + 1
    else:
        out.append(src[i]); i += 1
print(''.join(out))
PY
}

# Every file the check reads. Documentation is not in this list on purpose.
#
# Two of these globs were wrong and the check was quietly passing because of it:
# 'worker/**/*.rs' matched nothing, because the crate is render-worker, and the playground
# was listed as TypeScript when every file in it is .js. Between them that was the largest
# body of code in the repository and the whole of the customer-facing page, neither of
# which the seam check had ever read. A glob that matches nothing is the failure mode this
# script is most exposed to, which is why the count is asserted below.
mapfile -t code_files < <(
  git ls-files \
    'supabase/migrations/*.sql' \
    'supabase/functions/**/*.ts' \
    'workers/**/*.ts' \
    'render-worker/**/*.rs' \
    'playground/**/*.js' \
    'playground/**/*.ts' 2>/dev/null || true
)

if [ "${#code_files[@]}" -eq 0 ]; then
  # A checkout with no migrations means the check has nothing to stand on, and silently
  # passing would be worse than failing.
  note 'no code files matched; the seam check is not actually checking anything'
  exit 1
fi

# 1 and 2. Identifiers that would mean money had leaked into the open service. The
# patterns are deliberately narrow: `price` matches, `pricing_page_url` would too, and
# that is correct, because a price does not belong here even as a link target in code.
forbidden='\bbilling\.|\bbilling_[a-z_]+|\bstripe[_.a-z]*|\bprice[sd]?\b|\bprice_|\bunit_amount\b|\bamount_cents\b|\binvoice[sd]?\b|\bsubscription_?[a-z]*\b|\bcoupon\b|\bdiscount\b|\bcheckout_session\b|\bpayment_(intent|method)\b|\bmrr\b|\btax_rate\b'

for f in "${code_files[@]}"; do
  if hits="$(strip "$f" | grep -nEi "$forbidden" || true)"; [ -n "$hits" ]; then
    note "$f references billing:"
    printf '%s\n' "$hits" | sed 's/^/  /' >&2
  fi
done

# 3. The entitlements table is the one row billing writes, and it holds limits. A column
# whose name is about money is the failure this whole check exists to catch, so it is
# asserted directly against the DDL rather than inferred from the sweep above.
ent_ddl="$(awk '/create table public\.org_entitlements/,/^\);/' supabase/migrations/*.sql)"
if [ -z "$ent_ddl" ]; then
  note 'org_entitlements is not defined in the migrations'
else
  if printf '%s' "$ent_ddl" | grep -qEi '^\s*(price|amount|cost|currency|invoice|stripe|coupon|discount|subscription|seat_price|rate)[a-z_]*\s'; then
    note 'org_entitlements has a column about money'
  fi
  # Positive assertion, because a check that only forbids can be satisfied by an empty
  # table, and an empty entitlements table would move the limits somewhere unchecked.
  for required in max_concurrent_renders max_jobs_per_month artifact_retention_days; do
    printf '%s' "$ent_ddl" | grep -q "$required" \
      || note "org_entitlements is missing the $required limit"
  done
fi

# 4. No dependency on the private repository, by any of the names it goes by.
if git ls-files | grep -qE '(^|/)kaviri-billing(/|$)'; then
  note 'the private billing repository is vendored into this one'
fi
# This used to read a fixed list of three manifests at the repository root. None of them
# exists: the real manifests are workers/api/package.json, workers/dl/package.json and
# render-worker/Cargo.toml, and the loop skipped every name it was given, so adding a
# dependency on the private repository to a Worker passed the seam check. It is the same
# glob-matched-nothing failure the comment above warns about, which is why this is now
# asked of git rather than assumed, and why the count is asserted rather than trusted.
#
# Lock files are included because a dependency reaches the build through the lock whatever
# the manifest says, and a lock entry left behind after a manifest edit is exactly the
# residue worth catching.
manifests=()
mapfile -t manifests < <(
  git ls-files \
    'package.json' '*/package.json' \
    'package-lock.json' '*/package-lock.json' \
    'Cargo.toml' '*/Cargo.toml' \
    'Cargo.lock' '*/Cargo.lock' \
    'deno.json' '*/deno.json' \
    'deno.jsonc' '*/deno.jsonc' \
    'deno.lock' '*/deno.lock' 2>/dev/null || true
)

if [ "${#manifests[@]}" -eq 0 ]; then
  note 'no dependency manifests matched; the dependency half of the seam check is not checking anything'
else
  for manifest in "${manifests[@]}"; do
    if grep -qEi 'kaviri[-_]billing' "$manifest"; then
      note "$manifest depends on the private billing repository"
    fi
  done
fi

# 5. extra_limits is jsonb, so its keys are data rather than schema and no column-name
# check can see them. The runtime half of this guard lives in scripts/verify-seam.sh and
# supabase/tests/seam_none.sql, which read the keys out of the applied database. What can
# be checked here is the only place this repository itself puts keys into that column: a
# literal in a migration.
#
# The comment is stripped and the string literal is kept, which is the opposite of the
# sweep above and is deliberate: here the string literal IS the thing being inspected,
# because a jsonb key can only ever arrive as one, while a comment that explains why
# seat_price_cents is forbidden must stay allowed to name it.
ent_literals="$(
  awk '/extra_limits/ {
         line = $0
         sub(/--.*/, "", line)
         if (line ~ /extra_limits/) printf "%s:%d:%s\n", FILENAME, FNR, line
       }' supabase/migrations/*.sql
)"
money_key='(^|_|")(price|amount|cost|currency|invoice|stripe|coupon|discount|subscription|mrr|arr|cents|tax_rate|payment|charge)($|_|")'
if hits="$(printf '%s\n' "$ent_literals" | grep -Ei "$money_key" || true)"; [ -n "$hits" ]; then
  note 'a migration writes a key about money into extra_limits:'
  printf '%s\n' "$hits" | sed 's/^/  /' >&2
fi

if [ "$fail" -ne 0 ]; then
  printf 'seam: FAILED. See README.md, "The seam".\n' >&2
  exit 1
fi

printf 'seam: ok, %d code files and %d dependency manifests checked\n' \
  "${#code_files[@]}" "${#manifests[@]}"
