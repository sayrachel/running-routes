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
} from '../osrm';
import type { CandidateStrategy } from '../osrm';
import type { RoutePoint } from '../route-generator';
import type { GreenSpace } from '../overpass';

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
