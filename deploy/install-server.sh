#!/usr/bin/env bash
# First installation and redeployment of TOCTOC on its server (U15), as root. Idempotent: run it again to deploy a
# newer version. Everything it needs from the administrator's computer is staged beforehand in a private directory
# of the account that runs sudo (see docs/deploiement.md, "Préparation sur l'ordinateur de l'administrateur"):
#
#   <staging>/toctoc.bundle     git bundle of the main branch
#   <staging>/data/             optional, first install only: database and import files to start from
#   <staging>/routing/osrm/     optional: OSRM files of the commune, prepared by deploy/osrm/prepare-commune.sh
#
# Usage: sudo bash install-server.sh --domain <name> --recipient <age1...> --commune <insee> [--staging <dir>]
set -euo pipefail

DOMAIN=""
RECIPIENT=""
COMMUNE=""
STAGING=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --recipient) RECIPIENT="$2"; shift 2 ;;
    --commune) COMMUNE="$2"; shift 2 ;;
    --staging) STAGING="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "run as root (sudo)" >&2; exit 1; }
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || { echo "--domain: a host name such as toctoc.example.org" >&2; exit 2; }
[[ "$RECIPIENT" =~ ^age1[0-9a-z]+$ ]] || { echo "--recipient: the age public key (age1...) printed by bin/toctoc backup-key" >&2; exit 2; }
# A server installed before the commune became a setting keeps the one of its configuration.
if [[ -z "$COMMUNE" && -f /etc/toctoc/config.json ]]; then
  COMMUNE="$(sed -n 's/.*"commune_insee": *"\([0-9AB]*\)".*/\1/p' /etc/toctoc/config.json)"
fi
[[ "$COMMUNE" =~ ^([0-9]{5}|2[AB][0-9]{3})$ ]] || { echo "--commune: the INSEE code of the commune, such as 93014 (not its postal code)" >&2; exit 2; }
STAGING="${STAGING:-$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)/toctoc-staging}"
[[ -f "$STAGING/toctoc.bundle" ]] || { echo "no $STAGING/toctoc.bundle" >&2; exit 1; }

APP=/opt/toctoc
STATE=/var/lib/toctoc
ETC=/etc/toctoc
PNPM_VERSION=10.32.1
step() { printf '\n== %s\n' "$*"; }

step "Packages"
# No -y: on Arch a partial upgrade is unsupported. If a package is not found, run pacman -Syu first.
pacman -S --needed --noconfirm caddy docker docker-compose git nodejs npm base-devel sqlite rsync
command -v pnpm >/dev/null && [[ "$(pnpm --version)" == "$PNPM_VERSION" ]] || npm install -g "pnpm@$PNPM_VERSION"
systemctl enable --now docker
# Before Docker 28, a host of the same LAN segment could reach ports published on 127.0.0.1.
DOCKER_MAJOR="$(docker version --format '{{.Server.Version}}' | cut -d. -f1)"
[[ "$DOCKER_MAJOR" -ge 28 ]] || { echo "Docker $DOCKER_MAJOR is too old (28 or later needed)" >&2; exit 1; }

step "Service account and directories"
getent passwd toctoc >/dev/null || useradd --system --home-dir "$STATE" --shell /usr/bin/nologin toctoc
install -d -o toctoc -g toctoc -m 700 "$STATE" "$STATE/data" "$STATE/backups"
install -d -o root -g root -m 755 "$STATE/routing"
install -d -o root -g toctoc -m 750 "$ETC"

step "Egress containment (before anything of TOCTOC runs)"
# The files come from the bundle, read from a temporary clone.
TMP_REPO="$(mktemp -d)"
trap 'rm -rf "$TMP_REPO"' EXIT
git clone --quiet --branch main "$STAGING/toctoc.bundle" "$TMP_REPO/toctoc"
# Pristine copy, never touched by the service account: every file root installs or runs comes from here.
SRC="$TMP_REPO/toctoc"
install -m 644 "$SRC/deploy/system/toctoc-egress.nft" "$ETC/toctoc-egress.nft"
install -m 755 "$SRC/deploy/system/toctoc-egress.sh" "$ETC/toctoc-egress.sh"
install -m 644 "$SRC/deploy/system/toctoc-egress.service" /etc/systemd/system/toctoc-egress.service
systemctl daemon-reload
systemctl enable toctoc-egress.service
# Reload when already active: a restart would stop the application and Caddy, which require it.
systemctl is-active --quiet toctoc-egress.service && systemctl reload toctoc-egress.service || systemctl start toctoc-egress.service

