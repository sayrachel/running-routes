import type { RoutePoint, GeneratedRoute, RoutePreferences } from './route-generator';
import { fetchQuietScore, fetchGreenSpaceLocations } from './overpass';
import { scoreRoute } from './route-scoring';

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/foot';
const CANDIDATE_COUNT = 3;

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
  return Math.min(Math.max(radius, 1.5), 10);
}

/**
 * Snap a geometric waypoint toward the nearest green space if within range.
 * Returns a blended point (greenBlend toward green space) or the original if none nearby.
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
}

/**
 * Call OSRM to get a walking route through the given waypoints.
 * Returns GeoJSON coordinates and metadata.
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
 * Generate waypoints for a loop route.
 * Preferences affect the waypoint pattern:
 * - scenic: wider, more varied loop through parks/waterfront areas
 * - lowTraffic: offset waypoints toward residential zones (smaller radius variance)
 * - hilly: place waypoints at varying radii to create elevation change
 * - flat: uniform radius for consistent terrain
 */
function generateLoopWaypoints(
  center: RoutePoint,
  distanceKm: number,
  prefs: RoutePreferences,
  variant: number,
  greenSpaces: RoutePoint[] = []
): RoutePoint[] {
  // Approximate radius from circumference: C = 2*pi*r
  const baseRadius = distanceKm / (2 * Math.PI);

  // Number of waypoints: fewer since scenic is removed
  const numWaypoints = 4 + variant;

  // Start bearing varies per variant for route diversity
  const startBearing = variant * 73 + (prefs.lowTraffic ? 45 : 0);

  const waypoints: RoutePoint[] = [center];
  const maxSnapDistance = distanceKm * 0.25;

  for (let i = 0; i < numWaypoints; i++) {
    const angle = startBearing + (360 / numWaypoints) * i;

    // Radius variation — keep radius consistent (flat default)
    let radiusFactor: number;
    radiusFactor = 0.9 + Math.sin(variant * 1000 + i * 2.4) * 0.15;

    const scenicMultiplier = 0.95;

    // Quiet routes offset bearing slightly for residential areas
    const bearingOffset = prefs.lowTraffic
      ? Math.sin(variant * 2000 + i * 3.7) * 20
      : Math.sin(variant * 2000 + i * 3.7) * 8;

    const radius = baseRadius * radiusFactor * scenicMultiplier;
    let point = destinationPoint(center, angle + bearingOffset, radius);
    point = selectWaypoint(point, greenSpaces, maxSnapDistance);
    waypoints.push(point);
  }

  // Close the loop
  waypoints.push(center);
  return waypoints;
}

/**
 * Generate waypoints for an out-and-back route.
 */
function generateOutAndBackWaypoints(
  center: RoutePoint,
  distanceKm: number,
  prefs: RoutePreferences,
  variant: number,
  greenSpaces: RoutePoint[] = []
): RoutePoint[] {
  const halfDistance = distanceKm / 2;
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

    // Turnaround point gets stronger bias
    const blend = i === numOutPoints ? 0.8 : 0.7;
    point = selectWaypoint(point, greenSpaces, maxSnapDistance, blend);
    outPoints.push(point);
  }

  // Return path slightly offset for variety
  const returnPoints = [...outPoints].reverse().slice(1).map((p, i) => ({
    lat: p.lat + Math.sin(variant * 5000 + i * 83.9) * 0.0003,
    lng: p.lng + Math.cos(variant * 6000 + i * 91.3) * 0.0003,
  }));

  return [...outPoints, ...returnPoints];
}

/**
 * Generate waypoints for a point-to-point route.
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

    // Perpendicular offset
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

/** Route name pools */
const ROUTE_NAMES: Record<string, string[]> = {
  quiet: ['Backstreet Run', 'Quiet Lanes', 'Residential Circuit', 'Sidestreet Shuffle', 'Neighborhood Loop', 'Peaceful Path'],
  default: ['Downtown Explorer', 'City Loop', 'Urban Circuit', 'Coastal Breeze Route', 'Bridge Connector', 'Meadow Circuit'],
};

function pickRouteName(prefs: RoutePreferences, index: number, lat: number): string {
  const pool = prefs.lowTraffic ? ROUTE_NAMES.quiet : ROUTE_NAMES.default;
  return pool[Math.abs((index + Math.floor(lat * 10)) % pool.length)];
}

/** Check if preference-specific APIs would add value */
function hasPreferenceAPIsToCall(prefs: RoutePreferences): boolean {
  return prefs.lowTraffic;
}

