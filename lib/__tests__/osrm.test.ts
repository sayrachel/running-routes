import {
  haversineDistance,
  destinationPoint,
  bearingFrom,
  angleDiff,
  coordsString,
  calculateSearchRadius,
  fabricateElevationGain,
  pickRouteName,
  scoreGreenSpace,
  estimateCircuitDistance,
  countStubs,
  trimStubs,
  generateOSRMRoutes,
  setOSRMMock,
  setMockOSRMLatency,
  setMockOSRMFailureRate,
  setMockOSRMTimeoutRate,
  resetMockOSRMFailures,
  setOSRMTimeoutMs,
  setResolutionBudgetMs,
  setDeterministicSeed,
  clearOSRMCache,
  OSRMUnavailableError,
} from '../osrm';
import type { CandidateStrategy } from '../osrm';
import type { RoutePoint } from '../route-generator';
import type { GreenSpace } from '../overpass';
import { prefillOverpassCaches } from '../overpass';

describe('haversineDistance', () => {
  it('returns 0 for the same point', () => {
    const p = { lat: 40.7128, lng: -74.006 };
    expect(haversineDistance(p, p)).toBe(0);
  });

  it('returns a known approximate distance (NYC to LA ~3944 km)', () => {
    const nyc = { lat: 40.7128, lng: -74.006 };
    const la = { lat: 34.0522, lng: -118.2437 };
    const dist = haversineDistance(nyc, la);
    expect(dist).toBeGreaterThan(3900);
    expect(dist).toBeLessThan(4000);
  });

  it('returns small distance for nearby points', () => {
    const p1 = { lat: 51.5074, lng: -0.1278 }; // London
    const p2 = { lat: 51.5074, lng: -0.1178 }; // ~700m east
    const dist = haversineDistance(p1, p2);
    expect(dist).toBeGreaterThan(0.5);
    expect(dist).toBeLessThan(1.0);
  });
});

describe('destinationPoint', () => {
  it('going 1 km north increases latitude by ~0.009 degrees', () => {
    const origin = { lat: 40.0, lng: -74.0 };
    const dest = destinationPoint(origin, 0, 1); // 0° = north, 1 km
    const dLat = dest.lat - origin.lat;
    expect(dLat).toBeCloseTo(0.009, 2); // ~0.009° per km
    expect(Math.abs(dest.lng - origin.lng)).toBeLessThan(0.001);
  });

  it('going 0 km returns the origin', () => {
    const origin = { lat: 40.0, lng: -74.0 };
    const dest = destinationPoint(origin, 90, 0);
    expect(dest.lat).toBeCloseTo(origin.lat, 10);
    expect(dest.lng).toBeCloseTo(origin.lng, 10);
  });

  it('going east increases longitude', () => {
    const origin = { lat: 0, lng: 0 };
    const dest = destinationPoint(origin, 90, 100); // 90° = east
    expect(dest.lng).toBeGreaterThan(origin.lng);
    expect(Math.abs(dest.lat)).toBeLessThan(0.01);
  });
});

describe('bearingFrom', () => {
  it('due north = ~0 degrees', () => {
    const p1 = { lat: 40.0, lng: -74.0 };
    const p2 = { lat: 41.0, lng: -74.0 };
    const bearing = bearingFrom(p1, p2);
    expect(bearing).toBeCloseTo(0, 0);
  });

  it('due east = ~90 degrees', () => {
    const p1 = { lat: 0, lng: 0 };
    const p2 = { lat: 0, lng: 1 };
    const bearing = bearingFrom(p1, p2);
    expect(bearing).toBeCloseTo(90, 0);
  });

  it('due south = ~180 degrees', () => {
    const p1 = { lat: 41.0, lng: -74.0 };
    const p2 = { lat: 40.0, lng: -74.0 };
    const bearing = bearingFrom(p1, p2);
    expect(bearing).toBeCloseTo(180, 0);
  });

  it('due west = ~270 degrees', () => {
    const p1 = { lat: 0, lng: 1 };
    const p2 = { lat: 0, lng: 0 };
    const bearing = bearingFrom(p1, p2);
    expect(bearing).toBeCloseTo(270, 0);
  });
});

