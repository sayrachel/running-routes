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

// ---------------------------------------------------------------------------
// Topology metrics: catch "barbell" routes (multiple disjoint lobes joined
// at start) and routes with chronic U-turns. Distinct from countStubs
// (short dead-end juts) and retraceRatio (same-segment back-and-forth) —
// these target route SHAPE: how many lobes, how many sharp reversals.
// ---------------------------------------------------------------------------

/** Initial bearing from p1 → p2 in degrees [0, 360). */
function bearingFrom(p1: RoutePoint, p2: RoutePoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLng = toRad(p2.lng - p1.lng);
  const lat1 = toRad(p1.lat);
  const lat2 = toRad(p2.lat);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Smallest unsigned angle between two bearings (0–180°). */
function angleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/**
 * Count how many times the route re-enters a small circle around the
 * start point mid-route. A clean loop returns 0 (we leave once, never
 * come back until the closing segment, which we exclude). A "barbell"
 * route — two lobes connected through start — returns 1+ because the
 * runner passes through start between lobes.
 *
 * 100m radius is small enough that legitimate near-passes on tight loops
 * don't trip it, but generous enough to catch a barbell whose connector
 * doesn't land exactly on points[0].
 *
 * Out-and-back routes are NOT exempted here — the caller should skip this
 * metric for them, since their return leg ends at start by design.
 */
export function countStartPasses(points: RoutePoint[], radiusKm: number = 0.1): number {
  if (points.length < 3) return 0;
  let inside = true;
  let entries = 0;
  for (let i = 1; i < points.length; i++) {
    const nowInside = haversineDistance(points[0], points[i]) <= radiusKm;
    if (nowInside && !inside) entries++;
    inside = nowInside;
  }
  // Subtract 1 for the closing approach — every loop legitimately re-enters
  // the start circle once at the end. Anything beyond that is a barbell joint.
  return Math.max(0, entries - 1);
}

/**
 * Count near-U-turns (heading changes ≥150°) along the route. Sampled
 * roughly every 50m using a 150m lookback/lookahead window, so:
 *   - 90° street corners DO NOT count (well below threshold)
 *   - 120° "cut diagonally to the next street" DOES NOT count
 *   - Only true reversals (entering a peninsula and U-turning back) count
 *
 * A clean loop returns 0; a lollipop returns ~1; an out-and-back returns
 * 1; a barbell with two distinct lobes returns 2+. After detecting a
 * reversal we skip ahead by `lookbackKm` so the same U-turn isn't counted
 * from adjacent sample windows.
 *
 * Out-and-back routes are NOT exempted here — the caller should skip this
 * metric for them, since their far-end U-turn is the entire point.
 */
export function reversalCount(
  points: RoutePoint[],
  lookbackKm: number = 0.15,
  thresholdDeg: number = 150
): number {
  if (points.length < 4) return 0;

  const cum: number[] = new Array(points.length);
  cum[0] = 0;
  for (let i = 1; i < points.length; i++) {
    cum[i] = cum[i - 1] + haversineDistance(points[i - 1], points[i]);
  }
  const total = cum[points.length - 1];
  if (total < lookbackKm * 2.5) return 0;

  const SAMPLE_KM = 0.05;
  let reversals = 0;
  let nextSample = lookbackKm;

  for (let i = 1; i < points.length - 1; i++) {
    if (cum[i] < nextSample) continue;
    if (cum[i] > total - lookbackKm) break;

    let iBack = i;
    while (iBack > 0 && cum[i] - cum[iBack] < lookbackKm) iBack--;
    let iFwd = i;
    while (iFwd < points.length - 1 && cum[iFwd] - cum[i] < lookbackKm) iFwd++;

    if (iBack < i && iFwd > i) {
      const bBack = bearingFrom(points[iBack], points[i]);
      const bFwd = bearingFrom(points[i], points[iFwd]);
      if (angleDiff(bBack, bFwd) >= thresholdDeg) {
        reversals++;
        nextSample = cum[i] + lookbackKm;
        continue;
      }
    }
    nextSample = cum[i] + SAMPLE_KM;
  }
  return reversals;
}

/**
 * Count "real" turns the runner has to make. A turn is a heading change of
 * ≥`thresholdDeg` over a short window (default 25m back, 25m forward — about
 * one short city block on each side). Sampled every 20m, with a `minSpacingKm`
 * dedupe ahead after each counted turn so a single intersection doesn't get
 * counted twice from adjacent sample windows.
 *
 * Default 45° threshold catches every real intersection turn (90° corners,
 * diagonal jogs, soft "bear left" turns) without being tripped by polyline
 * curvature noise from OSRM. Smooth circular paths register near zero.
 *
 * Why this is distinct from reversalCount: reversalCount uses a 150° threshold
 * over a 150m window, which is tuned for U-turns (peninsula visits, lollipops).
 * That misses the kind of turn density that makes a route exhausting to
 * actually run — zigzag/staircase patterns where every block forces a
 * "do I turn here?" decision but no individual turn is a reversal.
 *
 * Caller divides by route length to get turns/km — useful as a per-km signal
 * since longer routes naturally have more total turns.
 */
export function turnCount(
  points: RoutePoint[],
  lookbackKm: number = 0.025,
  thresholdDeg: number = 45,
  minSpacingKm: number = 0.04
): number {
  if (points.length < 4) return 0;

  const cum: number[] = new Array(points.length);
  cum[0] = 0;
  for (let i = 1; i < points.length; i++) {
    cum[i] = cum[i - 1] + haversineDistance(points[i - 1], points[i]);
  }
  const total = cum[points.length - 1];
  if (total < lookbackKm * 2.5) return 0;

  const SAMPLE_KM = 0.02;
  let turns = 0;
  let nextSample = lookbackKm;

  for (let i = 1; i < points.length - 1; i++) {
    if (cum[i] < nextSample) continue;
    if (cum[i] > total - lookbackKm) break;

    let iBack = i;
    while (iBack > 0 && cum[i] - cum[iBack] < lookbackKm) iBack--;
    let iFwd = i;
    while (iFwd < points.length - 1 && cum[iFwd] - cum[i] < lookbackKm) iFwd++;

    if (iBack < i && iFwd > i) {
      const bBack = bearingFrom(points[iBack], points[i]);
      const bFwd = bearingFrom(points[i], points[iFwd]);
      if (angleDiff(bBack, bFwd) >= thresholdDeg) {
        turns++;
        nextSample = cum[i] + minSpacingKm;
        continue;
      }
    }
    nextSample = cum[i] + SAMPLE_KM;
  }
  return turns;
}

/**
 * Aspect ratio of the route's bounding box: max(NS, EW) / min(NS, EW).
 *
 * Catches degenerate-shape loops that pass every existing detector but read on
 * the map as "not a loop": through-line starts (outbound and closing along the
 * same axis through start), squished ovals, snake-shape routes weaving along a
 * single corridor, long-stem lollipops where the stem dominates the bbox.
 *
 * Reference shapes (3mi loop ≈ 4.83km perimeter):
 *   - Square loop ~1.2km × 1.2km            → aspect 1
 *   - Healthy rectangle ~1.6km × 0.8km      → aspect 2
 *   - Squished oval that reads as a line    → aspect 5+
 *   - Through-line start (1.5km E-W × 60m)  → aspect ~25
 *
 * Out-and-back routes are intentionally 1-D — callers must skip OAB.
 */
export function bboxAspectRatio(points: RoutePoint[]): number {
  if (points.length < 2) return 1;
  let minLat = points[0].lat, maxLat = points[0].lat;
  let minLng = points[0].lng, maxLng = points[0].lng;
  let latSum = 0;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
    latSum += p.lat;
  }
  const refLat = latSum / points.length;
  const cosLat = Math.max(0.01, Math.cos((refLat * Math.PI) / 180));
  const nsKm = (maxLat - minLat) * KM_PER_DEG_LAT;
  const ewKm = (maxLng - minLng) * KM_PER_DEG_LAT * cosLat;
  // Floor on the denominator: a sub-10m extent in either axis is below GPS
  // noise and would inflate aspect to absurd values without telling us
  // anything new — anything that thin is degenerate regardless of the exact
  // ratio. 0.01km = 10m matches the toFixed(4) precision floor used elsewhere.
  const maxAxis = Math.max(nsKm, ewKm);
  const minAxis = Math.max(0.01, Math.min(nsKm, ewKm));
  return maxAxis / minAxis;
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