step "Code"
if [[ ! -d "$APP/.git" ]]; then
  git clone --quiet --branch main "$STAGING/toctoc.bundle" "$APP"
else
  git -C "$APP" fetch --quiet "$STAGING/toctoc.bundle" main
  git -C "$APP" reset --quiet --hard FETCH_HEAD
fi
git config --system --get-all safe.directory | grep -qx "$APP" || git config --system --add safe.directory "$APP"
chown -R toctoc:toctoc "$APP"
# Built as the service account, so no package script ever runs as root; outbound traffic is already contained.
sudo -u toctoc -H bash -c "cd $APP && pnpm install --frozen-lockfile --prod=false && pnpm build"
# The service never writes its code: ProtectSystem=strict mounts /opt read-only, and the files belong to root.
chown -R root:toctoc "$APP"
chmod -R go-w "$APP"
# The build ran as toctoc: check it changed no tracked file before root uses anything from there.
if [[ -n "$(git -C "$APP" status --porcelain --untracked-files=no)" ]]; then
  echo "tracked files changed during the build, stopping" >&2
  exit 1
fi

step "Configuration"
CONFIG="$ETC/config.json"
cat > "$CONFIG.new" <<JSON
{
  "commune_insee": "$COMMUNE",
  "data_dir": "$STATE/data",
  "backup_dir": "$STATE/backups",
  "backup_recipient": "$RECIPIENT",
  "public_origin": "https://$DOMAIN",
  "server": { "port": 3000, "host": "127.0.0.1" },
  "routing": { "osrm_url": "http://127.0.0.1:5000", "vroom_url": "http://127.0.0.1:3010" }
}
JSON
install -o root -g toctoc -m 640 "$CONFIG.new" "$CONFIG"
rm -f "$CONFIG.new"
# Secrets and local overrides (TOCTOC_* variables, see .env.example) go to an environment file readable by the
# service account only, never to the repository. Created empty once, then left to the administrator.
if [[ ! -e "$ETC/toctoc.env" ]]; then
  printf '# TOCTOC secrets and overrides (TOCTOC_* variables, see .env.example). Readable by root and toctoc only.\n' > "$ETC/toctoc.env.new"
  install -o root -g toctoc -m 640 "$ETC/toctoc.env.new" "$ETC/toctoc.env"
  rm -f "$ETC/toctoc.env.new"
fi
chown root:toctoc "$ETC/toctoc.env"
chmod 640 "$ETC/toctoc.env"

step "Data"
if [[ -d "$STAGING/data" && ! -e "$STATE/data/toctoc.db" ]]; then
  cp -a "$STAGING/data/." "$STATE/data/"
  chown -R toctoc:toctoc "$STATE/data"
  chmod -R go-rwx "$STATE/data"
  # The copy comes from a development machine: its password and sessions never reach the internet. No login is
  # possible until set-password below.
  sudo -u toctoc sqlite3 "$STATE/data/toctoc.db" "DELETE FROM sessions; DELETE FROM admin_account;"
  # The staged copy holds nominative data: it does not stay in a home directory.
  find "$STAGING/data" -type f -exec shred -u {} +
  rm -rf "$STAGING/data"
  echo "database installed from the staged copy (staged copy shredded)"
elif [[ -d "$STAGING/data" ]]; then
  echo "a database already exists in $STATE/data: the staged copy is left untouched, not installed" >&2
elif [[ -e "$STATE/data/toctoc.db" ]]; then
  echo "existing database kept"
else
  echo "no staged data: the application starts empty"
fi

step "Routing (OSRM and VROOM, on 127.0.0.1 only)"
if [[ -d "$STAGING/routing/osrm" ]]; then
  rsync -a --delete "$STAGING/routing/osrm/" "$STATE/routing/osrm/"
