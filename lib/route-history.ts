import type { GeneratedRoute, RoutePoint } from './route-generator';

const MI_PER_KM = 0.621371;

function haversineMi(a: RoutePoint, b: RoutePoint): number {
  const R = 3958.8;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Find an in-session historical route that matches the user's current request.
 * Used as a silent fallback when generation produces no candidates so the user
 * gets a runnable route instead of "No routes found." Matching is intentionally
 * loose on start (within ~0.6 mi / 1 km) so a slightly drifted GPS fix still
 * matches the same neighborhood, but strict on rounded distance and route
 * style so we never silently swap a 4mi loop for a 6mi out-and-back.
 *
 * `targetDistanceUserUnits` is the user's requested distance in their current
 * units (mi or km); we convert internally to match the rounded-miles stored on
 * GeneratedRoute.distance.
 */
export function findMatchingHistoricalRoute(
  history: GeneratedRoute[],
  targetDistanceUserUnits: number,
  units: 'imperial' | 'metric',
  routeStyle: 'loop' | 'out-and-back' | 'point-to-point',
  start: RoutePoint,
  end: RoutePoint | null,
  excludeId: string | null,
): GeneratedRoute | null {
  const targetMiles = units === 'metric'
    ? Math.round(targetDistanceUserUnits * MI_PER_KM)
    : Math.round(targetDistanceUserUnits);
  const MAX_DELTA_MI = 0.6;
  for (const r of history) {
    if (r.id === excludeId) continue;
    if (r.distance !== targetMiles) continue;
    if (r.routeStyle && r.routeStyle !== routeStyle) continue;
    if (r.points.length === 0) continue;
    const rStart = r.points[0];
    if (haversineMi(rStart, start) > MAX_DELTA_MI) continue;
    if (routeStyle === 'point-to-point' && end) {
      const rEnd = r.points[r.points.length - 1];
      if (haversineMi(rEnd, end) > MAX_DELTA_MI) continue;
    }
    return r;
  }
  return null;
}
