#!/usr/bin/env bash
# Creates the artifact bucket and applies the lifecycle rules.
#
# Idempotent: creating a bucket that exists is reported and skipped, and the lifecycle
# call replaces the whole rule set rather than appending, so running this twice leaves
# exactly the rules in r2-lifecycle.json and nothing else.
#
# Credentials come from the environment and are never written anywhere:
#   CLOUDFLARE_API_TOKEN   needs Workers R2 Storage:Edit on the account
#   CLOUDFLARE_ACCOUNT_ID  defaults to the kaviri account below, which is not a secret
#
# The lifecycle rules are the backstop, not the primary retention mechanism. Postgres is
# authoritative: expire_due_artifacts marks the row and a sweeper deletes the object. But
# the sweeper can only delete what it has a row for, and the objects that actually run a
# storage bill up are the ones no row knows about, such as an upload that landed a moment
# before the render box died. The bucket expires those on the prefix alone.

set -euo pipefail

BUCKET="${R2_BUCKET:-kaviri-artifacts}"
ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:-5953bfdd63a83668a47dbaf1329dee16}"
# Western Europe, to sit next to the Supabase project in eu-central-1. A location hint and
# not a jurisdiction: a jurisdiction is fixed at creation, changes the S3 endpoint and
# makes every later wrangler call need a flag, and nothing here has a data residency
# obligation that would pay for that.
LOCATION="${R2_LOCATION:-weur}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIFECYCLE="${HERE}/r2-lifecycle.json"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN is not set. Export it for this shell; do not put it in a file." >&2
  exit 1
fi

api() {
  local method="$1" path="$2"
  shift 2
  curl --silent --show-error --fail-with-body \
    --request "${method}" \
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    --header "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}" \
    "$@"
}

echo "bucket: ${BUCKET} (account ${ACCOUNT}, location ${LOCATION})"

if api GET "/r2/buckets/${BUCKET}" >/dev/null 2>&1; then
  echo "  exists already, leaving it alone"
else
  echo "  creating"
  api POST "/r2/buckets" \
    --data "$(printf '{"name":"%s","locationHint":"%s"}' "${BUCKET}" "${LOCATION}")" >/dev/null
fi

echo "lifecycle rules from ${LIFECYCLE}"
api PUT "/r2/buckets/${BUCKET}/lifecycle" --data "@${LIFECYCLE}" >/dev/null
echo "  applied"

echo
echo "what the bucket now says:"
api GET "/r2/buckets/${BUCKET}/lifecycle"
echo

cat <<'NOTE'

Still to do by hand, because none of it can be set from this script:

  1. Public access must stay DISABLED for this bucket. R2 dashboard, the bucket,
     Settings, Public Development URL: leave r2.dev off, and attach no public custom
     domain. A publicly readable bucket makes every signature in this Worker decorative.
  2. dl.kaviri.dev must resolve to the kaviri-dl Worker. `wrangler deploy` claims it via
     the custom_domain route in wrangler.toml, which needs the kaviri.dev zone to be on
     this account already.
  3. Secrets: `wrangler secret put DL_SIGNING_KEY` for this Worker and the same value for
     the api Worker, which is the one that mints the links.
  4. Confirm the lifecycle shape above matches what the R2 API currently documents. The
     rule format is the one thing here that has changed under us before, and a rule that
     is silently rejected is a rule that expires nothing.

NOTE
