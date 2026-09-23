#!/usr/bin/env bash
# Create the render network and fence it off from everything that is not the public
# internet. Run as root. Re-running is safe: the rules live in a chain of their own which is
# flushed and rebuilt.
#
#   sudo docker/egress.sh            install the fence and make it survive a reboot
#   sudo docker/egress.sh --verify   only check an existing fence, change nothing
#
# WHY THIS RUNS AT EVERY BOOT AND NOT ONCE PER BOX
#
# It used to say "run once per box" and then print, at the very bottom, that its rules do
# not survive a reboot. Those two sentences cannot both be followed. A docker network is
# daemon state and comes back by itself; iptables rules are kernel state and do not. So a
# box set up correctly and rebooted later has a render network that inspects clean and no
# fence behind it, and nothing about that box looks wrong from the outside.
#
# This script now installs a systemd unit that runs it again at every boot, so the fence is
# rebuilt rather than merely remembered. That is still not the control. The control is the
# worker's own startup probe, which runs a container on this network and refuses to start
# unless a connection to 169.254.169.254 is genuinely refused. This makes the fence come
# back; the probe is what notices when it did not.
#
# WHY THIS EXISTS AND CHROMIUM'S FLAGS ARE NOT ENOUGH
#
# The worker passes Chromium a --host-resolver-rules that maps every name we know of for a
# cloud metadata service to NOTFOUND, and that closes the route a copied-and-pasted script
# would actually take. It does not close the route an attacker would take, for one specific
# reason: Chromium's host resolver is not consulted for a URL that already contains an IP
# literal, so http://169.254.169.254/ never passes through those rules at all. A resolver
# rule is a usability control. This file is the security control.
#
# Everything here is about the FORWARD path and the host itself. What it deliberately does
# not try to control is the container's own loopback, where the recorder talks to Chromium
# over CDP. That is not fenceable from outside the namespace, and it is why one job per
# container matters: the worst a page can reach on 127.0.0.1 is the browser filming its own
# take.

set -euo pipefail

NETWORK="${KAVIRI_DOCKER_NETWORK:-kaviri-egress}"
# A subnet of its own, so the rules below can name the render containers and nothing else
# on the box. Change it if it collides with something; nothing else depends on the value.
SUBNET="${KAVIRI_DOCKER_SUBNET:-172.31.240.0/24}"
CHAIN="KAVIRI-EGRESS"

# Where this script lives once it is a boot time dependency rather than a thing somebody
# ran. The unit names this path, so the unit file can be shipped as a constant.
INSTALLED_AT="/usr/local/sbin/kaviri-egress.sh"
UNIT_NAME="kaviri-egress.service"
UNIT_DIR="/etc/systemd/system"

VERIFY_ONLY=0
case "${1:-}" in
  --verify) VERIFY_ONLY=1 ;;
  "") ;;
  *) echo "usage: egress.sh [--verify]" >&2; exit 2 ;;
esac

if [[ $EUID -ne 0 ]]; then
  echo "egress.sh changes the host firewall and must run as root" >&2
  exit 1
fi

