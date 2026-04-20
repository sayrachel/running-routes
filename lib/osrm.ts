import type { RoutePoint, GeneratedRoute, RoutePreferences } from './route-generator';
import { fetchGreenSpacesAndHighways } from './overpass';
import type { GreenSpace } from './overpass';
import { scoreRoute, computeGreenSpaceProximity, computeRunPathProximity, computeHighwayProximity, computeWaterfrontProximity } from './route-scoring';
import { emit as traceEmit } from './debug-trace';
import { isPopularRunningPark } from './popular-running-parks';

const OSRM_BASE_DEFAULT = 'https://router.project-osrm.org/route/v1/foot';
let osrmBase = OSRM_BASE_DEFAULT;
/** Override the OSRM endpoint. The harness uses this to point at a local
 *  self-hosted OSRM (real Manhattan-grid geometry, no public-endpoint rate
 *  limits). Production leaves it null and uses the public router. */
export function setOSRMBase(url: string | null): void {
  osrmBase = url ?? OSRM_BASE_DEFAULT;
}
// User-facing route count cap. The internal candidate pool is larger so
// quality rejection has alternatives — see SAFETY_EXTRAS below.
const MAX_CANDIDATE_COUNT = 3;
const MAX_INTERNAL_CANDIDATES = 7;

/**
 * Road routing overhead factor.
 * Roads are typically 1.3–1.5x longer than straight-line distance due to
 * the road network geometry (grid patterns, curves, one-way streets, etc).
 * We use this factor to shrink the geometric radius so the OSRM-routed
 * result ends up closer to the user's target distance.
 */
const ROUTING_OVERHEAD = 1.45;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Remove self-intersecting loops ("lollipops") from a route.
 * Detects where the route crosses itself and cuts out the loop,
 * keeping the shorter path. This prevents routes where runners
 * would have to double back on the same streets.
 *
 * Iterates so multi-loop lollipops are all removed in a single call.
 * Each pass cuts at most one loop; we stop as soon as a pass finds nothing.
 */
