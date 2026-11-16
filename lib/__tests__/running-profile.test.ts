import { computeOffStreetRatio, routeClassShare, setOSRMBase, getRoutingProfile } from '../osrm';
import { maxStreetShare } from '../route-scoring';
import type { GreenSpace } from '../overpass';

// CLAUDE.md #62: self-hosted running profile (osrm/running.lua). Its
// responses carry per-intersection classes (greenway / path / sidewalk /
// steps / busy / service) that the off-street gate and path-share metric
// read. These tests pin that behavior and that car-profile responses (no
// running classes) keep the legacy name-based logic.

type Int = { location: [number, number]; classes?: string[] };
type Step = { name: string; distance: number; geometry: { type: string; coordinates: [number, number][] }; intersections?: Int[] };

/** Straight east-west step starting at (lat, lng0), split into pieces of the
 *  given lengths (meters); each piece starts at an intersection with the
 *  given classes. */
function mkStep(name: string, lat: number, lng0: number, pieces: { m: number; classes?: string[] }[]): Step {
  const degPerM = 1 / (111320 * Math.cos((lat * Math.PI) / 180));
  const coords: [number, number][] = [[lng0, lat]];
  const intersections: Int[] = [];
  let lng = lng0;
  for (const p of pieces) {
    intersections.push({ location: [lng, lat], ...(p.classes ? { classes: p.classes } : {}) });
    lng += p.m * degPerM;
    coords.push([lng, lat]);
  }
  const distance = pieces.reduce((s, p) => s + p.m, 0);
  return { name, distance, geometry: { type: 'LineString', coordinates: coords }, intersections };
}

function mkRoute(steps: Step[]) {
  const distance = steps.reduce((s, st) => s + st.distance, 0);
  return { distance, duration: distance, geometry: { type: 'LineString', coordinates: [] as [number, number][] }, legs: [{ steps }] };
}

describe('running-profile off-street gate (classes)', () => {
  it('does not count unnamed sidewalks, bike paths or busy roads', () => {
    const route = mkRoute([
      mkStep('E 14th St', 40.732, -73.99, [{ m: 400 }]),
      mkStep('', 40.733, -73.98, [{ m: 300, classes: ['sidewalk'] }, { m: 200, classes: ['greenway'] }, { m: 100, classes: ['busy'] }]),
    ]);
    expect(computeOffStreetRatio(route, [])).toBe(0);
  });

  it('counts only the walkway pieces of a mixed unnamed step', () => {
    // 300m sidewalk + 200m interior walkway (path) inside one unnamed step.
    const route = mkRoute([
      mkStep('E 14th St', 40.732, -73.99, [{ m: 500 }]),
      mkStep('', 40.733, -73.98, [{ m: 300, classes: ['sidewalk'] }, { m: 200, classes: ['path'] }]),
    ]);
    expect(computeOffStreetRatio(route, [])).toBeCloseTo(0.2, 2);
  });

  it('exempts walkway pieces inside a park bounding box (long linear park)', () => {
    // Path piece midpoint ~1.3km from the park centroid: outside the
    // centroid circle (r ≈ 0.25km for 0.2km²) but inside the bbox.
    const park: GreenSpace = {
      point: { lat: 40.720, lng: -73.975 }, tier: 1, kind: 'park', name: 'Linear Park', areaSize: 0.2,
      bounds: { minLat: 40.705, maxLat: 40.735, minLng: -73.990, maxLng: -73.970 },
    };
    const route = mkRoute([
      mkStep('Street', 40.70, -73.99, [{ m: 500 }]),
      mkStep('', 40.732, -73.985, [{ m: 300, classes: ['path'] }]),
    ]);
    expect(computeOffStreetRatio(route, [])).toBeCloseTo(0.375, 2);
    expect(computeOffStreetRatio(route, [park])).toBe(0);
  });

  it('keeps legacy behavior (bounds ignored) for car responses without running classes', () => {
    const park: GreenSpace = {
      point: { lat: 40.720, lng: -73.975 }, tier: 1, kind: 'park', name: 'Linear Park', areaSize: 0.2,
      bounds: { minLat: 40.705, maxLat: 40.735, minLng: -73.990, maxLng: -73.970 },
    };
    const route = mkRoute([
      mkStep('Street', 40.70, -73.99, [{ m: 500 }]),
      mkStep('', 40.732, -73.985, [{ m: 300, classes: ['tunnel'] }]),
    ]);
    // Whole unnamed step counts: the car path uses the centroid circle only.
    expect(computeOffStreetRatio(route, [park])).toBeCloseTo(0.375, 2);
  });
});

describe('routeClassShare', () => {
  it('splits distance by class, unclassified pieces as street', () => {
    const route = mkRoute([
      mkStep('Avenue', 40.73, -73.99, [{ m: 500 }]),
      mkStep('Greenway', 40.73, -73.98, [{ m: 300, classes: ['greenway'] }, { m: 200, classes: ['path'] }]),
    ]);
    const share = routeClassShare(route)!;
    expect(share.street).toBeCloseTo(0.5, 2);
    expect(share.greenway).toBeCloseTo(0.3, 2);
    expect(share.path).toBeCloseTo(0.2, 2);
  });

  it('returns null for car-profile responses', () => {
    const route = mkRoute([mkStep('Avenue', 40.73, -73.99, [{ m: 500, classes: ['toll'] }])]);
    expect(routeClassShare(route)).toBeNull();
  });
});

describe('maxStreetShare with unnamed distance in the total', () => {
  const steps = [
    { type: 'turn', location: { lat: 0, lng: 0 }, name: 'Brooklyn Bridge Park Greenway', distanceM: 1500 },
    { type: 'turn', location: { lat: 0, lng: 0 }, name: 'Furman St', distanceM: 1000 },
    { type: 'turn', location: { lat: 0, lng: 0 }, name: '', distanceM: 2000 },
  ] as any;
  it('legacy: share of named distance only', () => {
    expect(maxStreetShare(steps)).toBeCloseTo(0.6, 2);
  });
  it('running profile: share of all distance', () => {
    expect(maxStreetShare(steps, true)).toBeCloseTo(1500 / 4500, 3);
  });
});

describe('routing profile selection', () => {
  afterEach(() => setOSRMBase(null));
  it('defaults to the public car router', () => {
    setOSRMBase(null);
    expect(getRoutingProfile()).toBe('car');
  });
  it('follows an explicit running-profile endpoint', () => {
    setOSRMBase('http://localhost:5003/route/v1/foot', 'running');
    expect(getRoutingProfile()).toBe('running');
  });
});