describe('angleDiff', () => {
  it('0 and 180 = 180', () => {
    expect(angleDiff(0, 180)).toBe(180);
  });

  it('350 and 10 = 20 (wraps around)', () => {
    expect(angleDiff(350, 10)).toBe(20);
  });

  it('same angle = 0', () => {
    expect(angleDiff(90, 90)).toBe(0);
  });

  it('is symmetric', () => {
    expect(angleDiff(30, 100)).toBe(angleDiff(100, 30));
  });

  it('270 and 90 = 180', () => {
    expect(angleDiff(270, 90)).toBe(180);
  });
});

describe('coordsString', () => {
  it('formats as lng,lat (OSRM order)', () => {
    const points: RoutePoint[] = [
      { lat: 40.7128, lng: -74.006 },
      { lat: 34.0522, lng: -118.2437 },
    ];
    const result = coordsString(points);
    // OSRM expects lng,lat — verify lng comes first
    expect(result).toBe('-74.006,40.7128;-118.2437,34.0522');
  });

  it('handles single point', () => {
    const result = coordsString([{ lat: 1.5, lng: 2.5 }]);
    expect(result).toBe('2.5,1.5');
  });
});

describe('calculateSearchRadius', () => {
  it('clamps minimum to 1.5 km', () => {
    // Very short distance → radius = distanceKm * 0.8 < 1.5
    const radius = calculateSearchRadius('loop', 1, { lat: 0, lng: 0 });
    expect(radius).toBe(1.5);
  });

  it('clamps maximum to 10 km', () => {
    const radius = calculateSearchRadius('loop', 100, { lat: 0, lng: 0 });
    expect(radius).toBe(10);
  });

  it('uses 1.0 factor for loop', () => {
    const radius = calculateSearchRadius('loop', 10, { lat: 0, lng: 0 });
    expect(radius).toBe(10);
  });

  it('uses 0.8 factor for out-and-back', () => {
    const radius = calculateSearchRadius('out-and-back', 10, { lat: 0, lng: 0 });
    expect(radius).toBe(8);
  });

  it('uses haversine distance for point-to-point with end', () => {
    const center = { lat: 40.0, lng: -74.0 };
    const end = { lat: 40.1, lng: -74.0 };
    const radius = calculateSearchRadius('point-to-point', 10, center, end);
    // haversine(center, end) ~ 11.1 km, * 0.6 ~ 6.67
    expect(radius).toBeGreaterThan(5);
    expect(radius).toBeLessThan(10);
  });
});

describe('fabricateElevationGain', () => {
  it('computes 5 + distKm * 3 + variant * 2', () => {
    expect(fabricateElevationGain(10, 3)).toBe(Math.round(5 + 10 * 3 + 3 * 2));
  });

  it('returns rounded value for non-integer inputs', () => {
    const result = fabricateElevationGain(2.5, 1);
    expect(result).toBe(Math.round(5 + 2.5 * 3 + 1 * 2));
    expect(Number.isInteger(result)).toBe(true);
  });

  it('returns 5 for zero distance and zero variant', () => {
    expect(fabricateElevationGain(0, 0)).toBe(5);
  });
});

