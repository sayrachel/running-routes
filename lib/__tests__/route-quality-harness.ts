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

import { generateOSRMRoutes, retraceRatio, overlapSegmentRatio, haversineDistance, calculateSearchRadius } from '../osrm';
import { fetchGreenSpacesAndHighways } from '../overpass';
import type { RoutePoint, RoutePreferences } from '../route-generator';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Overpass enforces a per-IP rate limit; spacing requests avoids 429 storms
// that would force every fixture down the geometric-fallback path.
const FIXTURE_DELAY_MS = 3000;

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
];

interface Thresholds {
  // Distance must be within ±X of target. Wider for short routes since
  // a 0.5mi shortfall is much more glaring on a 3mi than a 6mi route.
  maxDistanceErrorPct: number;
  // Hard cap on retraced distance (exact-coordinate match)
  maxRetraceRatio: number;
  // Hard cap on overlapping/parallel segments (catches OSRM-wobble retraces)
  // Out-and-back routes inherently overlap ~50%; we exempt them below.
  maxOverlapRatio: number;
}

const DEFAULT_THRESHOLDS: Thresholds = {
  maxDistanceErrorPct: 0.20,
  maxRetraceRatio: 0.10,
  maxOverlapRatio: 0.20,
};

interface RouteMetrics {
  distanceMi: number;
  distanceErrorPct: number;
  retraceRatio: number;
  overlapRatio: number;
  pointCount: number;
  /** True if Overpass returned real data (i.e. the green-space algorithm was actually exercised). */
  hasOverpassData: boolean;
}

interface FixtureResult {
  fixture: Fixture;
  pass: boolean;
  failures: string[];
  metrics: RouteMetrics | null;
  error?: string;
}

function applyThresholds(f: Fixture, m: RouteMetrics): string[] {
  const failures: string[] = [];
  const t = DEFAULT_THRESHOLDS;

  if (m.distanceErrorPct > t.maxDistanceErrorPct) {
    failures.push(
      `distance ${m.distanceMi.toFixed(2)}mi vs target ${f.distanceMi.toFixed(2)}mi ` +
      `(${(m.distanceErrorPct * 100).toFixed(0)}% off, max ${(t.maxDistanceErrorPct * 100).toFixed(0)}%)`
    );
  }
  if (m.retraceRatio > t.maxRetraceRatio) {
    failures.push(
      `retrace ${(m.retraceRatio * 100).toFixed(0)}% > ${(t.maxRetraceRatio * 100).toFixed(0)}%`
    );
  }
  // Out-and-back routes legitimately retrace ~50% of distance.
  if (f.routeType !== 'out-and-back' && m.overlapRatio > t.maxOverlapRatio) {
    failures.push(
      `overlap ${(m.overlapRatio * 100).toFixed(0)}% > ${(t.maxOverlapRatio * 100).toFixed(0)}%`
    );
  }
  return failures;
}

async function runFixture(f: Fixture): Promise<FixtureResult> {
  const distKm = f.distanceMi * KM_PER_MI;
  try {
    // Pre-fetch Overpass so we can flag whether the algorithm got real data.
    // Use the same radius the production path will use so the in-process cache
    // hits and generateOSRMRoutes doesn't make a second Overpass call.
    const radiusKm = calculateSearchRadius(f.routeType, distKm, f.center, f.end);
    const op = await fetchGreenSpacesAndHighways(f.center, radiusKm);
    const hasOverpassData = op.greenSpaces.length > 0 || op.highwayPoints.length > 0;

    const routes = await generateOSRMRoutes(f.center, distKm, f.routeType, 1, f.prefs, f.end);
    if (routes.length === 0) {
      return { fixture: f, pass: false, failures: ['no routes generated'], metrics: null };
    }
    const r = routes[0];
    const points = r.points;
    let actualKm = 0;
    for (let i = 1; i < points.length; i++) actualKm += haversineDistance(points[i - 1], points[i]);
    const actualMi = actualKm * MI_PER_KM;
    const metrics: RouteMetrics = {
      distanceMi: actualMi,
      distanceErrorPct: Math.abs(actualMi - f.distanceMi) / f.distanceMi,
      retraceRatio: retraceRatio(points),
      overlapRatio: overlapSegmentRatio(points),
      pointCount: points.length,
      hasOverpassData,
    };
    const failures = applyThresholds(f, metrics);
    return { fixture: f, pass: failures.length === 0, failures, metrics };
  } catch (err: any) {
    return { fixture: f, pass: false, failures: [`error: ${err?.message ?? err}`], metrics: null };
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function fmtRow(r: FixtureResult): string {
  const tag = r.pass ? 'PASS' : 'FAIL';
  if (!r.metrics) return `${tag}  ${pad(r.fixture.name, 32)}  ${r.failures.join('; ')}`;
  const m = r.metrics;
  // Annotate fallback path so we can tell which results reflect the real
  // algorithm vs. the geometric-fallback path (when Overpass was down/429).
  const dataTag = m.hasOverpassData ? '     ' : '[fb] ';
  const summary =
    `dist=${m.distanceMi.toFixed(2)}mi(${(m.distanceErrorPct * 100).toFixed(0)}%)  ` +
    `retr=${(m.retraceRatio * 100).toFixed(0)}%  ` +
    `over=${(m.overlapRatio * 100).toFixed(0)}%  ` +
    `pts=${m.pointCount}`;
  const tail = r.failures.length ? `  -- ${r.failures.join('; ')}` : '';
  return `${tag}  ${dataTag}${pad(r.fixture.name, 32)}  ${summary}${tail}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;

  const fixtures = only ? FIXTURES.filter((f) => f.name.includes(only)) : FIXTURES;
  if (fixtures.length === 0) {
    console.error(`No fixtures matched --only ${only}`);
    process.exit(2);
  }

  console.log(`Running ${fixtures.length} fixture(s) against live OSRM + Overpass...\n`);

  const results: FixtureResult[] = [];
  for (let i = 0; i < fixtures.length; i++) {
    const r = await runFixture(fixtures[i]);
    results.push(r);
    console.log(fmtRow(r));
    if (i < fixtures.length - 1) await sleep(FIXTURE_DELAY_MS);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  const fallback = results.filter((r) => r.metrics && !r.metrics.hasOverpassData).length;
  console.log('');
  console.log(`Summary: ${passed}/${results.length} passed, ${failed} failed` +
    (fallback > 0 ? `  (${fallback} hit geometric-fallback path — Overpass unavailable)` : ''));

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exit(2);
});
