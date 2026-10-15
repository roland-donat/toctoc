# Sourced by bin/toctoc-deploy and bin/toctoc-check-cyber: which server, under which name. The values belong to
# one installation and stay out of the repository, in the `.env` file at its root (ignored by git, see
# .env.example), or in ~/.config/toctoc/deploy.env:
#
#   TOCTOC_DEPLOY_HOST=mon-serveur          # ssh destination of the server
#   TOCTOC_DOMAIN=toctoc.example.org        # public name served in HTTPS
#   TOCTOC_BACKUP_RECIPIENT=age1...         # public key printed by bin/toctoc backup-key
TOCTOC_REPO_ENV="$ROOT/.env"
TOCTOC_DEPLOY_ENV="${TOCTOC_DEPLOY_ENV:-${XDG_CONFIG_HOME:-$HOME/.config}/toctoc/deploy.env}"
for env_file in "$TOCTOC_DEPLOY_ENV" "$TOCTOC_REPO_ENV"; do
  if [[ -f "$env_file" ]]; then
    if [[ -n "$(find "$env_file" -perm /o=r)" ]]; then
      echo "$env_file is readable by other accounts: chmod 600 it" >&2
      exit 1
    fi
    # shellcheck disable=SC1090
    source "$env_file"
  fi
done
: "${TOCTOC_DEPLOY_HOST:?set TOCTOC_DEPLOY_HOST in $TOCTOC_REPO_ENV (see .env.example)}"
: "${TOCTOC_DOMAIN:?set TOCTOC_DOMAIN in $TOCTOC_REPO_ENV (see .env.example)}"
