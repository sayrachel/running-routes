import type { RoutePoint, GeneratedRoute, RoutePreferences } from './route-generator';
import { fetchGreenSpacesAndHighways } from './overpass';
import type { GreenSpace } from './overpass';
import { scoreRoute, computeGreenSpaceProximity, computeRunPathProximity, computeHighwayProximity, computeWaterfrontProximity } from './route-scoring';

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/foot';
const MAX_CANDIDATE_COUNT = 3;

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
  _greenSpaces: GreenSpace[]
): boolean {
  return haversineDistance(p1, p2) > 1.5;
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
  center: RoutePoint
): RoutePoint[] {
  if (waypoints.length < 3) return waypoints;

  const result = [...waypoints];
  const toRemove = new Set<number>();

  for (let i = 1; i < result.length - 1; i++) {
    if (!hasLikelyWaterCrossing(result[i - 1], result[i], greenSpaces) &&
        !hasLikelyWaterCrossing(result[i], result[i + 1], greenSpaces)) {
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
        if (hasLikelyWaterCrossing(center, gs.point, greenSpaces)) continue;
        const prevOk = !hasLikelyWaterCrossing(result[i - 1], gs.point, greenSpaces);
        const nextOk = i + 1 < result.length
          ? !hasLikelyWaterCrossing(gs.point, result[i + 1], greenSpaces)
          : true;
        if (prevOk && nextOk) {
          result[i] = gs.point;
          replaced = true;
          break;
        }
      }
    }

    if (!replaced) {
      toRemove.add(i);
    }
  }

  return result.filter((_, i) => !toRemove.has(i));
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
  const minStraightKm = 0.4; // 400m minimum to flag

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

  if (picks.length < (strict ? 3 : 2)) return null;

  // Cap at 3 waypoints max — more than 3 creates zigzag block-looping
  const maxGreenWaypoints = Math.min(picks.length, 3);
  const selectedPicks = picks
    .sort((a, b) => b.dist - a.dist) // drop farthest first if over cap
    .slice(picks.length - maxGreenWaypoints);

  // Order by bearing to form a loop
  selectedPicks.sort((a, b) => a.bearing - b.bearing);

  // Remove waypoints too close to center — prevents backtracking near start/end
  const minCenterDist = Math.max(0.8, targetDistanceKm * 0.12);
  for (let i = selectedPicks.length - 1; i >= 0; i--) {
    if (selectedPicks[i].dist < minCenterDist) {
      selectedPicks.splice(i, 1);
    }
  }

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
  minAreaForExpansion: number = 0.1
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
  const mainBearing = (variant * 97 + (prefs.lowTraffic ? 30 : 0)) % 360;
  const corridorWidth = 30; // degrees either side of main bearing

  // Find green spaces along the corridor
  const corridorSpaces = greenSpaces
    .map((gs) => ({
      gs,
      bearing: bearingFrom(center, gs.point),
      dist: haversineDistance(center, gs.point),
      score: scoreGreenSpace(gs, strategy, prefs.lowTraffic),
    }))
    .filter((a) => angleDiff(a.bearing, mainBearing) <= corridorWidth && a.dist <= halfDist)
    .sort((a, b) => a.dist - b.dist);

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

const OSRM_TIMEOUT_MS = 3000;

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
  maxRetries: number = 1
): Promise<{ route: OSRMRoute | null; waypoints: RoutePoint[] }> {
  let currentWaypoints = waypoints;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const route = await fetchOSRMRoute(currentWaypoints);
    if (!route) return { route: null, waypoints: currentWaypoints };

    const routeDistKm = route.distance / 1000;
    const ratio = routeDistKm / targetDistanceKm;

    // Accept if within 30%
    if (ratio >= 0.7 && ratio <= 1.3) {
      return { route, waypoints: currentWaypoints };
    }

    // On last attempt, return whatever we got
    if (attempt === maxRetries) {
      return { route, waypoints: currentWaypoints };
    }

    // Scale waypoints: if route is too long, shrink toward center
    // Dampen the correction to avoid oscillation
    const scaleFactor = 1 / ratio;
    const dampedScale = 1 + (scaleFactor - 1) * 0.7;
    currentWaypoints = scaleWaypoints(currentWaypoints, center, dampedScale);
  }

  return { route: null, waypoints: currentWaypoints };
}

