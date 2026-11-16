#!/usr/bin/env bash
# Build an OSRM dataset with the running profile (osrm/running.lua).
#
#   osrm/build.sh <region.osm.pbf> <out-dir>
#   osrm-routed --algorithm mld --port 5003 <out-dir>/region.osrm
#
# running.lua require()s OSRM's stock profile helpers (lib/*.lua), which must
# sit next to it, so the profile and the stock lib/ are copied into out-dir.
# Override the stock profile location with OSRM_PROFILES=/path/to/profiles.
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 <region.osm.pbf> <out-dir>" >&2; exit 2; }
PBF="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
OUT="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
PROFILES="${OSRM_PROFILES:-$(brew --prefix osrm-backend 2>/dev/null)/share/osrm/profiles}"
[ -d "$PROFILES/lib" ] || { echo "stock OSRM profiles not found at $PROFILES" >&2; exit 1; }

mkdir -p "$OUT"
rm -rf "$OUT/lib"
cp -R "$PROFILES/lib" "$OUT/lib"
cp "$HERE/running.lua" "$OUT/running.lua"
ln -sf "$PBF" "$OUT/region.osm.pbf"
cd "$OUT"
osrm-extract -p running.lua region.osm.pbf
osrm-partition region.osrm
osrm-customize region.osrm
echo "built $OUT/region.osrm"