# Verify by connecting, not by reading rules. Parsing iptables-save would mean deciding
# whether a rule set we did not write has the effect we expect, which is reimplementing
# netfilter's matching semantics in a shell script. One container answers the real question.
#
# The render image is used rather than a network utility image, because the worker refuses
# to pull anything and a box that has the render image is a box that can run this. bash's
# /dev/tcp is the client; timeout bounds it. Exit 0 is a completed connection, 124 is the
# deadline, and anything else is a prompt refusal, which is the answer the fence should give.
verify_fence() {
  local image="${KAVIRI_RENDER_IMAGE:-kaviri-render:local}"
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    echo "cannot verify: the render image $image is not on this box." >&2
    echo "Build it with docker/build.sh, or set KAVIRI_RENDER_IMAGE." >&2
    return 2
  fi

  # The same variable the worker reads, so the two agree about what the positive control is
  # and a box configured for one is configured for both.
  local public="${KAVIRI_EGRESS_PROBE_PUBLIC:-1.1.1.1:443}"
  local phost="${public%:*}" pport="${public##*:}"
  [[ "$pport" =~ ^[0-9]+$ ]] || { phost="$public"; pport=443; }

  local script
  script='probe() { timeout 5 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; rc=$?;
    if [ $rc -eq 0 ]; then echo "RESULT $3 open";
    elif [ $rc -eq 124 ]; then echo "RESULT $3 hung";
    else echo "RESULT $3 blocked"; fi; }
  probe 169.254.169.254 80 metadata
  probe 10.255.255.1 80 rfc1918'
  if [[ "$public" != "off" ]]; then
    script+="
  probe $phost $pport public"
  fi

  local out
  out="$(docker run --rm --network "$NETWORK" \
          --cap-drop ALL --security-opt no-new-privileges:true --read-only \
          --tmpfs /tmp:rw,nosuid,nodev,size=16m \
          --entrypoint /bin/bash "$image" -c "$script" 2>&1)" || true

  echo "$out"

  local bad=0
  for label in metadata rfc1918; do
    if ! grep -qx "RESULT $label blocked" <<<"$out"; then
      echo "FAIL: $label was not refused; the fence does not hold" >&2
      bad=1
    fi
  done
  # The positive control. Without it, a render network with no route anywhere refuses every
  # blocked address just as convincingly as a correctly fenced one does, and this script
  # would congratulate a box that cannot film anything at all.
  if [[ "$public" == "off" ]]; then
    echo "WARNING: KAVIRI_EGRESS_PROBE_PUBLIC=off, so the refusals above are unverified:" >&2
    echo "a render network with no route at all would look exactly like this." >&2
  elif ! grep -qx "RESULT public open" <<<"$out"; then
    echo "FAIL: $public did not answer, so the refusals above prove nothing" >&2
    bad=1
  fi

  if [[ $bad -ne 0 ]]; then
    return 1
  fi
  echo "OK: the egress fence holds on $NETWORK"
}

if [[ $VERIFY_ONLY -eq 1 ]]; then
  verify_fence
  exit $?
fi

# The network is created without IPv6. Not because IPv6 is a problem, but because a second
# address family is a second complete set of rules, and a box that forgets the second set
# has the fence it thinks it has in one family only.
if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  docker network create \
    --driver bridge \
    --subnet "$SUBNET" \
    --opt com.docker.network.bridge.name="br-kaviri" \
    --opt com.docker.network.bridge.enable_icc=false \
    "$NETWORK"
  echo "created docker network $NETWORK on $SUBNET"
else
  echo "docker network $NETWORK already exists"
fi

# Ranges a customer's page has no business reaching from our fleet. The link local block is
# the famous one, because 169.254.169.254 is where every cloud keeps the credentials of the
# host, but it is only the most famous member of the family: the Hetzner private network,
# the Docker bridge and the host's own services are all reachable from a container by
# default and none of them is a take.
BLOCKED=(
  0.0.0.0/8         # this network
  10.0.0.0/8        # RFC 1918
  100.64.0.0/10     # carrier grade NAT, where Hetzner and most clouds put internal services
  127.0.0.0/8       # the host's loopback, reachable across the bridge on some configurations
  169.254.0.0/16    # link local, and with it the metadata endpoint
  172.16.0.0/12     # RFC 1918, including every other docker bridge on this box
  192.0.0.0/24      # IETF protocol assignments
  192.168.0.0/16    # RFC 1918
  198.18.0.0/15     # benchmarking
  224.0.0.0/4       # multicast
  240.0.0.0/4       # reserved
)