describe('pickRouteName', () => {
  const makeAnchor = (name: string | null): GreenSpace => ({
    point: { lat: 0, lng: 0 },
    tier: 1,
    kind: 'park',
    name,
    areaSize: 0.1,
  });

  it('uses both named anchors for loop with 2+ named anchors', () => {
    const anchors = [makeAnchor('Central Park'), makeAnchor('Riverside Park')];
    const name = pickRouteName({ lowTraffic: false }, 0, 40.7, anchors, 'loop');
    // Mention both anchors so the title reflects the route's character;
    // strip the "Park" suffix from the second name to keep titles readable.
    expect(name).toBe('Central Park & Riverside Loop');
  });

  it('uses "A to B" format for non-loop with 2+ named anchors', () => {
    const anchors = [makeAnchor('Start Park'), makeAnchor('End Park')];
    const name = pickRouteName({ lowTraffic: false }, 0, 40.7, anchors, 'out-and-back');
    expect(name).toBe('Start Park to End Park');
  });

  it('uses single named anchor for loop', () => {
    const anchors = [makeAnchor('Prospect Park')];
    const name = pickRouteName({ lowTraffic: false }, 0, 40.7, anchors, 'loop');
    expect(name).toBe('Prospect Park Loop');
  });

  it('uses single named anchor for out-and-back', () => {
    const anchors = [makeAnchor('Hudson Trail')];
    const name = pickRouteName({ lowTraffic: false }, 0, 40.7, anchors, 'out-and-back');
    expect(name).toBe('Hudson Trail Out & Back');
  });

  it('uses generic pool when no named anchors', () => {
    const name = pickRouteName({ lowTraffic: false }, 0, 40.7, [], 'loop');
    expect(typeof name).toBe('string');
    expect(name.length).toBeGreaterThan(0);
  });

  it('uses quiet pool when lowTraffic is true', () => {
    const quietNames = ['Backstreet Run', 'Quiet Lanes', 'Residential Circuit', 'Sidestreet Shuffle', 'Neighborhood Loop', 'Peaceful Path'];
    const name = pickRouteName({ lowTraffic: true }, 0, 40.7, [], 'loop');
    expect(quietNames).toContain(name);
  });
});

describe('scoreGreenSpace', () => {
  const makeGS = (overrides: Partial<GreenSpace> = {}): GreenSpace => ({
    point: { lat: 0, lng: 0 },
    tier: 2,
    kind: 'other',
    name: null,
    areaSize: 0,
    ...overrides,
  });

  it('large-parks strategy gives double area bonus', () => {
    const gs = makeGS({ areaSize: 0.1, kind: 'park' });
    const scoreLargeParks = scoreGreenSpace(gs, 'large-parks', false);
    const scoreBalanced = scoreGreenSpace(gs, 'balanced', false);
    expect(scoreLargeParks).toBeGreaterThan(scoreBalanced);
  });

  it('named-paths strategy gives higher bonus for named features', () => {
    const gs = makeGS({ name: 'River Trail', kind: 'route' });
    const scoreNamedPaths = scoreGreenSpace(gs, 'named-paths', false);
    const scoreBalanced = scoreGreenSpace(gs, 'balanced', false);
    expect(scoreNamedPaths).toBeGreaterThan(scoreBalanced);
  });

  it('tier 1 gets bonus', () => {
    const tier1 = makeGS({ tier: 1 });
    const tier2 = makeGS({ tier: 2 });
    expect(scoreGreenSpace(tier1, 'balanced', false)).toBeGreaterThan(
      scoreGreenSpace(tier2, 'balanced', false)
    );
  });

  it('strict mode increases tier 1 and area bonuses', () => {
    const gs = makeGS({ tier: 1, areaSize: 0.1 });
    const strictScore = scoreGreenSpace(gs, 'balanced', true);
    const relaxedScore = scoreGreenSpace(gs, 'balanced', false);
    expect(strictScore).toBeGreaterThan(relaxedScore);
  });
});

describe('estimateCircuitDistance', () => {
  it('sums haversine distances between waypoints times ROUTING_OVERHEAD (1.45)', () => {
    const center = { lat: 40.0, lng: -74.0 };
    const north = { lat: 40.01, lng: -74.0 };
    const east = { lat: 40.0, lng: -73.99 };

    const waypoints = [center, north, east, center];
    const dist = estimateCircuitDistance(waypoints);

    // Manually compute expected: sum of haversine segments × 1.45
    const seg1 = haversineDistance(center, north);
    const seg2 = haversineDistance(north, east);
    const seg3 = haversineDistance(east, center);
    const expected = (seg1 + seg2 + seg3) * 1.45;

    expect(dist).toBeCloseTo(expected, 5);
  });

  it('returns 0 for single point', () => {
    expect(estimateCircuitDistance([{ lat: 0, lng: 0 }])).toBe(0);
  });
});


