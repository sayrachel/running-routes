import type { RoutePoint, GeneratedRoute, RoutePreferences } from './route-generator';
import { fetchQuietScore, fetchGreenSpacesEnriched } from './overpass';
import type { GreenSpace } from './overpass';
import { scoreRoute, computeGreenSpaceProximity, computeRunPathProximity } from './route-scoring';

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/foot';
const CANDIDATE_COUNT = 3;

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
 */
function removeSelfintersections(points: RoutePoint[]): RoutePoint[] {
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
          const cleaned = [...points.slice(0, i + 1), ...points.slice(j + 1)];
          return cleaned;
        }
      }
    }
  }

  return points;
}

/** Check if two line segments cross each other */
function segmentsCross(
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
 * Detect if two consecutive waypoints likely cross water or a major barrier.
 * Uses two checks:
 * 1. Flags if they are >0.6km apart AND no green space is within 0.3km of the midpoint.
 * 2. Flags if the bearing between the two points crosses a known barrier pattern
 *    (large gap with no infrastructure).
 * This is a universal heuristic — in Manhattan it catches Hudson/East River crossings,
 * in other cities it catches large gaps with no parks/paths (highways, industrial zones, etc).
 */
function hasLikelyWaterCrossing(
  p1: RoutePoint,
  p2: RoutePoint,
  greenSpaces: GreenSpace[]
): boolean {
  const dist = haversineDistance(p1, p2);
  if (dist <= 0.6) return false;

  // Check multiple sample points along the segment, not just the midpoint
  const numSamples = Math.max(2, Math.ceil(dist / 0.3));
  let uncoveredCount = 0;
  for (let s = 1; s < numSamples; s++) {
    const t = s / numSamples;
    const sample: RoutePoint = {
      lat: p1.lat + (p2.lat - p1.lat) * t,
      lng: p1.lng + (p2.lng - p1.lng) * t,
    };
    let covered = false;
    for (const gs of greenSpaces) {
      if (haversineDistance(sample, gs.point) <= 0.3) {
        covered = true;
        break;
      }
    }
    if (!covered) uncoveredCount++;
  }

  // If more than half the samples are uncovered, likely a barrier
  return uncoveredCount > numSamples / 2;
}

/**
 * Remove or replace waypoints that would cause water/barrier crossings.
 * For each bad waypoint, tries to find a replacement green space in the same
 * general direction from center that is itself accessible. If no safe
 * replacement exists, the waypoint is dropped entirely.
 */
function removeWaterCrossings(
  waypoints: RoutePoint[],
  greenSpaces: GreenSpace[],
  center: RoutePoint
): RoutePoint[] {
  if (waypoints.length < 3 || greenSpaces.length === 0) return waypoints;

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

    if (!replaced) {
      toRemove.add(i);
    }
  }

  return result.filter((_, i) => !toRemove.has(i));
}

/**
 * Check if a green space is reachable from center without crossing a major barrier.
 * Samples points every ~300m along the direct path and checks for green space
 * coverage. If there's a consecutive stretch of >600m with no nearby green space,
 * it's likely crossing water, a highway, or an industrial zone.
 */
function isAccessibleFromCenter(
  center: RoutePoint,
  target: RoutePoint,
  greenSpaces: GreenSpace[]
): boolean {
  const dist = haversineDistance(center, target);
  if (dist <= 0.5) return true; // Very close, always accessible

  const sampleSpacing = 0.3; // km between samples
  const numSamples = Math.max(3, Math.ceil(dist / sampleSpacing));
  const actualSpacing = dist / numSamples;
  let consecutiveGap = 0;

  for (let i = 1; i < numSamples; i++) {
    const t = i / numSamples;
    const sample: RoutePoint = {
      lat: center.lat + (target.lat - center.lat) * t,
      lng: center.lng + (target.lng - center.lng) * t,
    };

    let hasNearby = false;
    for (const gs of greenSpaces) {
      if (haversineDistance(sample, gs.point) <= 0.5) {
        hasNearby = true;
        break;
      }
    }

    if (!hasNearby) {
      consecutiveGap += actualSpacing;
      if (consecutiveGap >= 0.7) return false; // 0.7km+ dead zone = barrier
    } else {
      consecutiveGap = 0;
    }
  }

  return true;
}

/**
 * Check if a routed path (from OSRM) crosses a major barrier like a tunnel or bridge.
 * Samples the route at regular intervals and looks for stretches where the path
 * goes through areas with no green space coverage — indicating water, highways, etc.
 * This catches cases where OSRM routes through tunnels that pre-OSRM waypoint
 * checks wouldn't detect.
 */