export function removeSelfintersections(points: RoutePoint[]): RoutePoint[] {
  if (points.length < 20) return points;

  const MAX_PASSES = 4;
  let current = points;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = removeOneSelfIntersection(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

/** One pass of lollipop removal — returns the input unchanged if nothing was cut. */
function removeOneSelfIntersection(points: RoutePoint[]): RoutePoint[] {
  if (points.length < 20) return points;

  // Sample every N points for performance (checking all pairs is O(n^2))
  const step = Math.max(1, Math.floor(points.length / 200));

  for (let i = 0; i < points.length - 3; i += step) {
    for (let j = i + 10; j < points.length - 1; j += step) {
      // Check if segment i→i+1 crosses segment j→j+1
      if (segmentsCross(points[i], points[i + 1], points[j], points[j + 1])) {
        // Found a crossing — the loop is points[i+1..j]
        const loopLen = j - i;
        const totalLen = points.length;

        // If the loop is between 5% and 40% of the route, cut it out
        if (loopLen > totalLen * 0.05 && loopLen < totalLen * 0.4) {
          // Continuity guard: after the cut, the polyline jumps directly
          // from points[i] to points[j+1] in a straight line. For a TRUE
          // lollipop the loop closes back on itself, so this jump distance
          // is small relative to the total path that was removed. For a
          // SPURIOUS crossing (e.g. mock wobble between adjacent triangle
          // legs), the jump is comparable to the removed length — meaning
          // we'd render a fictional shortcut the runner can't actually
          // take. Threshold of 30% is generous enough for noisy real-OSRM
          // geometry but rejects the worst false positives.
          const cutGapKm = haversineDistance(points[i], points[j + 1]);
          let removedPathKm = 0;
          for (let k = i; k <= j; k++) {
            removedPathKm += haversineDistance(points[k], points[k + 1]);
          }
          if (removedPathKm > 0 && cutGapKm / removedPathKm > 0.30) continue;

          // Remove the loop: keep points[0..i] then points[j+1..end]
          return [...points.slice(0, i + 1), ...points.slice(j + 1)];
        }
      }
    }
  }

  return points;
}

/**
 * Fraction of total route distance covered by edges traversed more than once.
 * High values mean the route forces the runner to retrace ground (out-and-back
 * stubs, stacked rectangles, doubled-back spines).
 *
 * Uses ~10m endpoint rounding so OSRM's sub-meter coordinate wobble between
 * outbound and inbound on the same street still collides. Catches *exact*
 * coordinate retraces; for retraces where OSRM samples the same street at
 * different points, see overlapSegmentRatio().
 */
export function retraceRatio(points: RoutePoint[]): number {
  if (points.length < 2) return 0;

  const seen = new Set<string>();
  let totalLen = 0;
  let retracedLen = 0;

  for (let i = 0; i < points.length - 1; i++) {
    const segLen = haversineDistance(points[i], points[i + 1]);
    totalLen += segLen;

    const a = `${points[i].lat.toFixed(4)},${points[i].lng.toFixed(4)}`;
    const b = `${points[i + 1].lat.toFixed(4)},${points[i + 1].lng.toFixed(4)}`;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;

    if (seen.has(key)) retracedLen += segLen;
    else seen.add(key);
  }

  return totalLen > 0 ? retracedLen / totalLen : 0;
}

/**
 * Trim dead-end stubs out of a route. A stub is a "go out 50-150m, U-turn,
 * come back" pattern that visibly juts off the main path. Trimming replaces
 * the [out-leg, U-turn, back-leg] sequence with a direct connection — the
 * runner just doesn't take the detour. The trimmed polyline is shorter and
 * cleaner; the runner skips visiting the stub tip but the rest of the route
 * is identical.
 *
 * Iterates until no more stubs are found (some routes have multiple).
 */
export function trimStubs(points: RoutePoint[], maxStubLenKm: number = 0.15): RoutePoint[] {
  if (points.length < 4) return points;

  const MAX_PASSES = 6;
  let current = points;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = trimOneStub(current, maxStubLenKm);
    if (next === current) return current;
    current = next;
  }
  return current;
}

/** Walk backwards from index i through segments aligned with bearing b1,
 *  returning the index where the out-leg starts. */
function findStubOutStart(points: RoutePoint[], i: number, b1: number, maxLenKm: number): { start: number; len: number } {
  let outLen = haversineDistance(points[i - 1], points[i]);
  let k = i - 1;
  while (k > 0 && outLen <= maxLenKm) {
    const prevBearing = bearingFrom(points[k - 1], points[k]);
    if (angleDiff(prevBearing, b1) > 30) break;
    outLen += haversineDistance(points[k - 1], points[k]);
    k--;
  }
  return { start: k, len: outLen };
}

/** Walk forward from index i+1 through the back-leg, returning the index
 *  of the LAST point of the back-leg before the route resumes its original
 *  forward direction (or runs longer than the allowed back-leg length). */
function findStubBackEnd(points: RoutePoint[], i: number, b1: number, maxLenKm: number): { end: number; len: number; resumed: boolean } {
  let backLen = 0;
  let j = i + 1;
  let resumed = false;
  while (j < points.length - 1 && backLen <= maxLenKm) {
    const segLen = haversineDistance(points[j], points[j + 1]);
    backLen += segLen;
    const nextBearing = bearingFrom(points[j], points[j + 1]);
    // Back-leg ends when the route turns back to the forward direction
    // (within 60° of original bearing b1).
    if (j > i + 1 && angleDiff(nextBearing, b1) < 60) {
      resumed = true;
      break;
    }
    j++;
  }
  return { end: j, len: backLen, resumed };
}

/** Find one stub pattern (out-leg, U-turn, back-leg) and return points
 *  with that section removed. Returns input unchanged if no stub found.
 *  Uses the same criteria as countStubs so the two functions agree. */
function trimOneStub(points: RoutePoint[], maxStubLenKm: number): RoutePoint[] {
  for (let i = 1; i < points.length - 1; i++) {
    const b1 = bearingFrom(points[i - 1], points[i]);
    const b2 = bearingFrom(points[i], points[i + 1]);
    if (angleDiff(b1, b2) < 150) continue;

    const out = findStubOutStart(points, i, b1, maxStubLenKm);
    if (out.len > maxStubLenKm) continue; // not a stub: too long

    const back = findStubBackEnd(points, i, b1, maxStubLenKm * 1.5);

    // Trim: skip from out.start to back.end. The polyline jumps directly
    // across, removing the visible stub jut.
    const resumeIdx = back.resumed ? back.end + 1 : back.end;
    if (resumeIdx >= points.length) continue;
    return [...points.slice(0, out.start + 1), ...points.slice(resumeIdx)];
  }
  return points;
}

/**
 * Count "dead-end stubs" — places where the route does an immediate U-turn,
 * meaning the runner has to enter a non-thoroughfare street and exit the
 * same way. Visible on the map as a small line jutting off the main route.
 *
 * Detection: a stub is a sequence of segments where consecutive bearings
 * differ by ≥150° (near-180° reversal) over a short distance (<150m). A
 * route with more than 2 such stubs is almost certainly an OSRM-routed
 * disaster the runner can't follow as a single continuous path.
 *
 * Returns the count of stubs found.
 */
export function countStubs(points: RoutePoint[], maxStubLenKm: number = 0.15): number {
  if (points.length < 4) return 0;

  let stubCount = 0;
  let i = 1;
  while (i < points.length - 1) {
    const b1 = bearingFrom(points[i - 1], points[i]);
    const b2 = bearingFrom(points[i], points[i + 1]);
    const reversal = angleDiff(b1, b2);

    // U-turn: bearings differ by ≥150° (near-180°)
    if (reversal >= 150) {
      // Measure the "out" segment leading into the U-turn
      let outLen = haversineDistance(points[i - 1], points[i]);
      // Walk backwards to include any earlier segments going the same direction
      let k = i - 2;
      while (k >= 0 && angleDiff(bearingFrom(points[k], points[k + 1]), b1) < 30) {
        outLen += haversineDistance(points[k], points[k + 1]);
        k--;
        if (outLen > maxStubLenKm) break;
      }
      // Only count as a stub if the "out" leg was short — a U-turn after
      // 500m of travel is just the route changing direction, not a stub.
      if (outLen <= maxStubLenKm) {
        stubCount++;
        // Skip past the return leg so we don't double-count the same stub
        i += 2;
        continue;
      }
    }
    i++;
  }
  return stubCount;
}

/**
 * Fraction of total route distance covered by segments that overlap a later
 * segment in space — i.e. they sit within `proximityKm` of another segment
 * and run roughly parallel or antiparallel (same physical street).
 *
 * Catches retraces that retraceRatio() misses when OSRM samples the same
 * street at different vertex positions on the way out vs. the way back.
 */
export function overlapSegmentRatio(
  points: RoutePoint[],
  proximityKm: number = 0.012,
  bearingTolDeg: number = 20
): number {
  if (points.length < 2) return 0;

  // Pre-compute midpoints, bearings, and lengths once.
  const n = points.length - 1;
  const mid: RoutePoint[] = new Array(n);
  const brg: number[] = new Array(n);
  const len: number[] = new Array(n);
  let totalLen = 0;
  for (let i = 0; i < n; i++) {
    mid[i] = { lat: (points[i].lat + points[i + 1].lat) / 2, lng: (points[i].lng + points[i + 1].lng) / 2 };
    brg[i] = bearingFrom(points[i], points[i + 1]);
    len[i] = haversineDistance(points[i], points[i + 1]);
    totalLen += len[i];
  }
  if (totalLen === 0) return 0;

  let overlapLen = 0;
  for (let i = 0; i < n; i++) {
    let overlaps = false;
    // Skip near-adjacent segments — those are the route continuing forward.
    for (let j = i + 5; j < n; j++) {
      if (haversineDistance(mid[i], mid[j]) > proximityKm) continue;
      // Co-linear if bearings are equal (parallel) OR differ by 180° (antiparallel).
      const raw = Math.abs(brg[i] - brg[j]) % 360;
      const ang = Math.min(raw, 360 - raw);
      if (ang < bearingTolDeg || (180 - ang) < bearingTolDeg) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) overlapLen += len[i];
  }

  return overlapLen / totalLen;
}

/** Check if two line segments cross each other */
export function segmentsCross(
  a1: RoutePoint, a2: RoutePoint,
  b1: RoutePoint, b2: RoutePoint
): boolean {
  const d1 = cross(b1, b2, a1);
  const d2 = cross(b1, b2, a2);
  const d3 = cross(a1, a2, b1);
  const d4 = cross(a1, a2, b2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  return false;
}

function cross(o: RoutePoint, a: RoutePoint, b: RoutePoint): number {
  return (a.lat - o.lat) * (b.lng - o.lng) - (a.lng - o.lng) * (b.lat - o.lat);
}

/** Haversine distance in km between two points */
export function haversineDistance(p1: RoutePoint, p2: RoutePoint): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(p2.lat - p1.lat);
  const dLng = toRad(p2.lng - p1.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(p1.lat)) * Math.cos(toRad(p2.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Compute a destination point given origin, bearing (degrees), and distance (km) */
export function destinationPoint(origin: RoutePoint, bearingDeg: number, distanceKm: number): RoutePoint {
  const R = 6371;
  const d = distanceKm / R;
  const brng = (bearingDeg * Math.PI) / 180;
  const lat1 = (origin.lat * Math.PI) / 180;
  const lng1 = (origin.lng * Math.PI) / 180;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );

  return { lat: (lat2 * 180) / Math.PI, lng: (lng2 * 180) / Math.PI };
}

/** Compass bearing (0–360°) from p1 to p2 */
export function bearingFrom(p1: RoutePoint, p2: RoutePoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLng = toRad(p2.lng - p1.lng);
  const lat1 = toRad(p1.lat);
  const lat2 = toRad(p2.lat);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const brng = Math.atan2(y, x);
  return ((brng * 180) / Math.PI + 360) % 360;
}

/** Smallest angle (0–180°) between two bearings */
export function angleDiff(a: number, b: number): number {
  let diff = Math.abs(a - b) % 360;
  if (diff > 180) diff = 360 - diff;
  return diff;
}

/**
 * Detect if two consecutive waypoints are suspiciously far apart,
 * suggesting a water crossing, tunnel, or major barrier between them.
 *
 * Simple distance threshold — if two waypoints in a running route are
 * more than 1.5km apart in a straight line, OSRM will likely route
 * through a tunnel or over a bridge to connect them.
 */
export function hasLikelyWaterCrossing(
  p1: RoutePoint,
  p2: RoutePoint,
  _greenSpaces: GreenSpace[],
  targetDistanceKm?: number
): boolean {
  // Scale the threshold with route length. For a triangular loop, the
  // longest natural segment (wp1→wp2) is roughly 0.4× the total route
  // distance, so a 6mi (9.7km) loop legitimately has a 3.3km segment.
  // The fixed 1.5km threshold dropped wp1 AND wp2 for every loop ≥4mi,
  // collapsing the route to [center, center] and forcing the step-3.5
  // emergency fallback (which uses no green spaces).
  // Post-OSRM `hasRoutedBarrierCrossing` is the safety net for actual
  // tunnels/bridges — this pre-OSRM heuristic just needs to catch the
  // truly extreme cases (>50% of route in one segment).
  const limit = targetDistanceKm !== undefined
    ? Math.max(1.5, targetDistanceKm * 0.5)
    : 1.5;
  return haversineDistance(p1, p2) > limit;
}

/**
 * Remove or replace waypoints that would cause water/barrier crossings.
 * For each bad waypoint, tries to find a replacement green space in the same
 * general direction from center that is itself accessible. If no safe
 * replacement exists, the waypoint is dropped entirely.
 */
export function removeWaterCrossings(
  waypoints: RoutePoint[],
  greenSpaces: GreenSpace[],
  center: RoutePoint,
  targetDistanceKm?: number
): RoutePoint[] {
  return removeWaterCrossingsWithAnchors(waypoints, greenSpaces, center, [], targetDistanceKm).waypoints;
}

/**
 * Same as removeWaterCrossings but also keeps the parallel `anchors` array
 * in sync — when a waypoint is replaced with a different green space, the
 * matching anchor is updated; when a waypoint is dropped, the matching
 * anchor is dropped too. Without this sync, downstream consumers like
 * `expandParkWaypoints` and the "Tompkins Square Park Loop" naming look up
 * stale anchors and either skip expansion or pick the wrong name.
 *
 * Anchor indexing convention: waypoints are [center, gs1, gs2, ..., center];
 * anchors are [gs1, gs2, ...]. So anchors[i-1] corresponds to waypoints[i]
 * for i in 1..waypoints.length-2.
 */
export function removeWaterCrossingsWithAnchors(
  waypoints: RoutePoint[],
  greenSpaces: GreenSpace[],
  center: RoutePoint,
  anchors: GreenSpace[],
  targetDistanceKm?: number
): { waypoints: RoutePoint[]; anchors: GreenSpace[] } {
  if (waypoints.length < 3) return { waypoints, anchors };

  const result = [...waypoints];
  const resultAnchors = [...anchors];
  const toRemove = new Set<number>();

  for (let i = 1; i < result.length - 1; i++) {
    if (!hasLikelyWaterCrossing(result[i - 1], result[i], greenSpaces, targetDistanceKm) &&
        !hasLikelyWaterCrossing(result[i], result[i + 1], greenSpaces, targetDistanceKm)) {
      continue;
    }

    // Try to find a safe replacement in the same direction from center
    const targetBearing = bearingFrom(center, result[i]);
    let replaced = false;

    if (greenSpaces.length > 0) {
      // Sort green spaces by score (prefer large named parks)
      const candidates = [...greenSpaces]
        .filter((gs) => {
          const gsBearing = bearingFrom(center, gs.point);
          return angleDiff(gsBearing, targetBearing) <= 60;
        })
        .sort((a, b) => (b.areaSize * 10 + (b.name ? 5 : 0)) - (a.areaSize * 10 + (a.name ? 5 : 0)));

      for (const gs of candidates) {
        if (hasLikelyWaterCrossing(center, gs.point, greenSpaces, targetDistanceKm)) continue;
        // Don't replace with a green space that's already a waypoint —
        // produces a degenerate "center → X → X → center" route and a
        // duplicate name like "Tompkins Square Park / Tompkins Square Park".
        const alreadyUsed = result.some((p, idx) =>
          idx !== i && Math.abs(p.lat - gs.point.lat) < 1e-6 && Math.abs(p.lng - gs.point.lng) < 1e-6
        );
        if (alreadyUsed) continue;
        const prevOk = !hasLikelyWaterCrossing(result[i - 1], gs.point, greenSpaces, targetDistanceKm);
        const nextOk = i + 1 < result.length
          ? !hasLikelyWaterCrossing(gs.point, result[i + 1], greenSpaces, targetDistanceKm)
          : true;
        if (prevOk && nextOk) {
          result[i] = gs.point;
          // Sync the anchor: anchor index = waypoint index - 1.
          if (i - 1 < resultAnchors.length) resultAnchors[i - 1] = gs;
          replaced = true;
          break;
        }
      }
    }

    if (!replaced) {
      toRemove.add(i);
    }
  }

  // Drop dropped waypoints AND their matching anchors in lockstep.
  return {
    waypoints: result.filter((_, i) => !toRemove.has(i)),
    anchors: resultAnchors.filter((_, i) => !toRemove.has(i + 1)),
  };
}

/**
 * Check if a green space is reachable from center without crossing a major barrier.
 * The maxRadius filter in selectGreenSpaceWaypoints constrains distance, and
 * hasRoutedBarrierCrossing catches tunnels/bridges post-OSRM. This pre-filter
 * only rejects waypoints that are extremely far (>3km), which almost certainly
 * require a bridge or tunnel in dense urban areas.
 */
export function isAccessibleFromCenter(
  center: RoutePoint,
  target: RoutePoint,
  _greenSpaces: GreenSpace[]
): boolean {
  return haversineDistance(center, target) <= 3.0;
}

/**
 * Check if a routed path (from OSRM) crosses a major barrier like a tunnel or bridge.
 *
 * Uses two complementary heuristics:
 *
 * 1. **Straight-line detection**: tunnels and bridges produce unnaturally straight
 *    segments (low tortuosity) over long distances. We scan the route for any
 *    stretch where the direct distance between two sampled points is >80% of the
 *    walked distance over 400m+. Real streets in a city grid are never that straight
 *    for that long — only tunnels and bridges are.
 *
 * 2. **Geographic drift**: if any point on the route strays more than a reasonable
 *    radius from the center, the route has likely left the starting area (e.g.
 *    Manhattan → NJ via Lincoln Tunnel). The max allowed drift scales with the
 *    route's target distance so short runs stay local.
 */
export function hasRoutedBarrierCrossing(
  routePoints: RoutePoint[],
  _greenSpaces: GreenSpace[],
  center?: RoutePoint,
  targetDistanceKm?: number
): boolean {
  if (routePoints.length < 20) return false;

  // --- Heuristic 1: Straight-line (tunnel/bridge) detection ---
  // Sample every N points and look for segments with very high tortuosity ratio
  // (direct distance ÷ walked distance close to 1.0 over a long stretch)
  // AND low bearing variance (tunnels/bridges maintain constant direction,
  // while smooth curves have steadily changing bearings).
  const sampleInterval = Math.max(1, Math.floor(routePoints.length / 60));
  // Only flag VERY long straight segments (>1.2km) as likely tunnels/bridges.
  // Was 400m, which produced false positives on Manhattan avenues — going
  // 6 blocks straight east on a normal street is ~1.5km of "straight line"
  // and was being rejected as a barrier crossing. Real tunnels/bridges are
  // typically longer than 1km of fully-straight constant-bearing geometry.
  const minStraightKm = 1.2;

  for (let i = 0; i < routePoints.length - sampleInterval * 3; i += sampleInterval) {
    // Look ahead by multiple sample intervals to catch longer straight segments
    for (let lookAhead = 3; lookAhead <= 8; lookAhead++) {
      const j = i + sampleInterval * lookAhead;
      if (j >= routePoints.length) break;

      const directDist = haversineDistance(routePoints[i], routePoints[j]);
      if (directDist < minStraightKm) continue;

      // Compute walked distance along the route between i and j
      let walkedDist = 0;
      for (let k = i; k < j; k++) {
        walkedDist += haversineDistance(routePoints[k], routePoints[k + 1]);
      }

      // Tortuosity ratio: 1.0 = perfectly straight, lower = more winding
      // City streets are typically 0.5-0.7. Tunnels/bridges are 0.85+
      const ratio = walkedDist > 0 ? directDist / walkedDist : 0;
      if (ratio >= 0.85 && directDist >= minStraightKm) {
        // Check total bearing change to distinguish tunnels from smooth curves.
        // Tunnels/bridges maintain near-constant bearing (total change < 15°).
        // Smooth curves (arcs) accumulate bearing change across the span (> 15°).
        // We measure the total accumulated bearing change, not just the max
        // consecutive change, because a smooth arc changes direction gradually
        // (each step may be only ~6°) but the total over many steps is large.
        const bearings: number[] = [];
        for (let k = i; k < j; k++) {
          const segDist = haversineDistance(routePoints[k], routePoints[k + 1]);
          if (segDist > 0.001) { // skip near-zero segments
            bearings.push(bearingFrom(routePoints[k], routePoints[k + 1]));
          }
        }
        if (bearings.length >= 2) {
          let totalBearingChange = 0;
          for (let k = 1; k < bearings.length; k++) {
            totalBearingChange += angleDiff(bearings[k], bearings[k - 1]);
          }
          // If total bearing change exceeds 15°, this is a curve, not a tunnel
          if (totalBearingChange > 15) continue;
        }

        console.log(`[BarrierCheck] Straight segment detected: ${directDist.toFixed(3)}km, ratio=${ratio.toFixed(3)}`);
        return true;
      }
    }
  }

  // --- Heuristic 2: Geographic drift from center ---
  if (center && targetDistanceKm) {
    // Max allowed distance from center: proportional to route distance,
    // but capped conservatively. A 5km loop should stay within ~2km of start.
    const maxDriftKm = Math.min(targetDistanceKm * 0.45, 8);

    for (let i = 0; i < routePoints.length; i += sampleInterval) {
      const drift = haversineDistance(center, routePoints[i]);
      if (drift > maxDriftKm) {
        console.log(`[BarrierCheck] Geographic drift: ${drift.toFixed(2)}km from center (max ${maxDriftKm.toFixed(2)}km)`);
        return true;
      }
    }
  }

  return false;
}

/**
 * Build OSRM coordinate string from waypoints.
 * OSRM expects: lng,lat;lng,lat;...
 */
export function coordsString(points: RoutePoint[]): string {
  return points.map((p) => `${p.lng},${p.lat}`).join(';');
}

/**
 * Calculate the search radius for green space queries based on route type.
 * Clamped to [1.5, 10] km.
 */
export function calculateSearchRadius(
  routeType: 'loop' | 'out-and-back' | 'point-to-point',
  distanceKm: number,
  center: RoutePoint,
  end?: RoutePoint | null
): number {
  let radius: number;
  if (routeType === 'loop') {
    radius = distanceKm * 1.0;
  } else if (routeType === 'out-and-back') {
    radius = distanceKm * 0.8;
  } else if (end) {
    radius = haversineDistance(center, end) * 0.6;
  } else {
    radius = distanceKm * 0.6;
  }
  return Math.min(Math.max(radius, 1.5), 10);
}

// ---------------------------------------------------------------------------
// Green-space-first waypoint selection
// ---------------------------------------------------------------------------

export type CandidateStrategy = 'large-parks' | 'named-paths' | 'balanced';

/**
 * Score a green space for waypoint selection.
 * Strategy controls weighting:
 * - 'large-parks': heavy bonus for areaSize
 * - 'named-paths': heavy bonus for named paths/routes
 * - 'balanced': even spread
 */
export function scoreGreenSpace(
  gs: GreenSpace,
  strategy: CandidateStrategy,
  strict: boolean
): number {
  let score = 0;

  // Tier bonus
  if (gs.tier === 1) score += strict ? 10 : 5;

  // Named bonus
  if (gs.name) score += strategy === 'named-paths' ? 8 : 3;

  // Area bonus (parks/gardens/nature reserves)
  // Use log scale so large parks (Central Park ~3.4km², McCarren ~0.14km²)
  // score meaningfully higher than pocket parks (~0.01km²)
  if (gs.areaSize > 0) {
    // log10(0.01*1000)=1, log10(0.14*1000)=2.1, log10(3.4*1000)=3.5
    const areaBonus = Math.min(Math.log10(gs.areaSize * 1000 + 1) * 5, 18);
    score += strategy === 'large-parks' ? areaBonus * 2 : areaBonus;
    if (strict) score += areaBonus;
  }

  // Large named parks are landmarks — runners specifically seek these out
  if (gs.name && gs.areaSize > 0.05) {
    score += 5; // named park bonus
    if (gs.areaSize > 0.5) score += 5; // major park bonus (e.g., Central Park, Prospect Park)
  }

  // Curated runner-popularity boost: parks well-known to the running
  // community (Central Park, McCarren Park, Lakefront Trail, Embarcadero,
  // etc.) get a substantial bump above peers of similar geometry. Captures
  // the difference between "park people run in" vs. "park that just happens
  // to be there" — McCarren and Tompkins Square are similar size in OSM but
  // wildly different as running destinations. List in popular-running-parks.ts.
  if (gs.name && isPopularRunningPark(gs.name)) {
    score += 12;
  }

  // Kind bonuses
  if (gs.kind === 'park' || gs.kind === 'nature') score += 3;
  if (gs.kind === 'route') score += strategy === 'named-paths' ? 5 : 2;
  // Bike lanes and footways are ideal running surfaces — boost them
  if (gs.kind === 'cycleway') score += 4;
  if (gs.kind === 'footway' || gs.kind === 'path') score += 3;
  // Waterfront paths are among the most popular running corridors
  if (gs.kind === 'waterfront') score += 6;

  return score;
}

/**
 * Select green space waypoints using greedy angular spread with distance budget.
 *
 * Algorithm:
 * 1. Compute bearing + distance from center for each green space
 * 2. Filter: discard any beyond targetDistanceKm * 0.6 from center
 * 3. Score each green space based on strategy
 * 4. Divide 360° into N sectors (5–6), offset by variant
 * 5. Per sector, pick highest-scoring green space
 * 6. Order by bearing to form a loop
 * 7. Estimate circuit distance and adjust (drop farthest / add from unused)
 *
 * Returns null if fewer than 3 green space waypoints found (caller should fall back).
 */
export function selectGreenSpaceWaypoints(
  center: RoutePoint,
  greenSpaces: GreenSpace[],
  targetDistanceKm: number,
  strict: boolean,
  variant: number,
  strategy: CandidateStrategy
): { waypoints: RoutePoint[]; anchors: GreenSpace[] } | null {
  // Max distance from center: for a loop, the farthest point is roughly
  // distance / (2π × overhead). Allow up to 3× that so green spaces near
  // the route perimeter are included, but cap so routes don't cross boroughs.
  // Post-OSRM barrier detection (hasRoutedBarrierCrossing) catches tunnels/bridges.
  const loopRadius = targetDistanceKm / (2 * Math.PI * ROUTING_OVERHEAD);
  const maxRadius = Math.max(loopRadius * 3.0, 2.0);

  // Annotate each green space with bearing and distance from center
  // Use parks, gardens, nature reserves, and waterfront as loop waypoints —
  // bike lanes and footways should influence scoring, not force OSRM detours
  const waypointKinds = new Set(['park', 'garden', 'nature', 'waterfront']);
  // minCenterDist applied UPFRONT (was originally a post-pick filter, which
  // meant a sector could pick a too-close green space, then drop it later
  // and end up with too few picks. Filtering early lets the sectoring +
  // top-N backfill work on already-valid candidates.)
  // Capped at 0.6km so very long routes (8+ mi) don't filter out their
  // only nearby parks. trimStubs removes any visit-and-return artifact
  // a too-close waypoint creates, so allowing them costs little.
  const minCenterDist = Math.min(Math.max(0.3, targetDistanceKm * 0.08), 0.6);
  const annotated = greenSpaces
    .filter((gs) => waypointKinds.has(gs.kind) || (gs.kind === 'route' && gs.name))
    .map((gs) => {
    // Variant-dependent perturbation for refresh diversity
    const perturbation = Math.sin(variant * 1000 + gs.point.lat * 10000 + gs.point.lng * 10000) * 2;
    return {
      gs,
      bearing: bearingFrom(center, gs.point),
      dist: haversineDistance(center, gs.point),
      score: scoreGreenSpace(gs, strategy, strict) + perturbation,
    };
  })
  .filter((a) => a.dist <= maxRadius)
  .filter((a) => a.dist >= minCenterDist)
  .filter((a) => isAccessibleFromCenter(center, a.gs.point, greenSpaces));

  if (annotated.length < 2) return null;

  // Use fewer sectors for shorter routes to avoid clustering
  const numSectors = targetDistanceKm < 15 ? 3 : 4 + (variant % 2);
  const sectorSize = 360 / numSectors;
  const sectorOffset = (variant * 60) % 360;

  // Assign each green space to a sector
  const sectors: (typeof annotated[0])[][] = Array.from({ length: numSectors }, () => []);
  for (const a of annotated) {
    const adjustedBearing = (a.bearing - sectorOffset + 360) % 360;
    const sectorIdx = Math.floor(adjustedBearing / sectorSize);
    sectors[Math.min(sectorIdx, numSectors - 1)].push(a);
  }

  // Pick best per sector
  const picks: { gs: GreenSpace; bearing: number; dist: number }[] = [];
  const emptySectors: number[] = [];

  for (let s = 0; s < numSectors; s++) {
    const candidates = sectors[s];
    if (candidates.length === 0) {
      emptySectors.push(s);
      continue;
    }
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    picks.push({ gs: best.gs, bearing: best.bearing, dist: best.dist });
  }

  // Relaxed mode: require 2–4 sectors with green spaces; fill empty with geometric points
  // Strict mode: try to fill all sectors; check adjacent sectors for empty ones
  if (strict) {
    for (const emptySector of emptySectors) {
      // Check adjacent sectors
      const leftSector = (emptySector - 1 + numSectors) % numSectors;
      const rightSector = (emptySector + 1) % numSectors;
      const adjacentCandidates = [...(sectors[leftSector] || []), ...(sectors[rightSector] || [])];
      if (adjacentCandidates.length > 0) {
        // Pick the one closest to the empty sector's center bearing
        const sectorCenter = (sectorOffset + emptySector * sectorSize + sectorSize / 2) % 360;
        adjacentCandidates.sort((a, b) =>
          angleDiff(a.bearing, sectorCenter) - angleDiff(b.bearing, sectorCenter)
        );
        const fill = adjacentCandidates[0];
        // Only add if not already picked
        if (!picks.some((p) => p.gs === fill.gs)) {
          picks.push({ gs: fill.gs, bearing: fill.bearing, dist: fill.dist });
        }
      }
    }
  }

  // Top-N-by-score backfill for clustered locations. In dense urban areas
  // (e.g. NYC LES) green spaces often cluster on one side — sectoring may
  // place all of them in 1-2 sectors and leave us with too few picks. Rather
  // than punt to the geometric fallback (losing all green-space context AND
  // its naming benefit), pick the highest-scoring remaining candidates that
  // sit at least ~60° away in bearing from any existing pick. This keeps
  // diversity without requiring uniform angular spread.
  if (picks.length < 3) {
    const allByScore = annotated.slice().sort((a, b) => b.score - a.score);
    for (const cand of allByScore) {
      if (picks.length >= 3) break;
      if (picks.some((p) => p.gs === cand.gs)) continue;
      // 45° threshold matches the downstream bearing-similarity filter and
      // lets a third pick squeeze in for clustered locations (Williamsburg
      // has 4 greens within a 50° northern arc — a 60° threshold makes the
      // third pick impossible). The downstream minWaypointSpacing and
      // bearing-similarity filters still drop genuinely too-close picks.
      const tooClose = picks.some((p) => angleDiff(p.bearing, cand.bearing) < 45);
      if (tooClose) continue;
      picks.push({ gs: cand.gs, bearing: cand.bearing, dist: cand.dist });
    }
  }

  // Both modes: 2 picks is the hard minimum. Strict mode previously required
  // 3, which sounded right but sent every dense-cluster location (Chi
  // lakefront, Williamsburg) to the geometric fallback when only 2 well-
  // spaced candidates existed. Strict mode still applies stricter scoring
  // (boosted tier/area bonuses) and adjacent-sector backfill, so it favors
  // higher-quality picks — it just doesn't punt when the location
  // genuinely lacks 3 spread-out green spaces.
  if (picks.length < 2) return null;

  // Cap waypoints. For short routes (<4mi) in dense urban grids, 3 waypoints
  // forces them too close together and OSRM weaves through blocks producing
  // visible figure-8/rectangle patterns. 2 waypoints gives a cleaner triangle
  // loop that the runner can follow as one continuous path.
  // Allow up to 3 waypoints for all routes. Previously capped to 2 for
  // short routes on the theory that 3 close waypoints would force OSRM
  // to weave between blocks. Real-OSRM testing in dense Manhattan grid
  // showed the OPPOSITE: 3 waypoints spread at ~120° apart give OSRM
  // three distinct corridors to use, reducing retrace vs. 2 waypoints
  // where the wp2→center return leg often shares streets with the
  // center→wp1 outbound leg. Quality scoring picks the best regardless
  // of waypoint count, so generating 3-waypoint candidates alongside
  // 2-waypoint ones gives the algorithm more options.
  const maxGreenWaypoints = Math.min(picks.length, 3);
  const selectedPicks = picks
    .sort((a, b) => b.dist - a.dist) // drop farthest first if over cap
    .slice(picks.length - maxGreenWaypoints);

  // Order by bearing to form a loop
  selectedPicks.sort((a, b) => a.bearing - b.bearing);
  // (minCenterDist filter moved upstream to the `annotated` stage so
  // sectoring + top-N backfill operate on already-valid candidates.)

  // Remove ANY pair of waypoints that are too close (not just consecutive) —
  // in a city grid, two waypoints 500m apart on parallel streets cause
  // OSRM to zigzag between them creating rectangular block loops
  const minWaypointSpacing = Math.max(1.0, targetDistanceKm * 0.12);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < selectedPicks.length; i++) {
      for (let j = i + 1; j < selectedPicks.length; j++) {
        if (haversineDistance(selectedPicks[i].gs.point, selectedPicks[j].gs.point) < minWaypointSpacing) {
          // Keep the one with larger area
          if (selectedPicks[j].gs.areaSize >= selectedPicks[i].gs.areaSize) {
            selectedPicks.splice(i, 1);
          } else {
            selectedPicks.splice(j, 1);
          }
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }

  // Remove consecutive waypoints with too-similar bearings — prevents
  // the half-circle lollipop pattern where the route goes out and back on the same side
  for (let i = selectedPicks.length - 1; i > 0; i--) {
    if (angleDiff(selectedPicks[i].bearing, selectedPicks[i - 1].bearing) < 45) {
      // Keep the one farther from center for a wider loop
      if (selectedPicks[i].dist >= selectedPicks[i - 1].dist) {
        selectedPicks.splice(i - 1, 1);
      } else {
        selectedPicks.splice(i, 1);
      }
    }
  }

  if (selectedPicks.length < 2) return null;

  let waypoints: RoutePoint[] = [
    center,
    ...selectedPicks.map((p) => p.gs.point),
    center,
  ];
  const anchors = selectedPicks.map((p) => p.gs);

  // If the loop is way too long, drop the farthest waypoint
  if (waypoints.length > 4) {
    const loopDist = estimateCircuitDistance(waypoints);
    if (loopDist / targetDistanceKm > 1.5) {
      let farthestIdx = 1;
      let farthestDist = 0;
      for (let i = 1; i < waypoints.length - 1; i++) {
        const d = haversineDistance(center, waypoints[i]);
        if (d > farthestDist) {
          farthestDist = d;
          farthestIdx = i;
        }
      }
      waypoints.splice(farthestIdx, 1);
      anchors.splice(farthestIdx - 1, 1);
    }
  }

  return { waypoints, anchors };
}

/** Estimate routed circuit distance from waypoints using haversine sum × overhead */
export function estimateCircuitDistance(waypoints: RoutePoint[]): number {
  let sum = 0;
  for (let i = 1; i < waypoints.length; i++) {
    sum += haversineDistance(waypoints[i - 1], waypoints[i]);
  }
  return sum * ROUTING_OVERHEAD;
}

/**
 * Expand large park waypoints into entry/exit pairs so OSRM routes
 * *through* the park interior, not just past its edge.
 *
 * For each waypoint backed by a park above the area threshold, replaces
 * the single center point with two points:
 *   - Entry: offset from center toward the previous waypoint
 *   - Exit: offset from center toward the next waypoint
 *
 * This forces OSRM to find a path from the entry edge to the exit edge,
 * which traverses the park's internal footways/paths.
 */
export function expandParkWaypoints(
  waypoints: RoutePoint[],
  anchors: GreenSpace[],
  // Only expand parks ≥ 0.5 km² (Central Park, Prospect Park, Grant Park,
  // Forest Park). Smaller parks have entry/exit pairs that OSRM threads
  // through tiny access streets, creating dead-end stubs in the route.
  // Was 0.1 km² which caught medium parks like East River Park (0.32) and
  // Boston Common (0.20) — those got stubby routes; better to just route
  // to the park center and let OSRM pick the natural approach.
  minAreaForExpansion: number = 0.5
): RoutePoint[] {
  if (waypoints.length < 3 || anchors.length === 0) return waypoints;

  const result: RoutePoint[] = [waypoints[0]];

  for (let i = 1; i < waypoints.length - 1; i++) {
    const anchorIdx = i - 1;
    if (anchorIdx >= anchors.length || anchors[anchorIdx].areaSize < minAreaForExpansion) {
      result.push(waypoints[i]);
      continue;
    }

    const anchor = anchors[anchorIdx];
    // Estimate park "radius" from area (assuming roughly square)
    // and cap offset so we don't overshoot small-medium parks
    const parkRadiusKm = Math.sqrt(anchor.areaSize) / 2;
    const offset = Math.min(parkRadiusKm * 0.6, 0.4);

    const prev = waypoints[i - 1];
    const next = i + 1 < waypoints.length ? waypoints[i + 1] : waypoints[0];
    const parkCenter = waypoints[i];

    // Entry: offset toward previous waypoint (where runner enters the park)
    const entryBearing = bearingFrom(parkCenter, prev);
    const entry = destinationPoint(parkCenter, entryBearing, offset);

    // Exit: offset toward next waypoint (where runner leaves the park)
    const exitBearing = bearingFrom(parkCenter, next);
    const exit = destinationPoint(parkCenter, exitBearing, offset);

    result.push(entry, exit);
  }

  result.push(waypoints[waypoints.length - 1]);
  return result;
}

// ---------------------------------------------------------------------------
// Green-space-first generators
// ---------------------------------------------------------------------------

/**
 * Generate a loop route using green spaces as primary waypoints.
 * Falls back to geometric loop if < 3 green space waypoints found.
 */
function generateGreenSpaceLoop(
  center: RoutePoint,
  distanceKm: number,
  prefs: RoutePreferences,
  variant: number,
  greenSpaces: GreenSpace[],
  strategy: CandidateStrategy
): { waypoints: RoutePoint[]; anchors: GreenSpace[] } {
  const result = selectGreenSpaceWaypoints(
    center, greenSpaces, distanceKm, prefs.lowTraffic, variant, strategy
  );

  if (result) return result;

  // Fallback to geometric generation
  const fallbackWaypoints = generateLoopWaypoints(
    center, distanceKm, prefs, variant, greenSpaces.map((gs) => gs.point)
  );
  return { waypoints: fallbackWaypoints, anchors: [] };
}

/**
 * Generate an out-and-back route using green spaces as waypoints along a corridor.
 * Finds green spaces that form a line from center in a chosen direction.
 * Falls back to geometric out-and-back if insufficient green spaces.
 */
function generateGreenSpaceOutAndBack(
  center: RoutePoint,
  distanceKm: number,
  prefs: RoutePreferences,
  variant: number,
  greenSpaces: GreenSpace[],
  strategy: CandidateStrategy
): { waypoints: RoutePoint[]; anchors: GreenSpace[] } {
  const halfDist = distanceKm / (2 * ROUTING_OVERHEAD);
  const corridorWidth = 30; // degrees either side of main bearing
  const seedBearing = (variant * 97 + (prefs.lowTraffic ? 30 : 0)) % 360;

  // Pre-annotate green spaces once (bearing/dist/score independent of corridor).
  const annotated = greenSpaces
    .map((gs) => ({
      gs,
      bearing: bearingFrom(center, gs.point),
      dist: haversineDistance(center, gs.point),
      score: scoreGreenSpace(gs, strategy, prefs.lowTraffic),
    }))
    .filter((a) => a.dist <= halfDist);

  // A single random corridor bearing often points into water or a sparse area
  // (the same class of bug that bit the geometric fallback). Try N evenly-
  // spaced bearings and keep the corridor with the most green spaces.
  // The seed-derived bearing is checked first so variant diversity is preserved
  // when multiple corridors are equally good.
  const NUM_BEARINGS = 6;
  let corridorSpaces: typeof annotated = [];
  for (let i = 0; i < NUM_BEARINGS; i++) {
    const bearing = (seedBearing + (i * 360) / NUM_BEARINGS) % 360;
    const corridor = annotated
      .filter((a) => angleDiff(a.bearing, bearing) <= corridorWidth)
      .sort((a, b) => a.dist - b.dist);
    if (corridor.length > corridorSpaces.length) {
      corridorSpaces = corridor;
    }
  }

  if (corridorSpaces.length < 2) {
    // Fallback to geometric
    const fallbackWaypoints = generateOutAndBackWaypoints(
      center, distanceKm, prefs, variant, greenSpaces.map((gs) => gs.point)
    );
    return { waypoints: fallbackWaypoints, anchors: [] };
  }

  // Pick 2–3 outbound waypoints from corridor, spread by distance
  const outbound: typeof corridorSpaces = [];
  const targetCount = Math.min(3, corridorSpaces.length);
  const segmentDist = halfDist / targetCount;

  for (let i = 0; i < targetCount; i++) {
    const targetDist = segmentDist * (i + 1);
    let best = corridorSpaces[0];
    let bestDelta = Infinity;
    for (const cs of corridorSpaces) {
      if (outbound.some((o) => o.gs === cs.gs)) continue;
      const delta = Math.abs(cs.dist - targetDist);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = cs;
      }
    }
    outbound.push(best);
  }

  outbound.sort((a, b) => a.dist - b.dist);
  const anchors = outbound.map((o) => o.gs);

  // Build out-and-back: center → outbound waypoints → reverse back
  const outPoints = [center, ...outbound.map((o) => o.gs.point)];
  const returnPoints = [...outPoints].reverse().slice(1).map((p, i) => ({
    lat: p.lat + Math.sin(variant * 5000 + i * 83.9) * 0.0003,
    lng: p.lng + Math.cos(variant * 6000 + i * 91.3) * 0.0003,
  }));

  return {
    waypoints: [...outPoints, ...returnPoints],
    anchors,
  };
}

/**
 * Generate point-to-point waypoints using green spaces near the start→end line.
 */
function generateGreenSpacePointToPoint(
  start: RoutePoint,
  end: RoutePoint,
  prefs: RoutePreferences,
  variant: number,
  greenSpaces: GreenSpace[],
  strategy: CandidateStrategy
): { waypoints: RoutePoint[]; anchors: GreenSpace[] } {
  const totalDist = haversineDistance(start, end);
  // Narrow corridor — only detour for green spaces very close to the direct path
  const corridorWidth = Math.min(totalDist * 0.12, 0.5); // km, capped at 500m

  // Only consider named parks or large green spaces worth detouring for
  const nearLine = greenSpaces
    .filter((gs) => gs.name || gs.areaSize > 0.01)
    .map((gs) => {
      // Project onto the start→end line and measure perpendicular distance
      const t = Math.max(0, Math.min(1,
        ((gs.point.lat - start.lat) * (end.lat - start.lat) +
         (gs.point.lng - start.lng) * (end.lng - start.lng)) /
        ((end.lat - start.lat) ** 2 + (end.lng - start.lng) ** 2 || 1)
      ));
      const projLat = start.lat + t * (end.lat - start.lat);
      const projLng = start.lng + t * (end.lng - start.lng);
      const perpDist = haversineDistance(gs.point, { lat: projLat, lng: projLng });
      return { gs, t, perpDist, score: scoreGreenSpace(gs, strategy, prefs.lowTraffic) };
    })
    .filter((a) => a.perpDist <= corridorWidth && a.t > 0.15 && a.t < 0.85)
    .sort((a, b) => b.score - a.score);

  if (nearLine.length === 0) {
    // No significant green spaces along the path — use direct route
    return { waypoints: [start, end], anchors: [] };
  }

  // Pick at most 1–2 high-scoring waypoints to keep the route direct
  const maxWaypoints = totalDist > 5 ? 2 : 1;
  const selected = nearLine.slice(0, maxWaypoints);
  // Re-sort by position along the line
  selected.sort((a, b) => a.t - b.t);

  return {
    waypoints: [start, ...selected.map((s) => s.gs.point), end],
    anchors: selected.map((s) => s.gs),
  };
}

// ---------------------------------------------------------------------------
// Legacy geometric generators (kept as fallbacks)
// ---------------------------------------------------------------------------

/**
 * Snap a geometric waypoint toward the nearest green space if within range.
 */
function selectWaypoint(
  geometricPoint: RoutePoint,
  greenSpaces: RoutePoint[],
  maxSnapDistance: number,
  greenBlend: number = 0.7
): RoutePoint {
  if (greenSpaces.length === 0) return geometricPoint;

  let nearest: RoutePoint | null = null;
  let nearestDist = Infinity;
  for (const gs of greenSpaces) {
    const d = haversineDistance(geometricPoint, gs);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = gs;
    }
  }

  if (!nearest || nearestDist > maxSnapDistance) return geometricPoint;

  return {
    lat: greenBlend * nearest.lat + (1 - greenBlend) * geometricPoint.lat,
    lng: greenBlend * nearest.lng + (1 - greenBlend) * geometricPoint.lng,
  };
}

// Public OSRM endpoint (router.project-osrm.org) typically responds in
// 200-700ms; 1-2s when busy, occasionally 3-5s under load. 8s leaves
// headroom for the long tail without letting one stuck call dominate.
// Tighter limits (5s) caused legitimate slow responses to abort and
// fall through to the no-route path, which surfaced as straight-line
// triangles in the UI.
const OSRM_TIMEOUT_MS = 8000;

/** Retry wrapper for fetch with timeout */
async function fetchWithRetry(url: string, retries = 1): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (res.ok || res.status < 500) return res;
      } finally {
        clearTimeout(timeout);
      }
      if (i < retries) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    } catch (err) {
      if (i === retries) throw err;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw new Error('OSRM request failed after retries');
}