fi
# OSRM files are served as toctoc.osrm.*: files prepared under another name by an earlier version are renamed.
if ! compgen -G "$STATE/routing/osrm/toctoc.osrm*" >/dev/null; then
  mapfile -t bases < <(find "$STATE/routing/osrm" -maxdepth 1 -name '*.osrm' -printf '%f\n' 2>/dev/null)
  if [[ ${#bases[@]} -eq 1 ]]; then
    old="${bases[0]%.osrm}"
    for f in "$STATE/routing/osrm/$old".osrm*; do mv "$f" "${f/\/$old.osrm/\/toctoc.osrm}"; done
  fi
fi
if ! compgen -G "$STATE/routing/osrm/toctoc.osrm*" >/dev/null; then
  "$SRC/deploy/osrm/prepare-commune.sh" "$STATE/routing" "$COMMUNE"
fi
# The images come from ghcr.io; on a slow or flaky link a pull can be reset midway. Layers already fetched are kept,
# so retrying resumes where the previous attempt stopped.
for attempt in 1 2 3 4 5; do
  TOCTOC_ROUTING_DATA="$STATE/routing" docker compose -f "$APP/deploy/docker-compose.routing.yml" pull --quiet && break
  [[ $attempt -eq 5 ]] && { echo "image pull failed 5 times: run this script again" >&2; exit 1; }
  echo "image pull interrupted, retrying ($attempt/5)" >&2
  sleep 10
done
TOCTOC_ROUTING_DATA="$STATE/routing" docker compose -f "$APP/deploy/docker-compose.routing.yml" up -d
# The app reaches the routing services through their 127.0.0.1 ports, as it will in production.
for _ in $(seq 1 60); do
  # Any HTTP answer means osrm-routed has loaded its files, wherever the commune is.
  [[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5000/ 2>/dev/null)" != 000 ]] && break
  sleep 2
done

step "Services"
install -m 644 "$SRC/deploy/toctoc.service" "$SRC/deploy/toctoc-backup.service" "$SRC/deploy/toctoc-backup.timer" /etc/systemd/system/
install -d -m 755 /etc/caddy /etc/systemd/system/caddy.service.d
printf 'TOCTOC_DOMAIN=%s\n' "$DOMAIN" > /etc/caddy/toctoc.env
install -m 644 "$SRC/deploy/Caddyfile" /etc/caddy/Caddyfile
install -m 644 "$SRC/deploy/caddy-toctoc.conf" /etc/systemd/system/caddy.service.d/toctoc.conf
systemctl daemon-reload
systemctl enable toctoc.service toctoc-backup.timer caddy.service
# Repeated redeploys must not leave a service stuck on the start rate limit of systemd.
systemctl reset-failed toctoc.service caddy.service 2>/dev/null || true
systemctl restart toctoc.service
systemctl restart caddy.service
systemctl start toctoc-backup.timer

step "Administration commands"
# Read-only checks and redeployment, root-owned copies from the pristine clone (never from /opt/toctoc, which the
# service account owns while it builds). /etc/sudoers.d/toctoc lets the administrator account run them without
# password and without argument, so bin/toctoc-deploy and bin/toctoc-check-cyber need no interactive sudo.
install -m 755 "$SRC/deploy/check-server.sh" /usr/local/sbin/toctoc-check
install -m 755 "$SRC/deploy/system/toctoc-deploy" /usr/local/sbin/toctoc-deploy
printf 'DOMAIN=%q\nRECIPIENT=%q\nCOMMUNE=%q\nSTAGING=%q\n' "$DOMAIN" "$RECIPIENT" "$COMMUNE" "$STAGING" > "$ETC/deploy.conf.new"
install -m 644 "$ETC/deploy.conf.new" "$ETC/deploy.conf"
rm -f "$ETC/deploy.conf.new"
if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != root ]]; then
  printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/toctoc-deploy "", /usr/local/sbin/toctoc-check ""\n' "$SUDO_USER" > /etc/sudoers.d/toctoc.new
  chmod 440 /etc/sudoers.d/toctoc.new
  if visudo -cqf /etc/sudoers.d/toctoc.new; then mv /etc/sudoers.d/toctoc.new /etc/sudoers.d/toctoc; else rm -f /etc/sudoers.d/toctoc.new; echo "sudoers rule rejected by visudo, not installed" >&2; fi
fi

step "Checks"
for _ in $(seq 1 30); do
  curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS http://127.0.0.1:3000/api/health && echo
systemctl --no-pager --lines=0 status toctoc-egress.service toctoc.service caddy.service | grep -E "●|Active:"
if [[ "$(sudo -u toctoc sqlite3 "$STATE/data/toctoc.db" "SELECT count(*) FROM admin_account" 2>/dev/null)" != 1 ]]; then
  echo
  echo "Next: set the administrator password (asked twice):"
  echo "  sudo -u toctoc env TOCTOC_CONFIG=$CONFIG TOCTOC_ENV_FILE=$ETC/toctoc.env $APP/bin/toctoc set-password"
fi
