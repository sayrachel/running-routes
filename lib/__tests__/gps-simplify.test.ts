import { simplifyRDP } from '../gps-simplify';
import type { RoutePoint } from '../route-generator';

describe('simplifyRDP', () => {
  test('arrays of length ≤2 pass through unchanged', () => {
    expect(simplifyRDP([], 5)).toEqual([]);
    const single = [{ lat: 40.7, lng: -74.0 }];
    expect(simplifyRDP(single, 5)).toEqual(single);
    const two = [{ lat: 40.7, lng: -74.0 }, { lat: 40.71, lng: -74.01 }];
    expect(simplifyRDP(two, 5)).toEqual(two);
  });

  test('strictly-collinear vertices below tolerance are dropped', () => {
    // 5 points along the same meridian — all interior vertices are exactly
    // on the segment from first to last, so all should drop at any tolerance.
    const points: RoutePoint[] = [
      { lat: 40.700, lng: -74.0 },
      { lat: 40.701, lng: -74.0 },
      { lat: 40.702, lng: -74.0 },
      { lat: 40.703, lng: -74.0 },
      { lat: 40.704, lng: -74.0 },
    ];
    const simplified = simplifyRDP(points, 5);
    expect(simplified).toHaveLength(2);
    expect(simplified[0]).toEqual(points[0]);
    expect(simplified[1]).toEqual(points[points.length - 1]);
  });

  test('a real turn (vertex far from the chord) is preserved', () => {
    // Right-angle: north then east. The corner vertex is ~111m from the
    // diagonal chord — well above the 5m tolerance.
    const points: RoutePoint[] = [
      { lat: 40.700, lng: -74.000 },
      { lat: 40.701, lng: -74.000 }, // turn point
      { lat: 40.701, lng: -73.999 },
    ];
    const simplified = simplifyRDP(points, 5);
    expect(simplified).toHaveLength(3);
    expect(simplified[1]).toEqual(points[1]);
  });

  test('jitter ≤ tolerance is removed; jitter > tolerance is kept', () => {
    // Reference: 4 collinear points along the east axis (~111m apart).
    // Inject one jittery vertex ~2m off the line — below 5m tolerance →
    // dropped. Then a second test with ~10m off → kept.
    const base = (offsetLat: number): RoutePoint[] => [
      { lat: 40.700, lng: -74.000 },
      { lat: 40.700, lng: -73.999 },
      { lat: 40.700 + offsetLat, lng: -73.998 }, // jittery middle
      { lat: 40.700, lng: -73.997 },
      { lat: 40.700, lng: -73.996 },
    ];
    const smallJitter = base(0.00002); // ~2m
    expect(simplifyRDP(smallJitter, 5).some((p) => p.lng === -73.998)).toBe(false);

    const bigJitter = base(0.0001); // ~11m
    expect(simplifyRDP(bigJitter, 5).some((p) => p.lng === -73.998)).toBe(true);
  });

  test('endpoints always survive', () => {
    const points: RoutePoint[] = Array.from({ length: 50 }, (_, i) => ({
      lat: 40.700 + i * 0.0001,
      lng: -74.000 + Math.sin(i) * 0.00001, // tiny squiggle
    }));
    const simplified = simplifyRDP(points, 5);
    expect(simplified[0]).toEqual(points[0]);
    expect(simplified[simplified.length - 1]).toEqual(points[points.length - 1]);
  });

  test('output is shorter than input for a noisy series', () => {
    // Noisy GPS-like series: net path is a straight line east, but every
    // sample wobbles by ~3m off-axis (below the 5m tolerance).
    const points: RoutePoint[] = Array.from({ length: 30 }, (_, i) => ({
      lat: 40.700 + (i % 2 === 0 ? 0.00003 : -0.00003),
      lng: -74.000 + i * 0.00002,
    }));
    const simplified = simplifyRDP(points, 5);
    expect(simplified.length).toBeLessThan(points.length);
  });
});
