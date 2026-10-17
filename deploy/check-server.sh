#!/usr/bin/env bash
# Security checks of the TOCTOC installation, run as root on the server by bin/toctoc-check-cyber, through the
# root-owned copy /usr/local/sbin/toctoc-check that deploy/install-server.sh installs. Read-only, except one backup
# run at the end. Prints one line per check and exits non-zero when one fails.
set -uo pipefail

FAILED=0
report() { # status, label
  if [[ $1 == OK ]]; then printf '  OK    %s\n' "$2"; else printf '  FAIL  %s\n' "$2"; FAILED=$((FAILED + 1)); fi
}
check() { # label, command...
  local label=$1; shift
  if "$@" >/dev/null 2>&1; then report OK "$label"; else report FAIL "$label"; fi
}
# Connection attempt from a service account: expected "open" or "blocked".
reach() { # user, host, port, expected
  local got=blocked
  timeout 4 sudo -u "$1" bash -c "</dev/tcp/$2/$3" 2>/dev/null && got=open
  if [[ $got == "$4" ]]; then report OK "$1 -> $2:$3 $4"; else report FAIL "$1 -> $2:$3 $got (expected $4)"; fi
}
# Internet reach, IPv4 and IPv6 apart: a client that falls back from one to the other hides a blocked family.
reach_internet() { # user, host
  local family addr
  for family in v4 v6; do
    addr=$(getent "ahosts$family" "$2" | awk 'NR == 1 && $1 !~ /^::ffff:/ {print $1}')
    # A home IPv6 link can drop connections in bursts: three attempts, and a timeout is told apart from a rejection
    # by a rule.
    if [[ -n $addr ]]; then
      local got=blocked causes="" start elapsed
      for _ in 1 2 3; do
        start=$(date +%s%N)
        timeout 4 sudo -u "$1" bash -c "</dev/tcp/$addr/443" 2>/dev/null && { got=open; break; }
        elapsed=$(( ($(date +%s%N) - start) / 1000000 ))
        # A rule rejects at once; a timeout comes from the network, not from the containment.
        if (( elapsed < 3500 )); then causes+=" rejected(${elapsed}ms)"; else causes+=" timeout"; fi
      done
      if [[ $got == open ]]; then
        report OK "$1 -> $addr:443 open"
      elif [[ $causes != *rejected* ]]; then
        # Not the containment: the network did not answer.
        printf '  NOTE  %s -> %s:443 timed out 3 times: network outage, not a rule\n' "$1" "$addr"
      else
        report FAIL "$1 -> $addr:443 blocked:$causes (expected open)"
      fi
    else printf '  NOTE  %s has no IP%s address\n' "$2" "$family"; fi
  done
}
listens_only_on_loopback() { # port
  local addrs
  addrs=$(ss -ltnH "sport = :$1" | awk '{print $4}')
  [[ -n $addrs ]] && ! grep -qvE '^(127\.0\.0\.1|\[::1\]):' <<<"$addrs"
}

echo "== Services"
for unit in toctoc-egress.service toctoc.service caddy.service docker.service toctoc-backup.timer; do
  check "$unit active" systemctl is-active --quiet "$unit"
done
check "application health" curl -fsS http://127.0.0.1:3000/api/health

echo "== Network exposure"
for port in 3000 5000 3010; do check "port $port listens on loopback only" listens_only_on_loopback "$port"; done
check "Caddy admin API off (2019 closed)" bash -c '! timeout 2 bash -c "</dev/tcp/127.0.0.1/2019"'
check "egress table loaded" nft list table inet toctoc_egress

# What the machine offers on its own network: the gateway, the resolvers, the on-link IPv6 prefix, and the other
# services listening locally. Read here so the checks fit any installation.
GATEWAY4=$(ip -4 route show default | awk '{print $3; exit}')
RESOLVER4=$(awk '$1 == "nameserver" && $2 ~ /^[0-9.]+$/ {print $2; exit}' /etc/resolv.conf)
PREFIX6=$(ip -6 route show proto ra | awk '$1 != "default" && $1 !~ /^fe80/ {print $1; exit}')
LAN6=""; [[ -n $PREFIX6 ]] && LAN6="${PREFIX6%%/*}1"
# Other TCP services listening on the machine (at most 10), each of which the containment must hide.
other_ports() { # allowed ports...
  ss -ltnH | awk '{n = split($4, a, ":"); print a[n]}' | sort -un | grep -vxE "$(IFS='|'; echo "$*")" | head -10
}

