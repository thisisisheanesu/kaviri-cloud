#!/bin/sh
# The container's pid 1 (under tini, which the worker adds with --init).
#
# It does three things and then gets out of the way. The exec on the last line is the
# important one: without it this shell stays pid 1, the SIGTERM that truncates a take at
# the wall clock limit is delivered to the shell instead of to the recorder, and the take
# is killed rather than rendered. That failure is invisible in testing, because a take that
# finishes inside its budget never sees the signal at all.

set -eu

# A missing script is a worker bug rather than a customer one, and it is worth one clear
# line rather than the recorder's "cannot read /work/script.jsonl".
if [ "${1:-}" = "record" ] && [ ! -r /work/script.jsonl ]; then
  echo "kaviri-entrypoint: /work/script.jsonl is missing or unreadable; the worker did not mount the job directory" >&2
  exit 78
fi

# Chromium writes a profile, a crash directory and a cache, and with a read only root
# filesystem the only place it may do that is the tmpfs. If HOME is unwritable the browser
# exits with an error that reads like a sandbox problem and is not one.
if [ ! -w "${HOME:-/tmp}" ]; then
  echo "kaviri-entrypoint: HOME (${HOME:-/tmp}) is not writable; mount a tmpfs at it" >&2
  exit 78
fi

# Logged rather than assumed, so a support question about a video that looks wrong can be
# answered from the take's own log instead of from a rebuild.
if [ -r /etc/kaviri-image.json ]; then
  echo "kaviri-entrypoint: image $(cat /etc/kaviri-image.json)" >&2
fi

exec /usr/local/bin/kaviri "$@"
