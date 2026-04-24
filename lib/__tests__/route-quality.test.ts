import {
  removeSelfintersections,
  retraceRatio,
  segmentsCross,
  hasLikelyWaterCrossing,
  removeWaterCrossings,
  isAccessibleFromCenter,
  hasRoutedBarrierCrossing,
  selectGreenSpaceWaypoints,
  scaleWaypoints,
  expandParkWaypoints,
  haversineDistance,
  destinationPoint,
  bearingFrom,
  angleDiff,
  estimateCircuitDistance,
  scoreGreenSpace,
} from '../osrm';
import { computeHighwayProximity, computeWaterfrontProximity, computeGreenSpaceProximity, computeRunPathProximity, scoreRoute, countStartPasses, reversalCount } from '../route-scoring';
import type { RoutePoint } from '../route-generator';
import type { GreenSpace } from '../overpass';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a ring of points forming a clean circle (no self-intersection) */
function makeCircle(center: RoutePoint, radiusKm: number, n: number): RoutePoint[] {
  const points: RoutePoint[] = [];
  for (let i = 0; i < n; i++) {
    const bearing = (360 / n) * i;
    points.push(destinationPoint(center, bearing, radiusKm));
  }
  points.push(points[0]); // close the loop
  return points;
}

/**
 * Generate a route with a self-intersecting lollipop shape:
 * Goes NE, then loops around, crossing the outbound path on the way back.
 */
function makeSelfCrossingRoute(center: RoutePoint, radiusKm: number): RoutePoint[] {
  const n = 15;
  const points: RoutePoint[] = [];
  // Outbound: go northeast
  for (let i = 0; i <= n; i++) {
    points.push(destinationPoint(center, 45, radiusKm * (i / n)));
  }
  // Loop around: swing east, then south, then west — crossing the outbound path
  const tip = points[points.length - 1];
  for (let i = 1; i <= n; i++) {
    const angle = 45 + (270 * i) / n; // sweep 270 degrees
    points.push(destinationPoint(tip, angle, radiusKm * 0.6));
  }
  // Return: go southwest back to start (crosses the outbound NE line)
  const loopEnd = points[points.length - 1];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    points.push({
      lat: loopEnd.lat + (center.lat - loopEnd.lat) * t,
      lng: loopEnd.lng + (center.lng - loopEnd.lng) * t,
    });
  }
  return points;
}

/** Create a straight line of points between two locations */
function makeStraightLine(from: RoutePoint, to: RoutePoint, n: number): RoutePoint[] {
  const points: RoutePoint[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    points.push({
      lat: from.lat + (to.lat - from.lat) * t,
      lng: from.lng + (to.lng - from.lng) * t,
    });
  }
  return points;
}

/** Create a winding city-grid-like route between two points */
function makeWindingRoute(from: RoutePoint, to: RoutePoint, n: number): RoutePoint[] {
  const points: RoutePoint[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // Zigzag perpendicular to the main direction
    const perpOffset = Math.sin(i * 1.5) * 0.003;
    const dLat = to.lat - from.lat;
    const dLng = to.lng - from.lng;
    points.push({
      lat: from.lat + dLat * t + (-dLng) * perpOffset,
      lng: from.lng + dLng * t + dLat * perpOffset,
    });
  }
  return points;
}

function makeGreenSpace(overrides: Partial<GreenSpace> = {}): GreenSpace {
  return {
    point: { lat: 40.77, lng: -73.97 },
    tier: 1,
    kind: 'park',
    name: 'Central Park',
    areaSize: 3.41,
    ...overrides,
  };
}

// NYC center (Columbus Circle area)
const NYC: RoutePoint = { lat: 40.768, lng: -73.982 };

// ---------------------------------------------------------------------------
// 1. No self-intersections / backtracking
// ---------------------------------------------------------------------------

