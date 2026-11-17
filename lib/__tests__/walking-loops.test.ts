import {
  planWalkingLoop,
  walkingLoopWaypoints,
  findWaypointDetours,
  applyDetourRepairs,
  computeOffStreetRatio,
  routeUsesFerry,
  hasRoutedBarrierCrossing,
  expandParkWaypoints,
  setOSRMBase,
  haversineDistance,
  destinationPoint,
  bearingFrom,
  angleDiff,
} from '../osrm';
import type { GreenSpace } from '../overpass';
import type { RoutePoint } from '../route-generator';

// CLAUDE.md #63: walking-router loop fixes. Loops put the start ON the loop
// (not in its middle), dead-end detours at via waypoints are repaired between
// distance attempts, and the off-street / ferry gates cover walking routers
// without running classes (Mapbox).

const START: RoutePoint = { lat: 40.728, lng: -73.992 };

type Coord = [number, number];
function line(from: RoutePoint, bearing: number, km: number, stepKm = 0.05): Coord[] {
  const n = Math.max(1, Math.round(km / stepKm));
  const out: Coord[] = [];
  for (let i = 0; i <= n; i++) {
    const p = destinationPoint(from, bearing, (km * i) / n);
    out.push([p.lng, p.lat]);
  }
  return out;
}
const toPt = (c: Coord): RoutePoint => ({ lat: c[1], lng: c[0] });
function leg(...pieces: Coord[][]) {
  const coords = pieces.flat();
  return { steps: [{ name: 'Street', distance: 0, geometry: { type: 'LineString', coordinates: coords } }] };
}
function route(legs: ReturnType<typeof leg>[]) {
  return { distance: 1000, duration: 0, geometry: { type: 'LineString', coordinates: [] as Coord[] }, legs };
}

describe('walking loop geometry', () => {
  afterEach(() => setOSRMBase(null));

  it('puts the start on the circle and every vertex on one side of it', () => {
    setOSRMBase('http://localhost:5005/route/v1/foot', 'walking');
    const plan = planWalkingLoop(START, 6.4, 30);
    expect(haversineDistance(plan.circleCenter, START)).toBeCloseTo(plan.radiusKm, 3);
    const wps = walkingLoopWaypoints(START, 6.4, 30);
    expect(wps[0]).toEqual(START);
    expect(wps[wps.length - 1]).toEqual(START);
    expect(wps.length).toBe(2 + plan.n);
    for (const v of wps.slice(1, -1)) {
      expect(haversineDistance(plan.circleCenter, v)).toBeCloseTo(plan.radiusKm, 3);
      // On the loop side of the start: within 90° of the plan bearing.
      expect(angleDiff(bearingFrom(START, v), 30)).toBeLessThan(90);
    }
  });

  it('sizes the polygon so perimeter × overhead ≈ target', () => {
    setOSRMBase('http://localhost:5005/route/v1/foot', 'walking');
    for (const km of [3.2, 6.4, 16, 32]) {
      const wps = walkingLoopWaypoints(START, km, 200);
      let perim = 0;
      for (let i = 1; i < wps.length; i++) perim += haversineDistance(wps[i - 1], wps[i]);
      expect(perim * 1.25).toBeCloseTo(km, 1);
    }
  });

  it('uses a triangle for short loops and more vertices for long ones', () => {
    setOSRMBase('http://localhost:5005/route/v1/foot', 'walking');
    expect(planWalkingLoop(START, 3.2, 0).n).toBe(2);   // 2mi
    expect(planWalkingLoop(START, 6.4, 0).n).toBe(3);   // 4mi
    expect(planWalkingLoop(START, 24, 0).n).toBe(4);    // 15mi
    expect(planWalkingLoop(START, 40, 0).n).toBe(5);    // 25mi
  });
});

describe('findWaypointDetours / applyDetourRepairs', () => {
  const A = START;
  const branch = destinationPoint(A, 0, 0.5);    // where the detour starts
  const W = destinationPoint(branch, 90, 0.4);   // waypoint at the end of a 400m dead end

  it('finds a dead-end detour and where it starts', () => {
    const leg0 = leg(line(A, 0, 0.5), line(branch, 90, 0.4).slice(1));
    // Out of W: back west along the same street, then on north.
    const leg1 = leg(line(W, 270, 0.4), line(branch, 0, 0.6).slice(1));
    const detours = findWaypointDetours(route([leg0, leg1]) as any);
    expect(detours).toHaveLength(1);
    expect(detours[0].index).toBe(1);
    expect(detours[0].wholeLeg).toBe(false);
    expect(haversineDistance(detours[0].divergence, branch)).toBeLessThan(0.04);
    expect(detours[0].doubledKm).toBeGreaterThan(0.3);
    expect(detours[0].detourKm).toBeGreaterThan(0.7);
  });

  it('counts a loop at the tip (lollipop) as one detour', () => {
    const tip = destinationPoint(W, 90, 0.15);
    const leg0 = leg(line(A, 0, 0.5), line(branch, 90, 0.4).slice(1));
    // From W: around a 150m block east of W, back to W, then back west.
    const leg1 = leg(
      line(W, 90, 0.15),
      line(tip, 0, 0.1).slice(1),
      line(destinationPoint(tip, 0, 0.1), 270, 0.15).slice(1),
      line(destinationPoint(W, 0, 0.1), 180, 0.1).slice(1),
      line(W, 270, 0.4).slice(1),
      line(branch, 0, 0.6).slice(1),
    );
    const detours = findWaypointDetours(route([leg0, leg1]) as any);
    expect(detours).toHaveLength(1);
    expect(haversineDistance(detours[0].divergence, branch)).toBeLessThan(0.04);
  });

  it('reports nothing for a waypoint the route passes through', () => {
    const leg0 = leg(line(A, 0, 0.5), line(branch, 90, 0.4).slice(1));
    const leg1 = leg(line(W, 90, 0.6));
    expect(findWaypointDetours(route([leg0, leg1]) as any)).toEqual([]);
  });

  it('moves a detour waypoint to its divergence point, drops pure spurs', () => {
    const wps = [A, W, destinationPoint(A, 45, 1), destinationPoint(A, 90, 1), A];
    const moved = applyDetourRepairs(wps, [{ index: 1, divergence: branch, wholeLeg: false, detourKm: 0.8, doubledKm: 0.4 }]);
    expect(moved).toHaveLength(5);
    expect(moved[1]).toEqual(branch);
    const dropped = applyDetourRepairs(wps, [{ index: 2, divergence: W, wholeLeg: true, detourKm: 2, doubledKm: 1 }]);
    expect(dropped).toHaveLength(4);
    // Never below 2 intermediate waypoints.
    const tri = [A, W, branch, A];
    expect(applyDetourRepairs(tri, [{ index: 1, divergence: A, wholeLeg: true, detourKm: 1, doubledKm: 0.5 }])).toHaveLength(4);
  });
});

