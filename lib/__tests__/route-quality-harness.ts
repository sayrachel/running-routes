/**
 * Route quality harness — runs generateOSRMRoutes against a fixture set of
 * real (location, distance, routeType, prefs) combos using live OSRM and
 * Overpass, then scores each result on quality dimensions and asserts hard
 * thresholds.
 *
 * Usage:
 *   npx ts-node lib/__tests__/route-quality-harness.ts
 *   npx ts-node lib/__tests__/route-quality-harness.ts --only nyc-les
 *
 * Exits with code 1 if any fixture fails — wire into CI / pre-build hooks.
 */

import * as fs from 'fs';
import * as path from 'path';
import { generateOSRMRoutes, retraceRatio, overlapSegmentRatio, haversineDistance, calculateSearchRadius, dumpOSRMCache, loadOSRMCache, setOSRMCacheMax, setOSRMMock, setDeterministicSeed, countStubs, countPendantLoops, setOSRMBase, clearOSRMCache } from '../osrm';
import { fetchGreenSpacesAndHighways, dumpOverpassCaches, loadOverpassCaches, prefillOverpassCaches } from '../overpass';
import { computeGreenSpaceProximity, turnCount } from '../route-scoring';
import type { RoutePoint, RoutePreferences } from '../route-generator';
import { enableTrace, flushTrace, type TraceEvent } from '../debug-trace';
import { syntheticForCenter } from './fixtures/synthetic-green-spaces';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Overpass enforces a per-IP rate limit; spacing requests avoids 429 storms
// that would force every fixture down the geometric-fallback path.
const FIXTURE_DELAY_MS = 3000;

// Snapshot path for record-and-replay. Committed to the repo so the harness
// runs offline (no Overpass quota burned, deterministic across machines).
const SNAPSHOT_PATH = path.join(__dirname, 'fixtures', 'overpass-snapshot.json');

interface Fixture {
  name: string;
  center: RoutePoint;
  distanceMi: number;
  routeType: 'loop' | 'out-and-back' | 'point-to-point';
  prefs: RoutePreferences;
  end?: RoutePoint;
}

const MI_PER_KM = 0.621371;
const KM_PER_MI = 1.60934;

