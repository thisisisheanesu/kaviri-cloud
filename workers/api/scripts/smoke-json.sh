#!/usr/bin/env bash
# Does the deployed service still answer JSON, to everybody, on every path a caller can hit?
#
# WHY THIS EXISTS AS A SCRIPT AND NOT AS A PARAGRAPH IN A README
#
# Every response this Worker constructs is JSON, and test/always-json.test.ts proves that
# for every route in the table under every failure the code can be pushed into. None of
# that helps with the failure that actually costs a day, because in that failure the Worker
# never runs. A WAF managed rule, Super Bot Fight Mode, Browser Integrity Check, an Access
# policy or Under Attack mode answers first, with an HTML interstitial and usually a 200 on
# it. A GitHub Action parsing that reports:
#
#     expected JSON, got <!DOCTYPE html>
#
# and there is nothing in the Worker's logs, because there was no invocation. A machine
# caller cannot solve a challenge, so every challenged request is a permanently failed
# build. README.md lists the five settings that cause it. A list of settings is a checklist,
# and a checklist is only as good as the last person who read it, so this script asserts the
# outcome those settings are supposed to produce.
#
# The assertion is deliberately the crudest one available: the first byte of the body is a
# brace. It is the same assertion test/always-json.test.ts makes in process, so the two
# halves of the guarantee cannot drift into testing different things.
#
# Usage:
#   scripts/smoke-json.sh https://api.kaviri.dev [https://dl.kaviri.dev]
#
# Or set API_ORIGIN and, optionally, DL_ORIGIN in the environment.

set -uo pipefail

API_ORIGIN="${1:-${API_ORIGIN:-}}"
DL_ORIGIN="${2:-${DL_ORIGIN:-}}"

if [ -z "${API_ORIGIN}" ]; then
  echo "usage: $0 <api-origin> [dl-origin]" >&2
  echo "for example: $0 https://api.kaviri.dev https://dl.kaviri.dev" >&2
  exit 2
fi

API_ORIGIN="${API_ORIGIN%/}"
DL_ORIGIN="${DL_ORIGIN%/}"

# A real browser's user agent string. Sending it is the point of this whole file: a bot
# manager that challenges automated callers and a bot manager that challenges browsers fail
# in opposite directions, and only asserting both catches both.
BROWSER_UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
# curl's own default is left in place for the other half, because that is what a GitHub
# Action's `curl` and most SDKs look like on the wire.