describe('walking-profile gates without running classes (Mapbox)', () => {
  afterEach(() => setOSRMBase(null));
  const park: GreenSpace = {
    point: { lat: 40.720, lng: -73.975 }, tier: 1, kind: 'park', name: 'Linear Park', areaSize: 0.2,
    bounds: { minLat: 40.705, maxLat: 40.735, minLng: -73.990, maxLng: -73.970 },
  };
  const parkPathRoute = {
    distance: 800, duration: 0, geometry: { type: 'LineString', coordinates: [] as Coord[] },
    legs: [{ steps: [
      { name: 'Street', distance: 500, geometry: { type: 'LineString', coordinates: line({ lat: 40.70, lng: -73.99 }, 90, 0.5) } },
      { name: '', distance: 300, geometry: { type: 'LineString', coordinates: line({ lat: 40.732, lng: -73.985 }, 90, 0.3) } },
    ] }],
  };

  it('counts unnamed paths inside a park bounding box as in the park', () => {
    expect(computeOffStreetRatio(parkPathRoute as any, [park])).toBeCloseTo(0.375, 2); // car: circle only
    setOSRMBase('http://localhost:5004/route/v1/foot', 'walking');
    expect(computeOffStreetRatio(parkPathRoute as any, [park])).toBe(0);
  });

  it('does not flag long straight greenways/avenues as tunnels on foot', () => {
    // 2km dead-straight run (an avenue or greenway), then a turn. Points
    // every 200m so the car heuristic's 8-sample look-ahead spans >1.2km.
    const straight = line({ lat: 40.73, lng: -73.99 }, 30, 2.0, 0.2).map(toPt);
    const back = line(straight[straight.length - 1], 120, 2.0, 0.2).map(toPt).slice(1);
    const pts = [...straight, ...back];
    expect(hasRoutedBarrierCrossing(pts, [])).toBe(true); // car: straight-segment heuristic
    setOSRMBase('http://localhost:5004/route/v1/foot', 'walking');
    expect(hasRoutedBarrierCrossing(pts, [])).toBe(false);
  });

  it('lets long walking loops reach their far side (no 8km drift cap)', () => {
    // 32km (20mi) target; the route reaches 9km from the start.
    const center = { lat: 40.768, lng: -73.982 };
    const out = line(center, 20, 9, 0.2).map(toPt);
    const pts = [...out, ...out.slice().reverse().slice(1).map((p) => ({ lat: p.lat, lng: p.lng + 0.0004 }))];
    expect(hasRoutedBarrierCrossing(pts, [], center, 32)).toBe(true);
    setOSRMBase('http://localhost:5004/route/v1/foot', 'walking');
    expect(hasRoutedBarrierCrossing(pts, [], center, 32)).toBe(false);
  });

  it('detects ferries by step mode or class', () => {
    const mk = (step: object) => ({ distance: 1, duration: 0, geometry: { type: 'LineString', coordinates: [] }, legs: [{ steps: [step] }] });
    expect(routeUsesFerry(mk({ name: 'x', distance: 1, geometry: { type: 'LineString', coordinates: [] }, mode: 'ferry' }) as any)).toBe(true);
    expect(routeUsesFerry(mk({ name: 'x', distance: 1, geometry: { type: 'LineString', coordinates: [] }, intersections: [{ location: [0, 0], classes: ['ferry'] }] }) as any)).toBe(true);
    expect(routeUsesFerry(mk({ name: 'x', distance: 1, geometry: { type: 'LineString', coordinates: [] }, mode: 'walking' }) as any)).toBe(false);
  });
});

describe('expandParkWaypoints matchByPoint', () => {
  const bigPark: GreenSpace = { point: { lat: 40.78, lng: -73.965 }, tier: 1, kind: 'park', name: 'Big Park', areaSize: 3.4 };
  const geo: RoutePoint = { lat: 40.76, lng: -73.99 };
  const wps = [START, geo, bigPark.point, START];

  it('expands the park waypoint, not the geometric one before it', () => {
    const out = expandParkWaypoints(wps, [bigPark], undefined, true);
    expect(out).toHaveLength(5);
    expect(out[1]).toEqual(geo);
    expect(haversineDistance(out[2], bigPark.point)).toBeGreaterThan(0.1);
    expect(haversineDistance(out[3], bigPark.point)).toBeGreaterThan(0.1);
  });

  it('keeps index pairing by default (car path unchanged)', () => {
    const out = expandParkWaypoints(wps, [bigPark]);
    expect(out).toHaveLength(5);
    expect(out[3]).toEqual(bigPark.point);
  });
});
