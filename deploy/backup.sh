#!/usr/bin/env bash
# Daily encrypted backup (U15), run by toctoc-backup.timer. A non-zero exit marks the systemd unit failed,
# which `systemctl --failed` and the Paramètres screen (date of the last success) make visible.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$ROOT/bin/toctoc" backup