// Fixture set — picked for diversity: dense urban grid, hilly, waterfront,
// suburban-ish. Distances span the realistic request range.
const FIXTURES: Fixture[] = [
  // NYC — dense Manhattan grid
  { name: 'nyc-les-3mi-loop-quiet',     center: { lat: 40.715, lng: -73.985 }, distanceMi: 3, routeType: 'loop',         prefs: { lowTraffic: true } },
  { name: 'nyc-les-3mi-loop-relaxed',   center: { lat: 40.715, lng: -73.985 }, distanceMi: 3, routeType: 'loop',         prefs: { lowTraffic: false } },
  { name: 'nyc-les-4mi-loop-quiet',     center: { lat: 40.715, lng: -73.985 }, distanceMi: 4, routeType: 'loop',         prefs: { lowTraffic: true } },
  { name: 'nyc-les-6mi-loop-quiet',     center: { lat: 40.715, lng: -73.985 }, distanceMi: 6, routeType: 'loop',         prefs: { lowTraffic: true } },
  { name: 'nyc-les-3mi-out-quiet',      center: { lat: 40.715, lng: -73.985 }, distanceMi: 3, routeType: 'out-and-back', prefs: { lowTraffic: true } },
  { name: 'nyc-columbus-5mi-loop',      center: { lat: 40.768, lng: -73.982 }, distanceMi: 5, routeType: 'loop',         prefs: { lowTraffic: false } },
  { name: 'nyc-williamsburg-4mi-loop',  center: { lat: 40.714, lng: -73.961 }, distanceMi: 4, routeType: 'loop',         prefs: { lowTraffic: true } },
  // N. Williamsburg / Greenpoint — Build 23 user-reported spur (small westward
  // detour to Marsha P. Johnson State Park strip). Start matches actual
  // production blue-dot location, not the existing south-Williamsburg fixture.
  { name: 'nyc-greenpoint-4mi-loop-quiet', center: { lat: 40.718, lng: -73.961 }, distanceMi: 4, routeType: 'loop',     prefs: { lowTraffic: true } },
  { name: 'nyc-greenpoint-3mi-loop-quiet', center: { lat: 40.718, lng: -73.961 }, distanceMi: 3, routeType: 'loop',     prefs: { lowTraffic: true } },
  { name: 'nyc-greenpoint-5mi-loop-quiet', center: { lat: 40.718, lng: -73.961 }, distanceMi: 5, routeType: 'loop',     prefs: { lowTraffic: true } },

  // More out-and-back coverage — only one before this. OAB routes have
  // distinct algorithm path (skip lollipop, exempt retrace/overlap/stubs)
  // so under-coverage means OAB regressions hide.
  { name: 'nyc-east-village-3mi-out',   center: { lat: 40.7280, lng: -73.9920 }, distanceMi: 3, routeType: 'out-and-back', prefs: { lowTraffic: false } },
  { name: 'nyc-east-village-5mi-out',   center: { lat: 40.7280, lng: -73.9920 }, distanceMi: 5, routeType: 'out-and-back', prefs: { lowTraffic: true  } },
  { name: 'nyc-greenpoint-4mi-out',     center: { lat: 40.718,  lng: -73.961  }, distanceMi: 4, routeType: 'out-and-back', prefs: { lowTraffic: true  } },
  { name: 'nyc-uws-5mi-out',            center: { lat: 40.7850, lng: -73.9750 }, distanceMi: 5, routeType: 'out-and-back', prefs: { lowTraffic: false } },

  // Popular runner starts — INSIDE Central Park, on Hudson Greenway, etc.
  // Production users overwhelmingly start from these locations; absence of
  // coverage hid the dense-park-interior cases.
  { name: 'nyc-central-park-3mi-loop',  center: { lat: 40.7829, lng: -73.9654 }, distanceMi: 3, routeType: 'loop',         prefs: { lowTraffic: false } },
  { name: 'nyc-central-park-6mi-loop',  center: { lat: 40.7829, lng: -73.9654 }, distanceMi: 6, routeType: 'loop',         prefs: { lowTraffic: false } },
  { name: 'nyc-hudson-greenway-5mi',    center: { lat: 40.7720, lng: -73.9930 }, distanceMi: 5, routeType: 'out-and-back', prefs: { lowTraffic: false } },
  { name: 'nyc-prospect-park-4mi-loop', center: { lat: 40.6602, lng: -73.9690 }, distanceMi: 4, routeType: 'loop',         prefs: { lowTraffic: false } },

  // Edge distances — half-miles and 7mi (the harness only had whole miles
  // 1-6,8,10). These uncover cases where the geometric scaling lands at
  // an awkward intermediate radius.
  { name: 'nyc-east-village-1_5mi-loop', center: { lat: 40.7280, lng: -73.9920 }, distanceMi: 1.5, routeType: 'loop', prefs: { lowTraffic: true } },
  { name: 'nyc-greenpoint-2_5mi-loop',   center: { lat: 40.718,  lng: -73.961  }, distanceMi: 2.5, routeType: 'loop', prefs: { lowTraffic: true } },
  { name: 'nyc-columbus-7mi-loop',       center: { lat: 40.768,  lng: -73.982  }, distanceMi: 7,   routeType: 'loop', prefs: { lowTraffic: false } },

  // SF — hills + waterfront
  { name: 'sf-embarcadero-4mi-loop',    center: { lat: 37.795, lng: -122.394 }, distanceMi: 4, routeType: 'loop',         prefs: { lowTraffic: false } },
  { name: 'sf-embarcadero-3mi-out',     center: { lat: 37.795, lng: -122.394 }, distanceMi: 3, routeType: 'out-and-back', prefs: { lowTraffic: true } },

  // Chicago — lakefront grid
  { name: 'chi-lakefront-5mi-loop',     center: { lat: 41.886, lng: -87.616 }, distanceMi: 5, routeType: 'loop',         prefs: { lowTraffic: true } },
  { name: 'chi-lakefront-4mi-out',      center: { lat: 41.886, lng: -87.616 }, distanceMi: 4, routeType: 'out-and-back', prefs: { lowTraffic: false } },

  // LA — sprawling suburban-feel
  { name: 'la-venice-3mi-loop',         center: { lat: 33.991, lng: -118.464 }, distanceMi: 3, routeType: 'loop',         prefs: { lowTraffic: true } },
  { name: 'la-venice-5mi-loop',         center: { lat: 33.991, lng: -118.464 }, distanceMi: 5, routeType: 'loop',         prefs: { lowTraffic: false } },

  // Boston — irregular old-city street grid
  { name: 'bos-back-bay-3mi-loop',      center: { lat: 42.350, lng: -71.080 }, distanceMi: 3, routeType: 'loop',         prefs: { lowTraffic: true } },
  { name: 'bos-back-bay-4mi-loop',      center: { lat: 42.350, lng: -71.080 }, distanceMi: 4, routeType: 'loop',         prefs: { lowTraffic: false } },

  // Distance edge cases — short and long
  { name: 'nyc-les-1mi-loop-quiet',     center: { lat: 40.715, lng: -73.985 }, distanceMi: 1, routeType: 'loop',         prefs: { lowTraffic: true } },
  { name: 'nyc-les-2mi-loop-quiet',     center: { lat: 40.715, lng: -73.985 }, distanceMi: 2, routeType: 'loop',         prefs: { lowTraffic: true } },
  { name: 'nyc-columbus-8mi-loop',      center: { lat: 40.768, lng: -73.982 }, distanceMi: 8, routeType: 'loop',         prefs: { lowTraffic: false } },
  { name: 'nyc-columbus-10mi-loop',     center: { lat: 40.768, lng: -73.982 }, distanceMi: 10, routeType: 'loop',        prefs: { lowTraffic: true } },
  // Long-distance fixtures — exercise the multi-waypoint loop path
  // (≥14mi triggers 3 waypoints, ≥22mi triggers 4) and the 25km Overpass
  // bucket. Mock OSRM produces idealized geometry so these mostly verify
  // the algorithm isn't crashing or returning degenerate results; real
  // 30mi geometry needs a separate manual public-OSRM check.
  { name: 'nyc-columbus-15mi-loop',     center: { lat: 40.768, lng: -73.982 }, distanceMi: 15, routeType: 'loop',        prefs: { lowTraffic: false } },
  { name: 'nyc-columbus-20mi-loop',     center: { lat: 40.768, lng: -73.982 }, distanceMi: 20, routeType: 'loop',        prefs: { lowTraffic: false } },
  { name: 'nyc-columbus-30mi-loop',     center: { lat: 40.768, lng: -73.982 }, distanceMi: 30, routeType: 'loop',        prefs: { lowTraffic: false } },

  // East Village / NoHo — matches the user's screenshots showing block-
  // weaving, dead-end stubs, and figure-8 patterns. The dense Manhattan
  // grid is where mock geometry diverges most from real OSRM behavior, so
  // these only meaningfully run with --osrm-base pointing at local OSRM.
  { name: 'nyc-east-village-2mi-loop',  center: { lat: 40.7280, lng: -73.9920 }, distanceMi: 2, routeType: 'loop',       prefs: { lowTraffic: true } },
  { name: 'nyc-east-village-3mi-loop',  center: { lat: 40.7280, lng: -73.9920 }, distanceMi: 3, routeType: 'loop',       prefs: { lowTraffic: true } },
  { name: 'nyc-east-village-4mi-loop',  center: { lat: 40.7280, lng: -73.9920 }, distanceMi: 4, routeType: 'loop',       prefs: { lowTraffic: false } },
  { name: 'nyc-east-village-4mi-loop-quiet', center: { lat: 40.7280, lng: -73.9920 }, distanceMi: 4, routeType: 'loop',  prefs: { lowTraffic: true } },
  { name: 'nyc-east-village-6mi-loop',  center: { lat: 40.7280, lng: -73.9920 }, distanceMi: 6, routeType: 'loop',       prefs: { lowTraffic: false } },

  // Additional NYC neighborhoods — broader real-OSRM coverage. Each area
  // exposes different routing geometry: Tribeca/FiDi narrow streets and
  // water on three sides; UWS bordered by Central Park and Riverside;
  // UES bordered by Central Park and East River; Chelsea grid + Hudson;
  // Brooklyn Heights small grid + waterfront; DUMBO water-bounded.
  { name: 'nyc-tribeca-3mi-loop',       center: { lat: 40.7170, lng: -74.0080 }, distanceMi: 3, routeType: 'loop',       prefs: { lowTraffic: true } },
  { name: 'nyc-tribeca-5mi-loop',       center: { lat: 40.7170, lng: -74.0080 }, distanceMi: 5, routeType: 'loop',       prefs: { lowTraffic: false } },
  { name: 'nyc-uws-4mi-loop',           center: { lat: 40.7850, lng: -73.9750 }, distanceMi: 4, routeType: 'loop',       prefs: { lowTraffic: false } },
  { name: 'nyc-uws-6mi-loop',           center: { lat: 40.7850, lng: -73.9750 }, distanceMi: 6, routeType: 'loop',       prefs: { lowTraffic: true } },
  { name: 'nyc-ues-3mi-loop',           center: { lat: 40.7770, lng: -73.9580 }, distanceMi: 3, routeType: 'loop',       prefs: { lowTraffic: false } },
  { name: 'nyc-ues-5mi-loop',           center: { lat: 40.7770, lng: -73.9580 }, distanceMi: 5, routeType: 'loop',       prefs: { lowTraffic: true } },
  { name: 'nyc-chelsea-3mi-loop',       center: { lat: 40.7470, lng: -74.0020 }, distanceMi: 3, routeType: 'loop',       prefs: { lowTraffic: true } },
  { name: 'nyc-chelsea-5mi-loop',       center: { lat: 40.7470, lng: -74.0020 }, distanceMi: 5, routeType: 'loop',       prefs: { lowTraffic: false } },
  { name: 'nyc-brooklyn-heights-3mi',   center: { lat: 40.6960, lng: -73.9940 }, distanceMi: 3, routeType: 'loop',       prefs: { lowTraffic: true } },
  { name: 'nyc-dumbo-3mi-loop',         center: { lat: 40.7030, lng: -73.9890 }, distanceMi: 3, routeType: 'loop',       prefs: { lowTraffic: false } },
];

