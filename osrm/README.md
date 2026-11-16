# Running-profile routing server

The public `router.project-osrm.org` only serves OSRM's **car** profile (it
ignores `/foot/` in the URL), and its usage policy — like FOSSGIS's
`routing.openstreetmap.de` — is "max 1 request/second, no heavy use", while
one route generation makes ~30 route requests, ~12 at once. Real walking
routes therefore need a server of our own. `running.lua` is the profile for
it; see the header comment there and CLAUDE.md #62 for what it changes vs
OSRM's stock `foot.lua` (bike paths, street names over sidewalks, runner
preferences, turn cost, no ferries, response classes).

## Build and serve locally (macOS, Homebrew OSRM 26.4.1)

```sh
curl -LO https://download.geofabrik.de/north-america/us/new-york-latest.osm.pbf
osrm/build.sh new-york-latest.osm.pbf ~/osrm-data/run       # ~3 min, ~3.6 GB peak RAM
osrm-routed --algorithm mld --port 5003 ~/osrm-data/run/region.osrm   # ~1.9 GB RSS
```

Quality harness against it:

```sh
npx tsx lib/__tests__/route-quality-harness.ts --synthetic --no-snapshot --only nyc- \
  --osrm-base http://localhost:5003/route/v1/foot --profile running
```

`--profile running` matters: it switches the app's profile-dependent
calibration (distance overhead, `continue_straight`, street-share
denominator). The class-aware off-street gate keys off the response itself.

## Deploy

Any host that runs a container with ~3 GB RAM works (New York State extract:
2.8 GB of `.osrm` files, ~1.9 GB resident). `Dockerfile` builds the dataset
into the image:

```sh
docker build -t run-routes-osrm osrm/      # needs ~4 GB RAM for osrm-extract
docker run -p 5000:5000 run-routes-osrm
```

Requirements for the phone to use it:
- **HTTPS.** iOS App Transport Security blocks plain HTTP. `osrm-routed`
  speaks HTTP only, so put it behind a TLS-terminating proxy (Caddy, nginx)
  or a platform that terminates TLS for you.
- **Coverage.** The server only knows its extract. Starts outside it must
  use the public router; the app does that automatically from the coverage
  box (below). The NY State extract does not include New Jersey — use a
  larger Geofabrik extract (e.g. `us-northeast`, more RAM) if Jersey City /
  Hoboken starts matter.
- **Freshness.** Rebuild periodically (monthly is plenty) to pick up OSM edits.

## Point the app at it

In `lib/osrm.ts`, set `RUNNING_SERVER`:

```ts
const RUNNING_SERVER = {
  base: 'https://routes.example.com/route/v1/foot',
  coverage: { minLat: 40.49, maxLat: 40.92, minLng: -74.27, maxLng: -73.68 }, // NYC
};
```

Generations starting inside `coverage` use the running profile; everything
else keeps the public car router. JS-only change, so it ships with
`eas update` (no new TestFlight build). Before shipping, run the CLAUDE.md
pre-flight checklist against the deployed server, including ≥5 manual
generations on a device.
