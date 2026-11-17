import {
  setOSRMBase,
  getRoutingProfile,
  isMapboxBackend,
  isMapboxUrl,
  dumpOSRMCache,
  loadOSRMCache,
  clearOSRMCache,
  fetchOSRMNearest,
  fetchRouteThroughWaypoints,
  fetchInRunRoute,
  alternativeViaPoint,
  haversineDistance,
  destinationPoint,
} from '../osrm';
import { buildGoogleMapsUrl, canExportGpx, generateGpx } from '../route-export';
import type { GeneratedRoute, RoutePoint } from '../route-generator';

// CLAUDE.md #64: Mapbox Directions (walking) as the hosted router. Its terms
// bar caching/storing/exporting results, so Mapbox responses never reach the
// persisted cache, favorites keep waypoints, Google Maps links use waypoints,
// and GPX export is off for Mapbox routes.

const MAPBOX = 'https://api.mapbox.com/directions/v5/mapbox/walking';
const START: RoutePoint = { lat: 40.728, lng: -73.992 };

function fakeRoute(points: RoutePoint[]) {
  const coordinates = points.map((p) => [p.lng, p.lat]);
  return {
    code: 'Ok',
    routes: [{
      distance: 1500, duration: 1000,
      geometry: { type: 'LineString', coordinates },
      legs: [{ steps: [{ name: 'Street', distance: 1500, geometry: { type: 'LineString', coordinates } }] }],
    }],
  };
}

describe('Mapbox backend', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    setOSRMBase(null);
    clearOSRMCache();
  });

  it('defaults to the car router without a token (tests, harness)', () => {
    setOSRMBase(null);
    expect(getRoutingProfile()).toBe('car');
    expect(isMapboxBackend()).toBe(false);
  });

  it('recognizes Mapbox URLs and keeps them out of the persisted cache', async () => {
    expect(isMapboxUrl(`${MAPBOX}/1,2;3,4`)).toBe(true);
    expect(isMapboxUrl('https://router.project-osrm.org/route/v1/foot/1,2;3,4')).toBe(false);
    setOSRMBase(MAPBOX, 'walking');
    expect(isMapboxBackend()).toBe(true);
    const pts = [START, destinationPoint(START, 0, 0.5), destinationPoint(START, 90, 0.5), START];
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => fakeRoute(pts) })) as any;
    const r = await fetchRouteThroughWaypoints(pts, 'loop');
    expect(r).not.toBeNull();
    expect(dumpOSRMCache().routes).toHaveLength(0);
    // A persisted snapshot containing a Mapbox entry is ignored on load.
    loadOSRMCache({ routes: [[`${MAPBOX}/x`, fakeRoute(pts).routes[0] as any]] });
    expect(dumpOSRMCache().routes).toHaveLength(0);
  });

  it('does not call /nearest on Mapbox (it snaps waypoints itself)', async () => {
    setOSRMBase(MAPBOX, 'walking');
    const spy = jest.fn();
    global.fetch = spy as any;
    const p = { lat: 40.7, lng: -73.99 };
    await expect(fetchOSRMNearest(p)).resolves.toEqual(p);
    expect(spy).not.toHaveBeenCalled();
  });

  it('tags in-run reroutes by the router that produced them', async () => {
    const pts = [START, destinationPoint(START, 0, 0.5)];
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => fakeRoute(pts) })) as any;
    setOSRMBase(MAPBOX, 'walking');
    expect((await fetchInRunRoute(pts))?.source).toBe('mapbox');
    clearOSRMCache();
    setOSRMBase('http://localhost:5002/route/v1/foot');
    expect((await fetchInRunRoute(pts))?.source).toBeUndefined();
  });

  it('re-fetches a favorite from its waypoints with the generation cleanup', async () => {
    setOSRMBase(MAPBOX, 'walking');
    // Loop with a 100m dead-end stub at the top: the cleanup trims it.
    const a = destinationPoint(START, 0, 0.6);
    const tip = destinationPoint(a, 90, 0.1);
    const b = destinationPoint(START, 90, 0.6);
    const line = [START, a, tip, a, destinationPoint(a, 120, 0.4), b, START];
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => fakeRoute(line) })) as any;
    const r = await fetchRouteThroughWaypoints([START, a, b, START], 'loop');
    expect(r).not.toBeNull();
    expect(r!.points.some((p) => p.lat === tip.lat && p.lng === tip.lng)).toBe(false);
  });
});

describe('alternativeViaPoint', () => {
  // Start → end 0.8km east + 0.8km north. Primary goes east then north; the
  // alternative goes north then east, so it differs most at its corner.
  const east = destinationPoint(START, 90, 0.8);
  const north = destinationPoint(START, 0, 0.8);
  const end = destinationPoint(east, 0, 0.8);
  const path = (...legs: [RoutePoint, number][]) =>
    legs.flatMap(([from, bearing], li) => Array.from({ length: 17 }, (_, k) => destinationPoint(from, bearing, (0.8 * k) / 16)).slice(li ? 1 : 0));
  const primary = fakeRoute(path([START, 90], [east, 0])).routes[0] as any;
  const alt = fakeRoute(path([START, 0], [north, 90])).routes[0] as any;

  it('pins the alternative on the streets where it differs from the primary', () => {
    expect(haversineDistance(alternativeViaPoint(alt, primary), north)).toBeLessThan(0.11);
  });

  it('falls back to the middle point when the routes coincide', () => {
    const mid = primary.geometry.coordinates[Math.floor(primary.geometry.coordinates.length / 2)];
    expect(alternativeViaPoint(primary, primary)).toEqual({ lat: mid[1], lng: mid[0] });
  });
});

describe('route export for Mapbox routes', () => {
  const base: GeneratedRoute = {
    id: 'r', name: 'Loop', distance: 3, estimatedTime: 30, elevationGain: 0, terrain: 'Loop', difficulty: 'easy',
    points: [START, { lat: 40.73, lng: -73.99 }, { lat: 40.735, lng: -73.985 }, START],
  };
  const waypoints = [START, { lat: 40.74, lng: -73.98 }, { lat: 40.72, lng: -73.97 }, START];

  it('builds the Google Maps link from waypoints, not the Mapbox polyline', () => {
    const url = decodeURIComponent(buildGoogleMapsUrl({ ...base, source: 'mapbox', waypoints }));
    expect(url).toContain('40.74,-73.98');
    expect(url).not.toContain('40.735,-73.985');
    // Non-Mapbox routes keep sampling the polyline.
    expect(decodeURIComponent(buildGoogleMapsUrl(base))).toContain('40.735,-73.985');
  });

  it('blocks GPX export for Mapbox routes only', () => {
    expect(canExportGpx(base)).toBe(true);
    expect(generateGpx(base)).toContain('<gpx');
    const mb = { ...base, source: 'mapbox' as const, waypoints };
    expect(canExportGpx(mb)).toBe(false);
    expect(() => generateGpx(mb)).toThrow();
  });
});
