#!/usr/bin/env bash
#
# Blocks container egress to the host, the LAN and the tailnet, while leaving
# the internet reachable.
#
# WHY THIS EXISTS
#
# On a rootless daemon, UFW does not govern container->host traffic. RootlessKit
# NATs container egress so it reaches the kernel as host-origin traffic delivered
# locally, and `ufw-before-input` accepts `-i lo` unconditionally. Measured on the
# reference host with UFW active, INPUT and FORWARD both DROP: a container still
# reached the host's sshd, the WSL DNS stub and the Windows host's SMB port.
#
# The filter therefore belongs in the daemon's own network namespace, where
# DOCKER-USER lives and where the traffic is still forwarded rather than NAT'd.
# See docs/infrastructure/container-containment.md for the full reasoning.
#
# Runs entirely as the daemon's user. No sudo, no dedicated daemon account, and
# no changes to the host firewall.
#
# It also drops new connections from the Docker bridges to the daemon namespace's
# own addresses (the bridge gateways). That traffic is delivered locally, so it
# is INPUT, not the forwarded path DOCKER-USER sees.
#
# Usage:  container-egress-filter.sh [apply|flush|status]

set -euo pipefail

readonly UPLINK="${UPLINK:-tap0}"

# The uplink subnet carries the gateway and the fallback resolver, so it has to
# survive the RFC1918 drops below.
readonly UPLINK_SUBNET="${UPLINK_SUBNET:-10.0.2.0/24}"

# Everything on the far side of the uplink that containers have no business
# reaching. 100.64.0.0/10 is the CGNAT range Tailscale addresses come from.
readonly BLOCKED_V4=(
  10.0.0.0/8
  172.16.0.0/12
  192.168.0.0/16
  169.254.0.0/16
  100.64.0.0/10
)

readonly BLOCKED_V6=(
  fd00::/8
  fe80::/10
)

# Bridge interfaces whose new connections to the namespace itself are dropped:
# compose networks (br-*) and the default bridge.
readonly INPUT_BRIDGES=(br-+ docker0)

readonly STATE_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/dockerd-rootless"

# Two hops, mirroring dockerd-rootless.sh. Under --detach-netns the child stays
# in the host netns, so `-n -t <child>` targets the host and fails with EPERM.
# The detached netns is bind-mounted at STATE_DIR/netns, but only inside the
# child's mount namespace - from the host that path is an empty file and setns
# fails with EINVAL. So join the child's user and mount namespaces first, then
# the netns from inside.
#
# Resolved on every run rather than cached: the pid changes whenever the daemon
# restarts, and a stale value is the failure mode that leaves the rules silently
# unapplied while every command still reports success.
enter() {
  local child_pid
  child_pid="$(cat "${STATE_DIR}/child_pid")"

  nsenter --preserve-credentials -U -m -t "${child_pid}" \
    nsenter --net="${STATE_DIR}/netns" "$@"
}

# DOCKER-USER is created by dockerd, so this doubles as a readiness check.
#
# The wait is why it is a loop rather than a single test: the systemd unit is
# ordered After=docker.service, which only waits for the unit to be activated,
# not for the daemon to have finished building its chains. Racing that would
# apply the rules into a namespace that is about to be replaced, and every
# command would still report success.
require_chain() {
  local deadline=$((SECONDS + 30))

  until enter iptables -S DOCKER-USER >/dev/null 2>&1; do
    if ((SECONDS >= deadline)); then
      echo "DOCKER-USER not present after 30s - is the daemon up?" >&2
      exit 1
    fi

    sleep 1
  done
}

apply() {
  require_chain
  flush

  # Ordering is the whole rule set. The uplink subnet must RETURN before the
  # 10.0.0.0/8 drop that would otherwise swallow the gateway and the resolver.
  enter iptables -I DOCKER-USER 1 -o "${UPLINK}" -d "${UPLINK_SUBNET}" -j RETURN

  # -o is not optional. The `data` bridge is 172.19.0.0/16 and `edge` is
  # 172.30.0.0/24, both inside 172.16.0.0/12 - an unscoped drop would cut
  # app->db, app->cache and tunnel->proxy. Scoping to the uplink leaves every
  # bridge-to-bridge path untouched.
  local net
  for net in "${BLOCKED_V4[@]}"; do
    enter iptables -A DOCKER-USER -o "${UPLINK}" -d "${net}" -j DROP
  done

  # A no-op while the containers have no IPv6 address. Applied anyway so the
  # rule set cannot become half-enforced the moment that changes.
  for net in "${BLOCKED_V6[@]}"; do
    enter ip6tables -A DOCKER-USER -o "${UPLINK}" -d "${net}" -j DROP 2>/dev/null || true
  done

  # Safe to insert blindly: flush above removed any earlier copy. Nothing the
  # stacks use arrives on INPUT from a bridge - DNS is the embedded resolver in
  # the container's own namespace, and peer traffic is forwarded.
  local bridge
  for bridge in "${INPUT_BRIDGES[@]}"; do
    enter iptables -I INPUT 1 -i "${bridge}" -m conntrack --ctstate NEW -j DROP
    enter ip6tables -I INPUT 1 -i "${bridge}" -m conntrack --ctstate NEW -j DROP 2>/dev/null || true
  done

  echo "container egress filter applied on ${UPLINK}"
}

# Deletes only our own INPUT rules; the chain itself belongs to the namespace.
flush() {
  local bridge cmd
  enter iptables -F DOCKER-USER 2>/dev/null || true
  enter ip6tables -F DOCKER-USER 2>/dev/null || true

  for bridge in "${INPUT_BRIDGES[@]}"; do
    for cmd in iptables ip6tables; do
      if enter "${cmd}" -C INPUT -i "${bridge}" -m conntrack --ctstate NEW -j DROP 2>/dev/null; then
        enter "${cmd}" -D INPUT -i "${bridge}" -m conntrack --ctstate NEW -j DROP
      fi
    done
  done
}

status() {
  echo "--- IPv4 DOCKER-USER ---"
  enter iptables -S DOCKER-USER
  echo "--- IPv6 DOCKER-USER ---"
  enter ip6tables -S DOCKER-USER 2>/dev/null || echo "(none)"
  echo "--- IPv4 INPUT ---"
  enter iptables -S INPUT
}

case "${1:-apply}" in
  apply) apply ;;
  flush) flush && echo "container egress filter flushed" ;;
  status) status ;;
  *)
    echo "usage: $0 [apply|flush|status]" >&2
    exit 64
    ;;
esac