interface OSRMRoute {
  geometry: {
    coordinates: [number, number][];
    type: string;
  };
  distance: number; // meters
  duration: number; // seconds
}

interface OSRMResponse {
  code: string;
  routes: OSRMRoute[];
}

interface ResolvedCandidate {
  index: number;
  variant: number;
  points: RoutePoint[];
  distKm: number;
  estimatedTime: number;
  fromOSRM: boolean;
  anchors: GreenSpace[];
  /** Lower = better. Sums retrace + overlap + 0.1·stubs + 0.3·|1−distRatio|.
   *  Used to pick the best of several candidates that all passed hard
   *  rejection. Geometric step-3.5 fallback assigns a high penalty so it
   *  loses to any real candidate. */
  qualityPenalty: number;
}

/**
 * Scale intermediate waypoints toward/away from center to adjust route distance.
 * scaleFactor < 1 shrinks (closer to center), > 1 expands (farther from center).
 */
export function scaleWaypoints(
  waypoints: RoutePoint[],
  center: RoutePoint,
  scaleFactor: number
): RoutePoint[] {
  return waypoints.map((p, idx) => {
    // Don't move start/end (first and last, which are typically center)
    if (idx === 0 || idx === waypoints.length - 1) return p;
    return {
      lat: center.lat + (p.lat - center.lat) * scaleFactor,
      lng: center.lng + (p.lng - center.lng) * scaleFactor,
    };
  });
}