describe('countStubs', () => {
  // Build a route that goes east 200m, U-turns, comes back 100m, then continues
  // east 500m. Should detect 1 stub (the U-turn back).
  function makeStubbyRoute(): RoutePoint[] {
    const start = { lat: 40.7, lng: -74.0 };
    const points: RoutePoint[] = [start];
    // East 100m in 4 small segments — a true dead-end stub is short
    for (let i = 1; i <= 4; i++) {
      points.push(destinationPoint(start, 90, 0.025 * i));
    }
    const stubTip = points[points.length - 1];
    // U-turn — 100m west, returning to start
    for (let i = 1; i <= 4; i++) {
      points.push(destinationPoint(stubTip, 270, 0.025 * i));
    }
    const stubBack = points[points.length - 1];
    // Continue south 500m in 20 segments (genuine forward progress, not a stub)
    for (let i = 1; i <= 20; i++) {
      points.push(destinationPoint(stubBack, 180, 0.025 * i));
    }
    return points;
  }

  it('returns 0 for a clean route with no U-turns', () => {
    // Smooth circle — should never have U-turns
    const center = { lat: 40.7, lng: -74.0 };
    const points: RoutePoint[] = [];
    for (let i = 0; i < 50; i++) {
      points.push(destinationPoint(center, (i / 50) * 360, 0.5));
    }
    expect(countStubs(points)).toBe(0);
  });

  it('detects a single dead-end stub', () => {
    expect(countStubs(makeStubbyRoute())).toBe(1);
  });

  it('returns 0 for routes shorter than 4 points', () => {
    expect(countStubs([{ lat: 0, lng: 0 }, { lat: 0.1, lng: 0 }, { lat: 0.2, lng: 0 }])).toBe(0);
  });

  // Build 23 user-reported regression: a route with a 280m peninsula stub
  // (e.g. shooting out to a waterfront strip and U-turning back) was visible
  // to the user but slipped past detection because the original 150m default
  // skipped any stub with out-leg > 150m. Both detection AND trimming need
  // the wider window.
  function makeMidsizedStubRoute(outLegM: number, backLegM: number): RoutePoint[] {
    const start = { lat: 40.7, lng: -74.0 };
    const points: RoutePoint[] = [start];
    // East 'outLegM' in 25m steps — the kind of multi-segment out-leg that
    // OSRM emits when the runner leaves the main path through a few
    // consecutive intersections.
    const outSteps = Math.max(1, Math.round(outLegM / 25));
    for (let i = 1; i <= outSteps; i++) {
      points.push(destinationPoint(start, 90, (outLegM / 1000) * (i / outSteps)));
    }
    const stubTip = points[points.length - 1];
    // U-turn — back 'backLegM' (also in 25m steps), then resume original
    // direction.
    const backSteps = Math.max(1, Math.round(backLegM / 25));
    for (let i = 1; i <= backSteps; i++) {
      points.push(destinationPoint(stubTip, 270, (backLegM / 1000) * (i / backSteps)));
    }
    const stubBack = points[points.length - 1];
    // Continue south 500m so the route resumes after the stub (gives
    // findStubBackEnd a clean "resumed" signal).
    for (let i = 1; i <= 20; i++) {
      points.push(destinationPoint(stubBack, 180, 0.025 * i));
    }
    return points;
  }

  it('detects a 280m out / 280m back peninsula stub at the default threshold', () => {
    // Matches the user's Build 23 N. Williamsburg screenshot pattern.
    expect(countStubs(makeMidsizedStubRoute(280, 280))).toBe(1);
  });

  it('does not double-count a stub when out-leg is just under threshold', () => {
    // 290m out, 290m back — within the 300m default but only just; should
    // still count exactly once.
    expect(countStubs(makeMidsizedStubRoute(290, 290))).toBe(1);
  });
});

