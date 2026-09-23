#!/usr/bin/env bash
# Build the render image from the pins, and refuse to build an unpinned one in CI.
#
#   ./docker/build.sh                     build from docker/pins.env
#   REQUIRE_PINS=1 ./docker/build.sh      fail rather than resolve anything at build time
#   TAG=kaviri-render:2026-09-23 ./docker/build.sh

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pins="${here}/pins.env"
TAG="${TAG:-kaviri-render:local}"

args=()
if [[ -f "$pins" ]]; then
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    args+=(--build-arg "$line")
  done < "$pins"
else
  echo "docker/pins.env is missing; run docker/resolve-pins.sh > docker/pins.env" >&2
  [[ -n "${REQUIRE_PINS:-}" ]] && exit 1
fi

[[ -n "${REQUIRE_PINS:-}" ]] && args+=(--build-arg "REQUIRE_PINS=1")

# The build context is docker/ and nothing else. The recorder is cloned inside the builder
# stage rather than copied from a sibling checkout, so an image built here is an image
# anybody can rebuild from the two repositories and the pins, with nothing on the builder's
# disk making a difference to what comes out.
docker build "${args[@]}" -t "$TAG" "$here"

echo
echo "built $TAG"
docker run --rm --entrypoint /bin/cat "$TAG" /etc/kaviri-image.json
