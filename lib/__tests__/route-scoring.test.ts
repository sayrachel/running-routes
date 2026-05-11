import { scoreRoute, computeGreenSpaceProximity, bboxAspectRatio, polsbyPopper, maxTurnDensityInWindow } from '../route-scoring';
import type { GreenSpace } from '../overpass';
import type { RoutePoint } from '../route-generator';

describe('scoreRoute', () => {
  // Current weights (matching scoreRoute):
  //   relaxed: 0.50·dist + 0.15·green + 0.20·runPath + 0.15·waterfront
  //   strict:  0.25·dist + 0.15·quiet + 0.20·green + 0.20·runPath + 0.20·waterfront

  it('with lowTraffic=false: quiet score is ignored', () => {
    const candidate = { distanceKm: 5, targetDistanceKm: 5 };
    const prefs = { lowTraffic: false };
    const score1 = scoreRoute(candidate, prefs, 0.0, 0.5, 0.5);
    const score2 = scoreRoute(candidate, prefs, 1.0, 0.5, 0.5);
    expect(score1).toBeCloseTo(score2, 10);
  });

  it('with lowTraffic=true: weighted sum across distance/quiet/green/runPath/waterfront', () => {
    const candidate = { distanceKm: 5, targetDistanceKm: 5 };
    const prefs = { lowTraffic: true };
    // distScore=1.0, quiet=0.8, green=0.6, runPath=0.4, waterfront=0 (default)
    const score = scoreRoute(candidate, prefs, 0.8, 0.6, 0.4);
    // 0.25·1.0 + 0.15·0.8 + 0.20·0.6 + 0.20·0.4 + 0.20·0 = 0.25 + 0.12 + 0.12 + 0.08 = 0.57
    expect(score).toBeCloseTo(0.57, 5);
  });

  it('perfect distance match + perfect proximities (relaxed) yields distScore = 1.0', () => {
    const candidate = { distanceKm: 10, targetDistanceKm: 10 };
    const prefs = { lowTraffic: false };
    // green=1.0, runPath=1.0, waterfront=1.0
    const score = scoreRoute(candidate, prefs, 0.5, 1.0, 1.0, 1.0);
    // 0.50·1.0 + 0.15·1.0 + 0.20·1.0 + 0.15·1.0 = 1.0
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('distance 25% off yields distScore = 0', () => {
    const candidate = { distanceKm: 12.5, targetDistanceKm: 10 };
    const prefs = { lowTraffic: false };
    // distRatio = 1.25, |1 - 1.25| = 0.25, 0.25 * 4 = 1.0, max(1 - 1, 0) = 0
    const score = scoreRoute(candidate, prefs, 0.5, 0.0, 0.0);
    expect(score).toBeCloseTo(0, 5);
  });

  it('distance 10% off (relaxed) yields the right weighted score', () => {
    const candidate = { distanceKm: 11, targetDistanceKm: 10 };
    const prefs = { lowTraffic: false };
    // distRatio = 1.1, distScore = max(1 - 0.4, 0) = 0.6
    const score = scoreRoute(candidate, prefs, 0.5, 0.0, 0.0);
    // 0.50·0.6 + 0.15·0.0 + 0.20·0.0 + 0.15·0 = 0.30
    expect(score).toBeCloseTo(0.30, 5);
  });

  it('with targetDistanceKm=0, distScore defaults to 1.0', () => {
    const candidate = { distanceKm: 5, targetDistanceKm: 0 };
    const prefs = { lowTraffic: false };
    // distRatio = 1 (fallback), distScore = 1.0
    const score = scoreRoute(candidate, prefs, 0.5, 0.5, 0.5);
    // 0.50·1.0 + 0.15·0.5 + 0.20·0.5 + 0.15·0 = 0.50 + 0.075 + 0.10 + 0 = 0.675
    expect(score).toBeCloseTo(0.675, 5);
  });
});

describe('computeGreenSpaceProximity', () => {
  const makeGS = (lat: number, lng: number): GreenSpace => ({
    point: { lat, lng },
    tier: 1,
    kind: 'park',
    name: null,
    areaSize: 0,
  });

  it('returns 0 for empty route points', () => {
    expect(computeGreenSpaceProximity([], [makeGS(0, 0)])).toBe(0);
  });

  it('returns 0 for empty green spaces', () => {
    expect(computeGreenSpaceProximity([{ lat: 0, lng: 0 }], [])).toBe(0);
  });

  it('returns 1.0 when all points are near a green space', () => {
    const routePoints: RoutePoint[] = [
      { lat: 0.0, lng: 0.0 },
      { lat: 0.001, lng: 0.0 },
      { lat: 0.002, lng: 0.0 },
    ];
    // Green space at origin — all points within 0.2 km
    const greenSpaces = [makeGS(0.001, 0.0)];
    const score = computeGreenSpaceProximity(routePoints, greenSpaces);
    expect(score).toBe(1.0);
  });

  it('returns 0 when no points are near any green space', () => {
    const routePoints: RoutePoint[] = [
      { lat: 0.0, lng: 0.0 },
      { lat: 0.001, lng: 0.0 },
    ];
    // Green space far away
    const greenSpaces = [makeGS(10.0, 10.0)];
    const score = computeGreenSpaceProximity(routePoints, greenSpaces);
    expect(score).toBe(0);
  });
});

describe('bboxAspectRatio', () => {
  // 1km in NYC ≈ 0.009 deg lat, 0.0119 deg lng (cos(40.73°) ≈ 0.757)
  // We construct synthetic polylines whose bbox has known dimensions and
  // verify aspect = max(NS, EW) / min(NS, EW) within tolerance.

  it('square loop returns aspect ≈ 1', () => {
    // 1km × 1km square at NYC latitude
    const square: RoutePoint[] = [
      { lat: 40.73,         lng: -73.985 },
      { lat: 40.73,         lng: -73.985 + 0.0119 },
      { lat: 40.73 + 0.009, lng: -73.985 + 0.0119 },
      { lat: 40.73 + 0.009, lng: -73.985 },
      { lat: 40.73,         lng: -73.985 },
    ];
    expect(bboxAspectRatio(square)).toBeLessThan(1.1);
  });

  it('healthy 2:1 rectangular loop returns aspect ≈ 2', () => {
    const rect: RoutePoint[] = [
      { lat: 40.73,          lng: -73.985 },
      { lat: 40.73,          lng: -73.985 + 0.0238 },
      { lat: 40.73 + 0.009,  lng: -73.985 + 0.0238 },
      { lat: 40.73 + 0.009,  lng: -73.985 },
      { lat: 40.73,          lng: -73.985 },
    ];
    const aspect = bboxAspectRatio(rect);
    expect(aspect).toBeGreaterThan(1.8);
    expect(aspect).toBeLessThan(2.2);
  });

  it('through-line shape (1.5km E-W × 60m N-S) returns aspect > 20', () => {
    // Models the East Village 3mi case: outbound + closing along the same
    // E-W axis through start, with only a 60m drop to a parallel street.
    const throughLine: RoutePoint[] = [
      { lat: 40.7335,         lng: -73.985 },
      { lat: 40.7335,         lng: -73.985 + 0.018 },  // 1.5km east
      { lat: 40.7335 - 0.0005, lng: -73.985 + 0.018 }, // 55m south
      { lat: 40.7335 - 0.0005, lng: -73.985 },         // 1.5km west
      { lat: 40.7335,         lng: -73.985 },          // back to start
    ];
    expect(bboxAspectRatio(throughLine)).toBeGreaterThan(20);
  });

  it('squished oval (3:1 aspect) returns aspect ≈ 3', () => {
    // Five-vertex oval: 1.5km × 0.5km
    const oval: RoutePoint[] = [
      { lat: 40.73,          lng: -73.985 },
      { lat: 40.73,          lng: -73.985 + 0.018 },
      { lat: 40.73 + 0.0045, lng: -73.985 + 0.018 },
      { lat: 40.73 + 0.0045, lng: -73.985 },
      { lat: 40.73,          lng: -73.985 },
    ];
    const aspect = bboxAspectRatio(oval);
    expect(aspect).toBeGreaterThan(2.7);
    expect(aspect).toBeLessThan(3.3);
  });

  it('handles polylines with sub-10m extent (degenerate min axis is floored)', () => {
    // Two points 1km apart with effectively zero N-S extent.
    const line: RoutePoint[] = [
      { lat: 40.73, lng: -73.985 },
      { lat: 40.73, lng: -73.985 + 0.012 },
    ];
    // EW ≈ 1km, NS = 0, floor at 0.01km → aspect ≤ 100, ≥ ~95
    const aspect = bboxAspectRatio(line);
    expect(aspect).toBeGreaterThan(50);
  });

  it('returns 1 for fewer than 2 points', () => {
    expect(bboxAspectRatio([])).toBe(1);
    expect(bboxAspectRatio([{ lat: 40, lng: -73 }])).toBe(1);
  });

  it('uses cos(lat) correction so equator and high-latitude shapes score symmetrically', () => {
    // Two square loops with the same lat/lng deltas at very different
    // latitudes should NOT register as the same aspect — cos correction
    // shrinks EW extent at higher latitudes.
    const equatorSquare: RoutePoint[] = [
      { lat: 0,       lng: 0 },
      { lat: 0,       lng: 0.01 },
      { lat: 0.01,    lng: 0.01 },
      { lat: 0.01,    lng: 0 },
      { lat: 0,       lng: 0 },
    ];
    const polarSquare: RoutePoint[] = [
      { lat: 60,      lng: 0 },
      { lat: 60,      lng: 0.01 },
      { lat: 60.01,   lng: 0.01 },
      { lat: 60.01,   lng: 0 },
      { lat: 60,      lng: 0 },
    ];
    const equatorAspect = bboxAspectRatio(equatorSquare);
    const polarAspect = bboxAspectRatio(polarSquare);
    expect(equatorAspect).toBeCloseTo(1, 1);
    // At lat 60°, EW shrinks by cos(60°) = 0.5 — polar polyline is twice as
    // tall as it is wide, aspect ≈ 2.
    expect(polarAspect).toBeGreaterThan(1.8);
    expect(polarAspect).toBeLessThan(2.2);
  });
});

describe('polsbyPopper', () => {
  // Polsby-Popper: 4π·area / perimeter². Always 0–1, with 1 = circle.
  // Constructions below use NYC latitude where 1km ≈ 0.009 deg lat,
  // 0.0119 deg lng (cos(40.73°) ≈ 0.757).

  it('approximates 1.0 for a high-resolution circle', () => {
    // 32-vertex regular polygon approximating a 1km-radius circle.
    const center = { lat: 40.73, lng: -73.985 };
    const N = 32;
    const points = [];
    for (let i = 0; i <= N; i++) {
      const angle = (i / N) * 2 * Math.PI;
      const dyKm = Math.cos(angle);
      const dxKm = Math.sin(angle);
      points.push({
        lat: center.lat + dyKm / 111,
        lng: center.lng + dxKm / (111 * Math.cos((40.73 * Math.PI) / 180)),
      });
    }
    const pp = polsbyPopper(points);
    // 32-vertex polygon falls slightly short of a true circle (PP = 1.0).
    expect(pp).toBeGreaterThan(0.97);
    expect(pp).toBeLessThan(1.01);
  });

  it('square loop returns ≈ 0.785 (π/4)', () => {
    const square = [
      { lat: 40.73,         lng: -73.985 },
      { lat: 40.73,         lng: -73.985 + 0.0119 },
      { lat: 40.73 + 0.009, lng: -73.985 + 0.0119 },
      { lat: 40.73 + 0.009, lng: -73.985 },
      { lat: 40.73,         lng: -73.985 },
    ];
    const pp = polsbyPopper(square);
    expect(pp).toBeGreaterThan(0.75);
    expect(pp).toBeLessThan(0.82);
  });

  it('2:1 rectangle returns ≈ 0.7', () => {
    const rect = [
      { lat: 40.73,         lng: -73.985 },
      { lat: 40.73,         lng: -73.985 + 0.0238 },
      { lat: 40.73 + 0.009, lng: -73.985 + 0.0238 },
      { lat: 40.73 + 0.009, lng: -73.985 },
      { lat: 40.73,         lng: -73.985 },
    ];
    const pp = polsbyPopper(rect);
    expect(pp).toBeGreaterThan(0.65);
    expect(pp).toBeLessThan(0.75);
  });

  it('through-line shape returns < 0.15', () => {
    const throughLine = [
      { lat: 40.7335,         lng: -73.985 },
      { lat: 40.7335,         lng: -73.985 + 0.018 },
      { lat: 40.7335 - 0.0005, lng: -73.985 + 0.018 },
      { lat: 40.7335 - 0.0005, lng: -73.985 },
      { lat: 40.7335,         lng: -73.985 },
    ];
    expect(polsbyPopper(throughLine)).toBeLessThan(0.15);
  });

  it('snake-shape (winding within a single corridor) returns < 0.20', () => {
    // 1.5km long, 200m corridor wide, with 4 N-S "switchbacks".
    const snake = [
      { lat: 40.730, lng: -73.985 },
      { lat: 40.730, lng: -73.985 + 0.005 },
      { lat: 40.732, lng: -73.985 + 0.005 },
      { lat: 40.732, lng: -73.985 + 0.010 },
      { lat: 40.730, lng: -73.985 + 0.010 },
      { lat: 40.730, lng: -73.985 + 0.015 },
      { lat: 40.732, lng: -73.985 + 0.015 },
      { lat: 40.732, lng: -73.985 + 0.018 },
      { lat: 40.730, lng: -73.985 + 0.018 },
      { lat: 40.730, lng: -73.985 },
    ];
    expect(polsbyPopper(snake)).toBeLessThan(0.20);
  });

  it('returns 0 for fewer than 3 points', () => {
    expect(polsbyPopper([])).toBe(0);
    expect(polsbyPopper([{ lat: 40, lng: -73 }, { lat: 40.001, lng: -73.001 }])).toBe(0);
  });
});

describe('maxTurnDensityInWindow', () => {
  // Helpers below construct 100m segments at NYC latitude.
  // 100m N ≈ 0.0009 deg lat; 100m E ≈ 0.0012 deg lng.
  const STEP_LAT = 0.0009;
  const STEP_LNG = 0.0012;

  it('returns 0 for routes shorter than the window', () => {
    const tiny = [
      { lat: 40.73, lng: -73.985 },
      { lat: 40.73 + STEP_LAT, lng: -73.985 },
    ];
    expect(maxTurnDensityInWindow(tiny, 0.5)).toBe(0);
  });

  it('returns 0 for a straight line of any length', () => {
    const straight = [];
    for (let i = 0; i < 30; i++) {
      straight.push({ lat: 40.73, lng: -73.985 + i * STEP_LNG });
    }
    expect(maxTurnDensityInWindow(straight, 0.5)).toBe(0);
  });

  it('reports high density for a localized cluster', () => {
    // 5 turns within ~400m at the start, then 1.5km of straight.
    // Each "turn" is a 90° corner: east 100m, north 100m, east 100m, etc.
    const cluster = [
      { lat: 40.73, lng: -73.985 },
      { lat: 40.73, lng: -73.985 + STEP_LNG },                  // E 100m
      { lat: 40.73 + STEP_LAT, lng: -73.985 + STEP_LNG },        // N 100m  (turn 1)
      { lat: 40.73 + STEP_LAT, lng: -73.985 + 2 * STEP_LNG },    // E 100m  (turn 2)
      { lat: 40.73 + 2 * STEP_LAT, lng: -73.985 + 2 * STEP_LNG }, // N 100m (turn 3)
      { lat: 40.73 + 2 * STEP_LAT, lng: -73.985 + 3 * STEP_LNG }, // E 100m (turn 4)
      { lat: 40.73 + 3 * STEP_LAT, lng: -73.985 + 3 * STEP_LNG }, // N 100m (turn 5)
    ];
    // Append 1500m of straight east continuation from the cluster end.
    const last = cluster[cluster.length - 1];
    for (let i = 1; i <= 15; i++) {
      cluster.push({ lat: last.lat, lng: last.lng + i * STEP_LNG });
    }
    const max = maxTurnDensityInWindow(cluster, 0.5);
    // 5 turns in <500m → at least 5/0.5 = 10 t/km in some window.
    expect(max).toBeGreaterThanOrEqual(8);
  });

  it('reports low density when turns are spread evenly', () => {
    // 6 turns spread over 3km — each window has ≤ 2 turns.
    const spread = [];
    let lat = 40.73, lng = -73.985;
    spread.push({ lat, lng });
    for (let i = 0; i < 6; i++) {
      // 500m east, then a small N step (the turn), so the bearing flips back ~90°.
      for (let s = 0; s < 5; s++) {
        lng += STEP_LNG;
        spread.push({ lat, lng });
      }
      lat += STEP_LAT;
      spread.push({ lat, lng });
    }
    const max = maxTurnDensityInWindow(spread, 0.5);
    // ~1 turn per window of 500m → ~2 t/km max
    expect(max).toBeLessThanOrEqual(4);
  });
});