/**
 * Fetch an OSRM route and iteratively adjust waypoint distances so the
 * routed distance lands within ±30% of the target. This handles cases
 * where road routing is much longer than the geometric estimate (e.g.
 * routes near water/barriers where OSRM must detour around obstacles).
 */
async function fetchOSRMRouteAdjusted(
  waypoints: RoutePoint[],
  center: RoutePoint,
  targetDistanceKm: number,
  // 2 retries (3 total attempts) is the sweet spot. With damping 0.7 + the
  // [0.80, 1.25] cap, most candidates converge in attempt 1 — a 3rd retry
  // mostly burned wall-clock without improving the chosen route.
  maxRetries: number = 2
): Promise<{ route: OSRMRoute | null; waypoints: RoutePoint[] }> {
  // Sequential first attempt + iterative refinement. A previous experiment
  // hedged 3 parallel scales upfront for wall-clock wins, but tripled the
  // request volume to public OSRM which then rate-limited the burst — many
  // candidates resolved to null and the algorithm displayed raw waypoints
  // as straight-line "routes" through buildings and across rivers. Sticking
  // to one call per attempt keeps total in-flight requests = candidate count.
  let currentWaypoints = waypoints;
  // Track the best result we've seen across attempts so we don't accidentally
  // return a worse-fitting later attempt just because it ran last.
  let best: { route: OSRMRoute; waypoints: RoutePoint[]; ratio: number } | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const route = await fetchOSRMRoute(currentWaypoints);
    if (!route) {
      traceEmit('adjust-no-route', { attempt });
      if (best) return { route: best.route, waypoints: best.waypoints };
      return { route: null, waypoints: currentWaypoints };
    }

    const routeDistKm = route.distance / 1000;
    const ratio = routeDistKm / targetDistanceKm;
    traceEmit('adjust-attempt', { attempt, distKm: routeDistKm, ratio, target: targetDistanceKm });

    // Track best-so-far by closeness to ratio = 1.
    const prevBestErr = best ? Math.abs(1 - best.ratio) : Infinity;
    const thisErr = Math.abs(1 - ratio);
    if (!best || thisErr < prevBestErr) {
      best = { route, waypoints: currentWaypoints, ratio };
    }

    // Accept window ±15%. Tighter (±7%) caused over-iteration and
    // overshoot — routes ended up FARTHER from target after extra scaling.
    if (ratio >= 0.85 && ratio <= 1.15) {
      return { route, waypoints: currentWaypoints };
    }

    // Divergence detection. Scaling waypoints across a hard barrier
    // (river, large park, expressway) can flip the OSRM route from
    // ~10km → ~28km in a single step (observed in Columbus 8mi). When the
    // new attempt is dramatically WORSE than the best so far, further
    // scaling will only oscillate — return the best.
    if (attempt > 0 && thisErr > prevBestErr * 2.0) {
      traceEmit('adjust-diverged', { ratio, prevBestRatio: best!.ratio });
      return { route: best!.route, waypoints: best!.waypoints };
    }

    // Out of retries — return the closest attempt rather than the latest.
    if (attempt === maxRetries) {
      traceEmit('adjust-give-up', { bestRatio: best.ratio });
      return { route: best.route, waypoints: best.waypoints };
    }

    // Scale waypoints toward/away from center. Damped to prevent
    // overcorrection, then HARD-CAPPED to [0.80, 1.25] per step so that
    // a wildly-off ratio (e.g. 0.55 — usually means waypoint landed past
    // a barrier and OSRM cut it short) can't fling waypoints into water on
    // the next attempt. Trace data showed candidates oscillating
    // 10km → 28km → 7km → 11km when an unbounded scale (1.8×) pushed
    // waypoints across the East/Hudson rivers.
    const scaleFactor = 1 / ratio;
    const dampedScale = 1 + (scaleFactor - 1) * 0.7;
    const cappedScale = Math.max(0.80, Math.min(1.25, dampedScale));
    currentWaypoints = scaleWaypoints(currentWaypoints, center, cappedScale);
  }

  return best
    ? { route: best.route, waypoints: best.waypoints }
    : { route: null, waypoints: currentWaypoints };
}


