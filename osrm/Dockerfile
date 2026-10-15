# Self-contained OSRM routing service for hosts like Render: downloads a regional
# OpenStreetMap extract and builds the MLD graph at *image build* time, so no
# multi-GB dataset is committed to git (GitHub rejects files over 100 MB).
#
#   docker build -t carpool-osrm osrm        # Northern California cropped to the Bay Area (default)
#   docker build -t carpool-osrm osrm \
#     --build-arg PBF_URL=https://download.geofabrik.de/north-america/us/california/socal-latest.osm.pbf \
#     --build-arg BBOX="-118.7,33.6,-117.6,34.4"          # e.g. Los Angeles
#   docker build -t carpool-osrm osrm --build-arg BBOX=   # whole extract, no crop
#
# Measured: the default Bay Area crop is ~630 MB on disk and ~350 MB RSS after a
# first query (grows under load) — too tight for a 512 MB plan, fine on 1-2 GB.
# Trips outside the cropped area get
# no route and fall back to endpoint-radius matching.
# Pinned to the same version as docker-compose.yml so data and server match.
ARG PBF_URL=https://download.geofabrik.de/north-america/us/california/norcal-latest.osm.pbf

# The OSRM image has no curl/wget, so fetch the extract in a throwaway stage.
FROM debian:bookworm-slim AS download
ARG PBF_URL
# Optional "minLon,minLat,maxLon,maxLat" crop applied before the graph is built.
# The routing server holds the whole graph in RAM, so a smaller area is the main
# lever for fitting a small instance. Set BBOX="" to keep the full extract.
ARG BBOX="-122.65,37.15,-121.55,38.15"
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates osmium-tool && \
    rm -rf /var/lib/apt/lists/* && \
    curl -fL --retry 3 -o /full.osm.pbf "$PBF_URL" && \
    if [ -n "$BBOX" ]; then osmium extract --bbox "$BBOX" --strategy=smart -o /region.osm.pbf /full.osm.pbf; \
    else mv /full.osm.pbf /region.osm.pbf; fi

FROM osrm/osrm-backend:v5.25.0 AS build
COPY --from=download /region.osm.pbf /data/region.osm.pbf
RUN osrm-extract -p /opt/car.lua /data/region.osm.pbf && \
    osrm-partition /data/region.osrm && \
    osrm-customize /data/region.osrm && \
    rm /data/region.osm.pbf

FROM osrm/osrm-backend:v5.25.0
COPY --from=build /data /data
# Render supplies $PORT; fall back to OSRM's default locally.
ENV PORT=5000
EXPOSE 5000
CMD ["sh", "-c", "exec osrm-routed --algorithm mld --port ${PORT} /data/region.osrm"]