interface Thresholds {
  // Distance must be within ±X of target. Wider for short routes since
  // a 0.5mi shortfall is much more glaring on a 3mi than a 6mi route.
  maxDistanceErrorPct: number;
  // Hard cap on retraced distance (exact-coordinate match). Tightened from
  // 10% to 8% so harness rejects what users would visibly see as backtracking.
  maxRetraceRatio: number;
  // Hard cap on overlapping/parallel segments (catches OSRM-wobble retraces).
  // Tightened from 20% to 10% — anything above this ships routes the user
  // can see is not a single continuous path.
  // Out-and-back routes inherently overlap ~50%; we exempt them below.
  maxOverlapRatio: number;
  // Hard cap on dead-end stubs (small jutting-out segments). User-facing
  // requirement: ZERO stubs. Production code calls trimStubs() on every
  // route to enforce this; the harness threshold of 0 catches any case
  // where trimStubs misses a pattern.
  maxStubs: number;
  // Hard cap on pendant loops (closed sub-loop attached by a single
  // bridge segment traversed twice — see countPendantLoops). User-facing
  // requirement: ZERO. Production hard-rejects any candidate with one;
  // the harness threshold of 0 catches any case where the chosen route
  // somehow still has one (e.g. step-3.5 fallback).
  maxPendantLoops: number;
}

