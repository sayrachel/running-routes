import { scoreRoute, computeGreenSpaceProximity } from '../route-scoring';
import type { GreenSpace } from '../overpass';
import type { RoutePoint } from '../route-generator';

describe('scoreRoute', () => {
  it('with lowTraffic=false: quiet score is ignored, 60% distance + 15% green + 25% runPath', () => {
    const candidate = { distanceKm: 5, targetDistanceKm: 5 };
    const prefs = { lowTraffic: false };

    // Perfect distance match → distScore = 1.0
    // quietScore should be irrelevant in relaxed mode
    const score1 = scoreRoute(candidate, prefs, 0.0, 0.5, 0.5);
    const score2 = scoreRoute(candidate, prefs, 1.0, 0.5, 0.5);
    expect(score1).toBeCloseTo(score2, 10);
  });

  it('with lowTraffic=true: 30% distance + 20% quiet + 25% green + 25% runPath', () => {
    const candidate = { distanceKm: 5, targetDistanceKm: 5 };
    const prefs = { lowTraffic: true };

    // Perfect distance → distScore = 1.0
    const score = scoreRoute(candidate, prefs, 0.8, 0.6, 0.4);
    // 0.30 * 1.0 + 0.20 * 0.8 + 0.25 * 0.6 + 0.25 * 0.4 = 0.30 + 0.16 + 0.15 + 0.10 = 0.71
    expect(score).toBeCloseTo(0.71, 5);
  });

  it('perfect distance match yields distScore = 1.0', () => {
    const candidate = { distanceKm: 10, targetDistanceKm: 10 };
    const prefs = { lowTraffic: false };
    const score = scoreRoute(candidate, prefs, 0.5, 1.0, 1.0);
    // 0.60 * 1.0 + 0.15 * 1.0 + 0.25 * 1.0 = 1.0
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('distance 25% off yields distScore = 0', () => {
    const candidate = { distanceKm: 12.5, targetDistanceKm: 10 };
    const prefs = { lowTraffic: false };
    // distRatio = 1.25, |1 - 1.25| = 0.25, 0.25 * 4 = 1.0, max(1 - 1, 0) = 0
    const score = scoreRoute(candidate, prefs, 0.5, 0.0, 0.0);
    expect(score).toBeCloseTo(0, 5);
  });

  it('distance 10% off yields distScore = 0.6', () => {
    const candidate = { distanceKm: 11, targetDistanceKm: 10 };
    const prefs = { lowTraffic: false };
    // distRatio = 1.1, |1 - 1.1| = 0.1, 0.1 * 4 = 0.4, max(1 - 0.4, 0) = 0.6
    const score = scoreRoute(candidate, prefs, 0.5, 0.0, 0.0);
    // 0.60 * 0.6 + 0.15 * 0.0 + 0.25 * 0.0 = 0.36
    expect(score).toBeCloseTo(0.36, 5);
  });

  it('with targetDistanceKm=0, distScore defaults to 1.0', () => {
    const candidate = { distanceKm: 5, targetDistanceKm: 0 };
    const prefs = { lowTraffic: false };
    // distRatio = 1 (fallback), distScore = 1.0
    const score = scoreRoute(candidate, prefs, 0.5, 0.5, 0.5);
    // 0.60 * 1.0 + 0.15 * 0.5 + 0.25 * 0.5 = 0.60 + 0.075 + 0.125 = 0.80
    expect(score).toBeCloseTo(0.80, 5);
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
