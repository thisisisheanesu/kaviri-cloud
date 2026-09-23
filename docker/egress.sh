#!/usr/bin/env bash
# Create the render network and fence it off from everything that is not the public
# internet. Run once per box, as root, before the worker starts. Re-running is safe: the
# rules live in a chain of their own which is flushed and rebuilt.
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

if [[ $EUID -ne 0 ]]; then
  echo "egress.sh changes the host firewall and must run as root" >&2
  exit 1
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
echo
echo "Verify from inside the network, which should print three refusals and one success:"
echo "  docker run --rm --network $NETWORK curlimages/curl -sS -m 5 http://169.254.169.254/ || echo blocked"
echo "  docker run --rm --network $NETWORK curlimages/curl -sS -m 5 http://10.0.0.1/       || echo blocked"
echo "  docker run --rm --network $NETWORK curlimages/curl -sS -m 5 http://192.168.1.1/    || echo blocked"
echo "  docker run --rm --network $NETWORK curlimages/curl -sS -m 5 -o /dev/null -w '%{http_code}\\n' https://example.com/"
echo
echo "These rules are not persistent across a reboot unless the box saves them."
echo "Persist them with iptables-persistent, or re-run this script from a systemd unit"
echo "ordered before kaviri-render-worker.service."