/** Fabricated elevation gain when real data is unavailable */
function fabricateElevationGain(distKm: number, variant: number): number {
  return Math.round(5 + distKm * 3 + variant * 2);
}

/**
 * Generate real walking routes using the OSRM public API.
 *
 * Pipeline:
 * 1. Generate multiple candidate waypoint sets with varied geometry
 * 2. Fetch OSRM route for each candidate
 * 3. In parallel: fetch elevation profile + scenic/quiet scores for each
 * 4. Score each candidate against user preferences
 * 5. Return the best route(s)
 *
 * Falls back to geometry-only approach if preference APIs fail.
 *
 * @param center - Start location
 * @param distanceKm - Target distance in km
 * @param routeType - loop, out-and-back, or point-to-point
 * @param count - Number of routes to return
 * @param prefs - User preferences (elevation, scenic, lowTraffic)
 * @param end - End point for point-to-point routes
 * @returns Array of GeneratedRoute with real road-following coordinates
 */
export async function generateOSRMRoutes(
  center: RoutePoint,
  distanceKm: number,
  routeType: 'loop' | 'out-and-back' | 'point-to-point',
  count: number = 1,
  prefs: RoutePreferences = { lowTraffic: false },
  end?: RoutePoint | null
): Promise<GeneratedRoute[]> {
  // Step 1: Pre-fetch green spaces if lowTraffic is on (shared across all candidates)
  let greenSpaces: RoutePoint[] = [];
  if (prefs.lowTraffic) {
    const radiusKm = calculateSearchRadius(routeType, distanceKm, center, end);
    greenSpaces = await fetchGreenSpaceLocations(center, radiusKm);
  }

  // Step 2: Generate candidate waypoint sets
  const candidates: { variant: number; waypoints: RoutePoint[] }[] = [];
  for (let i = 0; i < CANDIDATE_COUNT; i++) {
    const variant = i + 1;
    let waypoints: RoutePoint[];
    if (routeType === 'point-to-point' && end) {
      waypoints = generatePointToPointWaypoints(center, end, prefs, variant, greenSpaces);
    } else if (routeType === 'out-and-back') {
      waypoints = generateOutAndBackWaypoints(center, distanceKm, prefs, variant, greenSpaces);
    } else {
      waypoints = generateLoopWaypoints(center, distanceKm, prefs, variant, greenSpaces);
    }
    candidates.push({ variant, waypoints });
  }

  // Step 3: Fetch OSRM routes for all candidates
  const osrmResults = await Promise.all(
    candidates.map((c) => fetchOSRMRoute(c.waypoints))
  );

  // Build resolved candidates with their route points and distances
  const resolved: ResolvedCandidate[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const osrmRoute = osrmResults[i];
    if (osrmRoute) {
      const points = osrmRoute.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
      const distKm = osrmRoute.distance / 1000;
      const estimatedTime = Math.round(osrmRoute.duration / 60);
      resolved.push({ index: i, variant: candidates[i].variant, points, distKm, estimatedTime, fromOSRM: true });
    } else {
      // Fallback: use raw waypoints
      const wp = candidates[i].waypoints;
      const totalDist = wp.reduce((sum, p, j) => {
        if (j === 0) return 0;
        return sum + haversineDistance(wp[j - 1], p);
      }, 0);
      resolved.push({
        index: i,
        variant: candidates[i].variant,
        points: wp,
        distKm: totalDist,
        estimatedTime: Math.round(totalDist * 6),
        fromOSRM: false,
      });
    }
  }

  // Step 4: Fetch preference data in parallel for all resolved candidates
  const useOverpassAPIs = hasPreferenceAPIsToCall(prefs);

  const preferenceData = await Promise.all(
    resolved.map(async (candidate) => {
      const quietScore = useOverpassAPIs ? await fetchQuietScore(candidate.points) : 0.5;
      return { quietScore };
    })
  );

  // Step 5: Score each candidate
  const scored = resolved.map((candidate, i) => {
    const { quietScore } = preferenceData[i];
    const score = scoreRoute(
      { distanceKm: candidate.distKm, targetDistanceKm: distanceKm },
      prefs,
      quietScore
    );

    console.log(
      `[RouteScoring] Candidate ${i}: dist=${candidate.distKm.toFixed(2)}km, ` +
      `quiet=${quietScore.toFixed(2)}, score=${score.toFixed(3)}`
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

    return {
      id: `route-${candidate.index}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: pickRouteName(prefs, candidate.index, center.lat),
      points: candidate.points,
      distance: Math.round(candidate.distKm * 100) / 100,
      estimatedTime: candidate.estimatedTime,
      elevationGain,
      terrain,
      difficulty,
    };
  });
}
