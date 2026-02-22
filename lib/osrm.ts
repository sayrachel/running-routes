import type { RoutePoint, GeneratedRoute, RoutePreferences } from './route-generator';
import { fetchQuietScore, fetchGreenSpacesEnriched } from './overpass';
import type { GreenSpace } from './overpass';
import { scoreRoute, computeGreenSpaceProximity } from './route-scoring';

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/foot';
const CANDIDATE_COUNT = 3;

/**
 * Road routing overhead factor.
 * Roads are typically 1.3–1.5x longer than straight-line distance due to
 * the road network geometry (grid patterns, curves, one-way streets, etc).
 * We use this factor to shrink the geometric radius so the OSRM-routed
 * result ends up closer to the user's target distance.
 */
const ROUTING_OVERHEAD = 1.35;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Haversine distance in km between two points */
function haversineDistance(p1: RoutePoint, p2: RoutePoint): number {
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
function destinationPoint(origin: RoutePoint, bearingDeg: number, distanceKm: number): RoutePoint {
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
function bearingFrom(p1: RoutePoint, p2: RoutePoint): number {
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
function angleDiff(a: number, b: number): number {
  let diff = Math.abs(a - b) % 360;
  if (diff > 180) diff = 360 - diff;
  return diff;
}

/**
 * Detect if two consecutive waypoints likely cross water or a major barrier.
 * Flags if they are >0.8km apart AND no green space is within 0.3km of the midpoint.
 * This is a universal heuristic — in Manhattan it catches Hudson/East River crossings,
 * in other cities it catches large gaps with no parks/paths (highways, industrial zones, etc).
 */
function hasLikelyWaterCrossing(
  p1: RoutePoint,
  p2: RoutePoint,
  greenSpaces: GreenSpace[]
): boolean {
  const dist = haversineDistance(p1, p2);
  if (dist <= 0.8) return false;

  const mid: RoutePoint = {
    lat: (p1.lat + p2.lat) / 2,
    lng: (p1.lng + p2.lng) / 2,
  };

  for (const gs of greenSpaces) {
    if (haversineDistance(mid, gs.point) <= 0.3) return false;
  }
  return true;
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
      if (consecutiveGap >= 1.0) return false; // 1km+ dead zone = barrier
    } else {
      consecutiveGap = 0;
    }
  }

  return true;
}

/**
 * Build OSRM coordinate string from waypoints.
 * OSRM expects: lng,lat;lng,lat;...
 */
function coordsString(points: RoutePoint[]): string {
  return points.map((p) => `${p.lng},${p.lat}`).join(';');
}

/**
 * Calculate the search radius for green space queries based on route type.
 * Clamped to [1.5, 10] km.
 */
function calculateSearchRadius(
  routeType: 'loop' | 'out-and-back' | 'point-to-point',
  distanceKm: number,
  center: RoutePoint,
  end?: RoutePoint | null
): number {
  let radius: number;
  if (routeType === 'loop') {
    radius = distanceKm * 0.8;
  } else if (routeType === 'out-and-back') {
    radius = distanceKm * 0.6;
  } else if (end) {
    radius = haversineDistance(center, end) * 0.6;
  } else {
    radius = distanceKm * 0.6;
  }
  return Math.min(Math.max(radius, 1.5), 12);
}

// ---------------------------------------------------------------------------
// Green-space-first waypoint selection
// ---------------------------------------------------------------------------

type CandidateStrategy = 'large-parks' | 'named-paths' | 'balanced';

/**
 * Score a green space for waypoint selection.
 * Strategy controls weighting:
 * - 'large-parks': heavy bonus for areaSize
 * - 'named-paths': heavy bonus for named paths/routes
 * - 'balanced': even spread
 */
function scoreGreenSpace(
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
  // Max distance from center: use loop geometry (circumference-based radius × 2)
  // This prevents waypoints from reaching into disparate regions
  const loopRadius = targetDistanceKm / (2 * Math.PI * ROUTING_OVERHEAD);
  const maxRadius = loopRadius * 3.0;

  // Annotate each green space with bearing and distance from center
  const annotated = greenSpaces.map((gs) => {
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

  if (annotated.length < 3) return null;

  const numSectors = 5 + (variant % 2);
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

  // In relaxed mode, cap at 4 green-space waypoints max
  const maxGreenWaypoints = strict ? picks.length : Math.min(picks.length, 4);
  const selectedPicks = picks
    .sort((a, b) => b.dist - a.dist) // drop farthest first if over cap
    .slice(picks.length - maxGreenWaypoints);

  // Order by bearing to form a loop
  selectedPicks.sort((a, b) => a.bearing - b.bearing);

  // Remove waypoints too close to center (< 300m) — prevents tiny blocks near start/end
  for (let i = selectedPicks.length - 1; i >= 0; i--) {
    if (selectedPicks[i].dist < 0.3) {
      selectedPicks.splice(i, 1);
    }
  }

  // Remove consecutive waypoints that are too close (< 400m) — prevents square-block routing
  for (let i = selectedPicks.length - 1; i > 0; i--) {
    if (haversineDistance(selectedPicks[i].gs.point, selectedPicks[i - 1].gs.point) < 0.4) {
      // Keep the one with larger area (more likely a significant park)
      if (selectedPicks[i].gs.areaSize >= selectedPicks[i - 1].gs.areaSize) {
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

  // Estimate circuit distance and adjust (up to 3 iterations)
  for (let iter = 0; iter < 3; iter++) {
    const loopDist = estimateCircuitDistance(waypoints);
    const ratio = loopDist / targetDistanceKm;

    if (ratio > 1.3 && waypoints.length > 4) {
      // Too long — drop the farthest waypoint from center (not start/end)
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
    } else if (ratio < 0.7) {
      // Too short — add a geometric fill point in an underserved direction
      // Only use directions that don't cross barriers
      const usedBearings = waypoints.slice(1, -1).map((wp) => bearingFrom(center, wp));
      let bestGap = 0;
      let bestBearing = 0;
      for (let b = 0; b < 360; b += 30) {
        const minDiff = usedBearings.reduce((min, ub) => Math.min(min, angleDiff(b, ub)), 360);
        if (minDiff > bestGap) {
          bestGap = minDiff;
          bestBearing = b;
        }
      }
      const fillRadius = (targetDistanceKm / (2 * Math.PI * ROUTING_OVERHEAD)) * 0.9;
      const fillPoint = destinationPoint(center, bestBearing, fillRadius);
      // Only add if the fill point is accessible (no barrier crossing)
      if (!isAccessibleFromCenter(center, fillPoint, greenSpaces)) continue;
      // Insert in bearing order
      const insertBearing = bestBearing;
      let insertIdx = 1;
      for (let i = 1; i < waypoints.length - 1; i++) {
        if (bearingFrom(center, waypoints[i]) < insertBearing) insertIdx = i + 1;
      }
      waypoints.splice(insertIdx, 0, fillPoint);
    } else {
      break; // Distance is acceptable
    }
  }

  return { waypoints, anchors };
}

/** Estimate routed circuit distance from waypoints using haversine sum × overhead */
function estimateCircuitDistance(waypoints: RoutePoint[]): number {
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
  const corridorWidth = totalDist * 0.3; // km either side of the line

  // Filter green spaces near the start→end line
  const nearLine = greenSpaces
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
    .filter((a) => a.perpDist <= corridorWidth && a.t > 0.1 && a.t < 0.9)
    .sort((a, b) => a.t - b.t);

  if (nearLine.length < 2) {
    // Fallback to geometric
    const fallbackWaypoints = generatePointToPointWaypoints(
      start, end, prefs, variant, greenSpaces.map((gs) => gs.point)
    );
    return { waypoints: fallbackWaypoints, anchors: [] };
  }

  // Pick 2–3 intermediate waypoints evenly spaced along the line
  const numIntermediate = Math.min(3, nearLine.length);
  const selected: typeof nearLine = [];
  for (let i = 0; i < numIntermediate; i++) {
    const targetT = (i + 1) / (numIntermediate + 1);
    let best = nearLine[0];
    let bestDelta = Infinity;
    for (const nl of nearLine) {
      if (selected.some((s) => s.gs === nl.gs)) continue;
      const delta = Math.abs(nl.t - targetT);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = nl;
      }
    }
    selected.push(best);
  }

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
 * Generate waypoints for a loop route (legacy geometric fallback).
 */
function generateLoopWaypoints(
  center: RoutePoint,
  distanceKm: number,
  prefs: RoutePreferences,
  variant: number,
  greenSpaces: RoutePoint[] = []
): RoutePoint[] {
  const baseRadius = distanceKm / (2 * Math.PI * ROUTING_OVERHEAD);
  const numWaypoints = 5 + (variant % 2);
  const startBearing = variant * 73 + (prefs.lowTraffic ? 45 : 0);
  const waypoints: RoutePoint[] = [center];
  const maxSnapDistance = distanceKm * 0.25;

  for (let i = 0; i < numWaypoints; i++) {
    const angle = startBearing + (360 / numWaypoints) * i;
    let radiusFactor: number;
    radiusFactor = 0.9 + Math.sin(variant * 1000 + i * 2.4) * 0.15;
    const scenicMultiplier = 0.95;
    const bearingOffset = prefs.lowTraffic
      ? Math.sin(variant * 2000 + i * 3.7) * 20
      : Math.sin(variant * 2000 + i * 3.7) * 8;
    const radius = baseRadius * radiusFactor * scenicMultiplier;
    let point = destinationPoint(center, angle + bearingOffset, radius);
    point = selectWaypoint(point, greenSpaces, maxSnapDistance);
    waypoints.push(point);
  }

  waypoints.push(center);
  return waypoints;
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
function generatePointToPointWaypoints(
  start: RoutePoint,
  end: RoutePoint,
  prefs: RoutePreferences,
  variant: number,
  greenSpaces: RoutePoint[] = []
): RoutePoint[] {
  const numWaypoints = 2;
  const waypoints: RoutePoint[] = [start];
  const maxSnapDistance = haversineDistance(start, end) * 0.2;

  for (let i = 1; i <= numWaypoints; i++) {
    const t = i / (numWaypoints + 1);
    const baseLat = start.lat + (end.lat - start.lat) * t;
    const baseLng = start.lng + (end.lng - start.lng) * t;
    const dLat = end.lat - start.lat;
    const dLng = end.lng - start.lng;
    const perpLat = -dLng;
    const perpLng = dLat;
    const offsetScale = 0.05;
    const offset = Math.sin(variant * 7000 + i * 123.7) * offsetScale;
    let point: RoutePoint = {
      lat: baseLat + perpLat * offset,
      lng: baseLng + perpLng * offset,
    };
    point = selectWaypoint(point, greenSpaces, maxSnapDistance);
    waypoints.push(point);
  }

  waypoints.push(end);
  return waypoints;
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
function pickRouteName(
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
function fabricateElevationGain(distKm: number, variant: number): number {
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

  // Step 2: Generate candidate waypoint sets using green-space-first approach
  const timeSeed = Date.now() % 100000;
  const candidates: { variant: number; waypoints: RoutePoint[]; anchors: GreenSpace[] }[] = [];

  for (let i = 0; i < CANDIDATE_COUNT; i++) {
    const variant = timeSeed + i + 1;
    const strategy = STRATEGIES[i % STRATEGIES.length];
    let waypoints: RoutePoint[];
    let anchors: GreenSpace[] = [];

    if (routeType === 'point-to-point' && end) {
      const result = generateGreenSpacePointToPoint(center, end, prefs, variant, greenSpaces, strategy);
      waypoints = result.waypoints;
      anchors = result.anchors;
    } else if (routeType === 'out-and-back') {
      const result = generateGreenSpaceOutAndBack(center, distanceKm, prefs, variant, greenSpaces, strategy);
      waypoints = result.waypoints;
      anchors = result.anchors;
    } else {
      const result = generateGreenSpaceLoop(center, distanceKm, prefs, variant, greenSpaces, strategy);
      waypoints = result.waypoints;
      anchors = result.anchors;
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
      const points = osrmRoute.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
      const distKm = osrmRoute.distance / 1000;
      const estimatedTime = Math.round(osrmRoute.duration / 60);
      const distRatio = distanceKm > 0 ? distKm / distanceKm : 1;
      if (distRatio > 1.5 || distRatio < 0.4) {
        console.log(`[RouteScoring] Rejecting candidate ${i}: dist=${distKm.toFixed(2)}km (ratio=${distRatio.toFixed(2)}, target=${distanceKm.toFixed(2)}km)`);
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
      if (fallbackRatio > 1.5 || fallbackRatio < 0.4) {
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

  // Step 4: Fetch preference data and green proximity in parallel
  const preferenceData = await Promise.all(
    resolved.map(async (candidate) => {
      const [quietScore, greenProximity] = await Promise.all([
        prefs.lowTraffic ? fetchQuietScore(candidate.points) : Promise.resolve(0.5),
        Promise.resolve(computeGreenSpaceProximity(candidate.points, greenSpaces)),
      ]);
      return { quietScore, greenProximity };
    })
  );

  // Step 5: Score each candidate
  const scored = resolved.map((candidate, i) => {
    const { quietScore, greenProximity } = preferenceData[i];
    const score = scoreRoute(
      { distanceKm: candidate.distKm, targetDistanceKm: distanceKm },
      prefs,
      quietScore,
      greenProximity
    );

    console.log(
      `[RouteScoring] Candidate ${i}: dist=${candidate.distKm.toFixed(2)}km, ` +
      `quiet=${quietScore.toFixed(2)}, green=${greenProximity.toFixed(2)}, score=${score.toFixed(3)}`
    );

    return { candidate, score, quietScore };
  });

  // Step 6: Sort by score (highest first) and take the top `count`
  scored.sort((a, b) => b.score - a.score);
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
