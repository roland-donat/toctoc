#!/usr/bin/env bash
# Prepares the OSRM foot-profile street network of one commune and its surroundings (KTD1).
#
# Usage: deploy/osrm/prepare-commune.sh <data-dir> <insee-code> [--refresh] [--pois-only]
#   e.g. deploy/osrm/prepare-commune.sh ~/.local/share/toctoc/routing 93014    (Clichy-sous-Bois)
#
# <insee-code> is the INSEE code of the commune (TOCTOC_COMMUNE_INSEE), not its postal code.
# <data-dir> must live outside the repository (for example ~/.local/share/toctoc/routing).
# The outline of the commune comes from the public commune API (geo.api.gouv.fr), queried with the code only; the
# street network from the regional OpenStreetMap extract of Geofabrik. Layout produced:
#   <data-dir>/osm/<region>-latest.osm.pbf   Geofabrik extract, downloaded once
#   <data-dir>/osm/commune.osm.pbf           bounding-box cut around the commune
#   <data-dir>/osrm/toctoc.osrm.*            OSRM MLD files served by osrm-routed
#   <data-dir>/pois/commerces-osm.json       shop fronts of the area, loaded from the Imports screen
#
# --refresh downloads a fresh Geofabrik extract; --pois-only extracts the shop fronts and leaves OSRM untouched.
set -euo pipefail

OSRM_IMAGE="ghcr.io/project-osrm/osrm-backend:v6.0.0"
OSMIUM_IMAGE="toctoc-osmium:bookworm"
# Margin around the outline of the commune, in kilometres, so that loops near its boundary still find their streets.
MARGIN_KM=3

# Geofabrik extract holding a department (Geofabrik keeps the former regions of France).
region_of() {
  case "$1" in
    67|68) echo alsace ;;
    24|33|40|47|64) echo aquitaine ;;
    03|15|43|63) echo auvergne ;;
    14|50|61) echo basse-normandie ;;
    21|58|71|89) echo bourgogne ;;
    22|29|35|56) echo bretagne ;;
    18|28|36|37|41|45) echo centre ;;
    08|10|51|52) echo champagne-ardenne ;;
    2A|2B) echo corse ;;
    25|39|70|90) echo franche-comte ;;
    27|76) echo haute-normandie ;;
    75|77|78|91|92|93|94|95) echo ile-de-france ;;
    11|30|34|48|66) echo languedoc-roussillon ;;
    19|23|87) echo limousin ;;
    54|55|57|88) echo lorraine ;;
    09|12|31|32|46|65|81|82) echo midi-pyrenees ;;
    59|62) echo nord-pas-de-calais ;;
    44|49|53|72|85) echo pays-de-la-loire ;;
    02|60|80) echo picardie ;;
    16|17|79|86) echo poitou-charentes ;;
    04|05|06|13|83|84) echo provence-alpes-cote-d-azur ;;
    01|07|26|38|42|69|73|74) echo rhone-alpes ;;
    971) echo guadeloupe ;;
    972) echo martinique ;;
    973) echo guyane ;;
    974) echo reunion ;;
    976) echo mayotte ;;
    *) return 1 ;;
  esac
}

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <data-dir> <insee-code> [--refresh]" >&2
  exit 2
fi
INSEE="$2"
REFRESH=""
POIS_ONLY=""
for flag in "${@:3}"; do
  case "$flag" in
    --refresh) REFRESH=1 ;;
    --pois-only) POIS_ONLY=1 ;;
    *) echo "unknown option: $flag" >&2; exit 2 ;;
  esac
done
[[ "$INSEE" =~ ^([0-9]{5}|2[AB][0-9]{3})$ ]] || { echo "error: $INSEE is not an INSEE commune code (e.g. 93014, not a postal code)" >&2; exit 2; }
if [[ "$INSEE" == 97* ]]; then DEPARTMENT="${INSEE:0:3}"; else DEPARTMENT="${INSEE:0:2}"; fi
REGION="$(region_of "$DEPARTMENT")" || { echo "error: no Geofabrik extract known for department $DEPARTMENT" >&2; exit 1; }
EXTRACT_URL="https://download.geofabrik.de/europe/france/$REGION-latest.osm.pbf"

# Bounding box of the outline of the commune, widened by MARGIN_KM.
COMMUNE_JSON="$(curl -fsS --retry 3 "https://geo.api.gouv.fr/communes/$INSEE?fields=nom,contour")" \
  || { echo "error: commune $INSEE not found in the commune API" >&2; exit 1; }
read -r COMMUNE_NAME BBOX < <(node -e '
  const c = JSON.parse(process.argv[1]); const margin = Number(process.argv[2])
  const flat = (a) => (typeof a[0] === "number" ? [a] : a.flatMap(flat))
  const pts = flat(c.contour.coordinates)
  const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1])
  const dLat = margin / 111, dLon = margin / (111 * Math.cos((Math.max(...lats) * Math.PI) / 180))
  const f = (x) => x.toFixed(4)
  const box = [f(Math.min(...lons) - dLon), f(Math.min(...lats) - dLat), f(Math.max(...lons) + dLon), f(Math.max(...lats) + dLat)]
  console.log(c.nom.replace(/\s+/g, "_"), box.join(","))
