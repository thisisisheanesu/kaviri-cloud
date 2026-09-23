#!/usr/bin/env bash
#
# Refresh the copied assets. There is no build: the playground is static files and is meant to
# stay that way, so this script only copies things in from the recorder checkout and says what it
# did.
#
# Run it after the recorder's brand tokens change, or after the planner's wasm build is published.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
recorder="${KAVIRI_RECORDER:-$(cd "$here/../../kaviri" 2>/dev/null && pwd || true)}"

if [ -z "$recorder" ] || [ ! -f "$recorder/brand/tokens.css" ]; then
  echo "cannot find the recorder checkout." >&2
  echo "expected it beside kaviri-cloud, or set KAVIRI_RECORDER to its path." >&2
  exit 1
fi

# The header is prepended rather than kept in the source file, because the source file belongs to
# the recorder and a note about this directory has no business in it.
{
  cat <<'HEADER'
/* COPY. The source of truth is brand/tokens.css in the recorder repository, which this
   playground does not own and must not edit. It is copied here because play.kaviri.dev is
   deployed as static files and cannot reach across a checkout at run time.

   Refresh it with ./build.sh, which copies the file and nothing else. If you are about to edit
   a value in here, edit it in the recorder instead and re-run that script, or the two will
   disagree and the one people see will be this one. */

HEADER
  cat "$recorder/brand/tokens.css"
} > "$here/tokens.css"

echo "tokens.css <- $recorder/brand/tokens.css"

# The wasm planner is optional and usually absent. When it is there, the page prefers it over the
# JavaScript port automatically; see NEEDS-FROM-RECORDER.md for the ABI.
if [ -f "$here/wasm/kaviri_planner.js" ]; then
  echo "wasm planner present: $(ls -1 "$here/wasm" | tr '\n' ' ')"
else
  echo "wasm planner absent: the page will run the JavaScript port and say so in its badge"
fi
