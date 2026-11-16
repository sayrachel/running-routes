# Running-profile OSRM server for run-routes (see osrm/README.md).
#
#   docker build -t run-routes-osrm osrm/
#   docker run -p 5000:5000 run-routes-osrm
#
# running.lua was written against osrm-backend 26.4.1's profile helpers
# (lib/way_handlers.lua etc.); keep OSRM_VERSION on a matching release.
# The official image ships the stock profiles and their lib/ under /opt.
ARG OSRM_VERSION=v26.4.1

FROM ghcr.io/project-osrm/osrm-backend:${OSRM_VERSION} AS build
ARG PBF_URL=https://download.geofabrik.de/north-america/us/new-york-latest.osm.pbf
WORKDIR /data
ADD ${PBF_URL} /data/region.osm.pbf
COPY running.lua /opt/running.lua
RUN osrm-extract -p /opt/running.lua /data/region.osm.pbf \
 && osrm-partition /data/region.osrm \
 && osrm-customize /data/region.osrm \
 && rm /data/region.osm.pbf

FROM ghcr.io/project-osrm/osrm-backend:${OSRM_VERSION}
COPY --from=build /data /data
EXPOSE 5000
CMD ["osrm-routed", "--algorithm", "mld", "--port", "5000", "/data/region.osrm"]