/**
 * Deterministic synthetic OSRM stand-in for the quality harness.
 *
 * Emits plausible road-shaped geometry through the given waypoints — enough
 * to exercise the post-OSRM pipeline (lollipop removal, retrace/overlap
 * detection, scoring, ranking) without burning quota on the public
 * router.project-osrm.org endpoint.
 *
 * Geometry is two-harmonic perpendicular wobble around the straight line
 * between each pair of waypoints, tapered to zero at the endpoints so the
 * route actually touches each waypoint. Wobble seed is derived from the
 * endpoint coordinates so the same waypoints always produce the same shape.
 *
 * NOT representative of real road geometry. Use only for algorithm-level
 * QA of waypoint selection + post-processing, not for end-user simulation.
 */
export function mockOSRMRoute(waypoints: RoutePoint[]): OSRMRoute {
  const STEP_KM = 0.025; // ~25m between sampled points
  // Wobble amplitude as fraction of segment length. Tuned so arc length
  // sits at ~1.25–1.4× straight line — close enough to ROUTING_OVERHEAD
  // that the distance-adjustment loop converges similarly to real OSRM.
  // Tuned so mock arc length is ~1.35-1.45× straight-line — matches real
  // OSRM's typical road-routing overhead. Was 0.09 (gave ~1.10×) which
  // made anchored routes look 25% shorter in mock than they'd actually
  // be in production, causing false rounding-distance failures.
  const WOBBLE_FRACTION = 0.22;

  const coords: [number, number][] = [];

  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    const direct = haversineDistance(a, b);
    if (direct < 0.001) continue;

    const steps = Math.max(8, Math.round(direct / STEP_KM));
    const bearing = bearingFrom(a, b);
    const perpBearing = (bearing + 90) % 360;

    if (i === 0) coords.push([a.lng, a.lat]);

    // Phase derived from segment endpoints — same waypoints → same shape.
    const seed = a.lat * 31 + a.lng * 71 + b.lat * 53 + b.lng * 13;

    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const baseLat = a.lat + (b.lat - a.lat) * t;
      const baseLng = a.lng + (b.lng - a.lng) * t;

      // Sin(πt) taper: zero at endpoints, full amplitude at midpoint.
      const taper = Math.sin(Math.PI * t);
      const wobble =
        WOBBLE_FRACTION * direct *
        (Math.sin(seed + t * 12.7) * 0.6 + Math.sin(seed * 1.3 + t * 31.3) * 0.4) *
        taper;

      const wobbled = destinationPoint(
        { lat: baseLat, lng: baseLng },
        perpBearing,
        wobble
      );
      coords.push([wobbled.lng, wobbled.lat]);
    }
  }

  let distMeters = 0;
  for (let k = 1; k < coords.length; k++) {
    const p1 = { lat: coords[k - 1][1], lng: coords[k - 1][0] };
    const p2 = { lat: coords[k][1], lng: coords[k][0] };
    distMeters += haversineDistance(p1, p2) * 1000;
  }

  // 9 min/km walking pace → 540 s/km
  const duration = (distMeters / 1000) * 540;

  return {
    geometry: { type: 'LineString', coordinates: coords },
    distance: distMeters,
    duration,
  };
}