const DEFAULT_THRESHOLDS: Thresholds = {
  maxDistanceErrorPct: 0.20,
  maxRetraceRatio: 0.08,
  maxOverlapRatio: 0.10,
  maxStubs: 0,
  maxPendantLoops: 0,
};

interface RouteMetrics {
  distanceMi: number;
  distanceErrorPct: number;
  retraceRatio: number;
  overlapRatio: number;
  pointCount: number;
  /** True if Overpass returned real data (i.e. the green-space algorithm was actually exercised). */
  hasOverpassData: boolean;
  /** True if OSRM was mocked (deterministic stand-in, not the public endpoint). */
  osrmMocked: boolean;
  /** Fraction of route points within 200m of any green space (0–1). Spot-check
   *  whether routes that were *named* for a green space actually pass near it. */
  greenProximity: number;
  /** Number of named green-space anchors used by the chosen route — 0 means
   *  the algorithm fell through to the geometric fallback (anchorless). */
  anchorCount: number;
  /** Count of dead-end stubs (visible "small jutting line" pattern). >0 means
   *  the route forces the runner into a dead-end and back. */
  stubs: number;
  /** Count of pendant loops (closed sub-loops attached by a single bridge
   *  segment traversed twice — visually a small square hanging off a stem,
   *  unrunnable as a single continuous path without doubling back). Production
   *  hard-rejects any candidate with one; >0 here means the chosen route
   *  came from a path that bypassed the reject (e.g. geometric fallback). */
  pendantLoops: number;
  /** True if the algorithm fell through to step 3.5 (geometric bearing-trial
   *  fallback) instead of selecting an OSRM-routed anchored candidate. This
   *  is a strong negative signal whenever Overpass returned green spaces:
   *  step 3.5 produces anchorless geometric routes that are strictly worse
   *  than even moderately-retracey anchored alternatives. Catches the East
   *  Village 4mi class of regression where the hard-reject was tightened
   *  enough to kill all anchored candidates. */
  chosenFromFallback: boolean;
  /** Per-reason count of how many candidates were rejected during step 3.
   *  A high `backtrack` count combined with `chosenFromFallback=true` is
   *  the smoking gun for "hard-reject too aggressive for this area". */
  rejectionCounts: { distance: number; barrier: number; highway: number; backtrack: number; pendantLoop: number; osrmNull: number };
  /** Turns per km — number of ≥45° heading changes per route km. Reported
   *  for measurement only (no threshold yet); tracking turn density to size
   *  a future scoring penalty for zigzag/staircase routes that pass distance
   *  + retrace + overlap thresholds but are exhausting to actually run. */
  turnsPerKm: number;
}

interface FixtureResult {
  fixture: Fixture;
  pass: boolean;
  /** True when OSRM has no coverage for this area (loaded data is region-
   *  bounded). Skipped fixtures don't count as failures — they're just
   *  outside the test environment's reach. */
  skipped?: boolean;
  failures: string[];
  metrics: RouteMetrics | null;
  error?: string;
  trace?: TraceEvent[];
  routePoints?: RoutePoint[];
}

