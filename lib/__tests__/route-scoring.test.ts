import { scoreRoute, computeGreenSpaceProximity } from '../route-scoring';
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
