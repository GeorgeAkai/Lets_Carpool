#!/usr/bin/env bash
# One-time (and re-run to refresh) preparation of the self-hosted OSRM dataset.
# Downloads a regional OpenStreetMap extract and builds the MLD routing graph
# into ./osrm-data, which the `osrm` service in docker-compose.yml then serves.
#
#   OSRM_PBF_URL=https://download.geofabrik.de/north-america/us/massachusetts-latest.osm.pbf \
#     scripts/osrm-prepare.sh
#
# The extract must cover every region drivers/riders will search in. Default is
# Northern California (set OSRM_PBF_URL for socal or another region); pick a smaller or different one from https://download.geofabrik.de.
set -euo pipefail

cd "$(dirname "$0")/.."
PBF_URL="${OSRM_PBF_URL:-https://download.geofabrik.de/north-america/us/california/norcal-latest.osm.pbf}"
IMAGE="osrm/osrm-backend:v5.25.0"
DATA_DIR="$PWD/osrm-data"

mkdir -p "$DATA_DIR"
echo "Downloading $PBF_URL"
curl -fL --retry 3 -o "$DATA_DIR/region.osm.pbf" "$PBF_URL"

run() { docker run --rm -t -v "$DATA_DIR:/data" "$IMAGE" "$@"; }
run osrm-extract -p /opt/car.lua /data/region.osm.pbf
run osrm-partition /data/region.osrm
run osrm-customize /data/region.osrm
echo "Done. Start routing with: docker compose up -d osrm"