function applyThresholds(f: Fixture, m: RouteMetrics): string[] {
  const failures: string[] = [];
  const t = DEFAULT_THRESHOLDS;

  // Hard rounding check: the user-facing distance label is rounded to the
  // nearest integer mile — if a 4mi request rounds to "3 mi" or "5 mi" in
  // the UI, the user thinks they got the wrong route. Stricter than the ±20%
  // distanceErrorPct check (which is a coarse guard against catastrophic
  // failures like the pre-fix 1.95mi-for-4mi-target bug).
  // Skipped for non-integer distances (1.5mi, 2.5mi etc) — those are
  // exploratory fixtures probing edge-distance behavior; the round check
  // only applies to whole-mile requests where the UI shows "X mi".
  if (Number.isInteger(f.distanceMi)) {
    const rounded = Math.round(m.distanceMi);
    if (rounded !== f.distanceMi) {
      failures.push(
        `rounds to ${rounded}mi, not requested ${f.distanceMi}mi ` +
        `(actual ${m.distanceMi.toFixed(2)}mi — needs to be ` +
        `[${(f.distanceMi - 0.5).toFixed(1)}, ${(f.distanceMi + 0.5).toFixed(1)}))`
      );
    }
  }

  if (m.distanceErrorPct > t.maxDistanceErrorPct) {
    failures.push(
      `distance ${m.distanceMi.toFixed(2)}mi vs target ${f.distanceMi.toFixed(2)}mi ` +
      `(${(m.distanceErrorPct * 100).toFixed(0)}% off, max ${(t.maxDistanceErrorPct * 100).toFixed(0)}%)`
    );
  }
  // Out-and-back routes legitimately retrace the outbound path on the way
  // back — that's the whole point. Exempting both retrace and overlap.
  if (f.routeType !== 'out-and-back' && m.retraceRatio > t.maxRetraceRatio) {
    failures.push(
      `retrace ${(m.retraceRatio * 100).toFixed(0)}% > ${(t.maxRetraceRatio * 100).toFixed(0)}%`
    );
  }
  if (f.routeType !== 'out-and-back' && m.overlapRatio > t.maxOverlapRatio) {
    failures.push(
      `overlap ${(m.overlapRatio * 100).toFixed(0)}% > ${(t.maxOverlapRatio * 100).toFixed(0)}%`
    );
  }
  // Out-and-back routes have an intentional U-turn at the far end which
  // countStubs detects — that's expected, not a UX failure. Loops should
  // have zero stubs.
  if (f.routeType !== 'out-and-back' && m.stubs > t.maxStubs) {
    failures.push(
      `${m.stubs} dead-end stubs (max ${t.maxStubs}) — runner can't follow as one path`
    );
  }
  // Pendant loops are NEVER acceptable for loop routes — the polyline can't
  // be physically run end-to-end without doubling back across the bridge.
  // Out-and-back exempt (its return leg looks like a pendant of every segment).
  if (f.routeType !== 'out-and-back' && m.pendantLoops > t.maxPendantLoops) {
    failures.push(
      `${m.pendantLoops} pendant loops (max ${t.maxPendantLoops}) — closed sub-loop attached by single bridge, unrunnable as one path`
    );
  }
  // Step-3.5-fired-when-anchored check. The classic mode of regression that
  // pure metric thresholds miss: the chosen route's distance/retrace/stubs
  // can all look fine on their own, but it came from the geometric bearing-
  // trial fallback because every anchored candidate was rejected. The user
  // sees an anchorless "Sidestreet Shuffle" rectangle in an area with parks
  // 200m away. Only fail when Overpass actually returned data — fixtures in
  // green-space-poor areas legitimately use the fallback.
  if (m.chosenFromFallback && m.hasOverpassData) {
    const breakdown = `backtrack=${m.rejectionCounts.backtrack}, pendant-loop=${m.rejectionCounts.pendantLoop}, ` +
      `distance=${m.rejectionCounts.distance}, barrier=${m.rejectionCounts.barrier}, ` +
      `highway=${m.rejectionCounts.highway}, osrm-null=${m.rejectionCounts.osrmNull}`;
    failures.push(
      `step-3.5 fallback fired despite Overpass data — anchored candidates rejected (${breakdown})`
    );
  }
  return failures;
}

/** Build a geojson.io URL that renders the route polyline. Inline-encoded so
 *  no upload is needed — paste into a browser to SEE the route geometry. */
function geojsonIoUrl(points: RoutePoint[]): string {
  const coords = points.map((p) => [p.lng, p.lat]);
  const geojson = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: coords },
    }],
  };
  return `https://geojson.io/#data=data:application/json,${encodeURIComponent(JSON.stringify(geojson))}`;
}

/** Stable hash of a fixture name → integer seed. Two runs on the same fixture
 *  produce identical waypoint variants, so any change in output reflects an
 *  algorithm change, not RNG noise. */
