# Self-contained OSRM routing service for hosts like Render: downloads a regional
# OpenStreetMap extract and builds the MLD graph at *image build* time, so no
# multi-GB dataset is committed to git (GitHub rejects files over 100 MB).
#
#   docker build -t carpool-osrm osrm                      # all of the US (default)
#   docker build -t carpool-osrm osrm --build-arg PBF_URL=<other geofabrik .osm.pbf>
#
# Resource warning: the US extract is ~10 GB. Building the graph needs on the
# order of 64 GB RAM and several hours, and serving it needs tens of GB of RAM;
# managed hosts' standard plans can't do that. Prefer building the image on a
# large machine, or pass a smaller PBF_URL (a state or metro) for Render.
# Pinned to the same version as docker-compose.yml so data and server match.
ARG PBF_URL=https://download.geofabrik.de/north-america/us-latest.osm.pbf

# The OSRM image has no curl/wget, so fetch the extract in a throwaway stage.
FROM alpine:3.20 AS download
ARG PBF_URL
RUN apk add --no-cache curl && curl -fL --retry 3 -o /region.osm.pbf "$PBF_URL"

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