describe('removeSelfintersections', () => {
  it('returns short routes unchanged (< 20 points)', () => {
    const short = makeCircle(NYC, 0.5, 10);
    expect(removeSelfintersections(short)).toEqual(short);
  });

  it('does not alter a clean circular route', () => {
    const circle = makeCircle(NYC, 1, 50);
    const result = removeSelfintersections(circle);
    // Should keep approximately the same number of points
    expect(result.length).toBeGreaterThanOrEqual(circle.length * 0.9);
  });

  it('removes a self-intersecting loop from a lollipop route', () => {
    const route = makeSelfCrossingRoute(NYC, 1.0);
    expect(route.length).toBeGreaterThan(20);
    const result = removeSelfintersections(route);
    // Should have removed the crossing loop
    expect(result.length).toBeLessThan(route.length);
  });

  it('iterates to remove multiple stacked lollipops in one call', () => {
    // Two lollipops back-to-back: each loop must be 5%-40% of total length
    // to be cut, so we build them deliberately and pad with straight segments.
    const a = makeSelfCrossingRoute(NYC, 1.0);
    const tail = a[a.length - 1];
    const b = makeSelfCrossingRoute(tail, 1.0);
    const stacked = [...a, ...b.slice(1)];
    const cleaned = removeSelfintersections(stacked);
    // Both loops should be cut, not just one
    let crossings = 0;
    const step = Math.max(1, Math.floor(cleaned.length / 200));
    for (let i = 0; i < cleaned.length - 3; i += step) {
      for (let j = i + 10; j < cleaned.length - 1; j += step) {
        if (segmentsCross(cleaned[i], cleaned[i + 1], cleaned[j], cleaned[j + 1])) {
          crossings++;
        }
      }
    }
    expect(crossings).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Segment crossing detection
// ---------------------------------------------------------------------------

describe('retraceRatio', () => {
  it('returns 0 for a clean non-retracing path', () => {
    const route = makeStraightLine(NYC, destinationPoint(NYC, 90, 1), 30);
    expect(retraceRatio(route)).toBe(0);
  });

  it('returns ~1 for a perfect out-and-back over the same edges', () => {
    const out = makeStraightLine(NYC, destinationPoint(NYC, 90, 1), 30);
    const back = [...out].reverse().slice(1);
    const route = [...out, ...back];
    // Every back-segment retraces an out-segment (within rounding).
    expect(retraceRatio(route)).toBeGreaterThan(0.45);
  });

  it('returns a moderate value for a partial retrace stub', () => {
    // 30 segments total, last 10 retrace the previous 10
    const out = makeStraightLine(NYC, destinationPoint(NYC, 90, 2), 20);
    const stub = out.slice(10).reverse().slice(1);
    const route = [...out, ...stub];
    const r = retraceRatio(route);
    expect(r).toBeGreaterThan(0.2);
    expect(r).toBeLessThan(0.5);
  });
});

describe('segmentsCross', () => {
  it('detects crossing segments (X shape)', () => {
    const a1: RoutePoint = { lat: 0, lng: 0 };
    const a2: RoutePoint = { lat: 1, lng: 1 };
    const b1: RoutePoint = { lat: 0, lng: 1 };
    const b2: RoutePoint = { lat: 1, lng: 0 };
    expect(segmentsCross(a1, a2, b1, b2)).toBe(true);
  });

  it('returns false for parallel segments', () => {
    const a1: RoutePoint = { lat: 0, lng: 0 };
    const a2: RoutePoint = { lat: 1, lng: 0 };
    const b1: RoutePoint = { lat: 0, lng: 1 };
    const b2: RoutePoint = { lat: 1, lng: 1 };
    expect(segmentsCross(a1, a2, b1, b2)).toBe(false);
  });

  it('returns false for non-intersecting segments', () => {
    const a1: RoutePoint = { lat: 0, lng: 0 };
    const a2: RoutePoint = { lat: 1, lng: 0 };
    const b1: RoutePoint = { lat: 2, lng: 2 };
    const b2: RoutePoint = { lat: 3, lng: 3 };
    expect(segmentsCross(a1, a2, b1, b2)).toBe(false);
  });

  it('returns false for L-shaped segments that share an endpoint', () => {
    const a1: RoutePoint = { lat: 0, lng: 0 };
    const a2: RoutePoint = { lat: 1, lng: 0 };
    const b1: RoutePoint = { lat: 1, lng: 0 };
    const b2: RoutePoint = { lat: 1, lng: 1 };
    // Shared endpoint is not a "crossing"
    expect(segmentsCross(a1, a2, b1, b2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. No tunnel / bridge crossings
// ---------------------------------------------------------------------------

describe('hasRoutedBarrierCrossing', () => {
  it('flags a route with unnaturally straight segments (tunnel/bridge)', () => {
    // Simulate a tunnel: perfectly straight line for 800m
    const start: RoutePoint = { lat: 40.76, lng: -74.00 };
    const end: RoutePoint = { lat: 40.767, lng: -74.00 }; // ~780m north
    const straightSegment = makeStraightLine(start, end, 40);

    // Pad with winding sections on each end so the route is long enough
    const preWind = makeWindingRoute(
      { lat: 40.75, lng: -74.00 },
      start,
      20
    );
    const postWind = makeWindingRoute(
      end,
      { lat: 40.775, lng: -74.00 },
      20
    );

    const route = [...preWind, ...straightSegment, ...postWind];
    expect(route.length).toBeGreaterThan(20);

    const result = hasRoutedBarrierCrossing(route, [], NYC, 5);
    expect(result).toBe(true);
  });

  it('passes a normally winding city route', () => {
    const winding = makeWindingRoute(
      { lat: 40.76, lng: -73.99 },
      { lat: 40.78, lng: -73.97 },
      60
    );
    const result = hasRoutedBarrierCrossing(winding, [], NYC, 5);
    expect(result).toBe(false);
  });

  it('flags a route that drifts too far from center', () => {
    // Route that starts near center but goes 5km away (too far for a 5km loop)
    const farAway = destinationPoint(NYC, 90, 5); // 5km east
    const route = makeStraightLine(NYC, farAway, 60);
    // For a 5km route, max drift = 5 * 0.45 = 2.25km
    const result = hasRoutedBarrierCrossing(route, [], NYC, 5);
    expect(result).toBe(true);
  });

  it('allows routes within acceptable drift for longer distances', () => {
    // 2km from center is fine for a 20km route (max drift = 8km)
    const nearish = destinationPoint(NYC, 90, 2);
    const route = makeWindingRoute(NYC, nearish, 60);
    const result = hasRoutedBarrierCrossing(route, [], NYC, 20);
    expect(result).toBe(false);
  });

  it('returns false for short routes (< 20 points)', () => {
    const short = makeStraightLine(NYC, destinationPoint(NYC, 0, 2), 10);
    expect(hasRoutedBarrierCrossing(short, [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Water crossing detection & avoidance
// ---------------------------------------------------------------------------

describe('hasLikelyWaterCrossing', () => {
  it('flags waypoints > 1.5km apart', () => {
    const p1: RoutePoint = { lat: 40.76, lng: -74.00 };
    const p2 = destinationPoint(p1, 90, 2); // 2km east
    expect(hasLikelyWaterCrossing(p1, p2, [])).toBe(true);
  });

  it('passes waypoints < 1.5km apart', () => {
    const p1: RoutePoint = { lat: 40.76, lng: -74.00 };
    const p2 = destinationPoint(p1, 90, 1); // 1km east
    expect(hasLikelyWaterCrossing(p1, p2, [])).toBe(false);
  });
});

describe('removeWaterCrossings', () => {
  it('removes waypoints that would cause a water crossing', () => {
    const center = NYC;
    const close = destinationPoint(center, 0, 0.5); // 500m north, fine
    const far = destinationPoint(center, 90, 3); // 3km east, likely barrier
    const waypoints = [center, close, far, center];

    // Should remove dangerous waypoints even with no green spaces available
    const result = removeWaterCrossings(waypoints, [], center);
    expect(result.length).toBeLessThan(waypoints.length);
    expect(result[0]).toEqual(center);
  });

  it('keeps all waypoints when none cross water', () => {
    const center = NYC;
    const wp1 = destinationPoint(center, 0, 0.5);
    const wp2 = destinationPoint(center, 90, 0.5);
    const waypoints = [center, wp1, wp2, center];

    const result = removeWaterCrossings(waypoints, [], center);
    expect(result.length).toBe(waypoints.length);
  });

  it('replaces a bad waypoint with a nearby green space when possible', () => {
    const center = NYC;
    const dangerous = destinationPoint(center, 90, 3); // 3km east, barrier
    const waypoints = [center, dangerous, center];

    // A park in the same general direction but close enough (no crossing)
    const safePark = makeGreenSpace({
      point: destinationPoint(center, 85, 1.0), // ~1km east-ish, safe
      name: 'Safe Park',
      areaSize: 0.5,
    });

    const result = removeWaterCrossings(waypoints, [safePark], center);
    // The dangerous waypoint should be replaced (not removed)
    expect(result.length).toBe(waypoints.length);
    // The replacement should be the safe park's location
    expect(haversineDistance(result[1], safePark.point)).toBeLessThan(0.01);
  });
});

// ---------------------------------------------------------------------------
// 5. Accessibility from center
// ---------------------------------------------------------------------------

describe('isAccessibleFromCenter', () => {
  it('returns true for points within 3km', () => {
    const target = destinationPoint(NYC, 45, 2.5);
    expect(isAccessibleFromCenter(NYC, target, [])).toBe(true);
  });

  it('returns false for points beyond 3km', () => {
    const target = destinationPoint(NYC, 45, 3.5);
    expect(isAccessibleFromCenter(NYC, target, [])).toBe(false);
  });

  it('returns true for the center itself', () => {
    expect(isAccessibleFromCenter(NYC, NYC, [])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Green space waypoint selection — scenic routing
// ---------------------------------------------------------------------------

describe('selectGreenSpaceWaypoints', () => {
  // Create parks spread around NYC at different bearings
  function makeParksAround(center: RoutePoint): GreenSpace[] {
    return [
      makeGreenSpace({
        point: destinationPoint(center, 0, 1.0),
        name: 'North Park',
        kind: 'park',
        areaSize: 0.5,
      }),
      makeGreenSpace({
        point: destinationPoint(center, 90, 1.2),
        name: 'East Garden',
        kind: 'garden',
        areaSize: 0.3,
      }),
      makeGreenSpace({
        point: destinationPoint(center, 180, 0.8),
        name: 'South Reserve',
        kind: 'nature',
        areaSize: 0.8,
      }),
      makeGreenSpace({
        point: destinationPoint(center, 270, 1.0),
        name: 'West Park',
        kind: 'park',
        areaSize: 0.4,
      }),
      makeGreenSpace({
        point: destinationPoint(center, 45, 1.5),
        name: 'Northeast Woods',
        kind: 'nature',
        areaSize: 1.0,
      }),
      makeGreenSpace({
        point: destinationPoint(center, 225, 1.3),
        name: 'Southwest Trail',
        kind: 'park',
        areaSize: 0.6,
      }),
    ];
  }

  it('selects waypoints from green spaces (scenic routing)', () => {
    const parks = makeParksAround(NYC);
    const result = selectGreenSpaceWaypoints(NYC, parks, 8, false, 1, 'balanced');

    expect(result).not.toBeNull();
    // Should have selected some green space waypoints + center bookends
    expect(result!.waypoints.length).toBeGreaterThanOrEqual(4); // center + 2 parks + center
    expect(result!.anchors.length).toBeGreaterThanOrEqual(2);
    // First and last waypoint should be center
    expect(result!.waypoints[0]).toEqual(NYC);
    expect(result!.waypoints[result!.waypoints.length - 1]).toEqual(NYC);
  });

  it('caps waypoints at 3 to prevent small zigzag loops', () => {
    const parks = makeParksAround(NYC);
    const result = selectGreenSpaceWaypoints(NYC, parks, 8, false, 1, 'balanced');

    expect(result).not.toBeNull();
    // Max 3 green space waypoints (plus 2 center bookends = 5 total max)
    const greenWaypoints = result!.waypoints.length - 2; // minus center bookends
    expect(greenWaypoints).toBeLessThanOrEqual(3);
  });

  it('removes waypoints too close to center (prevents backtracking)', () => {
    const veryCloseParks: GreenSpace[] = [
      makeGreenSpace({
        point: destinationPoint(NYC, 0, 0.2), // 200m away — too close
        name: 'Tiny Nearby Park',
        kind: 'park',
        areaSize: 0.1,
      }),
      makeGreenSpace({
        point: destinationPoint(NYC, 180, 1.5),
        name: 'Far South Park',
        kind: 'park',
        areaSize: 0.5,
      }),
      makeGreenSpace({
        point: destinationPoint(NYC, 90, 1.2),
        name: 'East Park',
        kind: 'park',
        areaSize: 0.4,
      }),
    ];
    const result = selectGreenSpaceWaypoints(NYC, veryCloseParks, 8, false, 1, 'balanced');

    if (result) {
      // The very close park should NOT be a waypoint
      const innerWaypoints = result.waypoints.slice(1, -1);
      for (const wp of innerWaypoints) {
        const dist = haversineDistance(NYC, wp);
        expect(dist).toBeGreaterThan(0.5); // at least 500m from center
      }
    }
  });

  it('removes waypoints too close to each other (prevents block-looping)', () => {
    // Two parks very close together — should keep only one
    const closePair: GreenSpace[] = [
      makeGreenSpace({
        point: destinationPoint(NYC, 0, 1.0),
        name: 'Park A',
        kind: 'park',
        areaSize: 0.5,
      }),
      makeGreenSpace({
        point: destinationPoint(NYC, 5, 1.05), // nearly same direction, very close to Park A
        name: 'Park B',
        kind: 'park',
        areaSize: 0.3,
      }),
      makeGreenSpace({
        point: destinationPoint(NYC, 180, 1.2),
        name: 'Park C',
        kind: 'park',
        areaSize: 0.4,
      }),
    ];
    const result = selectGreenSpaceWaypoints(NYC, closePair, 8, false, 1, 'balanced');

    if (result) {
      const innerWaypoints = result.waypoints.slice(1, -1);
      // No two waypoints should be closer than ~1km
      for (let i = 0; i < innerWaypoints.length; i++) {
        for (let j = i + 1; j < innerWaypoints.length; j++) {
          const dist = haversineDistance(innerWaypoints[i], innerWaypoints[j]);
          expect(dist).toBeGreaterThan(0.8);
        }
      }
    }
  });

  it('orders waypoints by bearing to form a loop (not zigzag)', () => {
    const parks = makeParksAround(NYC);
    const result = selectGreenSpaceWaypoints(NYC, parks, 8, false, 1, 'balanced');

    if (result && result.waypoints.length > 3) {
      // Inner waypoints (excluding center bookends) should have monotonically
      // increasing bearings — this means the route goes around in one direction
      const inner = result.waypoints.slice(1, -1);
      const bearings = inner.map((wp) => bearingFrom(NYC, wp));
      for (let i = 1; i < bearings.length; i++) {
        expect(bearings[i]).toBeGreaterThan(bearings[i - 1]);
      }
    }
  });

  it('returns null when too few green spaces available', () => {
    const singlePark: GreenSpace[] = [
      makeGreenSpace({
        point: destinationPoint(NYC, 0, 1.0),
        name: 'Only Park',
        kind: 'park',
        areaSize: 0.5,
      }),
    ];
    const result = selectGreenSpaceWaypoints(NYC, singlePark, 8, false, 1, 'balanced');
    expect(result).toBeNull();
  });

  it('rejects green spaces beyond the max radius', () => {
    const farParks: GreenSpace[] = [
      makeGreenSpace({
        point: destinationPoint(NYC, 0, 20), // 20km away — way too far for a 5km run
        name: 'Distant Park',
        kind: 'park',
        areaSize: 1.0,
      }),
      makeGreenSpace({
        point: destinationPoint(NYC, 180, 15),
        name: 'Another Far Park',
        kind: 'park',
        areaSize: 0.8,
      }),
    ];
    const result = selectGreenSpaceWaypoints(NYC, farParks, 5, false, 1, 'balanced');
    expect(result).toBeNull();
  });

  it('prefers large parks with the large-parks strategy', () => {
    const parks: GreenSpace[] = [
      makeGreenSpace({
        point: destinationPoint(NYC, 0, 1.0),
        name: 'Small Park',
        kind: 'park',
        areaSize: 0.05,
      }),
      makeGreenSpace({
        point: destinationPoint(NYC, 10, 1.2), // similar direction
        name: 'Huge Park',
        kind: 'park',
        areaSize: 2.0,
      }),
      makeGreenSpace({
        point: destinationPoint(NYC, 180, 1.0),
        name: 'South Park',
        kind: 'park',
        areaSize: 0.3,
      }),
    ];
    const result = selectGreenSpaceWaypoints(NYC, parks, 8, false, 1, 'large-parks');

    if (result) {
      // Huge Park should be among the anchors
      const anchorNames = result.anchors.map((a) => a.name);
      expect(anchorNames).toContain('Huge Park');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Scale waypoints (distance adjustment)
// ---------------------------------------------------------------------------

describe('scaleWaypoints', () => {
  it('does not move the first and last waypoints', () => {
    const center = NYC;
    const wp1 = destinationPoint(center, 0, 1);
    const wp2 = destinationPoint(center, 120, 1);
    const waypoints = [center, wp1, wp2, center];

    const scaled = scaleWaypoints(waypoints, center, 0.5);
    expect(scaled[0]).toEqual(center);
    expect(scaled[scaled.length - 1]).toEqual(center);
  });

  it('shrinks intermediate waypoints toward center when scale < 1', () => {
    const center = NYC;
    const wp1 = destinationPoint(center, 0, 2);
    const waypoints = [center, wp1, center];

    const scaled = scaleWaypoints(waypoints, center, 0.5);
    const originalDist = haversineDistance(center, wp1);
    const scaledDist = haversineDistance(center, scaled[1]);
    expect(scaledDist).toBeLessThan(originalDist);
    expect(scaledDist).toBeCloseTo(originalDist * 0.5, 0);
  });

  it('expands intermediate waypoints away from center when scale > 1', () => {
    const center = NYC;
    const wp1 = destinationPoint(center, 0, 1);
    const waypoints = [center, wp1, center];

    const scaled = scaleWaypoints(waypoints, center, 1.5);
    const originalDist = haversineDistance(center, wp1);
    const scaledDist = haversineDistance(center, scaled[1]);
    expect(scaledDist).toBeGreaterThan(originalDist);
  });

  it('keeps waypoints unchanged when scale = 1', () => {
    const center = NYC;
    const wp1 = destinationPoint(center, 0, 1);
    const wp2 = destinationPoint(center, 120, 1.5);
    const waypoints = [center, wp1, wp2, center];

    const scaled = scaleWaypoints(waypoints, center, 1.0);
    for (let i = 0; i < waypoints.length; i++) {
      expect(scaled[i].lat).toBeCloseTo(waypoints[i].lat, 10);
      expect(scaled[i].lng).toBeCloseTo(waypoints[i].lng, 10);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. End-to-end quality invariants
// ---------------------------------------------------------------------------

describe('route quality invariants', () => {
  it('a clean circular route passes all quality checks', () => {
    const route = makeCircle(NYC, 0.8, 60);
    // A smooth curve should NOT be flagged as a barrier (tunnel/bridge)
    expect(hasRoutedBarrierCrossing(route, [], NYC, 5)).toBe(false);
    // Self-intersection removal should keep most points
    const cleaned = removeSelfintersections(route);
    expect(cleaned.length).toBeGreaterThanOrEqual(route.length * 0.8);
  });

  it('consecutive waypoints in selected green spaces are well-spaced', () => {
    const parks: GreenSpace[] = [
      makeGreenSpace({ point: destinationPoint(NYC, 0, 1.0), name: 'N Park', areaSize: 0.5 }),
      makeGreenSpace({ point: destinationPoint(NYC, 60, 1.2), name: 'NE Park', areaSize: 0.4 }),
      makeGreenSpace({ point: destinationPoint(NYC, 120, 1.1), name: 'SE Park', areaSize: 0.6 }),
      makeGreenSpace({ point: destinationPoint(NYC, 180, 0.9), name: 'S Park', areaSize: 0.3 }),
      makeGreenSpace({ point: destinationPoint(NYC, 240, 1.3), name: 'SW Park', areaSize: 0.7 }),
      makeGreenSpace({ point: destinationPoint(NYC, 300, 1.0), name: 'NW Park', areaSize: 0.4 }),
    ];

    const result = selectGreenSpaceWaypoints(NYC, parks, 8, false, 1, 'balanced');
    if (result) {
      const inner = result.waypoints.slice(1, -1);
      // All consecutive waypoints should be at least 800m apart
      for (let i = 1; i < inner.length; i++) {
        expect(haversineDistance(inner[i - 1], inner[i])).toBeGreaterThan(0.8);
      }
      // All waypoints should be at least minCenterDist from center
      for (const wp of inner) {
        expect(haversineDistance(NYC, wp)).toBeGreaterThan(0.5);
      }
    }
  });

  it('water crossing removal + barrier check work together', () => {
    const center = NYC;
    const safe1 = destinationPoint(center, 0, 0.8);
    const dangerous = destinationPoint(center, 90, 4); // far away — water crossing
    const safe2 = destinationPoint(center, 180, 0.7);
    const waypoints = [center, safe1, dangerous, safe2, center];

    // Should remove dangerous waypoints even without any green space replacements
    const cleaned = removeWaterCrossings(waypoints, [], center);
    expect(cleaned.length).toBeLessThan(waypoints.length);
    // Remaining waypoints should all be within a reasonable distance
    for (const wp of cleaned) {
      expect(haversineDistance(center, wp)).toBeLessThan(1.5);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Highway avoidance
// ---------------------------------------------------------------------------

describe('computeHighwayProximity', () => {
  it('returns 0 when there are no highway points', () => {
    const route = makeCircle(NYC, 1, 30);
    expect(computeHighwayProximity(route, [])).toBe(0);
  });

  it('returns 0 when there are no route points', () => {
    const highways = [destinationPoint(NYC, 0, 1)];
    expect(computeHighwayProximity([], highways)).toBe(0);
  });

  it('returns 0 when route is far from all highways', () => {
    // Route in one area, highways in a completely different area
    const route = makeCircle(NYC, 0.5, 30);
    const highways = [
      destinationPoint(NYC, 0, 10), // 10km away
      destinationPoint(NYC, 90, 8),
    ];
    expect(computeHighwayProximity(route, highways)).toBe(0);
  });

  it('returns high score when route runs along a highway', () => {
    // Create a route that follows the same path as a highway
    const start = NYC;
    const end = destinationPoint(NYC, 45, 2);
    const route = makeStraightLine(start, end, 40);

    // Place highway points along the same path
    const highways: RoutePoint[] = [];
    for (let i = 0; i <= 20; i++) {
      highways.push(destinationPoint(start, 45, 2 * (i / 20)));
    }

    const proximity = computeHighwayProximity(route, highways);
    expect(proximity).toBeGreaterThan(0.5);
  });

  it('returns moderate score when route partially overlaps a highway', () => {
    // Route goes east for 2km
    const start = destinationPoint(NYC, 270, 1);
    const end = destinationPoint(NYC, 90, 1);
    const route = makeStraightLine(start, end, 40);

    // Highway runs along the first third of the route (same path)
    const hwEnd = destinationPoint(start, 90, 0.7); // first 700m
    const highways: RoutePoint[] = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      highways.push({
        lat: start.lat + (hwEnd.lat - start.lat) * t,
        lng: start.lng + (hwEnd.lng - start.lng) * t,
      });
    }

    const proximity = computeHighwayProximity(route, highways);
    // ~1/3 of the route overlaps the highway
    expect(proximity).toBeGreaterThan(0);
    expect(proximity).toBeLessThan(0.6);
  });

  it('uses 100m default proximity threshold', () => {
    // Route point exactly 90m from a highway — should count
    const routePoint: RoutePoint = NYC;
    const nearHighway = destinationPoint(NYC, 0, 0.09); // 90m north
    expect(computeHighwayProximity([routePoint], [nearHighway])).toBe(1);

    // Route point exactly 150m from a highway — should NOT count
    const farHighway = destinationPoint(NYC, 0, 0.15); // 150m north
    expect(computeHighwayProximity([routePoint], [farHighway])).toBe(0);
  });
});

describe('highway rejection threshold', () => {
  it('routes with >15% highway proximity should be rejected', () => {
    // This tests the threshold used in generateOSRMRoutes
    const MAX_HIGHWAY_PROXIMITY = 0.15;

    // A route where 20% of points are near highways — should be rejected
    const route: RoutePoint[] = [];
    for (let i = 0; i < 50; i++) {
      route.push(destinationPoint(NYC, (360 / 50) * i, 1));
    }
    // Place highways near 20% of those points (10 out of 50)
    const highways: RoutePoint[] = [];
    for (let i = 0; i < 10; i++) {
      highways.push(destinationPoint(NYC, (360 / 50) * i, 1));
    }

    const proximity = computeHighwayProximity(route, highways);
    expect(proximity).toBeGreaterThan(MAX_HIGHWAY_PROXIMITY);
  });

  it('routes with <15% highway proximity should pass', () => {
    const MAX_HIGHWAY_PROXIMITY = 0.15;

    // Route circles at 1km from center
    const route: RoutePoint[] = [];
    for (let i = 0; i < 50; i++) {
      route.push(destinationPoint(NYC, (360 / 50) * i, 1));
    }
    // Single highway point far from any sampled route point
    // (at 180° and offset inward so it's >100m from the circle)
    const highways = [
      destinationPoint(NYC, 180, 0.5), // 500m from center, route is at 1km
    ];

    const proximity = computeHighwayProximity(route, highways);
    expect(proximity).toBeLessThanOrEqual(MAX_HIGHWAY_PROXIMITY);
  });
});

// ===========================================================================
// ROUTE QUALITY SIMULATION HARNESS
// ===========================================================================
// These tests simulate route generation across diverse scenarios and check
// broad quality invariants. They catch quality regressions that individual
// unit tests miss — like subtle parameter interactions that produce bad routes.

// ---------------------------------------------------------------------------
// Test locations representing diverse running environments
// ---------------------------------------------------------------------------

const LOCATIONS: Record<string, RoutePoint> = {
  nyc_columbus_circle: { lat: 40.768, lng: -73.982 },
  nyc_lower_east_side: { lat: 40.715, lng: -73.985 },
  sf_embarcadero: { lat: 37.795, lng: -122.394 },
  chicago_lakefront: { lat: 41.886, lng: -87.616 },
  boston_esplanade: { lat: 42.354, lng: -71.072 },
};

/** Build a realistic set of green spaces around a location */
function makeRealisticGreenSpaces(center: RoutePoint): GreenSpace[] {
  const spaces: GreenSpace[] = [];

  // Large parks at varying distances and bearings
  const parkConfigs = [
    { bearing: 15, dist: 1.2, name: 'City Park', area: 1.5 },
    { bearing: 95, dist: 0.9, name: 'Riverside Park', area: 0.8 },
    { bearing: 170, dist: 1.5, name: 'Memorial Park', area: 2.0 },
    { bearing: 250, dist: 1.0, name: 'Lincoln Park', area: 0.6 },
    { bearing: 320, dist: 1.8, name: 'Heritage Garden', area: 0.3 },
  ];
  for (const cfg of parkConfigs) {
    spaces.push({
      point: destinationPoint(center, cfg.bearing, cfg.dist),
      tier: 1, kind: 'park', name: cfg.name, areaSize: cfg.area,
    });
  }

  // Waterfront features
  const waterfrontConfigs = [
    { bearing: 90, dist: 0.6, name: 'Waterfront Promenade' },
    { bearing: 100, dist: 0.8, name: 'River Walk' },
    { bearing: 110, dist: 1.0, name: 'Esplanade Path' },
  ];
  for (const cfg of waterfrontConfigs) {
    spaces.push({
      point: destinationPoint(center, cfg.bearing, cfg.dist),
      tier: 1, kind: 'waterfront', name: cfg.name, areaSize: 0,
    });
  }

  // Cycleways and footways
  const pathConfigs = [
    { bearing: 45, dist: 0.7, name: 'Bike Path North' },
    { bearing: 180, dist: 1.1, name: 'Greenway South' },
    { bearing: 270, dist: 0.5, name: null },
  ];
  for (const cfg of pathConfigs) {
    spaces.push({
      point: destinationPoint(center, cfg.bearing, cfg.dist),
      tier: cfg.name ? 1 : 2, kind: 'cycleway', name: cfg.name, areaSize: 0,
    });
  }

  return spaces;
}

/** Simulate highway locations near a center point */
function makeRealisticHighways(center: RoutePoint): RoutePoint[] {
  // Highways typically run through specific corridors
  const hwPoints: RoutePoint[] = [];
  // A highway running roughly east-west 2km south
  for (let i = 0; i < 10; i++) {
    hwPoints.push(destinationPoint(
      destinationPoint(center, 180, 2.0),
      90, i * 0.3
    ));
  }
  return hwPoints;
}

// ---------------------------------------------------------------------------
// 10. Waterfront scoring
// ---------------------------------------------------------------------------

describe('computeWaterfrontProximity', () => {
  it('returns 0 when no waterfront features exist', () => {
    const route = makeCircle(NYC, 1, 30);
    const parks: GreenSpace[] = [
      makeGreenSpace({ kind: 'park', point: destinationPoint(NYC, 0, 1) }),
    ];
    expect(computeWaterfrontProximity(route, parks)).toBe(0);
  });

  it('returns high score when route runs along waterfront', () => {
    // Route runs along a line of waterfront features
    const start = NYC;
    const end = destinationPoint(NYC, 90, 1.5);
    const route = makeStraightLine(start, end, 40);

    // Place waterfront features along the same corridor
    const waterfront: GreenSpace[] = [];
    for (let i = 0; i < 10; i++) {
      waterfront.push({
        point: destinationPoint(start, 90, 0.15 * i),
        tier: 1, kind: 'waterfront', name: `Pier ${i}`, areaSize: 0,
      });
    }
    const proximity = computeWaterfrontProximity(route, waterfront);
    expect(proximity).toBeGreaterThan(0.3);
  });

  it('returns 0 when route is far from waterfront', () => {
    const route = makeCircle(NYC, 0.5, 30);
    const waterfront: GreenSpace[] = [{
      point: destinationPoint(NYC, 0, 10), // 10km away
      tier: 1, kind: 'waterfront', name: 'Distant Shore', areaSize: 0,
    }];
    expect(computeWaterfrontProximity(route, waterfront)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 11. Waterfront features boost waypoint selection
// ---------------------------------------------------------------------------

describe('waterfront in waypoint selection', () => {
  it('waterfront features score higher than unnamed paths', () => {
    const wf: GreenSpace = {
      point: NYC, tier: 1, kind: 'waterfront', name: 'Riverwalk', areaSize: 0,
    };
    const path: GreenSpace = {
      point: NYC, tier: 2, kind: 'path', name: null, areaSize: 0,
    };
    expect(scoreGreenSpace(wf, 'balanced', false)).toBeGreaterThan(
      scoreGreenSpace(path, 'balanced', false)
    );
  });

  it('waterfront features are eligible as loop waypoints', () => {
    const center = NYC;
    // Only waterfront features available — should still produce waypoints
    const waterfront: GreenSpace[] = [
      { point: destinationPoint(center, 0, 1.2), tier: 1, kind: 'waterfront', name: 'North Pier', areaSize: 0 },
      { point: destinationPoint(center, 120, 1.5), tier: 1, kind: 'waterfront', name: 'East Marina', areaSize: 0 },
      { point: destinationPoint(center, 240, 1.0), tier: 1, kind: 'waterfront', name: 'South Dock', areaSize: 0 },
    ];
    const result = selectGreenSpaceWaypoints(center, waterfront, 8, false, 1, 'balanced');
    expect(result).not.toBeNull();
    expect(result!.anchors.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 11b. Popular/landmark park preference
// ---------------------------------------------------------------------------

describe('popular park preference', () => {
  it('large named parks score much higher than pocket parks', () => {
    const centralPark: GreenSpace = {
      point: NYC, tier: 1, kind: 'park', name: 'Central Park', areaSize: 3.41,
    };
    const pocketPark: GreenSpace = {
      point: NYC, tier: 1, kind: 'park', name: 'Tiny Triangle', areaSize: 0.005,
    };
    const cpScore = scoreGreenSpace(centralPark, 'balanced', false);
    const ppScore = scoreGreenSpace(pocketPark, 'balanced', false);
    // Central Park should score at least 2x a pocket park
    expect(cpScore).toBeGreaterThan(ppScore * 2);
  });

  it('named medium parks score higher than unnamed ones', () => {
    const named: GreenSpace = {
      point: NYC, tier: 1, kind: 'park', name: 'McCarren Park', areaSize: 0.14,
    };
    const unnamed: GreenSpace = {
      point: NYC, tier: 2, kind: 'park', name: null, areaSize: 0.14,
    };
    expect(scoreGreenSpace(named, 'balanced', false)).toBeGreaterThan(
      scoreGreenSpace(unnamed, 'balanced', false)
    );
  });

  it('landmark parks are selected over small parks when both exist', () => {
    const center = NYC;
    // Central Park to the north, pocket park to the south
    const parks: GreenSpace[] = [
      {
        point: destinationPoint(center, 0, 1.5),
        tier: 1, kind: 'park', name: 'Central Park', areaSize: 3.41,
      },
      {
        point: destinationPoint(center, 10, 1.0), // similar direction, closer
        tier: 1, kind: 'park', name: 'Small Playground', areaSize: 0.01,
      },
      {
        point: destinationPoint(center, 180, 1.2),
        tier: 1, kind: 'park', name: 'South Park', areaSize: 0.3,
      },
    ];
    const result = selectGreenSpaceWaypoints(center, parks, 8, false, 1, 'balanced');
    if (result) {
      const anchorNames = result.anchors.map((a) => a.name);
      // Should prefer Central Park over Small Playground
      expect(anchorNames).toContain('Central Park');
    }
  });

  it('large-parks strategy strongly favors landmark parks', () => {
    const centralPark: GreenSpace = {
      point: NYC, tier: 1, kind: 'park', name: 'Central Park', areaSize: 3.41,
    };
    const smallPark: GreenSpace = {
      point: NYC, tier: 1, kind: 'park', name: 'Small Garden', areaSize: 0.02,
    };
    const lpScore = scoreGreenSpace(centralPark, 'large-parks', false);
    const spScore = scoreGreenSpace(smallPark, 'large-parks', false);
    // With large-parks strategy, the gap should be even bigger
    expect(lpScore).toBeGreaterThan(spScore * 2);
  });
});

// ---------------------------------------------------------------------------
// 12. Scoring weights integration
// ---------------------------------------------------------------------------

describe('scoreRoute weights', () => {
  const candidate = { distanceKm: 5, targetDistanceKm: 5 }; // perfect distance

  it('waterfront proximity boosts score in relaxed mode', () => {
    const noWaterfront = scoreRoute(candidate, { lowTraffic: false }, 0.5, 0.5, 0.5, 0);
    const withWaterfront = scoreRoute(candidate, { lowTraffic: false }, 0.5, 0.5, 0.5, 0.8);
    expect(withWaterfront).toBeGreaterThan(noWaterfront);
  });

  it('waterfront proximity boosts score more in strict mode', () => {
    const noWf = scoreRoute(candidate, { lowTraffic: true }, 0.5, 0.5, 0.5, 0);
    const withWf = scoreRoute(candidate, { lowTraffic: true }, 0.5, 0.5, 0.5, 0.8);
    const boost = withWf - noWf;
    expect(boost).toBeGreaterThan(0.1);
  });

  it('perfect distance + all amenities yields high score', () => {
    const score = scoreRoute(candidate, { lowTraffic: false }, 0.8, 0.8, 0.8, 0.8);
    expect(score).toBeGreaterThan(0.7);
  });

  it('bad distance tanks the score even with great amenities', () => {
    const badDist = { distanceKm: 10, targetDistanceKm: 5 }; // 2x over
    const score = scoreRoute(badDist, { lowTraffic: false }, 0.9, 0.9, 0.9, 0.9);
    expect(score).toBeLessThan(0.6);
  });
});

// ---------------------------------------------------------------------------
// 13. Route quality simulation — diverse scenarios
// ---------------------------------------------------------------------------

describe('route quality simulation', () => {
  // For each test location, generate waypoints with various parameters
  // and check quality invariants that should hold universally

  const distances = [3, 5, 8, 12]; // km
  const strategies: ('large-parks' | 'named-paths' | 'balanced')[] = ['large-parks', 'named-paths', 'balanced'];

  for (const [locName, center] of Object.entries(LOCATIONS)) {
    describe(`${locName}`, () => {
      const greenSpaces = makeRealisticGreenSpaces(center);
      const highways = makeRealisticHighways(center);

      for (const dist of distances) {
        describe(`${dist}km loop`, () => {
          it('selected waypoints form a valid loop without backtracking', () => {
            for (const strategy of strategies) {
              for (let variant = 0; variant < 3; variant++) {
                const result = selectGreenSpaceWaypoints(center, greenSpaces, dist, false, variant, strategy);
                if (!result) continue; // fallback paths are tested separately

                const wps = result.waypoints;

                // Must start and end at center
                expect(wps[0]).toEqual(center);
                expect(wps[wps.length - 1]).toEqual(center);

                // Inner waypoints must be spread out (no backtracking)
                const inner = wps.slice(1, -1);
                for (let i = 0; i < inner.length; i++) {
                  for (let j = i + 1; j < inner.length; j++) {
                    const dist_ij = haversineDistance(inner[i], inner[j]);
                    expect(dist_ij).toBeGreaterThan(0.5); // at least 500m apart
                  }
                }

                // All inner waypoints must be a reasonable distance from center
                for (const wp of inner) {
                  const d = haversineDistance(center, wp);
                  expect(d).toBeGreaterThan(0.3); // not too close
                  expect(d).toBeLessThan(dist * 0.6); // not absurdly far
                }
              }
            }
          });

          it('estimated circuit distance is within 3x of target', () => {
            for (const strategy of strategies) {
              const result = selectGreenSpaceWaypoints(center, greenSpaces, dist, false, 1, strategy);
              if (!result) continue;

              const estimated = estimateCircuitDistance(result.waypoints);
              const ratio = estimated / dist;
              expect(ratio).toBeGreaterThan(0.3);
              expect(ratio).toBeLessThan(3.0);
            }
          });

          it('no selected waypoint is near a highway', () => {
            for (const strategy of strategies) {
              const result = selectGreenSpaceWaypoints(center, greenSpaces, dist, false, 1, strategy);
              if (!result) continue;

              for (const wp of result.waypoints.slice(1, -1)) {
                for (const hw of highways) {
                  expect(haversineDistance(wp, hw)).toBeGreaterThan(0.1); // >100m from highway
                }
              }
            }
          });

          it('waypoints ordered by bearing (no zigzag)', () => {
            const result = selectGreenSpaceWaypoints(center, greenSpaces, dist, false, 1, 'balanced');
            if (!result || result.waypoints.length <= 3) return;

            const inner = result.waypoints.slice(1, -1);
            const bearings = inner.map((wp) => bearingFrom(center, wp));
            for (let i = 1; i < bearings.length; i++) {
              expect(bearings[i]).toBeGreaterThan(bearings[i - 1]);
            }
          });
        });
      }

      it('route through this area passes barrier detection', () => {
        // A clean winding route in any location should NOT be flagged as a barrier crossing
        const nearby = destinationPoint(center, 45, 1.5);
        const route = makeWindingRoute(center, nearby, 60);
        expect(hasRoutedBarrierCrossing(route, [], center, 5)).toBe(false);
      });

      it('water crossing removal produces a safe result', () => {
        const safe1 = destinationPoint(center, 0, 0.8);
        const dangerous = destinationPoint(center, 90, 4);
        const safe2 = destinationPoint(center, 180, 0.7);
        const wps = [center, safe1, dangerous, safe2, center];
        const cleaned = removeWaterCrossings(wps, greenSpaces, center);

        // All remaining waypoints should be within reasonable distance of each other
        for (let i = 1; i < cleaned.length; i++) {
          expect(haversineDistance(cleaned[i - 1], cleaned[i])).toBeLessThan(3.0);
        }
      });

      it('scoring correctly ranks route near greenspace/waterfront higher', () => {
        // Route A: near parks and waterfront
        const routeA = makeCircle(center, 0.8, 40);
        const greenProxA = computeGreenSpaceProximity(routeA, greenSpaces);
        const runPathA = computeRunPathProximity(routeA, greenSpaces);
        const wfA = computeWaterfrontProximity(routeA, greenSpaces);
        const scoreA = scoreRoute(
          { distanceKm: 5, targetDistanceKm: 5 },
          { lowTraffic: false }, 0.5, greenProxA, runPathA, wfA
        );

        // Route B: far from everything (10km away from all features)
        const farCenter = destinationPoint(center, 0, 10);
        const routeB = makeCircle(farCenter, 0.8, 40);
        const greenProxB = computeGreenSpaceProximity(routeB, greenSpaces);
        const runPathB = computeRunPathProximity(routeB, greenSpaces);
        const wfB = computeWaterfrontProximity(routeB, greenSpaces);
        const scoreB = scoreRoute(
          { distanceKm: 5, targetDistanceKm: 5 },
          { lowTraffic: false }, 0.5, greenProxB, runPathB, wfB
        );

        expect(scoreA).toBeGreaterThan(scoreB);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 14. Anti-regression: known bad patterns
// ---------------------------------------------------------------------------

describe('anti-regression: known bad patterns', () => {
  it('two waypoints on parallel streets should be filtered out', () => {
    const center = NYC;
    // Simulate two parks on parallel streets 400m apart — causes block-looping
    const parkA: GreenSpace = {
      point: destinationPoint(center, 0, 1.0),
      tier: 1, kind: 'park', name: 'Park A', areaSize: 0.3,
    };
    const parkB: GreenSpace = {
      point: destinationPoint(center, 5, 1.05), // 5 degrees off, ~90m apart
      tier: 1, kind: 'park', name: 'Park B', areaSize: 0.3,
    };
    const parkC: GreenSpace = {
      point: destinationPoint(center, 180, 1.2),
      tier: 1, kind: 'park', name: 'Park C', areaSize: 0.4,
    };

    const result = selectGreenSpaceWaypoints(center, [parkA, parkB, parkC], 8, false, 1, 'balanced');
    if (result) {
      const inner = result.waypoints.slice(1, -1);
      // Should not have both parkA and parkB as waypoints
      for (let i = 0; i < inner.length; i++) {
        for (let j = i + 1; j < inner.length; j++) {
          expect(haversineDistance(inner[i], inner[j])).toBeGreaterThan(0.8);
        }
      }
    }
  });

  it('lollipop routes are cleaned up by self-intersection removal', () => {
    const route = makeSelfCrossingRoute(NYC, 1.5);
    const cleaned = removeSelfintersections(route);
    // Should have removed the crossing portion
    expect(cleaned.length).toBeLessThan(route.length);

    // Verify the clean route has no obvious crossings by checking
    // if any pair of non-adjacent segments cross
    let crossings = 0;
    const step = Math.max(1, Math.floor(cleaned.length / 30));
    for (let i = 0; i < cleaned.length - 3; i += step) {
      for (let j = i + 3; j < cleaned.length - 1; j += step) {
        if (segmentsCross(cleaned[i], cleaned[i + 1], cleaned[j], cleaned[j + 1])) {
          crossings++;
        }
      }
    }
    expect(crossings).toBeLessThanOrEqual(1); // at most 1 residual crossing from sampling
  });

  it('long straight tunnel-like segment triggers geographic drift detection', () => {
    const center = NYC;
    // A route that goes far from center through a straight corridor
    // triggers the geographic drift heuristic (e.g., leaving Manhattan via tunnel)
    const farPoint = destinationPoint(center, 270, 4); // 4km west (e.g., across Hudson)
    const route = [
      ...makeWindingRoute(center, destinationPoint(center, 270, 1), 20),
      ...makeStraightLine(destinationPoint(center, 270, 1), farPoint, 40),
      ...makeWindingRoute(farPoint, destinationPoint(farPoint, 0, 0.5), 20),
    ];
    // For a 5km route, max drift = 5 * 0.45 = 2.25km. Going 4km out should trigger.
    expect(hasRoutedBarrierCrossing(route, [], center, 5)).toBe(true);
  });

  it('waypoints too close to center are removed (prevents start/end backtracking)', () => {
    const center = NYC;
    const parks: GreenSpace[] = [
      { point: destinationPoint(center, 0, 0.15), tier: 1, kind: 'park', name: 'Pocket Park', areaSize: 0.01 },
      { point: destinationPoint(center, 90, 1.5), tier: 1, kind: 'park', name: 'East Park', areaSize: 0.5 },
      { point: destinationPoint(center, 180, 1.3), tier: 1, kind: 'park', name: 'South Park', areaSize: 0.4 },
      { point: destinationPoint(center, 270, 1.1), tier: 1, kind: 'park', name: 'West Park', areaSize: 0.3 },
    ];
    const result = selectGreenSpaceWaypoints(center, parks, 8, false, 1, 'balanced');
    if (result) {
      for (const wp of result.waypoints.slice(1, -1)) {
        expect(haversineDistance(center, wp)).toBeGreaterThan(0.5);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 15. Park traversal — routes go THROUGH parks, not just past them
// ---------------------------------------------------------------------------

describe('expandParkWaypoints', () => {
  it('expands large parks into entry/exit pairs', () => {
    const center = NYC;
    const parkCenter = destinationPoint(center, 0, 1.5);
    const waypoints = [center, parkCenter, center];
    const anchors: GreenSpace[] = [{
      point: parkCenter, tier: 1, kind: 'park',
      name: 'Central Park', areaSize: 3.41,
    }];

    const expanded = expandParkWaypoints(waypoints, anchors);
    // Should have: center, entry, exit, center
    expect(expanded.length).toBe(4);
    expect(expanded[0]).toEqual(center);
    expect(expanded[expanded.length - 1]).toEqual(center);
  });

  it('entry point is closer to previous waypoint than park center', () => {
    const center = NYC;
    const parkCenter = destinationPoint(center, 0, 1.5);
    const nextWp = destinationPoint(center, 120, 1.2);
    const waypoints = [center, parkCenter, nextWp, center];
    const anchors: GreenSpace[] = [
      { point: parkCenter, tier: 1, kind: 'park', name: 'Big Park', areaSize: 1.0 },
      { point: nextWp, tier: 1, kind: 'park', name: 'Small Park', areaSize: 0.05 },
    ];

    const expanded = expandParkWaypoints(waypoints, anchors);
    // Entry (expanded[1]) should be between center and parkCenter
    const entryDistToCenter = haversineDistance(center, expanded[1]);
    const parkDistToCenter = haversineDistance(center, parkCenter);
    expect(entryDistToCenter).toBeLessThan(parkDistToCenter);
  });

  it('exit point is closer to next waypoint than park center', () => {
    const center = NYC;
    const parkCenter = destinationPoint(center, 0, 1.5);
    const nextWp = destinationPoint(center, 90, 1.2);
    const waypoints = [center, parkCenter, nextWp, center];
    const anchors: GreenSpace[] = [
      { point: parkCenter, tier: 1, kind: 'park', name: 'Big Park', areaSize: 1.0 },
      { point: nextWp, tier: 1, kind: 'park', name: 'Tiny Park', areaSize: 0.02 },
    ];

    const expanded = expandParkWaypoints(waypoints, anchors);
    // Exit (expanded[2]) should be between parkCenter and nextWp
    const exitDistToNext = haversineDistance(expanded[2], nextWp);
    const parkDistToNext = haversineDistance(parkCenter, nextWp);
    expect(exitDistToNext).toBeLessThan(parkDistToNext);
  });

  it('does not expand small parks (below threshold)', () => {
    const center = NYC;
    const smallPark = destinationPoint(center, 0, 1.0);
    const waypoints = [center, smallPark, center];
    const anchors: GreenSpace[] = [{
      point: smallPark, tier: 1, kind: 'park',
      name: 'Pocket Park', areaSize: 0.05, // below 0.1 threshold
    }];

    const expanded = expandParkWaypoints(waypoints, anchors);
    // Should stay as: center, park, center (no expansion)
    expect(expanded.length).toBe(3);
  });

  it('handles mixed large and small parks', () => {
    const center = NYC;
    const bigPark = destinationPoint(center, 0, 1.5);
    const smallPark = destinationPoint(center, 180, 1.0);
    const waypoints = [center, bigPark, smallPark, center];
    const anchors: GreenSpace[] = [
      { point: bigPark, tier: 1, kind: 'park', name: 'Central Park', areaSize: 3.41 },
      { point: smallPark, tier: 1, kind: 'park', name: 'Tiny Garden', areaSize: 0.03 },
    ];

    const expanded = expandParkWaypoints(waypoints, anchors);
    // Big park expanded (2 waypoints) + small park unchanged (1) + bookends (2) = 5
    expect(expanded.length).toBe(5);
    expect(expanded[0]).toEqual(center);
    expect(expanded[expanded.length - 1]).toEqual(center);
  });

  it('entry and exit are within the park bounds', () => {
    const center = NYC;
    const parkCenter = destinationPoint(center, 45, 1.5);
    const waypoints = [center, parkCenter, center];
    const areaSize = 0.5; // ~0.7km x 0.7km park
    const anchors: GreenSpace[] = [{
      point: parkCenter, tier: 1, kind: 'park',
      name: 'Medium Park', areaSize,
    }];

    const expanded = expandParkWaypoints(waypoints, anchors);
    const parkRadius = Math.sqrt(areaSize) / 2;
    // Entry and exit should be within the park's approximate radius
    expect(haversineDistance(parkCenter, expanded[1])).toBeLessThan(parkRadius);
    expect(haversineDistance(parkCenter, expanded[2])).toBeLessThan(parkRadius);
  });

  it('returns unchanged waypoints when no anchors', () => {
    const center = NYC;
    const wp = destinationPoint(center, 0, 1.0);
    const waypoints = [center, wp, center];
    const result = expandParkWaypoints(waypoints, []);
    expect(result).toEqual(waypoints);
  });
});

// ---------------------------------------------------------------------------
// Topology metrics: countStartPasses + reversalCount
// ---------------------------------------------------------------------------

describe('countStartPasses', () => {
  it('returns 0 for a clean circular loop', () => {
    const loop = makeCircle(NYC, 0.5, 50);
    expect(countStartPasses(loop)).toBe(0);
  });

  it('returns 0 for a triangle that never re-enters the start neighborhood', () => {
    const a = destinationPoint(NYC, 90, 1.0);
    const b = destinationPoint(NYC, 0, 1.0);
    const route = [
      ...makeStraightLine(NYC, a, 30),
      ...makeStraightLine(a, b, 30).slice(1),
      ...makeStraightLine(b, NYC, 30).slice(1),
    ];
    expect(countStartPasses(route)).toBe(0);
  });

  it('returns 1 for a barbell route that passes through start between lobes', () => {
    const start = NYC;
    const eTip = destinationPoint(start, 90, 1.0);
    const wTip = destinationPoint(start, 270, 1.0);
    const route = [
      ...makeStraightLine(start, eTip, 30),
      ...makeStraightLine(eTip, start, 30).slice(1),
      ...makeStraightLine(start, wTip, 30).slice(1),
      ...makeStraightLine(wTip, start, 30).slice(1),
    ];
    expect(countStartPasses(route)).toBe(1);
  });

  it('returns 0 for a route shorter than 3 points', () => {
    expect(countStartPasses([NYC, destinationPoint(NYC, 0, 0.5)])).toBe(0);
  });
});

describe('reversalCount', () => {
  it('returns 0 for a clean circular loop with smooth turning', () => {
    const loop = makeCircle(NYC, 0.5, 50);
    expect(reversalCount(loop)).toBe(0);
  });

  it('returns 0 for an L-shaped 90° corner — turns are not reversals', () => {
    const a = destinationPoint(NYC, 90, 0.5);
    const b = destinationPoint(a, 0, 0.5);
    const route = [
      ...makeStraightLine(NYC, a, 30),
      ...makeStraightLine(a, b, 30).slice(1),
    ];
    expect(reversalCount(route)).toBe(0);
  });

  it('returns 1 for an out-and-back with a single far-end U-turn', () => {
    const tip = destinationPoint(NYC, 90, 1.0);
    const out = makeStraightLine(NYC, tip, 30);
    const back = makeStraightLine(tip, NYC, 30).slice(1);
    expect(reversalCount([...out, ...back])).toBe(1);
  });

  it('returns ≥2 for a barbell with U-turns at both lobe tips', () => {
    const start = NYC;
    const eTip = destinationPoint(start, 90, 1.0);
    const nTip = destinationPoint(start, 0, 1.0);
    const route = [
      ...makeStraightLine(start, eTip, 30),
      ...makeStraightLine(eTip, start, 30).slice(1),
      ...makeStraightLine(start, nTip, 30).slice(1),
      ...makeStraightLine(nTip, start, 30).slice(1),
    ];
    expect(reversalCount(route)).toBeGreaterThanOrEqual(2);
  });

  it('returns 0 for a route too short to evaluate', () => {
    const tip = destinationPoint(NYC, 90, 0.05);
    expect(reversalCount(makeStraightLine(NYC, tip, 5))).toBe(0);
  });
});