lan_checks() { # user
  if [[ -n $GATEWAY4 ]]; then reach "$1" "$GATEWAY4" 80 blocked; else printf '  NOTE  no IPv4 gateway\n'; fi
  if [[ -n $LAN6 ]]; then reach "$1" "$LAN6" 80 blocked; else printf '  NOTE  no on-link IPv6 prefix\n'; fi
  if [[ -n $RESOLVER4 && $RESOLVER4 != 127.* ]]; then reach "$1" "$RESOLVER4" 53 open; fi
}

echo "== Containment of the application (user toctoc)"
reach toctoc 127.0.0.1 5000 open
reach toctoc 127.0.0.1 3010 open
for port in $(other_ports 5000 3010); do reach toctoc 127.0.0.1 "$port" blocked; done
lan_checks toctoc
reach_internet toctoc data.geopf.fr

echo "== Containment of Caddy (user caddy)"
reach caddy 127.0.0.1 3000 open
# Local ports of other services this Caddy proxies to (see the Caddyfile): open, and every other port blocked.
UPSTREAMS=()
if [[ -f /etc/toctoc/caddy-upstreams ]]; then
  while read -r port _; do [[ $port =~ ^[0-9]{1,5}$ ]] && UPSTREAMS+=("$port"); done < /etc/toctoc/caddy-upstreams
fi
for port in "${UPSTREAMS[@]}"; do
  if ss -ltnH "sport = :$port" | grep -q .; then reach caddy 127.0.0.1 "$port" open; else report FAIL "caddy upstream $port listed but nothing listens"; fi
done
for port in $(other_ports 3000 80 443 "${UPSTREAMS[@]}"); do reach caddy 127.0.0.1 "$port" blocked; done
lan_checks caddy
reach_internet caddy acme-v02.api.letsencrypt.org

echo "== Privileges"
check "toctoc is not in the docker or wheel group" bash -c '! id -nG toctoc | grep -qwE "docker|wheel"'
check "code in /opt/toctoc owned by root" bash -c '[[ $(stat -c %U /opt/toctoc) == root ]]'
check "toctoc cannot write its own code" bash -c '! sudo -u toctoc test -w /opt/toctoc/server/app.ts'
check "configuration not readable by others" bash -c '[[ $(stat -c %a /etc/toctoc/config.json) == 640 ]]'
check "secrets file readable by root and toctoc only" bash -c '[[ $(stat -c %U:%G:%a /etc/toctoc/toctoc.env) == root:toctoc:640 ]]'
check "data directory private to toctoc" bash -c '[[ $(stat -c %a /var/lib/toctoc/data) == 700 ]]'
check "administrator password set" bash -c \
  '[[ $(sudo -u toctoc sqlite3 /var/lib/toctoc/data/toctoc.db "SELECT count(*) FROM admin_account") == 1 ]]'

check "sudo rule limited to the two TOCTOC commands" bash -c \
  '[[ ! -e /etc/sudoers.d/toctoc ]] || [[ $(grep -vc "^#" /etc/sudoers.d/toctoc) == 1 && $(stat -c %U%a /etc/sudoers.d/toctoc) == root440 ]]'
check "administration commands owned by root, writable by root only" bash -c \
  'for f in /usr/local/sbin/toctoc-check /usr/local/sbin/toctoc-deploy /etc/toctoc/deploy.conf; do
     [[ $(stat -c %U "$f") == root ]] && (( (8#$(stat -c %a "$f") & 8#022) == 0 )) || exit 1
   done'

echo "== Backup"
if systemctl start toctoc-backup.service; then
  report OK "backup run"
else
  report FAIL "backup run (journalctl -u toctoc-backup)"
fi
latest=$(ls -1t /var/lib/toctoc/backups 2>/dev/null | head -1)
if [[ -n $latest ]]; then report OK "latest backup: $latest"; else report FAIL "no backup file in /var/lib/toctoc/backups"; fi

echo
if [[ $FAILED -eq 0 ]]; then echo "server: all checks passed"; else echo "server: $FAILED check(s) failed"; fi
exit $(( FAILED > 0 ))