describe('trimStubs', () => {
  function destinationPointHelper(p: RoutePoint, bearing: number, distKm: number): RoutePoint {
    return destinationPoint(p, bearing, distKm);
  }

  function buildStubbyRoute(outLegM: number, backLegM: number): RoutePoint[] {
    const start = { lat: 40.7, lng: -74.0 };
    const points: RoutePoint[] = [start];
    const outSteps = Math.max(1, Math.round(outLegM / 25));
    for (let i = 1; i <= outSteps; i++) {
      points.push(destinationPointHelper(start, 90, (outLegM / 1000) * (i / outSteps)));
    }
    const stubTip = points[points.length - 1];
    const backSteps = Math.max(1, Math.round(backLegM / 25));
    for (let i = 1; i <= backSteps; i++) {
      points.push(destinationPointHelper(stubTip, 270, (backLegM / 1000) * (i / backSteps)));
    }
    const stubBack = points[points.length - 1];
    for (let i = 1; i <= 20; i++) {
      points.push(destinationPointHelper(stubBack, 180, 0.025 * i));
    }
    return points;
  }

  it('trims a 280m peninsula stub at the default 300m threshold', () => {
    // The user's Build 23 spur was ~280m each way. With the old 150m
    // default, trimStubs left the stub untouched and the user saw it on
    // the map. The 300m default trims it.
    const stubby = buildStubbyRoute(280, 280);
    const trimmed = trimStubs(stubby);
    expect(trimmed.length).toBeLessThan(stubby.length);
    // Trimmed route should have NO countable stubs left.
    expect(countStubs(trimmed)).toBe(0);
  });

  it('still trims a 100m stub (regression: short stubs already worked)', () => {
    const stubby = buildStubbyRoute(100, 100);
    const trimmed = trimStubs(stubby);
    expect(countStubs(trimmed)).toBe(0);
  });

  it('does not trim a 500m stub (above the default threshold)', () => {
    // 500m peninsulas might be intentional — leave them alone unless the
    // caller passes a wider maxStubLenKm. This is the safety boundary that
    // prevents over-aggressive trimming on legitimate long detours.
    const stubby = buildStubbyRoute(500, 500);
    const trimmed = trimStubs(stubby);
    // Polyline should be unchanged — same point count (no trim happened).
    expect(trimmed.length).toBe(stubby.length);
  });
});