' "$COMMUNE_JSON" "$MARGIN_KM")
echo "Commune $INSEE (${COMMUNE_NAME//_/ }), area $BBOX, extract $REGION"

mkdir -p "$1"
DATA_DIR="$(cd "$1" && pwd -P)"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
case "$DATA_DIR/" in
  "$REPO_ROOT"/*)
    echo "error: data dir $DATA_DIR is inside the repository; choose a directory outside it" >&2
    exit 1
    ;;
esac

mkdir -p "$DATA_DIR/osm" "$DATA_DIR/osrm" "$DATA_DIR/pois"
PBF="$DATA_DIR/osm/$REGION-latest.osm.pbf"
CUT="$DATA_DIR/osm/commune.osm.pbf"
USER_ARGS=(--user "$(id -u):$(id -g)")

if [[ ! -f "$PBF" || -n "$REFRESH" ]]; then
  echo "Downloading $EXTRACT_URL"
  curl -fL --retry 3 -o "$PBF.part" "$EXTRACT_URL"
  mv "$PBF.part" "$PBF"
fi

# osmium from the machine, else from a local image built from the Debian package; paths relative to <data-dir>/osm.
run_osmium() {
  if command -v osmium >/dev/null 2>&1; then
    (cd "$DATA_DIR/osm" && osmium "$@")
    return
  fi
  if ! docker image inspect "$OSMIUM_IMAGE" >/dev/null 2>&1; then
    echo "Building $OSMIUM_IMAGE (osmium-tool from Debian)"
    docker build -t "$OSMIUM_IMAGE" - <<'DOCKERFILE'
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends osmium-tool && rm -rf /var/lib/apt/lists/*
WORKDIR /data
ENTRYPOINT ["osmium"]
DOCKERFILE
  fi
  docker run --rm "${USER_ARGS[@]}" -v "$DATA_DIR/osm:/data" -w /data "$OSMIUM_IMAGE" "$@"
}

run_osmium extract --overwrite --bbox "$BBOX" --strategy complete_ways -o commune.osm.pbf "$REGION-latest.osm.pbf"

# Shop fronts: shops, commercial amenities, offices and hotels. Public data, no personal data.
run_osmium tags-filter --overwrite -o commerces.osm.pbf commune.osm.pbf nwr/shop nwr/office nwr/tourism=hotel \
  nwr/amenity=restaurant,fast_food,cafe,bar,pub,pharmacy,bank,post_office,doctors,dentist,clinic,veterinary,bureau_de_change,ice_cream,nightclub,cinema,fuel,car_wash
run_osmium export --overwrite -f geojsonseq --format-option=print_record_separator=false --add-unique-id=type_id \
  --geometry-types=point,polygon -o commerces.geojsonseq commerces.osm.pbf
node -e '
  const fs = require("node:fs")
  const out = []
  for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
    if (!line.trim()) continue
    const f = JSON.parse(line)
    const t = f.properties || {}
    const key = ["shop", "amenity", "office", "tourism"].find((k) => t[k])
    if (!key || !/^[nwr][0-9]+$/.test(String(f.id))) continue
    const ring = f.geometry.type === "Point" ? [f.geometry.coordinates]
      : f.geometry.type === "Polygon" ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0]
    const lon = ring.reduce((s, p) => s + p[0], 0) / ring.length
    const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length
    out.push({ id: String(f.id), kind: key + "=" + t[key], lat: +lat.toFixed(6), lon: +lon.toFixed(6),
      housenumber: t["addr:housenumber"] || null, street: t["addr:street"] || null })
  }
  fs.writeFileSync(process.argv[2] + ".part", JSON.stringify(out))
  fs.renameSync(process.argv[2] + ".part", process.argv[2])
  console.log(out.length + " shop fronts in " + process.argv[2])
' "$DATA_DIR/osm/commerces.geojsonseq" "$DATA_DIR/pois/commerces-osm.json"
rm -f "$DATA_DIR/osm/commerces.osm.pbf" "$DATA_DIR/osm/commerces.geojsonseq"
[[ -n "$POIS_ONLY" ]] && exit 0

rm -f "$DATA_DIR"/osrm/toctoc.osrm*
cp "$CUT" "$DATA_DIR/osrm/toctoc.osm.pbf"
run_osrm() {
  docker run --rm "${USER_ARGS[@]}" -v "$DATA_DIR/osrm:/data" "$OSRM_IMAGE" "$@"
}
run_osrm osrm-extract -p /opt/foot.lua /data/toctoc.osm.pbf
run_osrm osrm-partition /data/toctoc.osrm
run_osrm osrm-customize /data/toctoc.osrm
rm -f "$DATA_DIR/osrm/toctoc.osm.pbf"

echo "OSRM foot data ready in $DATA_DIR/osrm (restart the osrm service to load it)"
