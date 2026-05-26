import type { RoutePoint } from './route-generator';

/** Ramer-Douglas-Peucker polyline simplifier.
 *
 *  Removes intermediate vertices whose perpendicular distance from the line
 *  segment connecting their neighbors is below `toleranceM`. The endpoints
 *  are always preserved. The shape of the polyline is preserved within
 *  ±toleranceM at every point.
 *
 *  Used for the live GPS track only — distance integration in
 *  useLocationTracking continues to run on the raw smoothed series, so the
 *  total-distance number isn't affected by display simplification.
 */
export function simplifyRDP(points: RoutePoint[], toleranceM: number): RoutePoint[] {
  if (points.length <= 2) return points.slice();
  const tolDeg = metersToDegrees(toleranceM, points[0].lat);

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDistSq = 0;
    let maxIdx = -1;
    const a = points[start];
    const b = points[end];
    for (let i = start + 1; i < end; i++) {
      const dSq = perpendicularDistanceSq(points[i], a, b);
      if (dSq > maxDistSq) {
        maxDistSq = dSq;
        maxIdx = i;
      }
    }
    if (maxIdx >= 0 && maxDistSq > tolDeg * tolDeg) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx]);
      stack.push([maxIdx, end]);
    }
  }

  const out: RoutePoint[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) out.push(points[i]);
  }
  return out;
}

/** Convert a meter tolerance to a comparable degree tolerance at the given
 *  latitude. Used to keep the perpendicular-distance comparison in degree
 *  space (no per-point trig) while expressing the threshold in meters. */
function metersToDegrees(meters: number, lat: number): number {
  const metersPerDegLat = 111320;
  const metersPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
  const metersPerDegAvg = (metersPerDegLat + Math.max(metersPerDegLng, 1)) / 2;
  return meters / metersPerDegAvg;
}

/** Squared perpendicular distance from `p` to the segment ab, in degree
 *  units. Squared to avoid a sqrt in the hot inner loop. Lat/lng are
 *  treated as 2D Cartesian — the small projection error over a single
 *  GPS run (a few km at most) is well below the 5-10m tolerance we use. */
function perpendicularDistanceSq(p: RoutePoint, a: RoutePoint, b: RoutePoint): number {
  const dx = b.lng - a.lng;
  const dy = b.lat - a.lat;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = p.lng - a.lng;
    const ey = p.lat - a.lat;
    return ex * ex + ey * ey;
  }
  let t = ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const projLng = a.lng + t * dx;
  const projLat = a.lat + t * dy;
  const ex = p.lng - projLng;
  const ey = p.lat - projLat;
  return ex * ex + ey * ey;
}
