import type { RoutePreferences } from './route-generator';
import type { RoutePoint } from './route-generator';
import type { GreenSpace } from './overpass';

interface ScoringCandidate {
  distanceKm: number;
  targetDistanceKm: number;
}

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

// ---------------------------------------------------------------------------
// Spatial grid: bucket candidate points into cells sized to the proximity
// threshold so each query only checks a 3×3 neighborhood instead of the full
// list. Lng cell width is widened by 1/cos(lat) so a 3×3 lookup is guaranteed
// to cover everything within `proximityKm`, no matter the latitude.
// ---------------------------------------------------------------------------

interface SpatialGrid {
  cellLatDeg: number;
  cellLngDeg: number;
  cells: Map<number, RoutePoint[]>;
}

const KM_PER_DEG_LAT = 111;

function buildGrid(points: RoutePoint[], proximityKm: number): SpatialGrid | null {
  if (points.length === 0) return null;
  const cellLatDeg = proximityKm / KM_PER_DEG_LAT;
  // Widen lng cells by 1/cos(lat) so cell width in km ≥ proximityKm everywhere.
  // Use the centroid lat as the reference; the grid only needs to be conservative.
  let latSum = 0;
  for (const p of points) latSum += p.lat;
  const refLat = latSum / points.length;
  const cosLat = Math.max(0.01, Math.cos((refLat * Math.PI) / 180));
  const cellLngDeg = proximityKm / (KM_PER_DEG_LAT * cosLat);

  const cells = new Map<number, RoutePoint[]>();
  for (const p of points) {
    const key = cellKey(p.lat, p.lng, cellLatDeg, cellLngDeg);
    const bucket = cells.get(key);
    if (bucket) bucket.push(p);
    else cells.set(key, [p]);
  }
  return { cellLatDeg, cellLngDeg, cells };
}

// Pack two signed cell indices into one number key. Each fits in 21 bits
// (covers ±1M cells; at proximityKm=0.1 that's ±100,000 km — plenty).
function cellKey(lat: number, lng: number, cellLatDeg: number, cellLngDeg: number): number {
  const cy = Math.floor(lat / cellLatDeg);
  const cx = Math.floor(lng / cellLngDeg);
  return ((cy + (1 << 20)) << 21) | (cx + (1 << 20));
}

function hasPointWithin(grid: SpatialGrid | null, p: RoutePoint, proximityKm: number): boolean {
  if (!grid) return false;
  const cy = Math.floor(p.lat / grid.cellLatDeg);
  const cx = Math.floor(p.lng / grid.cellLngDeg);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const yi = cy + dy + (1 << 20);
      const xi = cx + dx + (1 << 20);
      const bucket = grid.cells.get((yi << 21) | xi);
      if (!bucket) continue;
      for (const q of bucket) {
        if (haversineDistance(p, q) <= proximityKm) return true;
      }
    }
  }
  return false;
}

/** Indices of route points to sample. Aims for ~50 samples — sparser misses
 *  brief park visits entirely (a 5km route passing through a 200m-wide park
 *  spends ~4% of its length there; with only 10 samples there's <40% chance
 *  any sample lands inside). 50 samples bring coverage close to 90%. */
function sampleIndices(n: number): number[] {
  if (n === 0) return [];
  const step = Math.max(1, Math.floor(n / 50));
  const out: number[] = [];
  for (let i = 0; i < n; i += step) out.push(i);
  return out;
}

/** Shared proximity computation: fraction of sampled route points within `proximityKm` of any candidate. */
function proximityFraction(
  routePoints: RoutePoint[],
  candidatePoints: RoutePoint[],
  proximityKm: number
): number {
  if (routePoints.length === 0 || candidatePoints.length === 0) return 0;
  const grid = buildGrid(candidatePoints, proximityKm);
  const samples = sampleIndices(routePoints.length);
  if (samples.length === 0) return 0;
  let nearCount = 0;
  for (const i of samples) {
    if (hasPointWithin(grid, routePoints[i], proximityKm)) nearCount++;
  }
  return nearCount / samples.length;
}

/**
 * Compute what fraction of route points are within proximity of a green space.
 * Samples every ~20th point to avoid expensive computation on dense routes.
 *
 * @param routePoints - The full route polyline
 * @param greenSpaces - Enriched green spaces near the route
 * @param proximityKm - Distance threshold in km (default 0.2 = 200m)
 * @returns Score between 0 and 1 (fraction of sampled points near a green space)
 */
