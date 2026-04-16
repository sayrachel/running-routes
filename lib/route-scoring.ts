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
  const waterfrontFeatures = greenSpaces.filter((gs) => gs.kind === 'waterfront');
  if (routePoints.length === 0 || waterfrontFeatures.length === 0) return 0;

  const step = Math.max(1, Math.floor(routePoints.length / Math.ceil(routePoints.length / 20)));
  let nearCount = 0;
  let sampleCount = 0;

  for (let i = 0; i < routePoints.length; i += step) {
    sampleCount++;
    const rp = routePoints[i];
    for (const wf of waterfrontFeatures) {
      if (haversineDistance(rp, wf.point) <= proximityKm) {
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
  // Filter to only bike lanes, footways, paths, designated routes, and waterfront paths
  const runPaths = greenSpaces.filter(
    (gs) => gs.kind === 'cycleway' || gs.kind === 'footway' || gs.kind === 'path' || gs.kind === 'route' || gs.kind === 'waterfront'
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
  if (routePoints.length === 0 || highwayPoints.length === 0) return 0;

  const step = Math.max(1, Math.floor(routePoints.length / Math.ceil(routePoints.length / 20)));
  let nearCount = 0;
  let sampleCount = 0;

  for (let i = 0; i < routePoints.length; i += step) {
    sampleCount++;
    const rp = routePoints[i];
    for (const hp of highwayPoints) {
      if (haversineDistance(rp, hp) <= proximityKm) {
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