/**
 * Toggle for the synthetic OSRM stand-in. Off in production; the harness
 * flips it on with `--mock-osrm` (auto-on with `--synthetic`) so a single
 * QA run exercises the real waypoint-selection + post-processing pipeline
 * without depending on the public OSRM endpoint.
 */
let osrmMockEnabled = false;
export function setOSRMMock(enabled: boolean): void { osrmMockEnabled = enabled; }
export function isOSRMMockEnabled(): boolean { return osrmMockEnabled; }

/**
 * Deterministic seed override for `generateOSRMRoutes`. When set (by the
 * harness), replaces `Date.now()` everywhere variant/bearing seeding is
 * computed so two runs over the same fixture produce byte-identical
 * waypoints. Production leaves this null so each user request shuffles.
 */
let deterministicSeed: number | null = null;
export function setDeterministicSeed(seed: number | null): void { deterministicSeed = seed; }
function getSeed(): number {
  return deterministicSeed !== null ? deterministicSeed : Date.now();
}

/**
 * In-memory cache of successful OSRM responses keyed by request URL.
 * Identical waypoints (e.g. when the user taps refresh from the same start)
 * skip the network round trip entirely. LRU-bounded to avoid unbounded
 * growth in long sessions; failures aren't cached so transient network
 * errors can still be retried.
 */
const osrmRouteCache = new Map<string, OSRMRoute>();
// Mutable so the test harness can raise the cap before recording a snapshot
// (a single harness run can fire 100+ OSRM calls; the production default
// would silently evict half of them, breaking deterministic replay).
// Production: 200 covers ~30 prior generations worth of waypoint hits and
// is small enough that the AsyncStorage JSON blob stays under ~500KB even
// with full-geometry geojson polylines.
let osrmCacheMax = 200;
export function setOSRMCacheMax(n: number): void { osrmCacheMax = n; }
/** Clear the in-memory OSRM cache. The harness calls this between fixtures
 *  in deterministic mode so cross-fixture cache hits don't make results
 *  depend on which fixtures preceded the current one. */
export function clearOSRMCache(): void { osrmRouteCache.clear(); }

/**
 * Pre-warm the TCP+TLS connection to the OSRM endpoint by firing a trivial
 * routing request and discarding the result. Saves ~100-300ms of handshake
 * latency on the first real route call. Pair with prefetch from the route
 * screen so the first user-visible Generate hits warm sockets.
 */
export function prewarmOSRMConnection(center: RoutePoint): void {
  // Tiny ~110m route (1° lat ≈ 111km, so 0.001° ≈ 110m) — minimal OSRM
  // compute, just enough to establish the connection. Skip when mocked.
  if (osrmMockEnabled) return;
  const wp1 = `${center.lng},${center.lat}`;
  const wp2 = `${center.lng},${center.lat + 0.001}`;
  const url = `${osrmBase}/${wp1};${wp2}?overview=false`;
  fetch(url).catch(() => {
    // Fire-and-forget; the real route call surfaces any endpoint errors.
  });
}

/**
 * Snapshot the OSRM cache for record-and-replay testing — same pattern as
 * the Overpass snapshot. Lets the quality harness run fully offline once
 * a recording exists, removing flakiness from the public OSRM endpoint.
 */
export interface OSRMSnapshot {
  routes: Array<[string, OSRMRoute]>;
}

export function dumpOSRMCache(): OSRMSnapshot {
  return { routes: Array.from(osrmRouteCache.entries()) };
}

export function loadOSRMCache(snapshot: Partial<OSRMSnapshot>): void {
  if (snapshot.routes) {
    for (const [k, v] of snapshot.routes) osrmRouteCache.set(k, v);
  }
}

/**
 * Call OSRM to get a walking route through the given waypoints.
 */
async function fetchOSRMRoute(waypoints: RoutePoint[]): Promise<OSRMRoute | null> {
  // Mock short-circuit — bypasses cache, network, and retry. Used only
  // by the quality harness to keep algorithm QA decoupled from OSRM quota.
  if (osrmMockEnabled) {
    if (waypoints.length < 2) return null;
    return mockOSRMRoute(waypoints);
  }

  const coords = coordsString(waypoints);
  const url = `${osrmBase}/${coords}?overview=full&geometries=geojson&steps=false`;

  const cached = osrmRouteCache.get(url);
  if (cached !== undefined) {
    // Refresh LRU position so hot entries survive eviction.
    osrmRouteCache.delete(url);
    osrmRouteCache.set(url, cached);
    return cached;
  }

  try {
    const res = await fetchWithRetry(url);
    if (!res.ok) return null;
    const data: OSRMResponse = await res.json();

    if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
      return null;
    }

    const route = data.routes[0];
    if (osrmRouteCache.size >= osrmCacheMax) {
      const oldest = osrmRouteCache.keys().next().value;
      if (oldest !== undefined) osrmRouteCache.delete(oldest);
    }
    osrmRouteCache.set(url, route);
    return route;
  } catch (err) {
    console.warn('OSRM fetch failed:', err);
    return null;
  }
}

/**
 * Triangle perimeter factor for the (center, wp1, wp2, center) waypoint
 * pattern with wp1 at bearing B and wp2 at bearing B+210°, both at the
 * same distance d from center:
 *   haversine perimeter = 2d + 2d·sin(105°) ≈ 3.93·d
 * Used to back-solve waypoint distance from the target route distance.
 *
 * Previously this was `2π` (treating the loop as a full circle), which
 * over-shrunk the radius by ~33% — the routed result undershot the target
 * by 20–30% on every loop fixture that fell through to the geometric path.
 */
const LOOP_TRIANGLE_PERIMETER = 2 + 2 * Math.sin((105 * Math.PI) / 180);

/**
 * Generate waypoints for a loop route (geometric fallback).
 * Uses only 2 waypoints on opposite sides to create a clean oval —
 * more waypoints in a city grid cause rectangular block-looping zigzags.
 */
function generateLoopWaypoints(
  center: RoutePoint,
  distanceKm: number,
  _prefs: RoutePreferences,
  variant: number,
  _greenSpaces: RoutePoint[] = []
): RoutePoint[] {
  const waypointDist = distanceKm / (LOOP_TRIANGLE_PERIMETER * ROUTING_OVERHEAD);
  const bearing = (variant * 73) % 360;

  const wp1 = destinationPoint(center, bearing, waypointDist);
  // Offset wp2 30° from antipodal so the route forms a triangle, not a
  // straight line — perfect-line waypoints make OSRM use the same streets
  // both ways, which produces high retrace.
  const wp2 = destinationPoint(center, (bearing + 210) % 360, waypointDist);

  return [center, wp1, wp2, center];
}

/**
 * Generate waypoints for an out-and-back route (legacy geometric fallback).
 */
function generateOutAndBackWaypoints(
  center: RoutePoint,
  distanceKm: number,
  prefs: RoutePreferences,
  variant: number,
  greenSpaces: RoutePoint[] = []
): RoutePoint[] {
  const halfDistance = distanceKm / (2 * ROUTING_OVERHEAD);
  const numOutPoints = 3;
  const segmentDist = halfDistance / numOutPoints;
  const mainBearing = variant * 97 + (prefs.lowTraffic ? 30 : 0);
  const maxSnapDistance = distanceKm * 0.25;
  const outPoints: RoutePoint[] = [center];

  for (let i = 1; i <= numOutPoints; i++) {
    const bearingOffset = Math.sin(variant * 3000 + i * 47.7) * 10;
    const distFactor = 0.95 + Math.sin(variant * 4000 + i * 63.1) * 0.1;
    const prev = outPoints[outPoints.length - 1];
    let point = destinationPoint(prev, mainBearing + bearingOffset, segmentDist * distFactor);
    const blend = i === numOutPoints ? 0.8 : 0.7;
    point = selectWaypoint(point, greenSpaces, maxSnapDistance, blend);
    outPoints.push(point);
  }

  const returnPoints = [...outPoints].reverse().slice(1).map((p, i) => ({
    lat: p.lat + Math.sin(variant * 5000 + i * 83.9) * 0.0003,
    lng: p.lng + Math.cos(variant * 6000 + i * 91.3) * 0.0003,
  }));

  return [...outPoints, ...returnPoints];
}

/**
 * Generate waypoints for a point-to-point route (legacy geometric fallback).
 */
/**
 * Generate waypoints for a point-to-point route (legacy geometric fallback).
 * Returns a direct route — intermediate geometric points cause unnecessary
 * block-looping since they aren't parks or green spaces.
 */
function generatePointToPointWaypoints(
  start: RoutePoint,
  end: RoutePoint,
  _prefs: RoutePreferences,
  _variant: number,
  _greenSpaces: RoutePoint[] = []
): RoutePoint[] {
  return [start, end];
}

// ---------------------------------------------------------------------------
// Route naming
// ---------------------------------------------------------------------------

const ROUTE_NAMES: Record<string, string[]> = {
  quiet: ['Backstreet Run', 'Quiet Lanes', 'Residential Circuit', 'Sidestreet Shuffle', 'Neighborhood Loop', 'Peaceful Path'],
  default: ['Downtown Explorer', 'City Loop', 'Urban Circuit', 'Coastal Breeze Route', 'Bridge Connector', 'Meadow Circuit'],
};

/**
 * Pick a route name. If green-space anchors with names are available,
 * generate a descriptive name from them instead of using the generic pool.
 */
export function pickRouteName(
  prefs: RoutePreferences,
  index: number,
  lat: number,
  anchors: GreenSpace[] = [],
  routeType: 'loop' | 'out-and-back' | 'point-to-point' = 'loop'
): string {
  const namedAnchors = anchors.filter((a) => a.name);

  if (namedAnchors.length >= 2) {
    if (routeType === 'loop') {
      // Mention up to two distinct named anchors so the title reflects the
      // full character of the route — "East River Park & Tompkins Loop" is
      // more useful than just "East River Park Loop" when the route visits
      // both parks. Truncate the second name's "Park"/"Square Park" suffix
      // to keep titles readable.
      const second = namedAnchors[1].name!.replace(/\s*(?:Square\s*)?Park$|\s*Greenway$|\s*Garden(?:s)?$|\s*Promenade$/i, '');
      return `${namedAnchors[0].name} & ${second} Loop`;
    }
    return `${namedAnchors[0].name} to ${namedAnchors[namedAnchors.length - 1].name}`;
  }

  if (namedAnchors.length === 1) {
    if (routeType === 'loop') return `${namedAnchors[0].name} Loop`;
    if (routeType === 'out-and-back') return `${namedAnchors[0].name} Out & Back`;
    return `via ${namedAnchors[0].name}`;
  }

  // Fallback to generic names
  const pool = prefs.lowTraffic ? ROUTE_NAMES.quiet : ROUTE_NAMES.default;
  return pool[Math.abs((index + Math.floor(lat * 10)) % pool.length)];
}