function fixtureSeed(name: string): number {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

async function runFixture(f: Fixture, captureTrace: boolean, useSynthetic: boolean, mockOsrm: boolean, deterministic: boolean): Promise<FixtureResult> {
  const distKm = f.distanceMi * KM_PER_MI;
  // Always enable trace — `chosenFromFallback` and rejection counts feed pass
  // criteria, not just the optional --dump output. The trace buffer is small
  // (~12 events per fixture) so the cost is negligible.
  enableTrace();
  if (deterministic) setDeterministicSeed(fixtureSeed(f.name));
  // Clear OSRM cache between fixtures in deterministic mode. Otherwise an
  // earlier fixture's cached route at the same waypoints (e.g. a popular
  // intersection in the city grid) leaks into a later fixture's resolution
  // and the harness becomes order-dependent — a single-fixture run produces
  // different outputs than the same fixture in a full sweep.
  if (deterministic) clearOSRMCache();

  // In synthetic mode, seed the Overpass caches with hand-crafted green
  // spaces for this location BEFORE the algorithm runs. Lets us exercise the
  // green-space-first path end-to-end when Overpass is unavailable. Real
  // cache hits (from a recorded snapshot) take precedence — we only prefill
  // if no synthetic data exists for this center.
  if (useSynthetic) {
    const synthetic = syntheticForCenter(f.center.lat, f.center.lng);
    if (synthetic) {
      const radiusKm = calculateSearchRadius(f.routeType, distKm, f.center, f.end);
      prefillOverpassCaches(f.center, radiusKm, synthetic, []);
    }
  }
  try {
    // Pre-fetch Overpass so we can flag whether the algorithm got real data.
    // Use the same radius the production path will use so the in-process cache
    // hits and generateOSRMRoutes doesn't make a second Overpass call.
    const radiusKm = calculateSearchRadius(f.routeType, distKm, f.center, f.end);
    const op = await fetchGreenSpacesAndHighways(f.center, radiusKm);
    const hasOverpassData = op.greenSpaces.length > 0 || op.highwayPoints.length > 0;

    const routes = await generateOSRMRoutes(f.center, distKm, f.routeType, 1, f.prefs, f.end);
    const trace = flushTrace();
    if (routes.length === 0) {
      return {
        fixture: f, pass: false, failures: ['no routes generated'], metrics: null,
        trace: captureTrace ? trace : undefined,
      };
    }
    const r = routes[0];
    const points = r.points;
    let actualKm = 0;
    for (let i = 1; i < points.length; i++) actualKm += haversineDistance(points[i - 1], points[i]);
    const actualMi = actualKm * MI_PER_KM;

    // Detect "OSRM has no coverage" — the local OSRM is region-loaded (e.g.
    // NYC-only) and fixtures outside that region degrade to raw waypoints
    // (3–4 points, near-zero routed distance). Skip them rather than
    // counting as algorithm failures, so the report focuses on real bugs.
    if (points.length < 10 && actualKm < 0.5) {
      return {
        fixture: f, pass: true, skipped: true,
        failures: [`SKIP: OSRM has no coverage for this region (${points.length} pts, ${actualKm.toFixed(2)}km)`],
        metrics: null,
        trace: captureTrace ? trace : undefined,
      };
    }
    // Anchor count inferred from the route name. The named-route formats are
    // "X & Y Loop" / "X to Y" / "X Loop" / "X Out & Back" / "via X"; generic-
    // name routes are "City Loop" / "Quiet Lanes" etc. (geometric fallback).
    const isGenericName = /^(City Loop|Urban Circuit|Downtown Explorer|Coastal Breeze Route|Bridge Connector|Meadow Circuit|Backstreet Run|Quiet Lanes|Residential Circuit|Sidestreet Shuffle|Neighborhood Loop|Peaceful Path)$/i.test(r.name);
    const anchorCount = isGenericName ? 0 : (/\s&\s|\sto\s/.test(r.name) ? 2 : 1);
    // Walk the trace once to derive `chosenFromFallback` and rejection
    // breakdown. `fallback-start` fires inside step 3.5 — its presence means
    // the algorithm dropped to geometric bearing-trial routing because every
    // step-3 candidate was rejected. That's the "Sidestreet Shuffle" anchorless
    // rectangle pattern in the East Village 4mi screenshot.
    const rejectionCounts = { distance: 0, barrier: 0, highway: 0, backtrack: 0, pendantLoop: 0, osrmNull: 0 };
    let chosenFromFallback = false;
    for (const e of trace) {
      if (e.event === 'fallback-start') chosenFromFallback = true;
      if (e.event === 'candidate-rejected') {
        const reason = (e.data as { reason?: string })?.reason;
        if (reason === 'distance') rejectionCounts.distance++;
        else if (reason === 'barrier') rejectionCounts.barrier++;
        else if (reason === 'highway') rejectionCounts.highway++;
        else if (reason === 'backtrack') rejectionCounts.backtrack++;
        else if (reason === 'pendant-loop') rejectionCounts.pendantLoop++;
        else if (reason === 'osrm-null') rejectionCounts.osrmNull++;
      }
    }
    const metrics: RouteMetrics = {
      distanceMi: actualMi,
      distanceErrorPct: Math.abs(actualMi - f.distanceMi) / f.distanceMi,
      retraceRatio: retraceRatio(points),
      overlapRatio: overlapSegmentRatio(points),
      pointCount: points.length,
      hasOverpassData,
      osrmMocked: mockOsrm,
      greenProximity: computeGreenSpaceProximity(points, op.greenSpaces),
      anchorCount,
      stubs: countStubs(points),
      pendantLoops: countPendantLoops(points),
      chosenFromFallback,
      rejectionCounts,
      turnsPerKm: actualKm > 0 ? turnCount(points) / actualKm : 0,
    };
    const failures = applyThresholds(f, metrics);
    return {
      fixture: f, pass: failures.length === 0, failures, metrics,
      trace: captureTrace ? trace : undefined,
      routePoints: captureTrace ? points : undefined,
    };
  } catch (err: any) {
    return {
      fixture: f, pass: false, failures: [`error: ${err?.message ?? err}`], metrics: null,
      trace: captureTrace ? flushTrace() : undefined,
    };
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function fmtRow(r: FixtureResult): string {
  const tag = r.skipped ? 'SKIP' : r.pass ? 'PASS' : 'FAIL';
  if (!r.metrics) return `${tag}  ${pad(r.fixture.name, 32)}  ${r.failures.join('; ')}`;
  const m = r.metrics;
  // Tag which path produced the result so a glance at the row tells you
  // whether you're looking at real-algorithm output or a degraded path.
  // [mock] = synthetic OSRM stand-in (algorithm exercised, geometry fake)
  // [fb]   = geometric fallback (Overpass returned no green spaces)
  // [s3.5] = step 3.5 bearing-trial fallback fired (anchored candidates
  //         rejected — strongest signal that a hard-reject threshold is
  //         too aggressive for this area).
  const dataTag = m.chosenFromFallback ? '[s3.5]'
    : !m.hasOverpassData ? '[fb]  '
    : m.osrmMocked ? '[mock]'
    : '      ';
  const summary =
    `dist=${m.distanceMi.toFixed(2)}mi(${(m.distanceErrorPct * 100).toFixed(0)}%)  ` +
    `retr=${(m.retraceRatio * 100).toFixed(0)}%  ` +
    `over=${(m.overlapRatio * 100).toFixed(0)}%  ` +
    `stubs=${m.stubs}  ` +
    `pend=${m.pendantLoops}  ` +
    `t/km=${m.turnsPerKm.toFixed(1)}  ` +
    `green=${(m.greenProximity * 100).toFixed(0)}%  ` +
    `anch=${m.anchorCount}  ` +
    `pts=${m.pointCount}`;
  // Show per-reason rejection breakdown only when something interesting
  // happened — otherwise it's noise on every clean PASS row.
  const rc = m.rejectionCounts;
  const totalRejects = rc.distance + rc.barrier + rc.highway + rc.backtrack + rc.pendantLoop + rc.osrmNull;
  const rejectStr = totalRejects > 0
    ? `  rej={bt=${rc.backtrack},pl=${rc.pendantLoop},d=${rc.distance},h=${rc.highway},b=${rc.barrier},n=${rc.osrmNull}}`
    : '';
  const tail = r.failures.length ? `  -- ${r.failures.join('; ')}` : '';
  return `${tag}  ${dataTag}${pad(r.fixture.name, 32)}  ${summary}${rejectStr}${tail}`;
}

interface SnapshotCounts { enriched: number; highway: number; osrm: number }

function loadSnapshot(): SnapshotCounts {
  if (!fs.existsSync(SNAPSHOT_PATH)) return { enriched: 0, highway: 0, osrm: 0 };
  try {
    const data = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    loadOverpassCaches(data);
    // OSRM section is optional — older snapshots don't have it. Loading it
    // here lets the harness replay route geometry without hitting the live
    // OSRM endpoint, removing flakiness from public-router timeouts.
    if (data.osrm) loadOSRMCache(data.osrm);
    return {
      enriched: data.enriched?.length ?? 0,
      highway: data.highway?.length ?? 0,
      osrm: data.osrm?.routes?.length ?? 0,
    };
  } catch (err) {
    console.warn(`Snapshot load failed (${SNAPSHOT_PATH}): ${(err as Error).message}`);
    return { enriched: 0, highway: 0, osrm: 0 };
  }
}

function saveSnapshot(): SnapshotCounts {
  const dir = path.dirname(SNAPSHOT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Drop empty entries — those are failed/rate-limited Overpass calls that
  // shouldn't be cached as "this location has no green spaces". Skipping them
  // lets the next quality:record run retry just the unfilled fixtures.
  const overpass = dumpOverpassCaches();
  const osrm = dumpOSRMCache();
  const snap = {
    enriched: overpass.enriched.filter(([, v]) => v.length > 0),
    highway: overpass.highway.filter(([, v]) => v.length > 0),
    osrm,
  };
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snap, null, 2));
  return { enriched: snap.enriched.length, highway: snap.highway.length, osrm: osrm.routes.length };
}

async function main() {
  const argv = process.argv.slice(2);
  const onlyIdx = argv.indexOf('--only');
  let only: string | null = null;
  if (onlyIdx >= 0) {
    // Guard against shell newline-splits like `--only\n  nyc-les-3mi` where
    // the value never reaches argv. Without this, an undefined value silently
    // disables the filter and the harness runs all 15 fixtures.
    const next = argv[onlyIdx + 1];
    if (!next || next.startsWith('--')) {
      console.error(`--only requires a fixture name (got ${next ? next : 'no value'})`);
      process.exit(2);
    }
    only = next;
  }
  const record = argv.includes('--record');
  const noSnapshot = argv.includes('--no-snapshot');
  const useSynthetic = argv.includes('--synthetic');
  // Mock OSRM with a deterministic stand-in. Default-on with --synthetic
  // because the recorded OSRM cache is keyed by exact waypoint URLs — the
  // moment synthetic green spaces pick different waypoints than what was
  // recorded, the cache misses and we fall through to the rate-limited
  // public endpoint, which is the whole problem we're trying to dodge.
  // --osrm-base http://localhost:5000 points at a self-hosted OSRM (real
  // road geometry, no public-endpoint rate limits). Implies --no-mock-osrm
  // since we want the real backend, not the synthetic mock.
  const osrmBaseIdx = argv.indexOf('--osrm-base');
  let osrmBase: string | null = null;
  if (osrmBaseIdx >= 0) {
    const next = argv[osrmBaseIdx + 1];
    if (!next || next.startsWith('--')) {
      console.error(`--osrm-base requires a URL (e.g. http://localhost:5000/route/v1/foot)`);
      process.exit(2);
    }
    osrmBase = next;
  }
  const noMockOsrm = argv.includes('--no-mock-osrm') || osrmBase !== null;
  const mockOsrm = !noMockOsrm && (argv.includes('--mock-osrm') || useSynthetic);
  // Deterministic seeding: default-on for any harness backend that's itself
  // deterministic (mocked OSRM OR a local OSRM via --osrm-base OR synthetic
  // green spaces). Without this, getSeed() falls back to Date.now() and
  // back-to-back harness runs picked completely different candidates — the
  // pre-Build-23 harness was silently non-deterministic and obscured whether
  // a change moved pass rate or just shifted the RNG. Production (no
  // --osrm-base, no --synthetic) keeps random seeding so users see fresh
  // routes on refresh.
  const noDeterministic = argv.includes('--no-deterministic');
  const deterministic = !noDeterministic && (argv.includes('--deterministic') || mockOsrm || useSynthetic || osrmBase !== null);
  const dumpIdx = argv.indexOf('--dump');
  let dumpPath: string | null = null;
  if (dumpIdx >= 0) {
    const next = argv[dumpIdx + 1];
    if (!next || next.startsWith('--')) {
      console.error(`--dump requires a file path (got ${next ? next : 'no value'})`);
      process.exit(2);
    }
    dumpPath = next;
  }

  const fixtures = only ? FIXTURES.filter((f) => f.name.includes(only!)) : FIXTURES;
  if (fixtures.length === 0) {
    console.error(`No fixtures matched --only ${only}`);
    process.exit(2);
  }

  // Disable OSRM LRU eviction during the harness run so a 15-fixture record
  // captures every distinct waypoint URL — production uses a small cap for
  // memory bounds, but the snapshot needs to be complete.
  setOSRMCacheMax(5000);

  if (mockOsrm) setOSRMMock(true);
  if (osrmBase) setOSRMBase(osrmBase);

  // Skip OSRM cache when mocking — the recorded URLs are stale (they
  // correspond to a different algorithm version's waypoints) and loading
  // them would mask whatever the current algorithm picks.
  const loaded = noSnapshot || mockOsrm
    ? { enriched: 0, highway: 0, osrm: 0 }
    : loadSnapshot();
  if (noSnapshot || mockOsrm) {
    // Still load Overpass entries when mocking — they give the real algo
    // green-space data for locations that aren't in the synthetic fixtures.
    if (!noSnapshot && fs.existsSync(SNAPSHOT_PATH)) {
      try {
        const data = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
        loadOverpassCaches({ enriched: data.enriched, highway: data.highway });
        loaded.enriched = data.enriched?.length ?? 0;
        loaded.highway = data.highway?.length ?? 0;
      } catch { /* fall through with zeros */ }
    }
  }
  const mode = record ? 'RECORD (will hit live network for any cache misses)' : 'REPLAY (cache hits skip the network)';
  const synth = useSynthetic ? ' + SYNTHETIC green spaces' : '';
  const osrmTag = mockOsrm ? ' + MOCK OSRM' : (osrmBase ? ` + LOCAL OSRM (${osrmBase})` : '');
  const detTag = deterministic ? ' + DETERMINISTIC' : '';
  console.log(`Running ${fixtures.length} fixture(s) — mode: ${mode}${synth}${osrmTag}${detTag}`);
  console.log(`Snapshot: ${loaded.enriched} green / ${loaded.highway} highway / ${loaded.osrm} OSRM entries loaded from ${SNAPSHOT_PATH}\n`);

  const results: FixtureResult[] = [];
  for (let i = 0; i < fixtures.length; i++) {
    const r = await runFixture(fixtures[i], dumpPath !== null, useSynthetic, mockOsrm, deterministic);
    results.push(r);
    console.log(fmtRow(r));
    // Only sleep between fixtures we expect to hit the network. In replay
    // mode (no record + cache loaded), all calls are local and we can rip.
    // Mocked OSRM also never hits the network for routing.
    const willHitNetwork = record || (!mockOsrm && !r.metrics?.hasOverpassData);
    if (i < fixtures.length - 1 && willHitNetwork) await sleep(FIXTURE_DELAY_MS);
  }

  if (record) {
    const saved = saveSnapshot();
    console.log(`\nSaved snapshot: ${saved.enriched} green / ${saved.highway} highway / ${saved.osrm} OSRM entries`);
  }

  if (dumpPath) {
    const dump = results.map((r) => ({
      name: r.fixture.name,
      input: r.fixture,
      pass: r.pass,
      failures: r.failures,
      metrics: r.metrics,
      // Visualization URLs so I can SEE routes, not just measure them.
      // Past harness iterations only reported numbers — block-weaving and
      // dead-end stubs are invisible to numeric metrics. geojson.io renders
      // the polyline directly.
      visualizeUrl: r.routePoints && r.routePoints.length > 0
        ? geojsonIoUrl(r.routePoints)
        : null,
      trace: r.trace ?? [],
      routePoints: r.routePoints ?? [],
    }));
    fs.writeFileSync(dumpPath, JSON.stringify(dump, null, 2));
    console.log(`\nDumped trace for ${dump.length} fixture(s) to ${dumpPath}`);
  }

  const skipped = results.filter((r) => r.skipped).length;
  const evaluated = results.filter((r) => !r.skipped);
  const passed = evaluated.filter((r) => r.pass).length;
  const failed = evaluated.length - passed;
  const fallback = results.filter((r) => r.metrics && !r.metrics.hasOverpassData).length;
  console.log('');
  console.log(`Summary: ${passed}/${evaluated.length} passed, ${failed} failed` +
    (skipped > 0 ? `, ${skipped} skipped (no OSRM coverage)` : '') +
    (fallback > 0 ? `  (${fallback} hit geometric-fallback path — Overpass unavailable for those)` : ''));

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exit(2);
});