/**
 * In-memory cache of successful OSRM responses keyed by request URL.
 * Identical waypoints (e.g. when the user taps refresh from the same start)
 * skip the network round trip entirely. LRU-bounded to avoid unbounded
 * growth in long sessions; failures aren't cached so transient network
 * errors can still be retried.
 */
const osrmRouteCache = new Map<string, OSRMRoute>();
const OSRM_CACHE_MAX = 50;

/**
 * Call OSRM to get a walking route through the given waypoints.
 */
async function fetchOSRMRoute(waypoints: RoutePoint[]): Promise<OSRMRoute | null> {
  const coords = coordsString(waypoints);
  const url = `${OSRM_BASE}/${coords}?overview=full&geometries=geojson&steps=false`;

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
    if (osrmRouteCache.size >= OSRM_CACHE_MAX) {
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
  const radius = distanceKm / (2 * Math.PI * ROUTING_OVERHEAD);
  const bearing = (variant * 73) % 360;

  const wp1 = destinationPoint(center, bearing, radius * 1.2);
  const wp2 = destinationPoint(center, (bearing + 180) % 360, radius * 1.2);

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
      return `${namedAnchors[0].name} Loop`;
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
  // Step 1: Fetch enriched green spaces and highway segments in a single
  // Overpass round trip (shared across all candidates).
  const radiusKm = calculateSearchRadius(routeType, distanceKm, center, end);
  const { greenSpaces, highwayPoints } = await fetchGreenSpacesAndHighways(center, radiusKm);

  // Step 2: Generate exactly `count` candidate waypoint sets with diversity.
  // Each candidate excludes parks used by previous candidates so routes go
  // through genuinely different areas. We don't speculate an extra "+1"
  // candidate as insurance — Promise.all would wait for the slowest of N+1
  // even though we only ever return N. The Step 3.5 fallback at the bottom
  // handles the rare case where every candidate is rejected.
  const candidateCount = Math.min(MAX_CANDIDATE_COUNT, count);
  const timeSeed = Date.now() % 100000;
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

    // Apply water crossing removal before OSRM
    waypoints = removeWaterCrossings(waypoints, greenSpaces, center);

    // Expand large parks into entry/exit pairs so OSRM routes through
    // the park interior, not just past its edge
    waypoints = expandParkWaypoints(waypoints, anchors);

    candidates.push({ variant, waypoints, anchors });
  }

  // Step 3: Fetch OSRM routes for all candidates, with iterative distance
  // adjustment. If a candidate's OSRM distance is too far from the target,
  // shrink/expand waypoints toward center and re-query (up to 2 retries).
  // Point-to-point routes skip adjustment since they must reach the destination.
  const useAdjustment = routeType !== 'point-to-point';
  const osrmResults = await Promise.all(
    candidates.map((c) =>
      useAdjustment
        ? fetchOSRMRouteAdjusted(c.waypoints, center, distanceKm)
        : fetchOSRMRoute(c.waypoints).then((route) => ({ route, waypoints: c.waypoints }))
    )
  );

  // Build resolved candidates
  const resolved: ResolvedCandidate[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const osrmResult = osrmResults[i];
    const osrmRoute = osrmResult.route;
    if (osrmRoute) {
      const rawPoints = osrmRoute.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
      const points = removeSelfintersections(rawPoints);
      const distKm = osrmRoute.distance / 1000;
      const estimatedTime = Math.round(osrmRoute.duration / 60);
      const distRatio = distanceKm > 0 ? distKm / distanceKm : 1;
      // Point-to-point routes go to a user-chosen destination, so be very
      // lenient on distance — the route must exist even if roads are indirect.
      const maxRatio = routeType === 'point-to-point' ? 3.0 : 1.3;
      const minRatio = routeType === 'point-to-point' ? 0.2 : 0.5;
      if (distRatio > maxRatio || distRatio < minRatio) {
        console.log(`[RouteScoring] Rejecting candidate ${i}: dist=${distKm.toFixed(2)}km (ratio=${distRatio.toFixed(2)}, target=${distanceKm.toFixed(2)}km)`);
        continue;
      }
      // Check the routed path for tunnels/bridges (straight-line segments)
      // and geographic drift (route leaving the starting area)
      if (routeType !== 'point-to-point' && hasRoutedBarrierCrossing(points, greenSpaces, center, distanceKm)) {
        console.log(`[RouteScoring] Rejecting candidate ${i}: route crosses a likely barrier (tunnel/bridge)`);
        continue;
      }
      // Check for highway proximity — reject routes where >15% of points
      // are near major roads (motorways, trunk, primary). Runners should
      // never be routed along highways.
      const hwProximity = computeHighwayProximity(points, highwayPoints);
      if (hwProximity > 0.15) {
        console.log(`[RouteScoring] Rejecting candidate ${i}: ${(hwProximity * 100).toFixed(0)}% of route is near highways`);
        continue;
      }
      // Reject routes where >15% of distance is on retraced edges — the line
      // looks connected on the map but the runner can't follow it as a single
      // pass without doubling back over the same blocks.
      const retraced = retraceRatio(points);
      if (retraced > 0.15) {
        console.log(`[RouteScoring] Rejecting candidate ${i}: ${(retraced * 100).toFixed(0)}% of distance is retraced`);
        continue;
      }
      resolved.push({ index: i, variant: candidates[i].variant, points, distKm, estimatedTime, fromOSRM: true, anchors: candidates[i].anchors });
    } else {
      const wp = osrmResult.waypoints;
      const totalDist = wp.reduce((sum, p, j) => {
        if (j === 0) return 0;
        return sum + haversineDistance(wp[j - 1], p);
      }, 0);
      const fallbackRatio = distanceKm > 0 ? totalDist / distanceKm : 1;
      const maxFallbackRatio = routeType === 'point-to-point' ? 3.0 : 1.3;
      const minFallbackRatio = routeType === 'point-to-point' ? 0.2 : 0.5;
      if (fallbackRatio > maxFallbackRatio || fallbackRatio < minFallbackRatio) {
        console.log(`[RouteScoring] Rejecting fallback ${i}: dist=${totalDist.toFixed(2)}km (ratio=${fallbackRatio.toFixed(2)})`);
        continue;
      }
      resolved.push({
        index: i,
        variant: candidates[i].variant,
        points: wp,
        distKm: totalDist,
        estimatedTime: Math.round(totalDist * 6),
        fromOSRM: false,
        anchors: candidates[i].anchors,
      });
    }
  }

  // Step 3.5: If all candidates were rejected, fall back to a direct route
  // Use iterative distance adjustment to ensure fallback also hits target distance
  if (resolved.length === 0) {
    console.log('[RouteScoring] All candidates rejected — generating direct fallback');
    let fallbackWaypoints: RoutePoint[];
    if (routeType === 'point-to-point' && end) {
      // Simple direct route from start to end
      fallbackWaypoints = [center, end];
    } else if (routeType === 'out-and-back') {
      const bearing = (Date.now() % 360);
      const halfDist = distanceKm / (2 * ROUTING_OVERHEAD);
      const turnaround = destinationPoint(center, bearing, halfDist);
      fallbackWaypoints = [center, turnaround, center];
    } else {
      // Loop fallback
      fallbackWaypoints = generateLoopWaypoints(center, distanceKm, prefs, Date.now() % 100000, []);
    }

    const adjusted = await fetchOSRMRouteAdjusted(fallbackWaypoints, center, distanceKm, 1);
    if (adjusted.route) {
      const points = adjusted.route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
      resolved.push({
        index: 0,
        variant: 0,
        points,
        distKm: adjusted.route.distance / 1000,
        estimatedTime: Math.round(adjusted.route.duration / 60),
        fromOSRM: true,
        anchors: [],
      });
    } else {
      // Use raw waypoints as last resort
      let totalDist = 0;
      for (let j = 1; j < adjusted.waypoints.length; j++) {
        totalDist += haversineDistance(adjusted.waypoints[j - 1], adjusted.waypoints[j]);
      }
      resolved.push({
        index: 0,
        variant: 0,
        points: adjusted.waypoints,
        distKm: totalDist,
        estimatedTime: Math.round(totalDist * 6),
        fromOSRM: false,
        anchors: [],
      });
    }
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

  // Step 6: Return candidates in generation order (not sorted by score).
  // Candidate 0 uses the best parks, candidate 1 excludes those parks
  // and finds alternatives, candidate 2 excludes both. This gives the user
  // genuinely different route options rather than minor variations.
  const topCandidates = scored.slice(0, count);

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
