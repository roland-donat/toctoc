#!/usr/bin/env bash
# Prepares the OSRM foot-profile street network of Séné and its surroundings (KTD1).
#
# Usage: deploy/osrm/prepare-sene.sh <data-dir>
#
# <data-dir> must live outside the repository (for example ~/.local/share/toctoc/routing).
# Layout produced:
#   <data-dir>/osm/bretagne-latest.osm.pbf   Geofabrik extract, downloaded once
#   <data-dir>/osm/sene.osm.pbf              bounding-box cut around Séné
#   <data-dir>/osrm/sene.osrm.*              OSRM MLD files served by osrm-routed
#
# Pass --refresh as second argument to download a fresh Geofabrik extract.
set -euo pipefail

OSRM_IMAGE="ghcr.io/project-osrm/osrm-backend:v6.0.0"
OSMIUM_IMAGE="toctoc-osmium:bookworm"
EXTRACT_URL="https://download.geofabrik.de/europe/france/bretagne-latest.osm.pbf"
# Commune of Séné (BAN extent lon -2.784..-2.701, lat 47.590..47.656) plus 2 to 4 km of margin,
# so that loops near the commune boundary still find their streets.
BBOX="-2.82,47.57,-2.64,47.69"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <data-dir> [--refresh]" >&2
  exit 2
fi

mkdir -p "$1"
DATA_DIR="$(cd "$1" && pwd -P)"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
case "$DATA_DIR/" in
  "$REPO_ROOT"/*)
    echo "error: data dir $DATA_DIR is inside the repository; choose a directory outside it" >&2
    exit 1
    ;;
esac

mkdir -p "$DATA_DIR/osm" "$DATA_DIR/osrm"
PBF="$DATA_DIR/osm/bretagne-latest.osm.pbf"
CUT="$DATA_DIR/osm/sene.osm.pbf"
USER_ARGS=(--user "$(id -u):$(id -g)")

if [[ ! -f "$PBF" || "${2:-}" == "--refresh" ]]; then
  echo "Downloading $EXTRACT_URL"
  curl -fL --retry 3 -o "$PBF.part" "$EXTRACT_URL"
  mv "$PBF.part" "$PBF"
fi

if command -v osmium >/dev/null 2>&1; then
  osmium extract --overwrite --bbox "$BBOX" --strategy complete_ways -o "$CUT" "$PBF"
else
  if ! docker image inspect "$OSMIUM_IMAGE" >/dev/null 2>&1; then
    echo "Building $OSMIUM_IMAGE (osmium-tool from Debian)"
    docker build -t "$OSMIUM_IMAGE" - <<'DOCKERFILE'
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends osmium-tool && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["osmium"]
DOCKERFILE
  fi
  docker run --rm "${USER_ARGS[@]}" -v "$DATA_DIR/osm:/data" "$OSMIUM_IMAGE" \
    extract --overwrite --bbox "$BBOX" --strategy complete_ways -o /data/sene.osm.pbf /data/bretagne-latest.osm.pbf
fi

rm -f "$DATA_DIR"/osrm/sene.osrm*
cp "$CUT" "$DATA_DIR/osrm/sene.osm.pbf"
run_osrm() {
  docker run --rm "${USER_ARGS[@]}" -v "$DATA_DIR/osrm:/data" "$OSRM_IMAGE" "$@"
}
run_osrm osrm-extract -p /opt/foot.lua /data/sene.osm.pbf
run_osrm osrm-partition /data/sene.osrm
run_osrm osrm-customize /data/sene.osrm
rm -f "$DATA_DIR/osrm/sene.osm.pbf"

echo "OSRM foot data ready in $DATA_DIR/osrm (restart the osrm service to load it)"