FAILURES=0
CHECKS=0

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# check <description> <expected-status-pattern> <require-worker-header: yes|no> <curl args...>
#
# The status is a pattern rather than a number because several of these are correct at more
# than one status. A health endpoint answering 503 because the database is down is still a
# passing JSON check, and conflating "the service is unwell" with "the service answered
# HTML" is how a genuine JSON failure gets dismissed as a flake.
check() {
  local description="$1" status_pattern="$2" require_header="$3"
  shift 3

  CHECKS=$((CHECKS + 1))

  local body="${work}/body" headers="${work}/headers"
  local status
  status="$(curl -sS --max-time 20 --output "${body}" --dump-header "${headers}" --write-out '%{http_code}' "$@" 2>"${work}/curlerr")" || {
    # The exit code is printed as well as the message because curl cannot always produce a
    # message. Exit 23 with nothing on stderr, for instance, is curl failing to write its
    # own output file, which means the temporary directory is full rather than the service
    # being unwell, and that is a confusing half hour if the number is not on the screen.
    local rc=$?
    printf 'FAIL  %s\n      curl exited %s: %s\n' "${description}" "${rc}" "$(tr -d '\r' <"${work}/curlerr" 2>/dev/null | head -3 | tr '\n' ' ')"
    FAILURES=$((FAILURES + 1))
    return
  }

  local content_type first_byte request_id
  content_type="$(tr -d '\r' <"${headers}" | grep -i '^content-type:' | tail -1 | cut -d' ' -f2- || true)"
  first_byte="$(head -c 1 "${body}")"
  request_id="$(tr -d '\r' <"${headers}" | grep -i '^x-kaviri-request-id:' | tail -1 || true)"

  local problems=()
  [[ "${status}" =~ ${status_pattern} ]] || problems+=("status ${status} does not match ${status_pattern}")
  [ "${first_byte}" = "{" ] || problems+=("first byte is '${first_byte}' and not '{'")
  case "${content_type}" in
    *application/json*) ;;
    *) problems+=("content-type is '${content_type:-none}' and not application/json") ;;
  esac
  if [ "${require_header}" = "yes" ] && [ -z "${request_id}" ]; then
    # Nothing in front of the Worker knows how to mint this header, so its absence on a
    # response that otherwise looks fine means something else answered.
    problems+=("no X-Kaviri-Request-Id, so the Worker probably never ran")
  fi

  if [ ${#problems[@]} -eq 0 ]; then
    printf 'ok    %s (%s)\n' "${description}" "${status}"
    return
  fi

  FAILURES=$((FAILURES + 1))
  printf 'FAIL  %s\n' "${description}"
  local problem
  for problem in "${problems[@]}"; do printf '      %s\n' "${problem}"; done
  printf '      first 200 bytes: %s\n' "$(head -c 200 "${body}" | tr '\n' ' ')"
}

echo "checking ${API_ORIGIN}"

# The one the verifier asked for, and the one a deploy check should run first: health, as a
# plain machine caller. 503 passes because a database outage is still a JSON answer.
check "GET /v1/health"                       '^(200|503)$' yes "${API_ORIGIN}/v1/health"

# The same request wearing a browser. A challenge aimed at browsers answers this one and not
# the one above.
check "GET /v1/health as a browser"          '^(200|503)$' yes -H "User-Agent: ${BROWSER_UA}" -H 'Accept: text/html,application/xhtml+xml' "${API_ORIGIN}/v1/health"

# An unknown path. A hosting platform's own 404 page is HTML, so this catches a route that
# stopped pointing at the Worker.
check "GET /v1/does-not-exist"               '^404$'       yes "${API_ORIGIN}/v1/does-not-exist"

# An unversioned path, which is the first thing a person pastes into a browser.
check "GET /"                                '^404$'       yes "${API_ORIGIN}/"

# Unauthenticated against a real endpoint. A Cloudflare Access policy in front of the
# hostname answers this with a redirect to a login page, which an Action follows into HTML.
check "GET /v1/jobs with no credential"      '^401$'       yes "${API_ORIGIN}/v1/jobs"

# A rejected credential, which is the shape a bot manager is most likely to treat as abuse.
check "GET /v1/jobs with a bad credential"   '^(401|403)$' yes -H 'Authorization: Bearer kv_00000000_notarealkey' "${API_ORIGIN}/v1/jobs"

# Wrong method. Some edge configurations answer a method they do not expect before the
# origin sees it.
check "DELETE /v1/jobs/{id}"                 '^(401|404|405)$' yes -X DELETE "${API_ORIGIN}/v1/jobs/4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44"

# A POST with a body that is not JSON, unauthenticated. This is the request most likely to
# trip a managed WAF rule, because it looks like a probe.
check "POST /v1/jobs with a hostile body"    '^(400|401|413|422)$' yes -X POST -H 'Content-Type: application/json' --data-binary '{"script": [ <script>alert(1)</script> ' "${API_ORIGIN}/v1/jobs"

if [ -n "${DL_ORIGIN}" ]; then
  echo "checking ${DL_ORIGIN}"
  # The download Worker serves bytes rather than JSON, but its errors are JSON and its
  # health endpoint is JSON, and a customer chasing a broken embed reads those errors.
  check "GET /healthz on dl"                 '^200$'       no "${DL_ORIGIN}/healthz"
  check "GET an invalid signed path on dl"   '^403$'       no "${DL_ORIGIN}/1/not-a-real-signature/nope.mp4"
  check "GET an unknown path on dl"          '^403$'       no "${DL_ORIGIN}/definitely-not-signed"
fi

echo
if [ "${FAILURES}" -eq 0 ]; then
  echo "${CHECKS} checks passed: every response was JSON."
  exit 0
fi

cat >&2 <<'EOF'

One or more responses were not JSON. Almost always this is the edge in front of the Worker
rather than the Worker, and the five settings that cause it are listed under "The WAF skip
rules the api subdomain must have" in workers/api/README.md. Check them in this order:

  1. the WAF custom rule with action Skip is present AND first in the phase
  2. Super Bot Fight Mode is off for the zone, or the skip rule includes it
  3. Under Attack mode is not on for this hostname
  4. there is no Cloudflare Access policy on the hostname
  5. there is no WAF rate limiting rule on the hostname

If the body above is an HTML challenge page, it is one of those. If it is a Cloudflare error
page with a number in it, 1101 is an uncaught exception in the Worker and 1102 is the CPU
limit, and both of those are the Worker rather than the edge.
EOF
exit 1