iptables -N "$CHAIN" 2>/dev/null || true
iptables -F "$CHAIN"
for cidr in "${BLOCKED[@]}"; do
  # REJECT rather than DROP, so a script that tries gets an immediate error instead of
  # spending the take's entire wall clock budget waiting for a connection that will never
  # be answered. A take that fails in two seconds is debuggable; one that times out at
  # thirty minutes is a support ticket.
  iptables -A "$CHAIN" -d "$cidr" -j REJECT --reject-with icmp-admin-prohibited
done
iptables -A "$CHAIN" -j RETURN

# DOCKER-USER is traversed before Docker's own rules for every forwarded packet, and Docker
# does not rewrite it, so a daemon restart does not undo this.
iptables -D DOCKER-USER -s "$SUBNET" -j "$CHAIN" 2>/dev/null || true
iptables -I DOCKER-USER 1 -s "$SUBNET" -j "$CHAIN"

# Traffic from a container to an address of the host itself is delivered locally rather
# than forwarded, so it never reaches DOCKER-USER. Without this, everything the box runs on
# 127.0.0.1 and on its public address is reachable from inside a take.
iptables -D INPUT -s "$SUBNET" -m conntrack --ctstate NEW -j REJECT --reject-with icmp-admin-prohibited 2>/dev/null || true
iptables -I INPUT 1 -s "$SUBNET" -m conntrack --ctstate NEW -j REJECT --reject-with icmp-admin-prohibited

echo "egress rules installed for $SUBNET"

# ---------------------------------------------------------------------------
# Make it survive a reboot
# ---------------------------------------------------------------------------
#
# Done here rather than left to whoever provisions the box. The old script printed this as
# advice in its last three lines, and advice is not a control: a box where somebody skipped
# those lines is indistinguishable from a box where they did not until a customer's script
# reads the host's credentials. Installing the unit is two file copies and it removes the
# step that can be forgotten.
#
# KAVIRI_EGRESS_NO_INSTALL=1 skips it, for a box whose configuration is managed elsewhere
# and where a unit appearing from under a provisioning tool would be the surprise.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${KAVIRI_EGRESS_NO_INSTALL:-0}" == "1" ]]; then
  echo
  echo "KAVIRI_EGRESS_NO_INSTALL=1, so the boot time unit was not installed."
  echo "These rules are kernel state and will be gone after a reboot. Arrange for"
  echo "$INSTALLED_AT to run before kaviri-render-worker.service, or the worker"
  echo "will refuse to start, which is the intended failure and not a helpful one."
elif ! command -v systemctl >/dev/null 2>&1; then
  echo
  echo "No systemctl on this box, so the boot time unit was not installed."
  echo "These rules are kernel state and will be gone after a reboot. Arrange for this"
  echo "script to run at boot before the worker."
elif [[ ! -f "$HERE/$UNIT_NAME" ]]; then
  # This is the normal path when the unit itself is what invoked us: the installed copy at
  # $INSTALLED_AT has no repository beside it, and the unit is already in place anyway.
  echo "running from $INSTALLED_AT; the boot time unit is already installed"
else
  install -m 0755 "${BASH_SOURCE[0]}" "$INSTALLED_AT"
  install -m 0644 "$HERE/$UNIT_NAME" "$UNIT_DIR/$UNIT_NAME"
  systemctl daemon-reload
  systemctl enable "$UNIT_NAME" >/dev/null
  echo "installed $INSTALLED_AT and enabled $UNIT_NAME, so the fence is rebuilt at every boot"
fi

# ---------------------------------------------------------------------------
# Prove it
# ---------------------------------------------------------------------------
#
# The script does not finish by telling you how to check its work. It checks it, and exits
# non zero if the fence it just installed does not hold, so a provisioning run that ends in
# success has demonstrated the fence rather than described it.

echo
if verify_fence; then
  echo
  echo "The worker runs this same probe at startup and will not lease a job without it."
else
  rc=$?
  echo
  echo "The rules were installed but could not be shown to work (exit $rc)."
  echo "The worker runs this same probe at startup and will refuse to start."
  exit "$rc"
fi