function hasRoutedBarrierCrossing(
  routePoints: RoutePoint[],
  greenSpaces: GreenSpace[]
): boolean {
  if (routePoints.length < 20 || greenSpaces.length === 0) return false;

  // Sample every N points to check coverage
  const sampleInterval = Math.max(1, Math.floor(routePoints.length / 40));
  let consecutiveUncovered = 0;
  let maxUncoveredDist = 0;
  let uncoveredDist = 0;

  for (let i = 0; i < routePoints.length; i += sampleInterval) {
    const p = routePoints[i];
    let covered = false;
    for (const gs of greenSpaces) {
      if (haversineDistance(p, gs.point) <= 0.4) {
        covered = true;
        break;
      }
    }

    if (!covered) {
      consecutiveUncovered++;
      if (i >= sampleInterval) {
        uncoveredDist += haversineDistance(routePoints[i - sampleInterval], p);
      }
      if (uncoveredDist > maxUncoveredDist) {
        maxUncoveredDist = uncoveredDist;
      }
    } else {
      consecutiveUncovered = 0;
      uncoveredDist = 0;
    }

    // If there's a 1km+ stretch with no green space coverage, likely a barrier
    if (maxUncoveredDist >= 1.0) return true;
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
  if (gs.areaSize > 0) {
    const areaBonus = Math.min(gs.areaSize * 50, 10); // cap at 10
    score += strategy === 'large-parks' ? areaBonus * 2 : areaBonus;
    if (strict) score += areaBonus; // doubled in strict mode
  }

  // Kind bonuses
  if (gs.kind === 'park' || gs.kind === 'nature') score += 3;
  if (gs.kind === 'route') score += strategy === 'named-paths' ? 5 : 2;
  // Bike lanes and footways are ideal running surfaces — boost them
  if (gs.kind === 'cycleway') score += 4;
  if (gs.kind === 'footway' || gs.kind === 'path') score += 3;

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
function selectGreenSpaceWaypoints(
  center: RoutePoint,
  greenSpaces: GreenSpace[],
  targetDistanceKm: number,
  strict: boolean,
  variant: number,
  strategy: CandidateStrategy
): { waypoints: RoutePoint[]; anchors: GreenSpace[] } | null {
  // Max distance from center: a runner doing an N km loop can reasonably
  // reach N*0.55 km from start. Use whichever is larger between the geometric
  // radius and the distance-based limit so major parks (whose Overpass center
  // may be far from their nearest edge) are reachable.
  const loopRadius = targetDistanceKm / (2 * Math.PI * ROUTING_OVERHEAD);
  const maxRadius = Math.max(loopRadius * 4.0, targetDistanceKm * 0.55);

  // Annotate each green space with bearing and distance from center
  // Only use parks, gardens, and nature reserves as loop waypoints —
  // bike lanes and footways should influence scoring, not force OSRM detours
  const parkKinds = new Set(['park', 'garden', 'nature']);
  const annotated = greenSpaces
    .filter((gs) => parkKinds.has(gs.kind) || (gs.kind === 'route' && gs.name))
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

/** Retry wrapper for fetch */
async function fetchWithRetry(url: string, retries = 2): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return res;
      if (i < retries) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    } catch (err) {
      if (i === retries) throw err;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
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
 * Call OSRM to get a walking route through the given waypoints.
 */
async function fetchOSRMRoute(waypoints: RoutePoint[]): Promise<OSRMRoute | null> {
  const coords = coordsString(waypoints);
  const url = `${OSRM_BASE}/${coords}?overview=full&geometries=geojson&steps=false`;

  try {
    const res = await fetchWithRetry(url);
    if (!res.ok) return null;
    const data: OSRMResponse = await res.json();

    if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
      return null;
    }

    return data.routes[0];
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
  // Step 1: Always fetch enriched green spaces (shared across all candidates)
  const radiusKm = calculateSearchRadius(routeType, distanceKm, center, end);
  const greenSpaces = await fetchGreenSpacesEnriched(center, radiusKm);

  // Step 2: Generate candidate waypoint sets with diversity
  // Each candidate excludes parks used by previous candidates so routes
  // go through genuinely different areas (e.g., route 1 via Central Park,
  // route 2 via a different park, route 3 via yet another).
  const timeSeed = Date.now() % 100000;
  const candidates: { variant: number; waypoints: RoutePoint[]; anchors: GreenSpace[] }[] = [];
  const usedParkPoints: RoutePoint[] = []; // Parks already used by earlier candidates

  for (let i = 0; i < CANDIDATE_COUNT; i++) {
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

    candidates.push({ variant, waypoints, anchors });
  }

  // Step 3: Fetch OSRM routes for all candidates
  const osrmResults = await Promise.all(
    candidates.map((c) => fetchOSRMRoute(c.waypoints))
  );

  // Build resolved candidates
  const resolved: ResolvedCandidate[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const osrmRoute = osrmResults[i];
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
      // Check the routed path for long straight segments (tunnels/bridges)
      // Sample the route every ~50 points and look for segments where
      // consecutive route points are very far apart relative to their
      // count, indicating the route passes through a tunnel or over a bridge
      if (routeType !== 'point-to-point' && hasRoutedBarrierCrossing(points, greenSpaces)) {
        console.log(`[RouteScoring] Rejecting candidate ${i}: route crosses a likely barrier (tunnel/bridge)`);
        continue;
      }
      resolved.push({ index: i, variant: candidates[i].variant, points, distKm, estimatedTime, fromOSRM: true, anchors: candidates[i].anchors });
    } else {
      const wp = candidates[i].waypoints;
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

    const fallbackOSRM = await fetchOSRMRoute(fallbackWaypoints);
    if (fallbackOSRM) {
      const points = fallbackOSRM.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
      resolved.push({
        index: 0,
        variant: 0,
        points,
        distKm: fallbackOSRM.distance / 1000,
        estimatedTime: Math.round(fallbackOSRM.duration / 60),
        fromOSRM: true,
        anchors: [],
      });
    } else {
      // Use raw waypoints as last resort
      let totalDist = 0;
      for (let j = 1; j < fallbackWaypoints.length; j++) {
        totalDist += haversineDistance(fallbackWaypoints[j - 1], fallbackWaypoints[j]);
      }
      resolved.push({
        index: 0,
        variant: 0,
        points: fallbackWaypoints,
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
    // Use a neutral quiet score (0.5) to avoid extra network calls
    const quietScore = 0.5;
    const score = scoreRoute(
      { distanceKm: candidate.distKm, targetDistanceKm: distanceKm },
      prefs,
      quietScore,
      greenProximity,
      runPathProximity
    );

    console.log(
      `[RouteScoring] Candidate ${candidate.index}: dist=${candidate.distKm.toFixed(2)}km, ` +
      `green=${greenProximity.toFixed(2)}, ` +
      `runPath=${runPathProximity.toFixed(2)}, score=${score.toFixed(3)}`
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
