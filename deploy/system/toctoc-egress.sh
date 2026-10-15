#!/usr/bin/env bash
# Loads the TOCTOC egress containment (toctoc-egress.nft), then adds what belongs to this machine: its resolvers
# (/etc/resolv.conf), and the prefixes it reaches directly, the LAN in IPv4 and in IPv6 the public prefix the router
# announces (every device of the local network has a global address there, which the private ranges of the static
# file do not cover).
set -euo pipefail
# One nft transaction: the static file and the prefixes of the machine are applied together, so a reload swaps the
# whole containment at once and never leaves a moment with the home prefixes missing.
elements() {
  local prefix
  while read -r prefix _; do
    [[ "$prefix" == default ]] || echo "add element inet toctoc_egress lan4 { $prefix }"
  done < <(ip -4 route show scope link)
  while read -r prefix _; do
    [[ "$prefix" == default || "$prefix" == fe80::* ]] || echo "add element inet toctoc_egress lan6 { $prefix }"
  done < <(ip -6 route show proto ra; ip -6 route show proto kernel)
  while read -r keyword address _; do
    [[ $keyword == nameserver ]] || continue
    address="${address%%%*}"
    if [[ $address == *:* ]]; then echo "add element inet toctoc_egress dns6 { $address }"; else echo "add element inet toctoc_egress dns4 { $address }"; fi
  done < /etc/resolv.conf
}
if ! { cat /etc/toctoc/toctoc-egress.nft; elements | sort -u; } | nft -f - 2>/dev/null; then
  # A prefix the static ranges already cover can make the whole transaction fail: load the static file alone,
  # then each prefix on its own, skipping the ones refused.
  nft -f /etc/toctoc/toctoc-egress.nft
  elements | sort -u | while read -r line; do nft "$line" 2>/dev/null || true; done
fi
nft list set inet toctoc_egress lan6 >/dev/null