// ---------------------------------------------------------------------------
// Resilience: budget timer + degraded-network behavior
// ---------------------------------------------------------------------------
//
// These tests exercise the structural property that previously let
// `generateOSRMRoutes` hang for ~60s when the public OSRM endpoint was
// slow or rate-limiting. The mock's failure-injection knobs simulate the
// degraded conditions; small OSRM_TIMEOUT_MS and RESOLUTION_BUDGET_MS
// values let the assertions fire in <1s of real time.
//
// What the harness alone could NOT catch (and these tests do):
//   1. All-candidates-timeout MUST throw OSRMUnavailableError, not return
//      [] (so the caller can show "service slow" not "no routes for area").
//   2. Resolution MUST complete within budget regardless of how many
//      candidates are stuck — no waterfall that compounds per-candidate
//      timeouts into 60s of user-visible spinner.
//   3. Step 3.5 fallback MUST be skipped when network is the failure mode
//      (it would re-hit the same dead endpoint and double the wait).
describe('generateOSRMRoutes resilience', () => {
  // NYC center for all tests — far from water-bound edges so the geometric
  // fallback waypoints don't accidentally land in barriers.
  const center = { lat: 40.7589, lng: -73.9851 };

  beforeEach(() => {
    setOSRMMock(true);
    setDeterministicSeed(42); // pin failure rolls
    clearOSRMCache();
    resetMockOSRMFailures();
    // Seed empty Overpass caches so generateOSRMRoutes doesn't try to hit
    // the real endpoint. Empty green-spaces is fine — the resilience tests
    // care about how OSRM failures propagate, not about route quality.
    prefillOverpassCaches(center, 10, [], []);
  });

  afterEach(() => {
    setOSRMMock(false);
    setDeterministicSeed(null);
    resetMockOSRMFailures();
    setOSRMTimeoutMs(8000); // restore production defaults
    setResolutionBudgetMs(18000);
  });

  it('throws OSRMUnavailableError when all candidates time out', async () => {
    // Per-call timeout 100ms → ~7 candidates each "time out" in 100ms wall
    // clock (parallel). Budget 2s gives generous headroom; the test should
    // exit well under it because all candidates resolve to null fast.
    setOSRMTimeoutMs(100);
    setResolutionBudgetMs(2000);
    setMockOSRMTimeoutRate(1.0);

    const start = Date.now();
    let caught: any = null;
    try {
      await generateOSRMRoutes(center, 5, 'loop', 1);
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;

    expect(caught).toBeInstanceOf(OSRMUnavailableError);
    // ~100ms per candidate (parallel) + small overhead. Anything over 1s
    // means we're hitting the old waterfall behavior.
    expect(elapsed).toBeLessThan(1000);
  });

  it('respects the resolution budget when candidates are merely slow', async () => {
    // Each candidate succeeds, but takes longer than the budget. Without
    // the budget, the function would wait for all 7 to finish (~3s in
    // parallel). With the budget at 200ms, it must give up sooner.
    setOSRMTimeoutMs(10000); // not the limit here
    setResolutionBudgetMs(200);
    setMockOSRMLatency(500); // each candidate takes 500ms

    const start = Date.now();
    let result: any = null;
    let caught: any = null;
    try {
      result = await generateOSRMRoutes(center, 5, 'loop', 1);
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;

    // Either we got nothing (budget fired before any candidate) → throws,
    // or budget fired between resolutions and we got partial results. In
    // both cases the function MUST return within budget + small slack.
    expect(elapsed).toBeLessThan(800);
    if (caught) {
      expect(caught).toBeInstanceOf(OSRMUnavailableError);
    } else {
      expect(Array.isArray(result)).toBe(true);
    }
  });

  it('returns successfully when mock has no failures (regression baseline)', async () => {
    // Sanity: with all knobs zeroed, the mock behaves like the legacy
    // synchronous version. Any resilience test that breaks this baseline
    // is a sign the fix introduced a behavior change in the happy path.
    setOSRMTimeoutMs(8000);
    setResolutionBudgetMs(18000);

    const start = Date.now();
    const routes = await generateOSRMRoutes(center, 5, 'loop', 1);
    const elapsed = Date.now() - start;

    expect(routes.length).toBeGreaterThan(0);
    // Mock is synchronous-equivalent — total wall-clock should be tiny.
    expect(elapsed).toBeLessThan(1000);
  });

  it('skips step 3.5 fallback when failures are network-only', async () => {
    // All-null without quality-rejects = network failure mode. The function
    // must throw OSRMUnavailableError quickly rather than running step 3.5
    // (which would just hit the same dead endpoint for another waterfall).
    //
    // We measure this by latency: if step 3.5 fired, it would do 4 sequential
    // bearing trials, each potentially timing out. With per-call timeout 100ms
    // × 4 trials × up to 4 attempts each = ~1.6s. Skipping = ~100ms total.
    setOSRMTimeoutMs(100);
    setResolutionBudgetMs(5000);
    setMockOSRMTimeoutRate(1.0);

    const start = Date.now();
    let caught: any = null;
    try {
      await generateOSRMRoutes(center, 5, 'loop', 1);
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;

    expect(caught).toBeInstanceOf(OSRMUnavailableError);
    // Hard ceiling: must be well under what step 3.5 would add. If step 3.5
    // runs, this assertion catches it.
    expect(elapsed).toBeLessThan(800);
  });
});