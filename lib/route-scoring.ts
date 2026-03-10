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
  if (routePoints.length === 0 || greenSpaces.length === 0) return 0;

  // Sample every ~20th point
  const step = Math.max(1, Math.floor(routePoints.length / Math.ceil(routePoints.length / 20)));
  let nearCount = 0;
  let sampleCount = 0;

  for (let i = 0; i < routePoints.length; i += step) {
    sampleCount++;
    const rp = routePoints[i];
    for (const gs of greenSpaces) {
      if (haversineDistance(rp, gs.point) <= proximityKm) {
        nearCount++;
        break;
      }
    }
  }

  return sampleCount > 0 ? nearCount / sampleCount : 0;
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
  // Filter to only bike lanes, footways, paths, and designated routes
  const runPaths = greenSpaces.filter(
    (gs) => gs.kind === 'cycleway' || gs.kind === 'footway' || gs.kind === 'path' || gs.kind === 'route'
  );
  if (routePoints.length === 0 || runPaths.length === 0) return 0;

  const step = Math.max(1, Math.floor(routePoints.length / Math.ceil(routePoints.length / 20)));
  let nearCount = 0;
  let sampleCount = 0;

  for (let i = 0; i < routePoints.length; i += step) {
    sampleCount++;
    const rp = routePoints[i];
    for (const rp2 of runPaths) {
      if (haversineDistance(rp, rp2.point) <= proximityKm) {
        nearCount++;
        break;
      }
    }
  }

  return sampleCount > 0 ? nearCount / sampleCount : 0;
}

/**
 * Score a route candidate (0–1) based on user preferences and real API data.
 *
 * Scoring weights:
 * - Avoid Traffic OFF (relaxed): 60% distance, 15% green proximity, 25% run-path proximity
 * - Avoid Traffic ON (strict): 30% distance, 20% quiet, 25% green proximity, 25% run-path proximity
 *
 * @returns score between 0 and 1 (higher is better)
 */
export function scoreRoute(
  candidate: ScoringCandidate,
  prefs: RoutePreferences,
  quietScore: number,
  greenSpaceProximity: number = 0.5,
  runPathProximity: number = 0.5
): number {
  // Distance accuracy score (same for both modes)
  const distRatio = candidate.targetDistanceKm > 0
    ? candidate.distanceKm / candidate.targetDistanceKm
    : 1;
  const distScore = Math.max(1.0 - Math.abs(1.0 - distRatio) * 4, 0);

  if (prefs.lowTraffic) {
    // Strict mode: 30% distance, 20% quiet, 25% green, 25% run-path
    return 0.30 * distScore + 0.20 * quietScore + 0.25 * greenSpaceProximity + 0.25 * runPathProximity;
  } else {
    // Relaxed mode: 60% distance, 15% green, 25% run-path
    return 0.60 * distScore + 0.15 * greenSpaceProximity + 0.25 * runPathProximity;
  }
}
