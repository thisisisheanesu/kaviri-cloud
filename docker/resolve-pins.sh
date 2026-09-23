#!/usr/bin/env bash
# Print the exact versions this box would install today, in the form docker/pins.env wants.
#
# Pinning by hand means reading them off a build log and typing them somewhere, which is
# how a pin ends up one revision behind the thing it claims to pin. This asks the archive
# instead, and writes a file you can commit.
#
#   ./docker/resolve-pins.sh > docker/pins.env
#
# Debian's stable archive keeps only the current version of a package, so a pin resolved
# today stops being installable when a security update supersedes it. That is the correct
# failure: the build breaks loudly and somebody looks at what changed in the browser that
# renders every customer's video. If you would rather it did not break, point the base
# image at a snapshot.debian.org date instead, and pin that date here too.

set -euo pipefail

BASE="${BASE_IMAGE:-debian:bookworm-slim}"

digest="$(docker buildx imagetools inspect "$BASE" --format '{{.Manifest.Digest}}' 2>/dev/null \
  || docker manifest inspect "$BASE" 2>/dev/null | sed -n 's/.*"digest": "\(sha256:[a-f0-9]*\)".*/\1/p' | head -1)"

versions="$(docker run --rm "$BASE" sh -c '
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1
  for pkg in chromium ffmpeg; do
    printf "%s %s\n" "$pkg" "$(apt-cache policy "$pkg" | awk "/Candidate:/ {print \$2}")"
  done
')"

chromium="$(echo "$versions" | awk '/^chromium /{print $2}')"
ffmpeg="$(echo "$versions" | awk '/^ffmpeg /{print $2}')"

cat <<EOF
# Resolved by docker/resolve-pins.sh on $(date -u +%Y-%m-%d). Commit this file.
# Pass every line to docker build as a --build-arg; docker/build.sh does that for you.
BASE_IMAGE=${BASE}${digest:+@${digest}}
CHROMIUM_VERSION=${chromium}
FFMPEG_VERSION=${ffmpeg}
# A tag or a commit of the recorder. A branch makes the image's contents depend on the day
# it was built, which defeats the rest of this file.
KAVIRI_REF=main
EOF