// ---------------------------------------------------------------------------
// Main route generation pipeline
// ---------------------------------------------------------------------------

/** Fabricated elevation gain when real data is unavailable */
export function fabricateElevationGain(distKm: number, variant: number): number {
  return Math.round(5 + distKm * 3 + variant * 2);
}

/** Candidate strategies for variety: each of the 3 candidates uses a different focus */
const STRATEGIES: CandidateStrategy[] = ['large-parks', 'named-paths', 'balanced'];

/**
 * Generate real walking routes using the OSRM public API.
 *
 * Pipeline:
 * 1. Always fetch enriched green spaces (regardless of prefs)
 * 2. Generate candidates using green-space-first generators (with fallback)
 * 3. Apply water-crossing removal before sending to OSRM
 * 4. Fetch OSRM routes, score with green proximity
 * 5. Return best route(s)
 */
export async function generateOSRMRoutes(
  center: RoutePoint,
  distanceKm: number,
  routeType: 'loop' | 'out-and-back' | 'point-to-point',
  count: number = 1,
  prefs: RoutePreferences = { lowTraffic: false },
  end?: RoutePoint | null
): Promise<GeneratedRoute[]> {
  traceEmit('generate-start', { center, distanceKm, routeType, count, prefs, end: end ?? null });

  // Step 1: Fetch enriched green spaces and highway segments in a single
  // Overpass round trip (shared across all candidates).
  const radiusKm = calculateSearchRadius(routeType, distanceKm, center, end);
  const { greenSpaces, highwayPoints } = await fetchGreenSpacesAndHighways(center, radiusKm);
  traceEmit('overpass-result', {
    radiusKm,
    greenSpaceCount: greenSpaces.length,
    highwayPointCount: highwayPoints.length,
  });

  // Step 2: Generate count + safety-margin candidate waypoint sets with
  // diversity. Each candidate excludes parks used by previous candidates so
  // routes go through genuinely different areas. We deliberately generate
  // more than `count` so the tightened quality rejection (overlap, stubs,
  // retrace) has alternatives to fall back to without dropping all the way
  // to the geometric step-3.5 emergency fallback (which produces no-anchor
  // routes the user doesn't want).
  // Generate more candidates than the user asked for — quality rejection
  // can leave us with too few survivors otherwise. SAFETY_EXTRAS = 6 keeps
  // generation responsive (~7 OSRM calls vs ~3) while still giving the
  // scorer enough variants to find a clean candidate near target. The
  // public OSRM router is the dominant latency source, so capping the
  // candidate pool directly drives perceived speed.
  const SAFETY_EXTRAS = 6;
  const candidateCount = Math.min(MAX_INTERNAL_CANDIDATES, count + SAFETY_EXTRAS);
  const timeSeed = getSeed() % 100000;
  const candidates: { variant: number; waypoints: RoutePoint[]; anchors: GreenSpace[] }[] = [];
  const usedParkPoints: RoutePoint[] = []; // Parks already used by earlier candidates

  for (let i = 0; i < candidateCount; i++) {
    const variant = timeSeed + i + 1;
    const strategy = STRATEGIES[i % STRATEGIES.length];
    let waypoints: RoutePoint[];
    let anchors: GreenSpace[] = [];

    // Filter out parks already used by previous candidates
    const availableGreenSpaces = i === 0
      ? greenSpaces
      : greenSpaces.filter((gs) =>
          !usedParkPoints.some((used) => haversineDistance(used, gs.point) < 0.5)
        );

    if (routeType === 'point-to-point' && end) {
      if (i === 0) {
        // First candidate: direct route — let OSRM find the shortest path
        waypoints = [center, end];
      } else {
        // Other candidates: route via green spaces for scenic variety
        const result = generateGreenSpacePointToPoint(center, end, prefs, variant, availableGreenSpaces, strategy);
        if (result.anchors.length > 0) {
          waypoints = result.waypoints;
          anchors = result.anchors;
        } else {
          // No green spaces — create diversity by adding an offset waypoint
          // perpendicular to the direct path
          const midLat = (center.lat + end.lat) / 2;
          const midLng = (center.lng + end.lng) / 2;
          const dLat = end.lat - center.lat;
          const dLng = end.lng - center.lng;
          // Alternate sides: candidate 1 goes left, candidate 2 goes right
          const side = i % 2 === 1 ? 1 : -1;
          const offsetScale = 0.15 + (i * 0.05); // increasing offset per candidate
          const offsetLat = midLat + side * dLng * offsetScale;
          const offsetLng = midLng - side * dLat * offsetScale;
          waypoints = [center, { lat: offsetLat, lng: offsetLng }, end];
        }
      }
    } else if (routeType === 'out-and-back') {
      const result = generateGreenSpaceOutAndBack(center, distanceKm, prefs, variant, availableGreenSpaces, strategy);
      waypoints = result.waypoints;
      anchors = result.anchors;
    } else {
      const result = generateGreenSpaceLoop(center, distanceKm, prefs, variant, availableGreenSpaces, strategy);
      waypoints = result.waypoints;
      anchors = result.anchors;
    }

    // Track which parks this candidate used so later candidates avoid them
    for (const a of anchors) {
      usedParkPoints.push(a.point);
    }

    // Apply water crossing removal before OSRM, keeping anchors in sync so
    // expandParkWaypoints and route naming see the actual post-replacement
    // green spaces. Pass route distance so the threshold scales — a 6mi
    // loop's natural wp1→wp2 chord is ~3km, well over the fixed 1.5km
    // legacy default which would drop both waypoints.
    {
      const synced = removeWaterCrossingsWithAnchors(waypoints, greenSpaces, center, anchors, distanceKm);
      waypoints = synced.waypoints;
      anchors = synced.anchors;
    }

    // Expand large parks into entry/exit pairs so OSRM routes through
    // the park interior, not just past its edge
    waypoints = expandParkWaypoints(waypoints, anchors);

    traceEmit('candidate-built', {
      i,
      strategy,
      variant,
      anchorCount: anchors.length,
      anchorNames: anchors.map((a) => a.name).filter(Boolean),
      waypointCount: waypoints.length,
      waypoints,
    });
    candidates.push({ variant, waypoints, anchors });
  }

  // Step 3: Fetch OSRM routes for all candidates, with iterative distance
  // adjustment. If a candidate's OSRM distance is too far from the target,
  // shrink/expand waypoints toward center and re-query (up to 2 retries).
  // Point-to-point routes skip adjustment since they must reach the destination.
  //
  // PROGRESSIVE RESOLUTION: process results AS THEY ARRIVE rather than
  // awaiting Promise.all. Public OSRM has high latency variance — the
  // slowest candidate often takes 2-3× as long as the median. If a fast
  // candidate already meets our quality bar, the slower ones rarely beat
  // it enough to justify waiting. Early exit cuts perceived generation
  // time from "max(latencies)" to roughly "median(latencies) + processing"
  // on most calls, while preserving best-of-N quality on hard cases
  // (clustered green spaces, water-bounded grids) where no candidate
  // reaches the early-exit bar and we naturally wait for all to finish.
  const useAdjustment = routeType !== 'point-to-point';
  type Tagged = { idx: number; result: { route: OSRMRoute | null; waypoints: RoutePoint[] } };
  const pending = new Map<number, Promise<Tagged>>();
  for (let idx = 0; idx < candidates.length; idx++) {
    const c = candidates[idx];
    const p = (useAdjustment
      ? fetchOSRMRouteAdjusted(c.waypoints, center, distanceKm)
      : fetchOSRMRoute(c.waypoints).then((route) => ({ route, waypoints: c.waypoints }))
    ).then((result) => ({ idx, result }));
    pending.set(idx, p);
  }

  // Quality threshold below which we stop waiting for additional candidates.
  // A perfect route scores ≤0.05; 0.20 means "well-shaped, on-target,
  // anchored to a named green space" — empirically rare to be beaten by
  // waiting for the rest. The threshold is intentionally strict so that
  // hitting it is a strong signal we've found a great route, not just an
  // OK one. On hard cases (clustered green spaces, water-bounded grids)
  // no candidate reaches this bar and we wait for all to finish.
  const EARLY_EXIT_QUALITY = 0.20;

  // Build resolved candidates. NEW BEHAVIOR: don't hard-reject candidates
  // that fail strict thresholds — KEEP them with a quality score so we can
  // pick the least-bad survivor instead of falling through to the geometric
  // step-3.5 fallback (which often produces *worse* routes than the
  // candidates we'd otherwise discard). Step-3.5 only fires now when the
  // OSRM call itself returned nothing.
  const resolved: ResolvedCandidate[] = [];
  // Hard rejection only for "completely unusable" cases: distance way off,
  // crosses a clear barrier, or routes along highways. Soft thresholds on
  // retrace/overlap/stubs feed into a quality score; the worst-quality
  // candidates lose to better ones but still beat the geometric fallback.
  while (pending.size > 0) {
    const winner = await Promise.race(pending.values());
    pending.delete(winner.idx);
    const i = winner.idx;
    const osrmResult = winner.result;
    const osrmRoute = osrmResult.route;
    if (osrmRoute) {
      const rawPoints = osrmRoute.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
      const rawDistKm = osrmRoute.distance / 1000;
      const skipLollipopRemoval = routeType === 'out-and-back' || osrmMockEnabled;
      const afterLollipop = skipLollipopRemoval
        ? rawPoints
        : removeSelfintersections(rawPoints);
      let afterLollipopKm = rawDistKm;
      if (afterLollipop !== rawPoints) {
        afterLollipopKm = 0;
        for (let k = 1; k < afterLollipop.length; k++) {
          afterLollipopKm += haversineDistance(afterLollipop[k - 1], afterLollipop[k]);
        }
        traceEmit('post-process-trim', { i, stage: 'lollipop', before: rawDistKm, after: afterLollipopKm });
      }
      // Always trim dead-end stubs. The user explicitly does not want any
      // visible stubs — even one ruins the "can the runner follow this as
      // a single path?" property. Out-and-back routes are exempt because
      // their U-turn at the far end is the intended pattern, not a stub.
      const points = routeType === 'out-and-back'
        ? afterLollipop
        : trimStubs(afterLollipop);
      if (points !== afterLollipop) {
        let stubKm = 0;
        for (let k = 1; k < points.length; k++) {
          stubKm += haversineDistance(points[k - 1], points[k]);
        }
        traceEmit('post-process-trim', { i, stage: 'stubs', before: afterLollipopKm, after: stubKm });
      }
      // Recompute distance from the FINAL points (after both lollipop
      // removal and stub trimming) so the displayed mileage matches the
      // polyline drawn on the map.
      let distKm: number;
      if (points === rawPoints) {
        distKm = osrmRoute.distance / 1000;
      } else {
        distKm = 0;
        for (let k = 1; k < points.length; k++) {
          distKm += haversineDistance(points[k - 1], points[k]);
        }
      }
      const estimatedTime = Math.round(osrmRoute.duration / 60);
      const distRatio = distanceKm > 0 ? distKm / distanceKm : 1;
      // HARD REJECT: distance catastrophically wrong (catches OSRM degenerate cases)
      const maxRatio = routeType === 'point-to-point' ? 3.0 : 1.3;
      const minRatio = routeType === 'point-to-point' ? 0.2 : 0.5;
      if (distRatio > maxRatio || distRatio < minRatio) {
        traceEmit('candidate-rejected', { i, reason: 'distance', distKm, distRatio, target: distanceKm });
        continue;
      }
      // HARD REJECT: route crosses a clear barrier (tunnel, bridge, water)
      if (routeType !== 'point-to-point' && hasRoutedBarrierCrossing(points, greenSpaces, center, distanceKm)) {
        traceEmit('candidate-rejected', { i, reason: 'barrier', distKm });
        continue;
      }
      const hwProximity = computeHighwayProximity(points, highwayPoints);
      // HARD REJECT: route runs alongside major highways
      if (hwProximity > 0.15) {
        traceEmit('candidate-rejected', { i, reason: 'highway', hwProximity });
        continue;
      }
      // SOFT METRICS: feed into a quality score. Lower retrace/overlap/stubs
      // = higher quality. We KEEP all candidates that pass hard rejection
      // and pick the best by quality at the end. This avoids the past bug
      // where a 28%-retrace candidate was thrown out and replaced by a
      // 50%-retrace step-3.5 fallback.
      const retraced = retraceRatio(points);
      const overlap = overlapSegmentRatio(points);
      const stubs = countStubs(points);
      // Quality score: 0 = perfect, higher = worse. Out-and-back is exempt
      // from retrace/overlap. Components:
      //   retrace + overlap: visible polyline ugliness
      //   stubs * 0.10: each dead-end is a UX hit but not catastrophic
      //   |1 - distRatio| * 1.0: hitting target distance is critical — if
      //     a "4 mi route" returns 3 mi the user feels misled
      //   - anchorBonus: small thumb on the scale toward named green
      //     spaces, but small enough that distance / cleanliness still wins
      const isOutAndBack = routeType === 'out-and-back';
      const anchorBonus = candidates[i].anchors.length >= 2 ? 0.10
        : candidates[i].anchors.length === 1 ? 0.05
        : 0;
      // Rounding penalty. The user-facing distance label rounds to the
      // nearest mile, so a 4mi request returning a route that rounds to
      // 3mi (or 5mi) feels broken even if the absolute error is small.
      // 0.4 per mile of rounded delta — bigger than typical retrace deltas
      // so a candidate that rounds correctly wins even if it's slightly
      // dirtier than one that doesn't. Empirically lifted random-seed
      // pass rate from ~5/15 to ~7/15 across the NYC harness fixtures.
      const targetMi = distanceKm * 0.621371;
      const actualMi = distKm * 0.621371;
      const roundedDelta = Math.abs(Math.round(actualMi) - Math.round(targetMi));
      const roundingPenalty = roundedDelta * 0.4;
      const qualityPenalty = Math.max(0,
        (isOutAndBack ? 0 : retraced) +
        (isOutAndBack ? 0 : overlap) +
        // Out-and-back routes have an intentional U-turn at the far end
        // which countStubs flags; don't penalize it.
        (isOutAndBack ? 0 : stubs * 0.20) +
        Math.abs(1 - distRatio) * 1.0 +
        roundingPenalty -
        anchorBonus
      );
      traceEmit('candidate-evaluated', { i, distKm, distRatio, hwProximity, retraced, overlap, stubs, roundingPenalty, qualityPenalty });
      resolved.push({ index: i, variant: candidates[i].variant, points, distKm, estimatedTime, fromOSRM: true, anchors: candidates[i].anchors, qualityPenalty });

      // Early exit: a confidently-good candidate just arrived; don't
      // keep waiting on the remaining OSRM calls. They'll finish in the
      // background and be GC'd; no cancellation needed since the network
      // cost is already incurred.
      if (qualityPenalty < EARLY_EXIT_QUALITY) {
        traceEmit('early-exit', {
          afterCount: resolved.length,
          bestQuality: qualityPenalty,
          remaining: pending.size,
        });
        break;
      }
    } else {
      // OSRM returned nothing — likely network failure, timeout, or no route
      // exists for these waypoints. Skip the candidate entirely. Older code
      // displayed the raw straight-line waypoints here as a "fallback" route,
      // which surfaced as triangles cutting through buildings and across
      // rivers when public OSRM was rate-limited. Better to drop and let
      // either another candidate or step-3.5 fill in.
      traceEmit('candidate-rejected', { i, reason: 'osrm-null' });
    }
  }

  // Step 3.5: If all candidates were rejected, fall back to a direct route
  // Use iterative distance adjustment to ensure fallback also hits target distance
  if (resolved.length === 0) {
    console.log('[RouteScoring] All candidates rejected — generating direct fallback');
    traceEmit('fallback-start', { routeType, distanceKm });

    let chosen: { route: OSRMRoute | null; waypoints: RoutePoint[] };

    if (routeType === 'point-to-point' && end) {
      // Direct route from start to end — only one waypoint option to try.
      chosen = await fetchOSRMRouteAdjusted([center, end], center, distanceKm, 3);
    } else {
      // A single random bearing can land in water or impassable terrain —
      // sf-embarcadero-3mi-out hit 11.65km on a 4.83km target because the
      // bearing pointed into the bay, forcing OSRM to detour around it.
      // Try N evenly-spaced bearings in parallel and keep the one whose
      // routed distance lands closest to the target.
      const NUM_BEARINGS = 4;
      const seedBearing = getSeed() % 360;
      const halfDist = distanceKm / (2 * ROUTING_OVERHEAD);
      // Same triangle-perimeter math as generateLoopWaypoints. Previously
      // used 2π here too, producing a 20–30% undershoot on the final fallback.
      const waypointDist = distanceKm / (LOOP_TRIANGLE_PERIMETER * ROUTING_OVERHEAD);

      // Sequential, not parallel. Firing all 4 trials in parallel (each with
      // its own internal retry loop) means up to 16 in-flight OSRM calls
      // against a free public endpoint, which rate-limits or times out — the
      // surviving trial is often the bad-bearing one. Sequential lets each
      // trial get OSRM's full attention; early-exit avoids wasted calls.
      chosen = { route: null, waypoints: [] };
      let bestErr = Infinity;
      let bestIdx = 0;
      const EARLY_EXIT_RATIO = 0.10; // stop once we're within 10% of target

      for (let i = 0; i < NUM_BEARINGS; i++) {
        const bearing = (seedBearing + (i * 360) / NUM_BEARINGS) % 360;
        const wps: RoutePoint[] = routeType === 'out-and-back'
          ? [center, destinationPoint(center, bearing, halfDist), center]
          : [
              center,
              destinationPoint(center, bearing, waypointDist),
              // Offset wp2 30° from antipodal so the route forms a triangle,
              // not a straight line. OSRM tends to use the same streets
              // both ways on a perfect line, causing high retrace.
              destinationPoint(center, (bearing + 210) % 360, waypointDist),
              center,
            ];

        const t = await fetchOSRMRouteAdjusted(wps, center, distanceKm, 3);
        traceEmit('fallback-trial', {
          i,
          bearing,
          routedKm: t.route ? t.route.distance / 1000 : null,
          ratio: t.route ? (t.route.distance / 1000) / distanceKm : null,
          waypoints: t.waypoints,
        });

        if (!t.route) continue;
        const err = Math.abs(t.route.distance / 1000 - distanceKm);
        if (err < bestErr) {
          chosen = t;
          bestErr = err;
          bestIdx = i;
        }
        if (err / distanceKm <= EARLY_EXIT_RATIO) break;
      }
      traceEmit('fallback-chosen', {
        bestIdx,
        bearing: (seedBearing + (bestIdx * 360) / NUM_BEARINGS) % 360,
        routedKm: chosen.route ? chosen.route.distance / 1000 : null,
      });
    }

    if (chosen.route) {
      const points = chosen.route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
      resolved.push({
        index: 0,
        variant: 0,
        points,
        distKm: chosen.route.distance / 1000,
        estimatedTime: Math.round(chosen.route.duration / 60),
        fromOSRM: true,
        anchors: [],
        qualityPenalty: 0.5, // step-3.5 emergency fallback — no anchors, but real OSRM geometry
      });
    }
    // If even the bearing-trial fallback came back with no OSRM route,
    // resolved stays empty — the caller surfaces "no routes found" rather
    // than displaying raw straight-line waypoints over the map.
  }

  // Step 4: Score each candidate using locally-computable metrics only.
  // Skip the extra Overpass quiet-score requests — they add ~1-2s per candidate
  // and the green/runPath proximity scores (computed locally) already capture
  // route quality well enough for ranking.
  const scored = resolved.map((candidate) => {
    const greenProximity = computeGreenSpaceProximity(candidate.points, greenSpaces);
    const runPathProximity = computeRunPathProximity(candidate.points, greenSpaces);
    const waterfrontProximity = computeWaterfrontProximity(candidate.points, greenSpaces);
    const hwProximity = computeHighwayProximity(candidate.points, highwayPoints);
    // Use a neutral quiet score (0.5) to avoid extra network calls
    const quietScore = 0.5;
    let score = scoreRoute(
      { distanceKm: candidate.distKm, targetDistanceKm: distanceKm },
      prefs,
      quietScore,
      greenProximity,
      runPathProximity,
      waterfrontProximity
    );

    // Penalize any highway proximity that slipped through the hard rejection
    if (hwProximity > 0) {
      score *= (1 - hwProximity);
    }

    console.log(
      `[RouteScoring] Candidate ${candidate.index}: dist=${candidate.distKm.toFixed(2)}km, ` +
      `green=${greenProximity.toFixed(2)}, ` +
      `runPath=${runPathProximity.toFixed(2)}, waterfront=${waterfrontProximity.toFixed(2)}, ` +
      `highway=${hwProximity.toFixed(2)}, score=${score.toFixed(3)}`
    );

    return { candidate, score, quietScore };
  });

  // Step 6: Sort by quality (lower penalty = better) and return top `count`.
  // Was previously generation-order, which assumed candidate 0 = best parks
  // = best route. That assumption broke in dense grids where candidate 0's
  // OSRM output had high retrace despite using "best" parks. Sorting by
  // quality means a candidate-2 with 5% retrace beats candidate-0 with 30%
  // retrace, regardless of which parks each used.
  const sortedByQuality = [...scored].sort(
    (a, b) => a.candidate.qualityPenalty - b.candidate.qualityPenalty
  );
  const topCandidates = sortedByQuality.slice(0, count);

  // Build final GeneratedRoute objects
  const terrain = routeType === 'point-to-point' ? 'Point to Point'
    : routeType === 'loop' ? 'Loop' : 'Out & Back';

  return topCandidates.map(({ candidate }) => {
    const elevationGain = fabricateElevationGain(candidate.distKm, candidate.variant);
    const difficulty: 'easy' | 'moderate' | 'hard' =
      candidate.distKm < 5 ? 'easy' : candidate.distKm < 10 ? 'moderate' : 'hard';
    const distanceMiles = Math.round(candidate.distKm * 0.621371);

    return {
      id: `route-${candidate.index}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: pickRouteName(prefs, candidate.index, center.lat, candidate.anchors, routeType),
      points: candidate.points,
      distance: distanceMiles,
      estimatedTime: candidate.estimatedTime,
      elevationGain,
      terrain,
      difficulty,
    };
  });
}