export function computeGreenSpaceProximity(
  routePoints: RoutePoint[],
  greenSpaces: GreenSpace[],
  proximityKm: number = 0.2
): number {
  return proximityFraction(routePoints, greenSpaces.map((gs) => gs.point), proximityKm);
}

/**
 * Compute what fraction of route points are near waterfront features
 * (coastlines, riverbanks, promenades, boardwalks). Waterfront paths
 * are among the most popular running corridors in any city.
 *
 * @param routePoints - The full route polyline
 * @param greenSpaces - Enriched green spaces (includes waterfront features)
 * @param proximityKm - Distance threshold in km (default 0.3 = 300m, wider since water features are area-based)
 * @returns Score between 0 and 1 (fraction of sampled points near waterfront)
 */
export function computeWaterfrontProximity(
  routePoints: RoutePoint[],
  greenSpaces: GreenSpace[],
  proximityKm: number = 0.3
): number {
  const waterfront: RoutePoint[] = [];
  for (const gs of greenSpaces) if (gs.kind === 'waterfront') waterfront.push(gs.point);
  return proximityFraction(routePoints, waterfront, proximityKm);
}

/**
 * Compute what fraction of route points are near bike lanes, cycleways,
 * footways, or other car-free paths. These are ideal running surfaces.
 *
 * @param routePoints - The full route polyline
 * @param greenSpaces - Enriched green spaces (includes cycleways/footways/paths)
 * @param proximityKm - Distance threshold in km (default 0.15 = 150m)
 * @returns Score between 0 and 1 (fraction of sampled points near a run-friendly path)
 */
export function computeRunPathProximity(
  routePoints: RoutePoint[],
  greenSpaces: GreenSpace[],
  proximityKm: number = 0.15
): number {
  const runPaths: RoutePoint[] = [];
  for (const gs of greenSpaces) {
    if (
      gs.kind === 'cycleway' ||
      gs.kind === 'footway' ||
      gs.kind === 'path' ||
      gs.kind === 'route' ||
      gs.kind === 'waterfront'
    ) {
      runPaths.push(gs.point);
    }
  }
  return proximityFraction(routePoints, runPaths, proximityKm);
}

/**
 * Compute what fraction of route points are dangerously close to major highways
 * (motorways, trunk roads, primary roads). Routes with high highway proximity
 * are unsafe for runners and should be rejected.
 *
 * @param routePoints - The full route polyline
 * @param highwayPoints - Center points of major highway segments near the route
 * @param proximityKm - Distance threshold in km (default 0.1 = 100m)
 * @returns Score between 0 and 1 (fraction of sampled points near a highway)
 */
export function computeHighwayProximity(
  routePoints: RoutePoint[],
  highwayPoints: RoutePoint[],
  proximityKm: number = 0.1
): number {
  return proximityFraction(routePoints, highwayPoints, proximityKm);
}

/**
 * Score a route candidate (0–1) based on user preferences and real API data.
 *
 * Scoring weights:
 * - Avoid Traffic OFF (relaxed): 50% distance, 15% green, 20% run-path, 15% waterfront
 * - Avoid Traffic ON (strict): 25% distance, 15% quiet, 20% green, 20% run-path, 20% waterfront
 *
 * @returns score between 0 and 1 (higher is better)
 */
export function scoreRoute(
  candidate: ScoringCandidate,
  prefs: RoutePreferences,
  quietScore: number,
  greenSpaceProximity: number = 0.5,
  runPathProximity: number = 0.5,
  waterfrontProximity: number = 0
): number {
  // Distance accuracy score (same for both modes)
  const distRatio = candidate.targetDistanceKm > 0
    ? candidate.distanceKm / candidate.targetDistanceKm
    : 1;
  const distScore = Math.max(1.0 - Math.abs(1.0 - distRatio) * 4, 0);

  if (prefs.lowTraffic) {
    // Strict mode: 25% distance, 15% quiet, 20% green, 20% run-path, 20% waterfront
    return 0.25 * distScore + 0.15 * quietScore + 0.20 * greenSpaceProximity + 0.20 * runPathProximity + 0.20 * waterfrontProximity;
  } else {
    // Relaxed mode: 50% distance, 15% green, 20% run-path, 15% waterfront
    return 0.50 * distScore + 0.15 * greenSpaceProximity + 0.20 * runPathProximity + 0.15 * waterfrontProximity;
  }
}
