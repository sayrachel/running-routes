import type { RoutePoint, GeneratedRoute, RoutePreferences, ManeuverStep } from './route-generator';
import { fetchGreenSpacesAndHighways } from './overpass';
import type { GreenSpace } from './overpass';
import { scoreRoute, computeGreenSpaceProximity, computeRunPathProximity, computeHighwayProximity, computeWaterfrontProximity, countStartPasses, reversalCount, turnCount, bboxAspectRatio, polsbyPopper, maxTurnDensityInWindow, shortTurnSegmentRatio, maxStreetShare } from './route-scoring';
import { emit as traceEmit } from './debug-trace';
import { isPopularRunningPark } from './popular-running-parks';

const OSRM_BASE_DEFAULT = 'https://router.project-osrm.org/route/v1/foot';
let osrmBase = OSRM_BASE_DEFAULT;
/** Override the OSRM endpoint. The harness uses this to point at a local
 *  self-hosted OSRM (real Manhattan-grid geometry, no public-endpoint rate
 *  limits). Production leaves it null and uses the public router. */
export function setOSRMBase(url: string | null): void {
  osrmBase = url ?? OSRM_BASE_DEFAULT;
}
// User-facing route count cap. The internal candidate pool is larger so
// quality rejection has alternatives — see SAFETY_EXTRAS below.
const MAX_CANDIDATE_COUNT = 3;
// Bumped 7 → 12 (May 2026). The 7-candidate pool routinely left dense-grid
// runs with no clean survivor — user reported 4mi East Village failing on a
// generate-again attempt with q=6 (6 quality rejects, 1 wrong-display, 0
// nulls), meaning OSRM was healthy and the pool just didn't contain a clean
// shape near target. With the 150ms launch stagger now in place, 12
// candidates is safe against burst rate limiting (1.8s launch window vs 1s
// at 7) and well within the 18s resolution budget. CLAUDE.md noted this
// fix as already-applied but the constant had remained at 7.
const MAX_INTERNAL_CANDIDATES = 12;

/** Diagnostic snapshot from the most recent `generateOSRMRoutes` call that
 *  returned `[]`. Surfaced in the UI so we can tell a user-reported "no
 *  routes found" apart from rate-limit-driven nulls vs every-candidate-was-
 *  geometrically-bad without needing console access (iOS production builds
 *  have no devtools). Reset to null on every generateOSRMRoutes call;
 *  populated only when the function returns []. */
export interface FailureDiagnostics {
  osrmNullCount: number;
  qualityRejectCount: number;
  wrongDisplayCount: number;
  budgetExpired: boolean;
  /** Per-reason breakdown of qualityRejectCount. Lets the banner show
   *  q=6 (b=2 o=2 d=1 p=1) so we can target the over-rejecting gate. */
  rejectReasons: {
    distance: number;
    barrier: number;
    highway: number;
    offStreet: number;
    pendantLoop: number;
    backtrack: number;
    aspect: number;
    turnDensity: number;
    polsbyPopper: number;
    turnCluster: number;
  };
}
let lastFailureDiagnostics: FailureDiagnostics | null = null;
export function getLastFailureDiagnostics(): FailureDiagnostics | null {
  return lastFailureDiagnostics;
}

/**
 * Thrown by `generateOSRMRoutes` when route generation failed because the
 * OSRM endpoint was unreachable or unresponsive (timeouts, 5xx, or the
 * overall resolution budget expired before any candidate finished). Lets
 * the caller distinguish "OSRM is down — show retry" from "OSRM responded
 * but no usable route exists for this area" (which surfaces as `[]`).
 */
export class OSRMUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OSRMUnavailableError';
  }
}

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
          // Continuity guard: after the cut, the polyline jumps directly
          // from points[i] to points[j+1] in a straight line. For a TRUE
          // lollipop the loop closes back on itself, so this jump distance
          // is small relative to the total path that was removed. For a
          // SPURIOUS crossing (e.g. mock wobble between adjacent triangle
          // legs), the jump is comparable to the removed length — meaning
          // we'd render a fictional shortcut the runner can't actually
          // take. Threshold of 30% is generous enough for noisy real-OSRM
          // geometry but rejects the worst false positives.
          const cutGapKm = haversineDistance(points[i], points[j + 1]);
          let removedPathKm = 0;
          for (let k = i; k <= j; k++) {
            removedPathKm += haversineDistance(points[k], points[k + 1]);
          }
          if (removedPathKm > 0 && cutGapKm / removedPathKm > 0.30) continue;

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
 * Trim dead-end stubs out of a route. A stub is a "go out 50-300m, U-turn,
 * come back" pattern that visibly juts off the main path. Trimming replaces
 * the [out-leg, U-turn, back-leg] sequence with a direct connection — the
 * runner just doesn't take the detour. The trimmed polyline is shorter and
 * cleaner; the runner skips visiting the stub tip but the rest of the route
 * is identical.
 *
 * Iterates until no more stubs are found (some routes have multiple).
 *
 * Default `maxStubLenKm` raised from 0.15 to 0.30 after Build 23: the user
 * reported a visible spur in N. Williamsburg/Greenpoint where the route
 * shot ~280m west to a waterfront strip (Marsha P. Johnson State Park area),
 * U-turned 180°, and came back. The previous 150m cap left this kind of
 * "peninsula visit" untrimmed because both legs exceeded 150m. The 150°
 * U-turn requirement is the safety net — only true dead-end visits get
 * collapsed; a 280m segment that turns 60° (a normal corner) is unaffected.
 */
export function trimStubs(points: RoutePoint[], maxStubLenKm: number = 0.30): RoutePoint[] {
  if (points.length < 4) return points;

  const MAX_PASSES = 6;
  let current = points;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = trimOneStub(current, maxStubLenKm);
    if (next === current) return current;
    current = next;
  }
  return current;
}


/** Walk backwards from index i through segments aligned with bearing b1,
 *  returning the index where the out-leg starts. */
function findStubOutStart(points: RoutePoint[], i: number, b1: number, maxLenKm: number): { start: number; len: number } {
  let outLen = haversineDistance(points[i - 1], points[i]);
  let k = i - 1;
  while (k > 0 && outLen <= maxLenKm) {
    const prevBearing = bearingFrom(points[k - 1], points[k]);
    if (angleDiff(prevBearing, b1) > 30) break;
    outLen += haversineDistance(points[k - 1], points[k]);
    k--;
  }
  return { start: k, len: outLen };
}

/** Walk forward from index i+1 through the back-leg, returning the index
 *  of the LAST point of the back-leg before the route resumes its original
 *  forward direction (or runs longer than the allowed back-leg length). */
function findStubBackEnd(points: RoutePoint[], i: number, b1: number, maxLenKm: number): { end: number; len: number; resumed: boolean } {
  let backLen = 0;
  let j = i + 1;
  let resumed = false;
  while (j < points.length - 1 && backLen <= maxLenKm) {
    const segLen = haversineDistance(points[j], points[j + 1]);
    backLen += segLen;
    const nextBearing = bearingFrom(points[j], points[j + 1]);
    // Back-leg ends when the route turns back to the forward direction
    // (within 60° of original bearing b1).
    if (j > i + 1 && angleDiff(nextBearing, b1) < 60) {
      resumed = true;
      break;
    }
    j++;
  }
  return { end: j, len: backLen, resumed };
}

/** Find one stub pattern (out-leg, U-turn, back-leg) and return points
 *  with that section removed. Returns input unchanged if no stub found.
 *  Uses the same criteria as countStubs so the two functions agree. */
function trimOneStub(points: RoutePoint[], maxStubLenKm: number): RoutePoint[] {
  for (let i = 1; i < points.length - 1; i++) {
    const b1 = bearingFrom(points[i - 1], points[i]);
    const b2 = bearingFrom(points[i], points[i + 1]);
    if (angleDiff(b1, b2) < 150) continue;

    const out = findStubOutStart(points, i, b1, maxStubLenKm);
    if (out.len > maxStubLenKm) continue; // not a stub: too long

    const back = findStubBackEnd(points, i, b1, maxStubLenKm * 1.5);

    // Trim: skip from out.start to back.end. The polyline jumps directly
    // across, removing the visible stub jut.
    const resumeIdx = back.resumed ? back.end + 1 : back.end;
    if (resumeIdx >= points.length) continue;
    return [...points.slice(0, out.start + 1), ...points.slice(resumeIdx)];
  }
  return points;
}

/**
 * Count "dead-end stubs" — places where the route does an immediate U-turn,
 * meaning the runner has to enter a non-thoroughfare street and exit the
 * same way. Visible on the map as a small line jutting off the main route.
 *
 * Detection: a stub is a sequence of segments where consecutive bearings
 * differ by ≥150° (near-180° reversal) over a short distance (<150m). A
 * route with more than 2 such stubs is almost certainly an OSRM-routed
 * disaster the runner can't follow as a single continuous path.
 *
 * Returns the count of stubs found.
 */
export function countStubs(points: RoutePoint[], maxStubLenKm: number = 0.30): number {
  if (points.length < 4) return 0;

  let stubCount = 0;
  let i = 1;
  while (i < points.length - 1) {
    const b1 = bearingFrom(points[i - 1], points[i]);
    const b2 = bearingFrom(points[i], points[i + 1]);
    const reversal = angleDiff(b1, b2);

    // U-turn: bearings differ by ≥150° (near-180°)
    if (reversal >= 150) {
      // Measure the "out" segment leading into the U-turn
      let outLen = haversineDistance(points[i - 1], points[i]);
      // Walk backwards to include any earlier segments going the same direction
      let k = i - 2;
      while (k >= 0 && angleDiff(bearingFrom(points[k], points[k + 1]), b1) < 30) {
        outLen += haversineDistance(points[k], points[k + 1]);
        k--;
        if (outLen > maxStubLenKm) break;
      }
      // Only count as a stub if the "out" leg was short — a U-turn after
      // 500m of travel is just the route changing direction, not a stub.
      if (outLen <= maxStubLenKm) {
        stubCount++;
        // Skip past the return leg so we don't double-count the same stub
        i += 2;
        continue;
      }
    }
    i++;
  }
  return stubCount;
}

/**
 * "Are these two polylines essentially the same route?" — used by the
 * refresh path to demote candidates whose geometry replays the previously-
 * shown route.
 *
 * Samples 8 evenly-spaced positions along `a`; for each, takes the minimum
 * haversine distance to any vertex on `b`. Returns the average. Two routes
 * that follow the same streets sample to <50m on average; routes that take
 * different avenues separate by 200m+.
 *
 * Returns 1 (treat as different) if either polyline is empty so callers
 * never accidentally demote candidates against a missing reference.
 */
export function polylineDivergenceKm(a: RoutePoint[], b: RoutePoint[]): number {
  if (a.length === 0 || b.length === 0) return 1;
  const SAMPLES = 8;
  let total = 0;
  for (let i = 0; i < SAMPLES; i++) {
    // Skip endpoints — for p2p they're identical (same start, same end) by
    // construction and would always pull the average toward 0.
    const t = (i + 1) / (SAMPLES + 1);
    const aIdx = Math.min(a.length - 1, Math.max(0, Math.floor(t * (a.length - 1))));
    const aPt = a[aIdx];
    let nearest = Infinity;
    for (const bPt of b) {
      const d = haversineDistance(aPt, bPt);
      if (d < nearest) nearest = d;
      if (nearest === 0) break;
    }
    total += nearest;
  }
  return total / SAMPLES;
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

/**
 * Trim pendant loops out of a polyline. A pendant loop is a closed sub-loop
 * attached to the rest of the path by a single bridge segment traversed in
 * both directions (see countPendantLoops for the topology). To eliminate it
 * we remove the bridge-in segment, the loop body, and the bridge-out segment
 * — the polyline jumps straight from the main route point on one side of
 * the bridge to the main route point on the other side (which are the same
 * physical intersection). The runner just doesn't take the side detour.
 *
 * Iterates so multi-pendant routes are all cleaned in one call. Each pass
 * removes one pendant; we stop as soon as a pass finds nothing.
 *
 * Trimming reduces total distance by (bridge × 2 + loop body). Callers must
 * recompute distance after this and re-run the distance hard-reject — a
 * candidate whose pendant accounts for most of its length will get gutted
 * and should be rejected by the existing distance band ([0.5, 1.3] of
 * target), not surfaced to the user.
 *
 * Out-and-back routes intentionally retrace every segment; do not call this
 * on them.
 */
/**
 * Backstop pendant trim — catches retrace-shaped spurs that survived
 * trimStubs (which requires a sharp ≥150° apex) and trimPendantLoops
 * (which requires both bridge endpoints to match within 20m).
 *
 * Algorithm: build a coarse-rounded canonical edge key for every segment.
 * Edges that appear more than once are retraced. Group consecutive
 * retraced indices into "back-leg runs", and for each run >= minRetraceM
 * find the matching forward edges (their first-occurrence indices). The
 * span from the first forward edge through the last back-leg edge IS the
 * stub. Trim it.
 *
 * Shape-agnostic — handles U-turn pendants, L-shaped detours, multi-turn
 * spurs, anything that visibly retraces the same edges. Out-and-back
 * routes are exempt (their entire return leg is "retraced" by design).
 *
 * Bounded blast radius: refuses to trim more than 25% of the route's
 * total length in one pass. A larger trim signals the polyline isn't
 * really a stub-with-mainline but a degenerate near-OAB shape that
 * upstream gates should have rejected.
 */
export function trimRetracedSpurs(
  points: RoutePoint[],
  minRetraceM: number = 50,
): RoutePoint[] {
  if (points.length < 4) return points;

  // ~5 decimal-place rounding ≈ 1m precision at NYC latitudes — fine
  // enough that legitimate adjacent points don't collide, coarse enough
  // that OSRM's sub-meter coordinate jitter on forward vs reverse
  // traversal of the same OSM way still matches.
  const keyOf = (p1: RoutePoint, p2: RoutePoint): string => {
    const a = `${p1.lat.toFixed(5)},${p1.lng.toFixed(5)}`;
    const b = `${p2.lat.toFixed(5)},${p2.lng.toFixed(5)}`;
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  };

  // edgeIndices[key] = sorted list of indices where this edge appears.
  // Indices ARE traversal order so first-occurrence is forward, later
  // occurrences are back-traversals.
  const edgeIndices = new Map<string, number[]>();
  for (let i = 0; i < points.length - 1; i++) {
    const key = keyOf(points[i], points[i + 1]);
    const list = edgeIndices.get(key);
    if (list) list.push(i);
    else edgeIndices.set(key, [i]);
  }

  // Indices of retraced (non-first-occurrence) edges.
  const retracedAt = new Set<number>();
  for (const indices of edgeIndices.values()) {
    if (indices.length > 1) {
      for (let k = 1; k < indices.length; k++) retracedAt.add(indices[k]);
    }
  }
  if (retracedAt.size === 0) return points;

  // Group into contiguous runs.
  const sorted = [...retracedAt].sort((a, b) => a - b);
  type Run = { start: number; end: number; lengthM: number };
  const runs: Run[] = [];
  let runStart = sorted[0];
  let runEnd = sorted[0];
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k] === runEnd + 1) {
      runEnd = sorted[k];
    } else {
      runs.push({ start: runStart, end: runEnd, lengthM: 0 });
      runStart = sorted[k];
      runEnd = sorted[k];
    }
  }
  runs.push({ start: runStart, end: runEnd, lengthM: 0 });
  for (const run of runs) {
    let m = 0;
    for (let i = run.start; i <= run.end; i++) {
      m += haversineDistance(points[i], points[i + 1]) * 1000;
    }
    run.lengthM = m;
  }

  // For each long-enough run, locate the forward leg and mark indices for
  // removal. The stub spans [fwdStart .. backEnd], inclusive of the
  // forward edges and back edges.
  const toRemove = new Set<number>();
  for (const run of runs) {
    if (run.lengthM < minRetraceM) continue;
    const fwdIdx: number[] = [];
    for (let i = run.start; i <= run.end; i++) {
      const key = keyOf(points[i], points[i + 1]);
      const occurrences = edgeIndices.get(key)!;
      fwdIdx.push(occurrences[0]);
    }
    fwdIdx.sort((a, b) => a - b);
    // Sanity: forward leg must precede back leg. If they overlap the
    // stub is malformed (figure-8 etc) — skip rather than mistrim.
    if (fwdIdx[fwdIdx.length - 1] >= run.start) continue;

    // Mark points[fwdStart+1 .. backEnd+1] for removal. Keep
    // points[fwdStart] (the entry to the stub on the trunk).
    for (let i = fwdIdx[0] + 1; i <= run.end + 1; i++) {
      toRemove.add(i);
    }
  }
  if (toRemove.size === 0) return points;

  // Bounded blast radius — refuse to trim >25% of route length.
  let totalM = 0;
  for (let i = 0; i < points.length - 1; i++) {
    totalM += haversineDistance(points[i], points[i + 1]) * 1000;
  }
  let removedM = 0;
  for (let i = 1; i < points.length; i++) {
    if (toRemove.has(i)) {
      removedM += haversineDistance(points[i - 1], points[i]) * 1000;
    }
  }
  if (removedM > totalM * 0.25) return points;

  const result: RoutePoint[] = [];
  for (let i = 0; i < points.length; i++) {
    if (!toRemove.has(i)) result.push(points[i]);
  }
  return result;
}

export function trimPendantLoops(points: RoutePoint[]): RoutePoint[] {
  if (points.length < 5) return points;
  // 2 passes (down from 8). Even with per-pass body caps, real OSRM closed
  // loops in dense grids expose nested "exit street → small loop → return
  // street" patterns. Each pass looks innocuous (~150-250m body) but 8
  // passes compound to 60% of the route gone — East Village 3mi went from
  // 4.75km to 1.85km that way and got distance-rejected. Two passes cover
  // the legitimate multi-pendant case (the test fixture has two stacked
  // pendants) without leaving headroom for nested-pattern cascade.
  const MAX_PASSES = 2;
  let current = points;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = trimOnePendantLoop(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

function trimOnePendantLoop(points: RoutePoint[]): RoutePoint[] {
  const TOL_KM = 0.020;
  // Bridge edge must be a real path segment, not OSRM's input-to-snap closure
  // noise. For a closed-loop request OSRM emits geometry as
  // [input, snap, ...loop body..., snap, input] where the snap point is
  // OSRM's nearest-road projection of the (identical) start/end input. The
  // first edge (input→snap) is sub-meter to ~5m and the last edge (snap→input)
  // mirrors it — exactly the bridge-in/bridge-out signature this detector
  // looks for, but with the entire loop as the "body". Without this guard the
  // (i=0, j=N-2) match cuts the polyline down to a single point. Any real
  // pendant loop has a bridge that's a real edge (typically 50m+); requiring
  // bridge ≥ TOL_KM (20m) excludes the snap noise without missing real cases.
  const MIN_BRIDGE_KM = TOL_KM;
  // Body cap. The detector's job is to remove SMALL aesthetic stubs —
  // a square hanging off a stem. When the body is most of the route, what
  // looks like "a pendant attached to a stem" is actually "the entire loop
  // attached to a short connector street to the user's start". Closed-loop
  // routes naturally have this pattern: exit street (50-150m) → big loop →
  // return on the same street. Trimming would strip the loop and leave just
  // the exit-street segment — exactly the East Village 3mi failure mode where
  // the algorithm reported "no routes found" because every candidate's body
  // exceeded the implicit cap of "infinity" and got chopped to start-only.
  //
  // A real aesthetic pendant is bounded — a single block-perimeter square is
  // ~700m but most observed pendants are 200-400m. Fraction-only caps don't
  // hold up against MAX_PASSES iteration: the first cut shrinks the route,
  // the next pass's body-fraction recomputes against the smaller total, and
  // the same exit-street-then-loop pattern fires again, cascading until the
  // route is gone. We require BOTH a fraction cap AND an absolute cap so the
  // pass-N body has to clear an absolute floor regardless of denominator.
  const MAX_BODY_FRAC = 0.30;
  const MAX_BODY_KM = 0.300;
  const MIN_BODY_SEGS = 2;
  let totalKm = 0;
  for (let k = 1; k < points.length; k++) totalKm += haversineDistance(points[k - 1], points[k]);
  for (let i = 0; i < points.length - 1; i++) {
    for (let j = i + 1 + MIN_BODY_SEGS; j < points.length - 1; j++) {
      const startMatches = haversineDistance(points[i], points[j + 1]) < TOL_KM;
      const endMatches = haversineDistance(points[i + 1], points[j]) < TOL_KM;
      if (startMatches && endMatches) {
        const bridgeKm = haversineDistance(points[i], points[i + 1]);
        if (bridgeKm < MIN_BRIDGE_KM) continue;
        let bodyKm = 0;
        for (let k = i + 1; k < j; k++) bodyKm += haversineDistance(points[k], points[k + 1]);
        if (bodyKm > MAX_BODY_KM) continue;
        if (totalKm > 0 && bodyKm / totalKm > MAX_BODY_FRAC) continue;
        // Drop bridge-in (i→i+1), loop body (i+1..j), and bridge-out (j→j+1).
        // P[i] ≈ P[j+1] is the same intersection; we keep the first copy and
        // resume from P[j+2] so the polyline reconnects without a duplicate
        // vertex.
        return [...points.slice(0, i + 1), ...points.slice(j + 2)];
      }
    }
  }
  return points;
}

/**
 * Detect "pendant loops" — closed sub-loops attached to the rest of the
 * polyline by a single bridge segment that's traversed in both directions.
 *
 * Topology: the polyline goes …→A→B→[loop body]→B→A→… where (A,B) is the
 * bridge edge. To physically run the polyline as a continuous path, the
 * runner has to cover (A,B) twice — once entering the loop, once leaving —
 * because the loop has only one connection back to the main route. Visually
 * on the map this looks like a square (or other small polygon) attached to
 * the main path by a short stem.
 *
 * Distinct from existing detectors:
 *   - removeSelfintersections / segmentsCross — looks for X-shape crossings.
 *     A pendant loop's bridge OVERLAPS itself rather than crossing, so X
 *     detection misses it entirely.
 *   - countStubs — looks for a single ≥150° U-turn within ≤300m. A 4-corner
 *     pendant loop (e.g. around one NYC block) has four 90° turns and zero
 *     ≥150° reversals, so stub detection misses it.
 *   - retraceRatio — counts the duplicated bridge in km, but for a 6mi route
 *     a 50–150m bridge is <1%, so retrace fraction stays low even with a
 *     glaringly broken polyline.
 *   - overlapSegmentRatio — detects parallel-street antiparallel segments
 *     within 12m. A pendant-loop bridge IS antiparallel-overlapping with
 *     itself (proximity ≈ 0), but again the contribution to total fraction
 *     is tiny on long routes, never approaching the 0.50 hard-reject.
 *
 * The signature we detect is unambiguous: a pair of polyline segments
 * (i, i+1) and (j, j+1) where (j > i) and the second is the *reverse* of
 * the first within tolerance — i.e. P[i] ≈ P[j+1] AND P[i+1] ≈ P[j]. The
 * polyline necessarily traces a closed sub-loop between them (returning
 * to the same point). Caller should reject any candidate with count > 0.
 *
 * Out-and-back routes intentionally retrace every segment and would report
 * huge counts here; callers must skip OAB.
 */
export function countPendantLoops(points: RoutePoint[]): number {
  if (points.length < 5) return 0;

  // ~20m tolerance for "same physical edge" — slightly looser than
  // overlapSegmentRatio's 12m to absorb OSRM sub-meter wobble between
  // outbound and inbound traversals of the same street.
  const TOL_KM = 0.020;
  // Bridge edge must be a real path segment — see trimOnePendantLoop for the
  // full rationale. OSRM's closed-loop output looks like
  // [input, snap, ...body..., snap, input] where (input, snap) is sub-meter
  // to ~5m. Without the guard countPendantLoops returns 1 for every closed
  // loop and the candidate-evaluation safety net rejects them all.
  const MIN_BRIDGE_KM = TOL_KM;
  // Body caps — see trimOnePendantLoop. A short connector street into a big
  // loop has the topology of a "pendant" but the body is the route itself.
  // Counting it as a defect would reject every closed loop whose start is
  // not directly on the loop perimeter.
  const MAX_BODY_FRAC = 0.30;
  const MAX_BODY_KM = 0.300;
  // Loop body must have at least 2 segments between bridge-in and bridge-out.
  // A 1-segment body is just a degenerate stub (already caught by countStubs
  // when the U-turn is sharp). A 2+ segment body is a real polygon.
  const MIN_BODY_SEGS = 2;

  let count = 0;
  // Mark indices already explained by a detected pendant loop so we don't
  // double-count the inner segments of a multi-segment bridge or stacked
  // pendant loops.
  const consumed = new Array<boolean>(points.length).fill(false);
  let totalKm = 0;
  for (let k = 1; k < points.length; k++) totalKm += haversineDistance(points[k - 1], points[k]);

  for (let i = 0; i < points.length - 1; i++) {
    if (consumed[i]) continue;
    for (let j = i + 1 + MIN_BODY_SEGS; j < points.length - 1; j++) {
      if (consumed[j]) continue;
      const startMatches = haversineDistance(points[i], points[j + 1]) < TOL_KM;
      const endMatches = haversineDistance(points[i + 1], points[j]) < TOL_KM;
      if (startMatches && endMatches) {
        const bridgeKm = haversineDistance(points[i], points[i + 1]);
        if (bridgeKm < MIN_BRIDGE_KM) continue;
        let bodyKm = 0;
        for (let k = i + 1; k < j; k++) bodyKm += haversineDistance(points[k], points[k + 1]);
        if (bodyKm > MAX_BODY_KM) continue;
        if (totalKm > 0 && bodyKm / totalKm > MAX_BODY_FRAC) continue;
        count++;
        for (let k = i; k <= j; k++) consumed[k] = true;
        break;
      }
    }
  }
  return count;
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
  _greenSpaces: GreenSpace[],
  targetDistanceKm?: number
): boolean {
  // Scale the threshold with route length. For a triangular loop, the
  // longest natural segment (wp1→wp2) is roughly 0.4× the total route
  // distance, so a 6mi (9.7km) loop legitimately has a 3.3km segment.
  // The fixed 1.5km threshold dropped wp1 AND wp2 for every loop ≥4mi,
  // collapsing the route to [center, center] and forcing the step-3.5
  // emergency fallback (which uses no green spaces).
  // Post-OSRM `hasRoutedBarrierCrossing` is the safety net for actual
  // tunnels/bridges — this pre-OSRM heuristic just needs to catch the
  // truly extreme cases (>50% of route in one segment).
  const limit = targetDistanceKm !== undefined
    ? Math.max(1.5, targetDistanceKm * 0.5)
    : 1.5;
  return haversineDistance(p1, p2) > limit;
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
  center: RoutePoint,
  targetDistanceKm?: number
): RoutePoint[] {
  return removeWaterCrossingsWithAnchors(waypoints, greenSpaces, center, [], targetDistanceKm).waypoints;
}

/**
 * Same as removeWaterCrossings but also keeps the parallel `anchors` array
 * in sync — when a waypoint is replaced with a different green space, the
 * matching anchor is updated; when a waypoint is dropped, the matching
 * anchor is dropped too. Without this sync, downstream consumers like
 * `expandParkWaypoints` and the "Tompkins Square Park Loop" naming look up
 * stale anchors and either skip expansion or pick the wrong name.
 *
 * Anchor indexing convention: waypoints are [center, gs1, gs2, ..., center];
 * anchors are [gs1, gs2, ...]. So anchors[i-1] corresponds to waypoints[i]
 * for i in 1..waypoints.length-2.
 */
export function removeWaterCrossingsWithAnchors(
  waypoints: RoutePoint[],
  greenSpaces: GreenSpace[],
  center: RoutePoint,
  anchors: GreenSpace[],
  targetDistanceKm?: number
): { waypoints: RoutePoint[]; anchors: GreenSpace[] } {
  if (waypoints.length < 3) return { waypoints, anchors };

  const result = [...waypoints];
  const resultAnchors = [...anchors];
  const toRemove = new Set<number>();

  for (let i = 1; i < result.length - 1; i++) {
    if (!hasLikelyWaterCrossing(result[i - 1], result[i], greenSpaces, targetDistanceKm) &&
        !hasLikelyWaterCrossing(result[i], result[i + 1], greenSpaces, targetDistanceKm)) {
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
        if (hasLikelyWaterCrossing(center, gs.point, greenSpaces, targetDistanceKm)) continue;
        // Don't replace with a green space that's already a waypoint —
        // produces a degenerate "center → X → X → center" route and a
        // duplicate name like "Tompkins Square Park / Tompkins Square Park".
        const alreadyUsed = result.some((p, idx) =>
          idx !== i && Math.abs(p.lat - gs.point.lat) < 1e-6 && Math.abs(p.lng - gs.point.lng) < 1e-6
        );
        if (alreadyUsed) continue;
        const prevOk = !hasLikelyWaterCrossing(result[i - 1], gs.point, greenSpaces, targetDistanceKm);
        const nextOk = i + 1 < result.length
          ? !hasLikelyWaterCrossing(gs.point, result[i + 1], greenSpaces, targetDistanceKm)
          : true;
        if (prevOk && nextOk) {
          result[i] = gs.point;
          // Sync the anchor: anchor index = waypoint index - 1.
          if (i - 1 < resultAnchors.length) resultAnchors[i - 1] = gs;
          replaced = true;
          break;
        }
      }
    }

    if (!replaced) {
      toRemove.add(i);
    }
  }

  // Drop dropped waypoints AND their matching anchors in lockstep.
  return {
    waypoints: result.filter((_, i) => !toRemove.has(i)),
    anchors: resultAnchors.filter((_, i) => !toRemove.has(i + 1)),
  };
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
  // Only flag VERY long straight segments (>1.2km) as likely tunnels/bridges.
  // Was 400m, which produced false positives on Manhattan avenues — going
  // 6 blocks straight east on a normal street is ~1.5km of "straight line"
  // and was being rejected as a barrier crossing. Real tunnels/bridges are
  // typically longer than 1km of fully-straight constant-bearing geometry.
  const minStraightKm = 1.2;

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

  // --- Heuristic 3: Sparse long edge (tunnel/ferry/unwalkable way) ---
  // OSRM with overview=full returns the OSM way's full node list. Walkable
  // infrastructure is reasonably noded, but real-world OSM data is uneven —
  // some legitimate edges exceed 500m even on foot-walkable infra (long
  // park paths with sparse intersections, some bridge segments). A 0.5km
  // threshold rejected 100% of 12 candidates on a real-OSRM 20mi NYC loop
  // (user-reported "Q=12 B=12"). Tunnels we actually want to catch are
  // 1.5–2.6km single segments (Lincoln 2.4km, Holland 2.6km, Brooklyn-
  // Battery 2.8km). 1.2km threshold sits comfortably between legit edges
  // and tunnel-class single segments — catches the user-reported Manhattan
  // →Hoboken case (those tunnels are 2km+ each) without rejecting routes
  // that include normally-noded long greenway sections.
  for (let i = 1; i < routePoints.length; i++) {
    const edgeKm = haversineDistance(routePoints[i - 1], routePoints[i]);
    if (edgeKm > 1.2) {
      console.log(`[BarrierCheck] Sparse long edge: ${edgeKm.toFixed(3)}km between consecutive polyline points`);
      return true;
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
  // Upper clamp lifted from 10 to 25 so long-distance loops (~25-30mi) can
  // pull anchors from a wide enough area to wrap around water barriers like
  // the Hudson/East River. The actual Overpass fetch radius is bucketed via
  // getMaxOverpassRadius, so a 30mi user only causes one extra network call
  // (10km bucket → 25km bucket) and subsequent shorter requests at the same
  // start are served from the larger cache.
  return Math.min(Math.max(radius, 1.5), 25);
}

// ---------------------------------------------------------------------------
// Green-space-first waypoint selection
// ---------------------------------------------------------------------------

export type CandidateStrategy = 'large-parks' | 'named-paths' | 'balanced' | 'macro-snap' | 'corridor-loop';

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

  // Curated runner-popularity boost: parks well-known to the running
  // community (Central Park, McCarren Park, Lakefront Trail, Embarcadero,
  // etc.) get a substantial bump above peers of similar geometry. Captures
  // the difference between "park people run in" vs. "park that just happens
  // to be there" — McCarren and Tompkins Square are similar size in OSM but
  // wildly different as running destinations. List in popular-running-parks.ts.
  if (gs.name && isPopularRunningPark(gs.name)) {
    score += 12;
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
/**
 * Compute the maximum turn severity at any interior waypoint in a sequence.
 *
 * For waypoints `[w0, w1, w2, ..., wn]`, the turn at w[i] is the angular
 * difference between the bearing-in (w[i-1]→w[i]) and the bearing-out
 * (w[i]→w[i+1]). 0° means the runner continues straight through w[i];
 * 180° means a full U-turn. Values ≥160° require OSRM to reverse direction
 * at that waypoint, which it can only achieve via a block-loop or U-turn —
 * the visible spurs that originally motivated this check.
 *
 * For closed loops the wrap-around at center (w[n] → w[0] equivalence) is
 * intentionally not checked: a circular loop arrives at start from one
 * direction and "starts" from the opposite, but the runner experiences
 * neither — they begin and end at the same time. Adding the wrap-around to
 * the check would penalize good loops as much as bad ones.
 */
export function maxTurnSeverity(waypoints: RoutePoint[]): number {
  if (waypoints.length < 3) return 0;
  let maxTurn = 0;
  for (let i = 1; i < waypoints.length - 1; i++) {
    const bIn = bearingFrom(waypoints[i - 1], waypoints[i]);
    const bOut = bearingFrom(waypoints[i], waypoints[i + 1]);
    const turn = angleDiff(bIn, bOut);
    if (turn > maxTurn) maxTurn = turn;
  }
  return maxTurn;
}

/**
 * Try all permutations of intermediate waypoints (excluding fixed endpoints)
 * and return the order that minimizes max turn severity. Catches the case
 * where the bearing-sorted order forces a U-turn (e.g. picks at compass
 * bearings 0°, 90°, 270° in bearing-sorted order has a 180° turn at the
 * third waypoint, but the alternative order 90°→0°→270° has max turn 135°).
 *
 * Brute-force across N! permutations — fine for N≤5 (the practical waypoint
 * count cap). Returns the input order unchanged if it's already optimal or
 * if no better permutation exists.
 *
 * Closed-loop note: for a closed loop with center duplicated as both
 * endpoints, the input is `[center, w1, w2, ..., wn, center]`. We permute
 * w1..wn while keeping center fixed at both ends. The "reverse" permutation
 * produces an equivalent loop (clockwise vs counter-clockwise) — we don't
 * dedupe explicitly because the picker is correct either way.
 */
export function reorderForLowestUTurn(
  center: RoutePoint,
  intermediate: RoutePoint[],
): RoutePoint[] {
  if (intermediate.length <= 2) {
    // For 0, 1, or 2 intermediate waypoints, no reordering helps —
    // single-element sets have one order, and 2-element sets produce
    // identical loops in either direction (closed-loop equivalence).
    return intermediate;
  }
  // Cap at 5 to bound the permutation count (5! = 120). Above 5 the
  // generator runs but the generation pipeline doesn't currently produce
  // that many waypoints.
  if (intermediate.length > 5) return intermediate;

  let bestOrder = intermediate;
  let bestMaxTurn = maxTurnSeverity([center, ...intermediate, center]);

  const permute = (remaining: RoutePoint[], built: RoutePoint[]): void => {
    if (remaining.length === 0) {
      const turn = maxTurnSeverity([center, ...built, center]);
      if (turn < bestMaxTurn) {
        bestMaxTurn = turn;
        bestOrder = [...built];
      }
      return;
    }
    for (let i = 0; i < remaining.length; i++) {
      const next = [...remaining.slice(0, i), ...remaining.slice(i + 1)];
      permute(next, [...built, remaining[i]]);
    }
  };
  permute(intermediate, []);

  return bestOrder;
}

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
  // minCenterDist applied UPFRONT (was originally a post-pick filter, which
  // meant a sector could pick a too-close green space, then drop it later
  // and end up with too few picks. Filtering early lets the sectoring +
  // top-N backfill work on already-valid candidates.)
  // Capped at 0.6km so very long routes (8+ mi) don't filter out their
  // only nearby parks. trimStubs removes any visit-and-return artifact
  // a too-close waypoint creates, so allowing them costs little.
  const minCenterDist = Math.min(Math.max(0.3, targetDistanceKm * 0.08), 0.6);
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
  .filter((a) => a.dist >= minCenterDist)
  .filter((a) => isAccessibleFromCenter(center, a.gs.point, greenSpaces));

  if (annotated.length < 2) return null;

  // Use fewer sectors for shorter routes to avoid clustering. Long routes
  // need more sectors so the picks spread across a wider perimeter — a 30mi
  // loop with 3 sectors clusters anchors in one direction and the loop
  // collapses into a narrow strip; 6+ sectors give the 5-waypoint cap
  // enough angular spread to actually wrap around water barriers.
  const numSectors = targetDistanceKm < 15
    ? 3
    : targetDistanceKm < 25
      ? 4 + (variant % 2)
      : 6 + (variant % 2);
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

  // Top-N-by-score backfill for clustered locations. In dense urban areas
  // (e.g. NYC LES) green spaces often cluster on one side — sectoring may
  // place all of them in 1-2 sectors and leave us with too few picks. Rather
  // than punt to the geometric fallback (losing all green-space context AND
  // its naming benefit), pick the highest-scoring remaining candidates that
  // sit at least ~60° away in bearing from any existing pick. This keeps
  // diversity without requiring uniform angular spread.
  // Backfill target scales with distance — long routes (15mi+) need more
  // picks for the larger waypoint cap below to draw from.
  const backfillTargetMi = targetDistanceKm * 0.621371;
  const backfillTarget = backfillTargetMi >= 22 ? 5 : backfillTargetMi >= 15 ? 4 : 3;
  if (picks.length < backfillTarget) {
    const allByScore = annotated.slice().sort((a, b) => b.score - a.score);
    for (const cand of allByScore) {
      if (picks.length >= backfillTarget) break;
      if (picks.some((p) => p.gs === cand.gs)) continue;
      // 45° threshold matches the downstream bearing-similarity filter and
      // lets a third pick squeeze in for clustered locations (Williamsburg
      // has 4 greens within a 50° northern arc — a 60° threshold makes the
      // third pick impossible). The downstream minWaypointSpacing and
      // bearing-similarity filters still drop genuinely too-close picks.
      const tooClose = picks.some((p) => angleDiff(p.bearing, cand.bearing) < 45);
      if (tooClose) continue;
      picks.push({ gs: cand.gs, bearing: cand.bearing, dist: cand.dist });
    }
  }

  // Both modes: 2 picks is the hard minimum. Strict mode previously required
  // 3, which sounded right but sent every dense-cluster location (Chi
  // lakefront, Williamsburg) to the geometric fallback when only 2 well-
  // spaced candidates existed. Strict mode still applies stricter scoring
  // (boosted tier/area bonuses) and adjacent-sector backfill, so it favors
  // higher-quality picks — it just doesn't punt when the location
  // genuinely lacks 3 spread-out green spaces.
  if (picks.length < 2) return null;

  // Cap waypoints. For short routes (<4mi) in dense urban grids, 3 waypoints
  // forces them too close together and OSRM weaves through blocks producing
  // visible figure-8/rectangle patterns. 2 waypoints gives a cleaner triangle
  // loop that the runner can follow as one continuous path.
  // Allow up to 3 waypoints for all routes. Previously capped to 2 for
  // short routes on the theory that 3 close waypoints would force OSRM
  // to weave between blocks. Real-OSRM testing in dense Manhattan grid
  // showed the OPPOSITE: 3 waypoints spread at ~120° apart give OSRM
  // three distinct corridors to use, reducing retrace vs. 2 waypoints
  // where the wp2→center return leg often shares streets with the
  // center→wp1 outbound leg. Quality scoring picks the best regardless
  // of waypoint count, so generating 3-waypoint candidates alongside
  // 2-waypoint ones gives the algorithm more options.
  // For long distances (15mi+), 3 waypoints can't span enough area —
  // a 30mi loop in NYC needs anchors across both Manhattan and Brooklyn,
  // which demands 4-6 waypoints to wrap around the rivers. Cap scales:
  // ≤15mi: 3, 15-22mi: 4, 22-32mi: 5. Per-bucket caps (3/4/5) keep
  // each candidate's OSRM call shape predictable.
  const targetMi = targetDistanceKm * 0.621371;
  const distanceCap = targetMi >= 22 ? 5 : targetMi >= 15 ? 4 : 3;
  const maxGreenWaypoints = Math.min(picks.length, distanceCap);
  const selectedPicks = picks
    .sort((a, b) => b.dist - a.dist) // drop farthest first if over cap
    .slice(picks.length - maxGreenWaypoints);

  // Order by bearing to form a loop
  selectedPicks.sort((a, b) => a.bearing - b.bearing);
  // (minCenterDist filter moved upstream to the `annotated` stage so
  // sectoring + top-N backfill operate on already-valid candidates.)

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

  // Reorder picks to minimize max turn severity at any waypoint. The
  // bearing-sorted order (above) isn't always U-turn-free — e.g. picks at
  // compass bearings 0°/90°/270° in bearing order force a 180° turn at the
  // third waypoint. Reordering catches that without dropping any picks.
  // Aligned with user request (May 2026, CLAUDE.md #37): when consecutive
  // waypoints require OSRM to reverse direction, OSRM's only response is
  // a U-turn or block-loop — fix it upstream by ordering waypoints so
  // every transition is a forward-progressing turn.
  const intermediatePoints = selectedPicks.map((p) => p.gs.point);
  const reorderedPoints = reorderForLowestUTurn(center, intermediatePoints);
  // Re-pair anchors with the reordered points by lookup. Coordinates are
  // unique per pick (different green spaces) so this is unambiguous.
  const anchors: GreenSpace[] = reorderedPoints.map((pt) => {
    const pick = selectedPicks.find((p) =>
      p.gs.point.lat === pt.lat && p.gs.point.lng === pt.lng
    );
    return pick!.gs;
  });
  let waypoints: RoutePoint[] = [center, ...reorderedPoints, center];

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
  // Only expand parks ≥ 0.5 km² (Central Park, Prospect Park, Grant Park,
  // Forest Park). Smaller parks have entry/exit pairs that OSRM threads
  // through tiny access streets, creating dead-end stubs in the route.
  // Was 0.1 km² which caught medium parks like East River Park (0.32) and
  // Boston Common (0.20) — those got stubby routes; better to just route
  // to the park center and let OSRM pick the natural approach.
  minAreaForExpansion: number = 0.5
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
 * Macro-snap loop: plan the loop SHAPE first (compass-bearing vertices sized
 * so the perimeter ≈ target distance), then snap each vertex to the nearest
 * scenic anchor (park/bridge/corridor) within ~800m. The existing
 * `selectGreenSpaceWaypoints` strategy is anchor-first — it picks the highest-
 * scoring nearby greens then sectors them, which in dense areal-rich
 * neighborhoods packs all anchors into a 2km square (every park is right
 * there) and the loop shape collapses, forcing the route to make multiple
 * passes through the same area to fit longer distances. By placing target
 * vertices on a circle/polygon FIRST and snapping to anchors second, this
 * strategy enforces loop coherence while preserving scenic anchoring.
 *
 * If a macro vertex has no anchor within snap radius, the geometric vertex is
 * used directly — the resulting candidate then mixes anchored and pure-
 * geometric vertices, which still produces a coherent loop shape (better
 * than collapsing all vertices into the anchored area).
 *
 * Variant produces different starting bearings so each macro-snap candidate
 * lands on a different rotation of the same shape, giving sectoring-style
 * variety without the anchor-clustering pathology.
 */
function generateMacroSnapLoop(
  center: RoutePoint,
  distanceKm: number,
  variant: number,
  greenSpaces: GreenSpace[],
): { waypoints: RoutePoint[]; anchors: GreenSpace[] } {
  // Same vertex-count and perimeter math as the step-3.5 geometric fallback,
  // so the macro-snap distance lands in the same neighborhood and the
  // distance-adjustment loop has a similar starting point.
  const targetMi = distanceKm * 0.621371;
  const numLoopWaypoints = targetMi >= 22 ? 4 : targetMi >= 14 ? 3 : 2;
  const loopPerimeterFactor =
    numLoopWaypoints === 4 ? 6.243 :
    numLoopWaypoints === 3 ? 5.464 :
    LOOP_TRIANGLE_PERIMETER;
  const waypointDist = distanceKm / (loopPerimeterFactor * ROUTING_OVERHEAD);

  // Bearing seeded from variant for diversity across the candidate pool.
  // 137 chosen so consecutive variants land on visibly different bearings
  // (golden-angle-ish — minimizes near-duplicates in a small variant range).
  const seedBearing = (variant * 137) % 360;
  // Spread across 330° (matches step-3.5 fallback) so the last vertex isn't
  // antipodal to the first — leaves room for the closing leg to take a
  // different street back.
  const arc = 330;
  const step = arc / numLoopWaypoints;

  // Scale snap radius with waypoint distance. Long loops put vertices ~4-6km
  // out — many of those land in water or unreachable zones, and the nearest
  // viable corridor (e.g. Hudson River Greenway from an East Village macro
  // vertex floating in the Hudson) can be 1.5-2km away. A flat 0.8km radius
  // left those vertices anchorless, OSRM routed to the geometric vertex in
  // water, and the route either failed or produced a degenerate shape.
  // Short loops (1-3mi, waypointDist < 1.5km) keep the tight 0.6km radius
  // so vertices don't snap across half of Manhattan to the same big park.
  const SNAP_RADIUS_KM = Math.max(0.5, Math.min(2.0, waypointDist * 0.4));

  // Anchors that route as linear extensions (greenways, bridges, named
  // pedestrian/cycle paths, waterfronts) get a 0.5× distance discount when
  // the snap chooser compares candidates within range. Catches the user-
  // reported East Village 16mi case where the Manhattan-side macro vertex
  // snapped to the nearest park (Washington Sq, dense weaving back to
  // start) instead of the Hudson River Greenway (clean linear extension
  // up/down the river). Park anchors are still picked when nothing else
  // is in range — the discount only flips ties.
  const LINEAR_KINDS = new Set<GreenSpace['kind']>([
    'cycleway', 'footway', 'path', 'route', 'waterfront',
  ]);

  const usedAnchorIdx = new Set<number>();
  const waypoints: RoutePoint[] = [center];
  const anchors: GreenSpace[] = [];

  // Bearing-jitter sequence: try the planned bearing first, then ±30°, ±60°
  // before giving up. When the planned bearing puts the vertex in water or
  // a no-anchor zone, a small bearing nudge often reaches a viable anchor
  // without breaking the macro shape much. The user-reported 16mi case had
  // a NW vertex floating in the Hudson — with no jitter, the vertex stayed
  // geometric and OSRM routed to a point in the river. With ±30° jitter,
  // the vertex moves to Chelsea Piers / Hudson River Park.
  const JITTER_DEGREES = [0, 30, -30, 60, -60];

  for (let k = 0; k < numLoopWaypoints; k++) {
    const baseAngle = (seedBearing + k * step) % 360;
    let bestIdx = -1;
    let bestEffectiveDist = SNAP_RADIUS_KM;

    for (const jitter of JITTER_DEGREES) {
      const angle = (baseAngle + jitter + 360) % 360;
      const macroVertex = destinationPoint(center, angle, waypointDist);
      for (let idx = 0; idx < greenSpaces.length; idx++) {
        if (usedAnchorIdx.has(idx)) continue;
        const d = haversineDistance(macroVertex, greenSpaces[idx].point);
        if (d > SNAP_RADIUS_KM) continue;
        const effectiveDist = LINEAR_KINDS.has(greenSpaces[idx].kind) ? d * 0.5 : d;
        if (effectiveDist < bestEffectiveDist) {
          bestEffectiveDist = effectiveDist;
          bestIdx = idx;
        }
      }
      // Stop searching jitters as soon as we found something — preserves
      // the planned bearing as much as possible. Only jitter when needed.
      if (bestIdx !== -1) break;
    }

    if (bestIdx !== -1) {
      const gs = greenSpaces[bestIdx];
      waypoints.push(gs.point);
      anchors.push(gs);
      usedAnchorIdx.add(bestIdx);
    } else {
      // No anchor found across all jittered bearings — use the geometric
      // vertex at the planned bearing. Rare in practice (jitter sweep is
      // 5 bearings × ~50 anchors typically) but possible in genuinely
      // park-poor areas.
      const macroVertex = destinationPoint(center, baseAngle, waypointDist);
      waypoints.push(macroVertex);
    }
  }

  waypoints.push(center);
  // Reorder intermediate vertices to minimize max turn severity (CLAUDE.md
  // #37). Macro-snap's planned bearings are well-spread so the input order
  // is usually optimal, but jitter retries can move vertices by ±60° from
  // their planned bearing — the bearing-sorted (visit-in-planned-order)
  // sequence isn't always U-turn-free after that.
  const intermediate = waypoints.slice(1, -1);
  const reordered = reorderForLowestUTurn(center, intermediate);
  if (reordered !== intermediate) {
    // Re-pair anchors with the reordered points. An anchor matches a
    // point iff lat/lng coincide; geometric-only vertices have no anchor.
    const newAnchors: GreenSpace[] = [];
    for (const pt of reordered) {
      const matched = anchors.find((a) =>
        a.point.lat === pt.lat && a.point.lng === pt.lng
      );
      if (matched) newAnchors.push(matched);
    }
    return { waypoints: [center, ...reordered, center], anchors: newAnchors };
  }
  return { waypoints, anchors };
}

/**
 * Corridor-loop strategy (CLAUDE.md #38). Picks linear corridor anchors
 * (greenways, waterfronts, bridges, named cycleways/footways) in each
 * cardinal direction so every leg of the loop runs ALONG a corridor
 * instead of weaving through dense grid.
 *
 * The user-reported East Village 16mi pattern: macro-snap got the Brooklyn
 * lobe clean (via Williamsburg Bridge corridor) but the Manhattan side
 * still block-weaved through SoHo because the Manhattan-side vertex
 * snapped to a park (Washington Sq, dense weaving back) instead of the
 * Hudson River Greenway (clean linear extension). Macro-snap has corridor
 * preference (#36 0.5x discount) but it only flips ties — when the closest
 * anchor to the macro vertex is a park, the park still wins.
 *
 * Corridor-loop guarantees corridors get used: it filters the anchor pool
 * to corridors-only first, then assigns one to each cardinal direction by
 * angular fit. Routes generated this way naturally have lobes per leg
 * (each leg traverses or extends along a corridor) rather than grid fill.
 *
 * Falls back to geometric vertex when no corridor exists in a given
 * direction (rare in NYC but possible elsewhere).
 */
function generateCorridorLoop(
  center: RoutePoint,
  distanceKm: number,
  variant: number,
  greenSpaces: GreenSpace[],
): { waypoints: RoutePoint[]; anchors: GreenSpace[] } {
  // Same vertex-count math as macro-snap so the two strategies produce
  // candidates at comparable target distances.
  const targetMi = distanceKm * 0.621371;
  const numLoopWaypoints = targetMi >= 22 ? 4 : targetMi >= 14 ? 3 : 2;
  const loopPerimeterFactor =
    numLoopWaypoints === 4 ? 6.243 :
    numLoopWaypoints === 3 ? 5.464 :
    LOOP_TRIANGLE_PERIMETER;
  const waypointDist = distanceKm / (loopPerimeterFactor * ROUTING_OVERHEAD);

  // Filter to corridor-only anchors. Linear features extend over distance
  // (a runner traversing them gets clean linear progress) vs parks
  // (point destinations that OSRM weaves to/from).
  const LINEAR_KINDS = new Set<GreenSpace['kind']>([
    'cycleway', 'footway', 'path', 'route', 'waterfront',
  ]);
  const corridors = greenSpaces.filter((gs) => LINEAR_KINDS.has(gs.kind));

  // If too few corridors, this strategy can't work — fall back to
  // macro-snap (which itself falls back to geometric if needed).
  if (corridors.length < numLoopWaypoints) {
    return generateMacroSnapLoop(center, distanceKm, variant, greenSpaces);
  }

  // Bearings spaced for variety, same seed math as macro-snap.
  const seedBearing = (variant * 137) % 360;
  const arc = 360; // full 360° spread for corridor-loop; corridors don't
                    // benefit from the 330° asymmetry that prevented closing-
                    // leg overlap in macro-snap.
  const step = arc / numLoopWaypoints;

  // Tolerance for "corridor in this direction": ±60° from target bearing.
  // Corridors don't always sit exactly on the planned compass — the user's
  // start might not have a corridor due south but does have one to the SW.
  // 60° tolerance lets us catch those without crossing into the next
  // cardinal direction.
  const SEARCH_ARC_DEG = 60;
  // Distance band: corridor anchor should be roughly at waypointDist from
  // center (where a macro-snap vertex would land). 0.4×–1.6× allows for
  // varied corridor positions while keeping the loop perimeter on target.
  const MIN_DIST_KM = waypointDist * 0.4;
  const MAX_DIST_KM = waypointDist * 1.6;

  const usedAnchorIdx = new Set<number>();
  const waypoints: RoutePoint[] = [center];
  const anchors: GreenSpace[] = [];

  for (let k = 0; k < numLoopWaypoints; k++) {
    const targetBearing = (seedBearing + k * step) % 360;

    // Score each corridor: lower is better. Components:
    //   - bearing fit: angular distance from target bearing (0 = perfect)
    //   - distance fit: |dist - waypointDist| / waypointDist
    //   - tier bonus: tier-1 corridors (named) get a small discount
    let bestIdx = -1;
    let bestScore = Infinity;
    for (let idx = 0; idx < corridors.length; idx++) {
      if (usedAnchorIdx.has(idx)) continue;
      const c = corridors[idx];
      const cBearing = bearingFrom(center, c.point);
      const cDist = haversineDistance(center, c.point);
      const bearingFit = angleDiff(cBearing, targetBearing);
      if (bearingFit > SEARCH_ARC_DEG) continue;
      if (cDist < MIN_DIST_KM || cDist > MAX_DIST_KM) continue;
      const distFit = Math.abs(cDist - waypointDist) / waypointDist;
      const tierBonus = c.tier === 1 ? -0.1 : 0;
      // Combined score: bearing fit dominates (degrees ÷ 60 normalized to
      // [0,1]), distance fit secondary (weighted 0.5), tier as small thumb.
      const score = (bearingFit / 60) + distFit * 0.5 + tierBonus;
      if (score < bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    }

    if (bestIdx !== -1) {
      const c = corridors[bestIdx];
      // Need to find the original index in greenSpaces array for usedAnchorIdx
      // (we filtered to `corridors` for iteration but `usedAnchorIdx` is keyed
      // by `corridors` index — that's fine, both use the same filtered list).
      waypoints.push(c.point);
      anchors.push(c);
      usedAnchorIdx.add(bestIdx);
    } else {
      // No corridor in this direction — fall back to a geometric vertex at
      // the target bearing. Allows corridor-loop to succeed even when
      // corridor coverage is sparse in one cardinal direction.
      waypoints.push(destinationPoint(center, targetBearing, waypointDist));
    }
  }

  waypoints.push(center);

  // Reorder for lowest U-turn (same as macro-snap, CLAUDE.md #37).
  const intermediate = waypoints.slice(1, -1);
  const reordered = reorderForLowestUTurn(center, intermediate);
  if (reordered !== intermediate) {
    const newAnchors: GreenSpace[] = [];
    for (const pt of reordered) {
      const matched = anchors.find((a) =>
        a.point.lat === pt.lat && a.point.lng === pt.lng
      );
      if (matched) newAnchors.push(matched);
    }
    return { waypoints: [center, ...reordered, center], anchors: newAnchors };
  }
  return { waypoints, anchors };
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
  const corridorWidth = 30; // degrees either side of main bearing
  const seedBearing = (variant * 97 + (prefs.lowTraffic ? 30 : 0)) % 360;

  // Pre-annotate green spaces once (bearing/dist/score independent of corridor).
  const annotated = greenSpaces
    .map((gs) => ({
      gs,
      bearing: bearingFrom(center, gs.point),
      dist: haversineDistance(center, gs.point),
      score: scoreGreenSpace(gs, strategy, prefs.lowTraffic),
    }))
    .filter((a) => a.dist <= halfDist);

  // A single random corridor bearing often points into water or a sparse area
  // (the same class of bug that bit the geometric fallback). Try N evenly-
  // spaced bearings and keep the corridor with the most green spaces.
  // The seed-derived bearing is checked first so variant diversity is preserved
  // when multiple corridors are equally good.
  const NUM_BEARINGS = 6;
  let corridorSpaces: typeof annotated = [];
  for (let i = 0; i < NUM_BEARINGS; i++) {
    const bearing = (seedBearing + (i * 360) / NUM_BEARINGS) % 360;
    const corridor = annotated
      .filter((a) => angleDiff(a.bearing, bearing) <= corridorWidth)
      .sort((a, b) => a.dist - b.dist);
    if (corridor.length > corridorSpaces.length) {
      corridorSpaces = corridor;
    }
  }

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

// Public OSRM endpoint (router.project-osrm.org) typically responds in
// 200-700ms; 1-2s when busy, occasionally 3-5s under load. 8s leaves
// headroom for the long tail without letting one stuck call dominate.
// Tighter limits (5s) caused legitimate slow responses to abort and
// fall through to the no-route path, which surfaced as straight-line
// triangles in the UI. Mutable so resilience tests can use a small
// timeout (e.g. 100ms) without sitting 8s per fixture.
let OSRM_TIMEOUT_MS = 8000;
export function setOSRMTimeoutMs(ms: number): void { OSRM_TIMEOUT_MS = Math.max(1, ms); }

// Overall wall-clock budget for the candidate-resolution loop in
// generateOSRMRoutes. Mutable so tests can dial it down. Production
// default of 18s leaves comfortable headroom for healthy public OSRM
// (~5s end-to-end) while bounding the worst case the user sees.
let RESOLUTION_BUDGET_MS = 18000;
export function setResolutionBudgetMs(ms: number): void { RESOLUTION_BUDGET_MS = Math.max(1, ms); }

/** Retry wrapper for fetch with timeout.
 *
 * Retries are skipped for AbortError (timeout) — a request that already took
 * 8s will almost always time out again on the same slow endpoint, doubling
 * the wall-clock for no benefit. Real network errors (DNS, connection reset)
 * still get one retry since those can be transient.
 */
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
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      if (i === retries) throw err;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw new Error('OSRM request failed after retries');
}

/** One contiguous segment along the routed polyline, corresponding to a
 *  single OSM way. The `name` field is what we lean on for off-street
 *  detection: real public streets almost always have one, while interior
 *  pedestrian paths inside private superblocks (residential complexes,
 *  hospital/college campuses, gated developments) typically don't. */
interface OSRMStep {
  name: string;
  distance: number; // meters
  geometry: {
    coordinates: [number, number][];
    type: string;
  };
  /** OSRM maneuver schema — only the fields the turn-by-turn UI consumes.
   *  `location` is [lng, lat] (GeoJSON convention). `type` covers
   *  turn/depart/arrive/continue/fork/etc.; `modifier` (left/right/sharp
   *  left/...) is absent for depart/arrive. */
  maneuver?: {
    type: string;
    modifier?: string;
    location: [number, number];
  };
}

interface OSRMLeg {
  steps: OSRMStep[];
}

interface OSRMRoute {
  geometry: {
    coordinates: [number, number][];
    type: string;
  };
  distance: number; // meters
  duration: number; // seconds
  /** Per-segment breakdown when the request was made with `steps=true`.
   *  Empty array in legacy/mock callers — `computeOffStreetRatio` treats
   *  missing steps as "can't classify" and returns 0 (no rejection). */
  legs: OSRMLeg[];
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
  /** retrace + overlap of the final polyline. Stored so the post-sort
   *  cleanness gate can check best-of-pool without recomputing. */
  dirtiness?: number;
  /** Lower = better. Sums retrace + overlap + 0.1·stubs + 0.3·|1−distRatio|.
   *  Used to pick the best of several candidates that all passed hard
   *  rejection. Geometric step-3.5 fallback assigns a high penalty so it
   *  loses to any real candidate. */
  qualityPenalty: number;
  /** OSRM maneuver list flattened from all legs. Attached to the final
   *  GeneratedRoute so the in-run banner / voice prompts / map arrow can
   *  drive turn-by-turn without a fresh routing call. Undefined for the
   *  step-3.5 geometric fallback when steps weren't fetched. */
  steps?: ManeuverStep[];
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
/** Returns true when `routeKm` rounds to the same display unit as `targetKm`.
 *  Imperial rounds to whole miles; metric rounds to whole km. The displayed
 *  `route.distance` field is the user-visible mile/km integer — if these
 *  don't match, the user reads the wrong number on the run screen even when
 *  the absolute error is small. */
export function roundedDisplayMatches(routeKm: number, targetKm: number, units: 'imperial' | 'metric'): boolean {
  if (units === 'metric') {
    return Math.round(routeKm) === Math.round(targetKm);
  }
  const MI_PER_KM = 0.621371;
  return Math.round(routeKm * MI_PER_KM) === Math.round(targetKm * MI_PER_KM);
}

/** Looser version of roundedDisplayMatches: rounded distance is within ±1 of
 *  target. Used as a guardrail on the wrong-display fallback pool — without it,
 *  the fallback could ship a 4mi route for a 7mi request (ratio 0.57 still
 *  passes the [0.5, 1.3] candidate gate). User has explicitly accepted "off
 *  by one mile" as fallback UX, but anything beyond that is read as broken. */
export function nearDisplayMatches(routeKm: number, targetKm: number, units: 'imperial' | 'metric'): boolean {
  if (units === 'metric') {
    return Math.abs(Math.round(routeKm) - Math.round(targetKm)) <= 1;
  }
  const MI_PER_KM = 0.621371;
  return Math.abs(Math.round(routeKm * MI_PER_KM) - Math.round(targetKm * MI_PER_KM)) <= 1;
}

async function fetchOSRMRouteAdjusted(
  waypoints: RoutePoint[],
  center: RoutePoint,
  targetDistanceKm: number,
  // 2 retries (3 total attempts). Combined with fetchWithRetry no longer
  // double-retrying on AbortError and the new RESOLUTION_BUDGET_MS ceiling
  // at the candidate-loop level, per-candidate worst case is bounded at
  // ~24s and the total user-visible spinner duration is bounded at the
  // budget regardless. Keeping 3 attempts (vs 2) is what gives the
  // distance-refinement loop room to converge — dropping to 2 caused
  // out-and-back fixtures to undershoot target by ~25%.
  maxRetries: number = 2,
  // When set, the early-exit accept window also requires the route's
  // displayed distance integer (rounded mile or km) to match the target's.
  // Without this, the ±15% accept window happily exits on a 5.7mi route for
  // a 5mi request — which then displays as "6 mi" in the UI and feels broken.
  // If iteration runs out without satisfying both, returns best-so-far (the
  // caller decides whether to accept or hard-reject the wrong-display result).
  requireRoundedTargetUnits: 'imperial' | 'metric' | null = null,
): Promise<{ route: OSRMRoute | null; waypoints: RoutePoint[] }> {
  // Sequential first attempt + iterative refinement. A previous experiment
  // hedged 3 parallel scales upfront for wall-clock wins, but tripled the
  // request volume to public OSRM which then rate-limited the burst — many
  // candidates resolved to null and the algorithm displayed raw waypoints
  // as straight-line "routes" through buildings and across rivers. Sticking
  // to one call per attempt keeps total in-flight requests = candidate count.
  let currentWaypoints = waypoints;
  // Track the best result we've seen across attempts so we don't accidentally
  // return a worse-fitting later attempt just because it ran last.
  let best: { route: OSRMRoute; waypoints: RoutePoint[]; ratio: number } | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const route = await fetchOSRMRoute(currentWaypoints);
    if (!route) {
      traceEmit('adjust-no-route', { attempt });
      if (best) return { route: best.route, waypoints: best.waypoints };
      return { route: null, waypoints: currentWaypoints };
    }

    const routeDistKm = route.distance / 1000;
    const ratio = routeDistKm / targetDistanceKm;
    traceEmit('adjust-attempt', { attempt, distKm: routeDistKm, ratio, target: targetDistanceKm });

    // Track best-so-far by closeness to ratio = 1.
    const prevBestErr = best ? Math.abs(1 - best.ratio) : Infinity;
    const thisErr = Math.abs(1 - ratio);
    if (!best || thisErr < prevBestErr) {
      best = { route, waypoints: currentWaypoints, ratio };
    }

    // Accept window ±15%. Tighter (±7%) caused over-iteration and
    // overshoot — routes ended up FARTHER from target after extra scaling.
    // When requireRoundedTargetUnits is set, the route also has to round to
    // the same display integer as the target — otherwise we keep iterating.
    // The current attempt remains tracked as `best` either way, so if we
    // exhaust retries without satisfying the rounded-display check, we still
    // return the closest-by-ratio route rather than failing entirely.
    if (ratio >= 0.85 && ratio <= 1.15) {
      const roundedOk =
        !requireRoundedTargetUnits ||
        roundedDisplayMatches(routeDistKm, targetDistanceKm, requireRoundedTargetUnits);
      if (roundedOk) {
        return { route, waypoints: currentWaypoints };
      }
    }

    // Divergence detection. Scaling waypoints across a hard barrier
    // (river, large park, expressway) can flip the OSRM route from
    // ~10km → ~28km in a single step (observed in Columbus 8mi). When the
    // new attempt is dramatically WORSE than the best so far, further
    // scaling will only oscillate — return the best.
    if (attempt > 0 && thisErr > prevBestErr * 2.0) {
      traceEmit('adjust-diverged', { ratio, prevBestRatio: best!.ratio });
      return { route: best!.route, waypoints: best!.waypoints };
    }

    // Out of retries — return the closest attempt rather than the latest.
    if (attempt === maxRetries) {
      // Bearing-rotation retry: when scaling-based iteration converges on a
      // wrong-display result, the local road network in the original
      // direction simply may not offer a route at the requested mile.
      // Rotate the best waypoints 45° around center and try ONE more OSRM
      // call. Only fires when the caller asked for rounded-display match
      // AND the best attempt failed it — bounded extra cost (1 call per
      // truly-stuck candidate). Swap in the rotated route only if it's
      // BOTH within the accept window AND rounds to the right display
      // integer; otherwise keep best-so-far.
      if (
        requireRoundedTargetUnits &&
        !roundedDisplayMatches(best.route.distance / 1000, targetDistanceKm, requireRoundedTargetUnits)
      ) {
        const rotated = best.waypoints.map((p) => {
          const distFromCenter = haversineDistance(center, p);
          if (distFromCenter < 0.001) return p; // ~1m epsilon — leave start/end
          const newBearing = (bearingFrom(center, p) + 45) % 360;
          return destinationPoint(center, newBearing, distFromCenter);
        });
        const rRoute = await fetchOSRMRoute(rotated);
        if (rRoute) {
          const rDistKm = rRoute.distance / 1000;
          const rRatio = rDistKm / targetDistanceKm;
          if (
            rRatio >= 0.85 && rRatio <= 1.15 &&
            roundedDisplayMatches(rDistKm, targetDistanceKm, requireRoundedTargetUnits)
          ) {
            traceEmit('adjust-rotation-recovered', {
              originalRatio: best.ratio, rotatedRatio: rRatio,
              originalDistKm: best.route.distance / 1000, rotatedDistKm: rDistKm,
            });
            return { route: rRoute, waypoints: rotated };
          }
          traceEmit('adjust-rotation-no-help', { rotatedRatio: rRatio, rotatedDistKm: rDistKm });
        } else {
          traceEmit('adjust-rotation-no-route', {});
        }
      }
      traceEmit('adjust-give-up', { bestRatio: best.ratio });
      return { route: best.route, waypoints: best.waypoints };
    }

    // Scale waypoints toward/away from center. Damped to prevent
    // overcorrection, then HARD-CAPPED to [0.80, 1.25] per step so that
    // a wildly-off ratio (e.g. 0.55 — usually means waypoint landed past
    // a barrier and OSRM cut it short) can't fling waypoints into water on
    // the next attempt. Trace data showed candidates oscillating
    // 10km → 28km → 7km → 11km when an unbounded scale (1.8×) pushed
    // waypoints across the East/Hudson rivers.
    const scaleFactor = 1 / ratio;
    const dampedScale = 1 + (scaleFactor - 1) * 0.7;
    const cappedScale = Math.max(0.80, Math.min(1.25, dampedScale));
    currentWaypoints = scaleWaypoints(currentWaypoints, center, cappedScale);
  }

  return best
    ? { route: best.route, waypoints: best.waypoints }
    : { route: null, waypoints: currentWaypoints };
}


/**
 * Deterministic synthetic OSRM stand-in for the quality harness.
 *
 * Emits plausible road-shaped geometry through the given waypoints — enough
 * to exercise the post-OSRM pipeline (lollipop removal, retrace/overlap
 * detection, scoring, ranking) without burning quota on the public
 * router.project-osrm.org endpoint.
 *
 * Geometry is two-harmonic perpendicular wobble around the straight line
 * between each pair of waypoints, tapered to zero at the endpoints so the
 * route actually touches each waypoint. Wobble seed is derived from the
 * endpoint coordinates so the same waypoints always produce the same shape.
 *
 * NOT representative of real road geometry. Use only for algorithm-level
 * QA of waypoint selection + post-processing, not for end-user simulation.
 */
export function mockOSRMRoute(waypoints: RoutePoint[]): OSRMRoute {
  const STEP_KM = 0.025; // ~25m between sampled points
  // Wobble amplitude as fraction of segment length. Tuned so arc length
  // sits at ~1.25–1.4× straight line — close enough to ROUTING_OVERHEAD
  // that the distance-adjustment loop converges similarly to real OSRM.
  // Tuned so mock arc length is ~1.35-1.45× straight-line — matches real
  // OSRM's typical road-routing overhead. Was 0.09 (gave ~1.10×) which
  // made anchored routes look 25% shorter in mock than they'd actually
  // be in production, causing false rounding-distance failures.
  const WOBBLE_FRACTION = 0.22;

  const coords: [number, number][] = [];

  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    const direct = haversineDistance(a, b);
    if (direct < 0.001) continue;

    const steps = Math.max(8, Math.round(direct / STEP_KM));
    const bearing = bearingFrom(a, b);
    const perpBearing = (bearing + 90) % 360;

    if (i === 0) coords.push([a.lng, a.lat]);

    // Phase derived from segment endpoints — same waypoints → same shape.
    const seed = a.lat * 31 + a.lng * 71 + b.lat * 53 + b.lng * 13;

    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const baseLat = a.lat + (b.lat - a.lat) * t;
      const baseLng = a.lng + (b.lng - a.lng) * t;

      // Sin(πt) taper: zero at endpoints, full amplitude at midpoint.
      const taper = Math.sin(Math.PI * t);
      const wobble =
        WOBBLE_FRACTION * direct *
        (Math.sin(seed + t * 12.7) * 0.6 + Math.sin(seed * 1.3 + t * 31.3) * 0.4) *
        taper;

      const wobbled = destinationPoint(
        { lat: baseLat, lng: baseLng },
        perpBearing,
        wobble
      );
      coords.push([wobbled.lng, wobbled.lat]);
    }
  }

  // Retrace injection (test-only): mirror first `fraction*N` points onto the
  // tail. The mirrored segment shares both endpoints (rounded to 4dp = ~10m)
  // with the original, so retraceRatio counts each mirrored segment as
  // retraced. Used by tests to simulate dense-grid retrace; production keeps
  // mockOSRMRetraceFraction=0 so the mock route is the simple wobble.
  if (mockOSRMRetraceFraction > 0 && coords.length > 4) {
    const mirrorCount = Math.floor(coords.length * mockOSRMRetraceFraction);
    for (let k = mirrorCount - 1; k >= 0; k--) {
      coords.push([coords[k][0], coords[k][1]]);
    }
  }

  let distMeters = 0;
  for (let k = 1; k < coords.length; k++) {
    const p1 = { lat: coords[k - 1][1], lng: coords[k - 1][0] };
    const p2 = { lat: coords[k][1], lng: coords[k][0] };
    distMeters += haversineDistance(p1, p2) * 1000;
  }

  // 9 min/km walking pace → 540 s/km
  const duration = (distMeters / 1000) * 540;

  return {
    geometry: { type: 'LineString', coordinates: coords },
    distance: distMeters,
    duration,
    // Mock leaves legs empty. `computeOffStreetRatio` treats empty steps as
    // "can't classify" and returns 0, so the harness behaves as before.
    legs: [],
  };
}

/**
 * Toggle for the synthetic OSRM stand-in. Off in production; the harness
 * flips it on with `--mock-osrm` (auto-on with `--synthetic`) so a single
 * QA run exercises the real waypoint-selection + post-processing pipeline
 * without depending on the public OSRM endpoint.
 */
let osrmMockEnabled = false;
export function setOSRMMock(enabled: boolean): void { osrmMockEnabled = enabled; }
export function isOSRMMockEnabled(): boolean { return osrmMockEnabled; }

/**
 * Deterministic seed override for `generateOSRMRoutes`. When set (by the
 * harness), replaces `Date.now()` everywhere variant/bearing seeding is
 * computed so two runs over the same fixture produce byte-identical
 * waypoints. Production leaves this null so each user request shuffles.
 */
let deterministicSeed: number | null = null;
export function setDeterministicSeed(seed: number | null): void {
  deterministicSeed = seed;
  // Reset the LCG state so failure rolls are reproducible across runs even
  // when no fixture explicitly resets between iterations.
  mockFailureRollState = (seed ?? 0) | 0;
}
function getSeed(): number {
  return deterministicSeed !== null ? deterministicSeed : Date.now();
}

/**
 * Failure-injection knobs for the mock. All zero by default — mock returns
 * instantly with success, matching the legacy behavior that callers rely on.
 *
 * The harness uses these to simulate degraded public-OSRM conditions that
 * the perfect-network mock would otherwise hide. Past bugs (Build 21
 * straight-line triangles, the 60s spinner hang) only manifest when the
 * network is slow or rate-limiting; without injection the harness cannot
 * prove the algorithm degrades gracefully under those conditions.
 *
 * latencyMs: each mock call sleeps this long before returning (or timing
 *   out / failing). Models tail latency on public OSRM (typical 200-700ms,
 *   busy 1-2s, occasional 3-5s spikes per CLAUDE.md).
 * failureRate: 0..1 probability that the call returns null (modeling 5xx
 *   or "no route found" responses).
 * timeoutRate: 0..1 probability that the call rejects with an AbortError
 *   AFTER waiting OSRM_TIMEOUT_MS (modeling a request that hits the
 *   client-side timeout). Sleeps the full timeout so wall-clock measurements
 *   include the slow-then-fail path that real OSRM exhibits.
 */
let mockOSRMLatencyMs = 0;
let mockOSRMFailureRate = 0;
let mockOSRMTimeoutRate = 0;
// Retrace injection: when > 0, mockOSRMRoute appends a mirror of the first
// `fraction*N` points to the end, creating exact-coordinate retrace at that
// fraction. Lets tests simulate dense Manhattan-grid behavior where real
// OSRM produces ~20-40% retrace because one-way streets force backtracking.
// The pure-wobble mock can't naturally produce this — without injection,
// any test of "high-retrace candidate handling" would be a no-op.
let mockOSRMRetraceFraction = 0;
export function setMockOSRMLatency(ms: number): void { mockOSRMLatencyMs = Math.max(0, ms); }
export function setMockOSRMFailureRate(rate: number): void { mockOSRMFailureRate = Math.max(0, Math.min(1, rate)); }
export function setMockOSRMTimeoutRate(rate: number): void { mockOSRMTimeoutRate = Math.max(0, Math.min(1, rate)); }
export function setMockOSRMRetraceFraction(fraction: number): void { mockOSRMRetraceFraction = Math.max(0, Math.min(0.9, fraction)); }
/** Reset all mock knobs to zero. Call between fixtures so one fixture's
 *  degradation settings don't leak into the next. */
export function resetMockOSRMFailures(): void {
  mockOSRMLatencyMs = 0;
  mockOSRMFailureRate = 0;
  mockOSRMTimeoutRate = 0;
  mockOSRMRetraceFraction = 0;
}

/** Simple LCG so failure rolls are deterministic when the harness sets a
 *  deterministic seed. Math.random() would make resilience-fixture results
 *  jitter run-to-run, defeating the point of pinned thresholds. */
let mockFailureRollState = 0;
function mockFailureRoll(): number {
  if (deterministicSeed !== null) {
    mockFailureRollState = (mockFailureRollState * 1103515245 + 12345) & 0x7fffffff;
    return mockFailureRollState / 0x7fffffff;
  }
  return Math.random();
}

/**
 * In-memory cache of successful OSRM responses keyed by request URL.
 * Identical waypoints (e.g. when the user taps refresh from the same start)
 * skip the network round trip entirely. LRU-bounded to avoid unbounded
 * growth in long sessions; failures aren't cached so transient network
 * errors can still be retried.
 */
const osrmRouteCache = new Map<string, OSRMRoute>();
// Mutable so the test harness can raise the cap before recording a snapshot
// (a single harness run can fire 100+ OSRM calls; the production default
// would silently evict half of them, breaking deterministic replay).
// Production: 200 covers ~30 prior generations worth of waypoint hits and
// is small enough that the AsyncStorage JSON blob stays under ~500KB even
// with full-geometry geojson polylines.
let osrmCacheMax = 200;
export function setOSRMCacheMax(n: number): void { osrmCacheMax = n; }
/** Clear the in-memory OSRM cache. The harness calls this between fixtures
 *  in deterministic mode so cross-fixture cache hits don't make results
 *  depend on which fixtures preceded the current one. */
export function clearOSRMCache(): void { osrmRouteCache.clear(); }

/**
 * Pre-warm the TCP+TLS connection to the OSRM endpoint by firing a trivial
 * routing request and discarding the result. Saves ~100-300ms of handshake
 * latency on the first real route call. Pair with prefetch from the route
 * screen so the first user-visible Generate hits warm sockets.
 */
export function prewarmOSRMConnection(center: RoutePoint): void {
  // Tiny ~110m route (1° lat ≈ 111km, so 0.001° ≈ 110m) — minimal OSRM
  // compute, just enough to establish the connection. Skip when mocked.
  if (osrmMockEnabled) return;
  const wp1 = `${center.lng},${center.lat}`;
  const wp2 = `${center.lng},${center.lat + 0.001}`;
  const url = `${osrmBase}/${wp1};${wp2}?overview=false`;
  fetch(url).catch(() => {
    // Fire-and-forget; the real route call surfaces any endpoint errors.
  });
}

/**
 * Snapshot the OSRM cache for record-and-replay testing — same pattern as
 * the Overpass snapshot. Lets the quality harness run fully offline once
 * a recording exists, removing flakiness from the public OSRM endpoint.
 */
export interface OSRMSnapshot {
  routes: Array<[string, OSRMRoute]>;
}

export function dumpOSRMCache(): OSRMSnapshot {
  return { routes: Array.from(osrmRouteCache.entries()) };
}

export function loadOSRMCache(snapshot: Partial<OSRMSnapshot>): void {
  if (snapshot.routes) {
    for (const [k, v] of snapshot.routes) osrmRouteCache.set(k, v);
  }
}

/**
 * Fraction of a routed polyline (by distance) that's on UNNAMED OSM ways
 * AND outside every known green-space catchment.
 *
 * Why this matters: OSRM's foot profile happily routes through interior
 * `highway=footway`/`highway=service` paths inside private superblocks
 * (residential complexes, hospital/college campuses, gated developments).
 * Those paths are real in OSM but invisible on consumer basemaps, so the
 * route renders as "a diagonal through nothing." Real public streets
 * almost universally have a `name` tag in OSM; interior paths usually
 * don't. Park paths are ALSO usually unnamed, but they fall inside known
 * green-space polygons we already fetch, so we exclude them from the
 * count.
 *
 * Returns 0 when:
 *  - The route's `legs` array is empty (mock OSRM, or response without
 *    `steps=true`) — caller should treat this as "can't classify, don't
 *    reject."
 *  - All steps are named or all unnamed steps fall inside green spaces.
 */
export function computeOffStreetRatio(
  route: OSRMRoute,
  greenSpaces: GreenSpace[],
): number {
  const totalMeters = route.distance;
  if (totalMeters <= 0) return 0;
  if (!route.legs || route.legs.length === 0) return 0;

  let offStreetMeters = 0;
  for (const leg of route.legs) {
    for (const step of leg.steps) {
      // Named step → assume real public street. This is the dominant signal.
      if (step.name && step.name.trim().length > 0) continue;
      // Unnamed step. Step distance ≤20m is often just a maneuver edge
      // (corner clipping, lane transition) — too short to matter.
      if (step.distance < 20) continue;
      // Allow if the step's geometry centroid falls inside a known green
      // space catchment (parks, named cycleways, pedestrian zones,
      // waterfronts). One representative point is enough — green-space
      // catchments are tens-to-hundreds of meters and steps are typically
      // <500m in dense areas.
      if (isStepInsideAnyGreenSpace(step, greenSpaces)) continue;
      offStreetMeters += step.distance;
    }
  }
  return offStreetMeters / totalMeters;
}

function isStepInsideAnyGreenSpace(step: OSRMStep, greenSpaces: GreenSpace[]): boolean {
  const coords = step.geometry?.coordinates;
  if (!coords || coords.length === 0) return false;
  const mid = coords[Math.floor(coords.length / 2)];
  const point = { lat: mid[1], lng: mid[0] };

  for (const gs of greenSpaces) {
    // Polygon green spaces (parks/gardens/nature reserves): catchment is
    // the effective radius derived from the OSM bounds, plus 50m of slop
    // to absorb perimeter paths that hug the edge of the park.
    // Linear features (named cycleways, pedestrian streets, waterfront)
    // have areaSize=0; we use a small fixed catchment because each record
    // represents one centroid along the feature, not its full extent.
    const radiusKm = gs.areaSize > 0
      ? Math.sqrt(gs.areaSize / Math.PI) + 0.05
      : 0.10;
    if (haversineDistance(point, gs.point) <= radiusKm) return true;
  }
  return false;
}

/**
 * Call OSRM to get a walking route through the given waypoints.
 */
async function fetchOSRMRoute(waypoints: RoutePoint[]): Promise<OSRMRoute | null> {
  // Mock short-circuit — bypasses cache, network, and retry. Used only
  // by the quality harness to keep algorithm QA decoupled from OSRM quota.
  // Failure-injection knobs simulate degraded public-OSRM conditions
  // (latency, 5xx, client-timeout) that perfect-mock would otherwise hide.
  if (osrmMockEnabled) {
    if (waypoints.length < 2) return null;

    // Apply latency BEFORE the failure roll. Real OSRM that returns a 5xx
    // still costs the full request RTT — the algorithm's wall-clock
    // sensitivity needs to see that cost in the mock too. For the timeout
    // case, sleep the full OSRM_TIMEOUT_MS so resilience tests measure the
    // same waterfall the user actually sits through.
    const willTimeout = mockOSRMTimeoutRate > 0 && mockFailureRoll() < mockOSRMTimeoutRate;
    const willFail = !willTimeout && mockOSRMFailureRate > 0 && mockFailureRoll() < mockOSRMFailureRate;
    const sleepMs = willTimeout ? OSRM_TIMEOUT_MS : mockOSRMLatencyMs;
    if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
    // Both timeout and 5xx surface to upstream as null — matching real
    // fetchOSRMRoute behavior where the outer catch converts AbortError
    // to null. The wall-clock cost is what differentiates them.
    if (willTimeout || willFail) return null;
    return mockOSRMRoute(waypoints);
  }

  const coords = coordsString(waypoints);
  // steps=true gives us per-segment way names. We use those names to detect
  // when OSRM has routed through unnamed interior paths inside private
  // superblocks (PCV/Stuy Town, college campuses, gated complexes). Costs
  // ~10-20% more response payload but no extra requests. See
  // `computeOffStreetRatio` for the consumer.
  const url = `${osrmBase}/${coords}?overview=full&geometries=geojson&steps=true`;

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
    if (osrmRouteCache.size >= osrmCacheMax) {
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
 * In-memory cache for `?alternatives=true` responses. Keyed by URL (which
 * encodes both the waypoints and the alternatives flag), so it never
 * collides with `osrmRouteCache`. Stores the FULL alternatives array per URL
 * so subsequent callers asking for alt 1, 2, etc. don't re-hit OSRM.
 */
const osrmAlternativesCache = new Map<string, OSRMRoute[]>();

/**
 * Fetch a direct route between two waypoints WITH up to N alternatives.
 *
 * Public OSRM (router.project-osrm.org runs OSRM 5.x) supports
 * `alternatives=true` which returns the primary shortest path plus up to 3
 * structurally different routes (e.g. one via Park Ave, one via 6th Ave).
 * We use this for p2p when the corridor has no usable green-space anchors —
 * without it, the perpendicular-offset diversification snaps back to the
 * same dominant avenue every refresh, producing the user-reported "i=0
 * a=0 g=0 r=1, same route every refresh" pattern.
 *
 * Returns the full `routes[]` array. routes[0] is the primary (same as
 * fetchOSRMRoute would return), routes[1+] are the alternatives. Returns
 * empty array on network failure.
 */
async function fetchOSRMRouteAlternatives(
  waypoints: RoutePoint[],
  alternativesCount: number,
): Promise<OSRMRoute[]> {
  if (osrmMockEnabled) {
    // Mock OSRM doesn't model alternatives; return just the primary so
    // harness behavior is unchanged. The diversification this function
    // provides is only meaningful against a real road network.
    if (waypoints.length < 2) return [];
    const route = mockOSRMRoute(waypoints);
    return route ? [route] : [];
  }

  const coords = coordsString(waypoints);
  const url = `${osrmBase}/${coords}?overview=full&geometries=geojson&steps=true&alternatives=${alternativesCount}`;

  const cached = osrmAlternativesCache.get(url);
  if (cached !== undefined) {
    osrmAlternativesCache.delete(url);
    osrmAlternativesCache.set(url, cached);
    return cached;
  }

  try {
    const res = await fetchWithRetry(url);
    if (!res.ok) return [];
    const data: OSRMResponse = await res.json();
    if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
      return [];
    }
    if (osrmAlternativesCache.size >= osrmCacheMax) {
      const oldest = osrmAlternativesCache.keys().next().value;
      if (oldest !== undefined) osrmAlternativesCache.delete(oldest);
    }
    osrmAlternativesCache.set(url, data.routes);
    return data.routes;
  } catch (err) {
    console.warn('OSRM alternatives fetch failed:', err);
    return [];
  }
}

/**
 * Triangle perimeter factor for the (center, wp1, wp2, center) waypoint
 * pattern with wp1 at bearing B and wp2 at bearing B+210°, both at the
 * same distance d from center:
 *   haversine perimeter = 2d + 2d·sin(105°) ≈ 3.93·d
 * Used to back-solve waypoint distance from the target route distance.
 *
 * Previously this was `2π` (treating the loop as a full circle), which
 * over-shrunk the radius by ~33% — the routed result undershot the target
 * by 20–30% on every loop fixture that fell through to the geometric path.
 */
const LOOP_TRIANGLE_PERIMETER = 2 + 2 * Math.sin((105 * Math.PI) / 180);

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
  // Waypoint count scales with distance. A 3-vertex triangle (2 waypoints +
  // start/end) is fine up to ~10mi loops where each leg is ~3-4km; for a 30mi
  // loop the same triangle puts each waypoint 9km from start, which in NYC
  // routinely lands in the Hudson or East River. More waypoints = each one
  // sits closer to start AND the loop wraps around water naturally.
  // ≤14mi: 2 waypoints (current shape), 14-22mi: 3 waypoints (square),
  // 22-32mi: 4 waypoints (pentagon).
  const targetMi = distanceKm * 0.621371;
  const numWaypoints = targetMi >= 22 ? 4 : targetMi >= 14 ? 3 : 2;
  const seedBearing = (variant * 73) % 360;

  if (numWaypoints === 2) {
    // Original triangle shape — keep byte-identical for distances where
    // it works (avoids regression on the well-tested ≤14mi path).
    const waypointDist = distanceKm / (LOOP_TRIANGLE_PERIMETER * ROUTING_OVERHEAD);
    const wp1 = destinationPoint(center, seedBearing, waypointDist);
    // Offset wp2 30° from antipodal so the route forms a triangle, not a
    // straight line — perfect-line waypoints make OSRM use the same streets
    // both ways, which produces high retrace.
    const wp2 = destinationPoint(center, (seedBearing + 210) % 360, waypointDist);
    return [center, wp1, wp2, center];
  }

  // For N=3 waypoints (4-vertex polygon: start + 3 waypoints + return-to-start):
  //   2 radial segments (center↔wp1, wp3↔center) of length D
  //   2 chord segments (wp1↔wp2, wp2↔wp3) of length 2*D*sin(60°) ≈ 1.732*D
  //   total ≈ (2 + 2*1.732) * D = 5.464 * D
  // For N=4 waypoints (5-vertex polygon):
  //   2 radial segments + 3 chords of 2*D*sin(45°) ≈ 1.414*D
  //   total ≈ (2 + 3*1.414) * D = 6.243 * D
  // Solve for D given target distanceKm with ROUTING_OVERHEAD baked in.
  const perimeterFactor = numWaypoints === 3 ? 5.464 : 6.243;
  const waypointDist = distanceKm / (perimeterFactor * ROUTING_OVERHEAD);
  // Spread waypoints across an arc of ~330° (leave 30° gap on the closing
  // side so the wpN→center leg doesn't overlap the center→wp1 leg). 360°/N
  // would space them evenly but the final leg back to center would parallel
  // the first leg out, causing visible retrace.
  const arcDegrees = 330;
  const wps: RoutePoint[] = [];
  for (let i = 0; i < numWaypoints; i++) {
    const angle = (seedBearing + i * (arcDegrees / (numWaypoints - 1))) % 360;
    wps.push(destinationPoint(center, angle, waypointDist));
  }
  return [center, ...wps, center];
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
      // Mention up to two distinct named anchors so the title reflects the
      // full character of the route — "East River Park & Tompkins Loop" is
      // more useful than just "East River Park Loop" when the route visits
      // both parks. Truncate the second name's "Park"/"Square Park" suffix
      // to keep titles readable.
      const second = namedAnchors[1].name!.replace(/\s*(?:Square\s*)?Park$|\s*Greenway$|\s*Garden(?:s)?$|\s*Promenade$/i, '');
      return `${namedAnchors[0].name} & ${second} Loop`;
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

/**
 * Flatten an OSRMRoute's legs into a single ManeuverStep[] for the in-run
 * turn-by-turn UI. Drops `depart` (origin isn't a maneuver to announce) and
 * `arrive` (destination isn't either — the run is already finishing). What
 * remains is the actual list of turns/forks the user needs to make. Returns
 * undefined when the route has no maneuver data so callers can branch on
 * "passive tracing only".
 */
export function extractManeuvers(osrmRoute: OSRMRoute): ManeuverStep[] | undefined {
  if (!osrmRoute.legs || osrmRoute.legs.length === 0) return undefined;
  const out: ManeuverStep[] = [];
  for (const leg of osrmRoute.legs) {
    for (const step of leg.steps) {
      if (!step.maneuver) continue;
      const t = step.maneuver.type;
      if (t === 'arrive' || t === 'depart') continue;
      const [lng, lat] = step.maneuver.location;
      out.push({
        type: t,
        modifier: step.maneuver.modifier,
        location: { lat, lng },
        name: step.name ?? '',
        distanceM: step.distance,
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Main route generation pipeline
// ---------------------------------------------------------------------------

/** Fabricated elevation gain when real data is unavailable */
export function fabricateElevationGain(distKm: number, variant: number): number {
  return Math.round(5 + distKm * 3 + variant * 2);
}

/** Candidate strategies for variety. With 12-candidate pools each strategy
 *  gets ~2-3 attempts. 'macro-snap' is the loop-shape-first strategy
 *  (CLAUDE.md #34). 'corridor-loop' (CLAUDE.md #38) is the linear-corridor-
 *  first strategy: picks corridor anchors (greenways, waterfronts, bridges,
 *  named cycleways/footways) in each cardinal direction so every leg of the
 *  loop runs along a corridor instead of weaving through dense grid.
 *  Compete against the existing strategies; chooser picks the best by
 *  quality. */
const STRATEGIES: CandidateStrategy[] = ['large-parks', 'named-paths', 'balanced', 'macro-snap', 'corridor-loop'];

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
  end?: RoutePoint | null,
  excludeAnchors?: RoutePoint[] | null,
  // Polyline of the previously-shown route, passed on refresh. Candidates
  // whose geometry essentially replays this polyline are demoted in the
  // final pick so refresh produces visible variety even when the underlying
  // candidate pool is small (e.g. p2p with no green-space anchors, where
  // OSRM's alternatives are the only diversification source). Null on
  // initial generate.
  excludePoints?: RoutePoint[] | null,
  // INTERNAL: tracks retry depth for the auto-retry on quality-driven empty
  // results. Bumped to 1 by the recursive retry call below when the first
  // pass yielded no usable candidates. Never set by external callers.
  _retryAttempt: number = 0,
): Promise<GeneratedRoute[]> {
  // Reset failure diagnostics on every call. Populated only on the path
  // that returns [] so the UI can render "n/q/w" counts in the error
  // banner. A successful generation leaves it null.
  lastFailureDiagnostics = null;
  traceEmit('generate-start', { center, distanceKm, routeType, count, prefs, end: end ?? null, retryAttempt: _retryAttempt });
  // Wall-clock anchor for the retry deadline check at the bottom — bounds
  // total time across first-pass + retry so the user can't sit on the
  // spinner past the existing degraded ceiling.
  const generateStartMs = Date.now();

  // Step 1: Fetch enriched green spaces and highway segments in a single
  // Overpass round trip (shared across all candidates).
  const radiusKm = calculateSearchRadius(routeType, distanceKm, center, end);
  const { greenSpaces: rawGreenSpaces, highwayPoints } = await fetchGreenSpacesAndHighways(center, radiusKm);
  // Refresh exclusion: drop green spaces within 0.5km of any anchor used by
  // the previously-shown route. Forces the sectoring/scoring to pick a
  // different park set, which in turn produces different waypoints, which
  // bypasses the OSRM cache (keyed by exact waypoint coords). Without this,
  // dense urban areas with few high-scoring parks deterministically replay
  // the same top picks every refresh — same waypoints, same OSRM result,
  // same route. Match the 0.5km threshold used by the per-candidate
  // diversity filter below for consistency.
  // Skip when the exclusion would leave fewer than 2 waypoint-eligible
  // greens — better to repeat than to force a geometric fallback in a
  // genuinely park-poor area.
  const WAYPOINT_KINDS = new Set(['park', 'garden', 'nature', 'waterfront']);
  let greenSpaces = rawGreenSpaces;
  if (excludeAnchors && excludeAnchors.length > 0) {
    const filtered = rawGreenSpaces.filter((gs) =>
      !excludeAnchors.some((ex) => haversineDistance(ex, gs.point) < 0.5)
    );
    const eligibleAfter = filtered.filter((gs) => WAYPOINT_KINDS.has(gs.kind)).length;
    // Threshold is route-type aware. Loops use sectoring across multiple
    // anchors to produce shape diversity, so they need >= 2 eligibles after
    // exclusion. Point-to-point only needs 1 anchor (a single via-waypoint
    // along the corridor between start and end), so >= 1 is sufficient —
    // and necessary for refresh to actually do anything in narrow corridors
    // like NoHo → Central Park where only ~2 parks (Madison Sq, Bryant
    // Park) sit in the corridor at all. With the previous >= 2 threshold,
    // excluding 1 left 1 remaining, the filter was skipped, same park
    // re-selected, refresh produced identical route every time.
    const minEligibleForExclusion = routeType === 'point-to-point' ? 1 : 2;
    if (eligibleAfter >= minEligibleForExclusion) {
      greenSpaces = filtered;
      traceEmit('refresh-exclude', { excluded: rawGreenSpaces.length - filtered.length, remainingEligible: eligibleAfter });
    } else {
      traceEmit('refresh-exclude-skipped', { reason: 'insufficient-remaining', eligibleAfter, threshold: minEligibleForExclusion });
    }
  }
  traceEmit('overpass-result', {
    radiusKm,
    greenSpaceCount: greenSpaces.length,
    highwayPointCount: highwayPoints.length,
  });

  // Step 2: Generate count + safety-margin candidate waypoint sets with
  // diversity. Each candidate excludes parks used by previous candidates so
  // routes go through genuinely different areas. We deliberately generate
  // more than `count` so the tightened quality rejection (overlap, stubs,
  // retrace) has alternatives to fall back to without dropping all the way
  // to the geometric step-3.5 emergency fallback (which produces no-anchor
  // routes the user doesn't want).
  // Generate more candidates than the user asked for — quality rejection
  // can leave us with too few survivors otherwise. SAFETY_EXTRAS = 6 keeps
  // generation responsive (~7 OSRM calls vs ~3) while still giving the
  // scorer enough variants to find a clean candidate near target. The
  // public OSRM router is the dominant latency source, so capping the
  // candidate pool directly drives perceived speed.
  // SAFETY_EXTRAS = 11 makes count(1) + extras(11) = 12, hitting the bumped
  // MAX_INTERNAL_CANDIDATES cap. Was 6 (yielding 7 candidates) before the
  // East Village dense-grid q=6 incident.
  // On RETRY (_retryAttempt > 0): smaller pool of 6 candidates. The first
  // pass already exhausted the 12-candidate budget; retry is a fast targeted
  // second roll of the dice rather than another full pass. Keeps total
  // wall-clock bounded — see RETRY_DEADLINE_MS below.
  const SAFETY_EXTRAS = _retryAttempt === 0 ? 11 : 5;
  const candidateCount = Math.min(MAX_INTERNAL_CANDIDATES, count + SAFETY_EXTRAS);
  // Offset the seed on retry so variant indices yield genuinely different
  // waypoint geometry from the first pass (Date.now()-based drift typically
  // produces different values across calls anyway, but the offset guarantees
  // it under deterministic-seed mode and tightens the no-overlap property).
  const timeSeed = (getSeed() + _retryAttempt * 99991) % 100000;
  type CandidateSpec = {
    variant: number;
    waypoints: RoutePoint[];
    anchors: GreenSpace[];
    /** When set, the OSRM dispatch awaits this instead of issuing its own
     *  fetch. Used to share one `alternatives=true` call across multiple
     *  alternative-route candidates without N parallel network requests. */
    prefetchedResult?: Promise<{ route: OSRMRoute | null; waypoints: RoutePoint[] }>;
  };
  const candidates: CandidateSpec[] = [];
  const usedParkPoints: RoutePoint[] = []; // Parks already used by earlier candidates

  // For p2p, fire OSRM's `alternatives=true` request in parallel with the
  // candidate-generation loop so we have structurally-different routes ready
  // by the time we'd otherwise fall back to perpendicular-offset waypoints.
  // Why this matters: perpendicular offsets ≤500m snap back to the same
  // dominant avenue under OSRM's shortest-path logic, producing the same
  // rendered route every refresh. OSRM's native alternatives consider the
  // road network and return genuinely different paths (e.g. one via Park
  // Ave, one via 6th Ave). One extra OSRM call, much better refresh variety.
  const p2pAlternativesPromise: Promise<OSRMRoute[]> =
    routeType === 'point-to-point' && end
      ? fetchOSRMRouteAlternatives([center, end], 3)
      : Promise.resolve([]);

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
      // On refresh (signaled by excludeAnchors being passed at all, even if
      // empty), skip the direct shortest-path candidate. Why: the direct
      // route's quality penalty almost always wins for p2p (distRatio = 1,
      // zero detour cost, no anchors to add up to a meaningful bonus), so
      // keeping it in the pool meant every refresh re-elected the same
      // shortest-path result. The user reported "I'm hitting refresh for a
      // route from NoHo to Central Park, and you're only returning the same
      // option." Skipping i=0 on refresh forces all candidates to be green-
      // space variants → different greens per refresh (anchors excluded by
      // the existing usedParkPoints filter) → genuinely different routes.
      const isRefresh = excludeAnchors !== undefined;
      if (i === 0 && !isRefresh) {
        // First candidate, initial Generate: direct route — let OSRM find
        // the shortest path. This is what most users want from a fresh p2p
        // generate; the variety comes on refresh.
        waypoints = [center, end];
      } else {
        // Other candidates (always on refresh, candidates 1+ on initial):
        // route via green spaces for scenic variety
        const result = generateGreenSpacePointToPoint(center, end, prefs, variant, availableGreenSpaces, strategy);
        if (result.anchors.length > 0) {
          waypoints = result.waypoints;
          anchors = result.anchors;
        } else {
          // No green-space anchor for this candidate. Skip — OSRM's native
          // `alternatives=true` (fired in parallel above) will provide the
          // diversity. Previously this generated a perpendicular-offset
          // midpoint waypoint, but offsets ≤500m reliably snapped back to
          // the same dominant avenue, so OSRM returned the same route every
          // refresh. Bailing here lets the alternatives pool dominate.
          continue;
        }
      }
    } else if (routeType === 'out-and-back') {
      // macro-snap and corridor-loop are loop-only — out-and-back has 1-D
      // geometry, no shape to plan macro-first. Fall through.
      const obStrategy = (strategy === 'macro-snap' || strategy === 'corridor-loop')
        ? 'balanced' : strategy;
      const result = generateGreenSpaceOutAndBack(center, distanceKm, prefs, variant, availableGreenSpaces, obStrategy);
      waypoints = result.waypoints;
      anchors = result.anchors;
    } else {
      // Loop. macro-snap plans the loop SHAPE first then snaps to anchors
      // (#34); corridor-loop picks corridor anchors directly in cardinal
      // directions (#38); other strategies pick anchors first then connect.
      let result;
      if (strategy === 'macro-snap') {
        result = generateMacroSnapLoop(center, distanceKm, variant, availableGreenSpaces);
      } else if (strategy === 'corridor-loop') {
        result = generateCorridorLoop(center, distanceKm, variant, availableGreenSpaces);
      } else {
        result = generateGreenSpaceLoop(center, distanceKm, prefs, variant, availableGreenSpaces, strategy);
      }
      waypoints = result.waypoints;
      anchors = result.anchors;
    }

    // Track which parks this candidate used so later candidates avoid them
    for (const a of anchors) {
      usedParkPoints.push(a.point);
    }

    // Apply water crossing removal before OSRM, keeping anchors in sync so
    // expandParkWaypoints and route naming see the actual post-replacement
    // green spaces. Pass route distance so the threshold scales — a 6mi
    // loop's natural wp1→wp2 chord is ~3km, well over the fixed 1.5km
    // legacy default which would drop both waypoints.
    {
      const synced = removeWaterCrossingsWithAnchors(waypoints, greenSpaces, center, anchors, distanceKm);
      waypoints = synced.waypoints;
      anchors = synced.anchors;
    }

    // Expand large parks into entry/exit pairs so OSRM routes through
    // the park interior, not just past its edge
    waypoints = expandParkWaypoints(waypoints, anchors);

    traceEmit('candidate-built', {
      i,
      strategy,
      variant,
      anchorCount: anchors.length,
      anchorNames: anchors.map((a) => a.name).filter(Boolean),
      waypointCount: waypoints.length,
      waypoints,
    });
    candidates.push({ variant, waypoints, anchors });
  }

  // For p2p, append two alternative-route candidates that share a single
  // pre-fetched `alternatives=true` OSRM call. We always skip alt 0:
  //   - On initial generate, alt 0 is identical to the i=0 direct candidate
  //     above (same waypoints, same shortest-path geometry) so adding it
  //     would just duplicate work.
  //   - On refresh, alt 0 is the route the user just refreshed away from —
  //     showing it again defeats the point of refresh.
  // The two slots below pull alts 1 and 2, which are structurally different
  // routes from the OSRM road-network engine (e.g. via a different avenue).
  if (routeType === 'point-to-point' && end) {
    for (let altIdx = 1; altIdx <= 2; altIdx++) {
      const altWaypoints: RoutePoint[] = [center, end];
      const prefetchedResult = (async () => {
        const alts = await p2pAlternativesPromise;
        return { route: alts[altIdx] ?? null, waypoints: altWaypoints };
      })();
      candidates.push({
        variant: timeSeed + 1000 + altIdx,
        waypoints: altWaypoints,
        anchors: [],
        prefetchedResult,
      });
      traceEmit('candidate-built', {
        i: candidates.length - 1,
        strategy: 'osrm-alternative' as CandidateStrategy,
        variant: timeSeed + 1000 + altIdx,
        anchorCount: 0,
        anchorNames: [],
        waypointCount: altWaypoints.length,
        waypoints: altWaypoints,
      });
    }
  }

  // Step 3: Fetch OSRM routes for all candidates, with iterative distance
  // adjustment. If a candidate's OSRM distance is too far from the target,
  // shrink/expand waypoints toward center and re-query (up to 2 retries).
  // Point-to-point routes skip adjustment since they must reach the destination.
  //
  // PROGRESSIVE RESOLUTION: process results AS THEY ARRIVE so the scorer
  // can see them in completion order rather than blocking on Promise.all.
  // No early exit — we always wait for all candidates so the final pick is
  // the best of N, not just the first that crosses some quality threshold.
  // An earlier early-exit experiment (Build 22) shipped routes that scored
  // well numerically (low retrace, on-target distance, anchored) but had
  // visually bad shape — multiple disconnected sub-loops, two-axis
  // out-and-backs — because the quality scorer doesn't currently penalize
  // shape complexity. Waiting for all candidates lets the best-of-N
  // property mask those scorer blind spots until we can address them
  // properly.
  const useAdjustment = routeType !== 'point-to-point';
  // Loop and out-and-back targets are user-chosen — we should land on the
  // displayed mile/km the user requested. Point-to-point distance is fixed
  // by the start/end pair; nothing to converge to.
  const adjustUnits = useAdjustment ? prefs.units ?? 'imperial' : null;
  type Tagged = { idx: number; result: { route: OSRMRoute | null; waypoints: RoutePoint[] } };
  const pending = new Map<number, Promise<Tagged>>();
  // Stagger candidate OSRM launches against public OSRM (skipped under
  // mock — the harness needs to stay fast). Firing all 7 candidates at
  // once is a documented null-spike trigger: the public endpoint throttles
  // bursts and returns 429s, which become nulls and lose candidates. With
  // wrong-display fallback now removed, every null counts directly toward
  // "No routes found." 150ms × 7 candidates ≈ 1s added launch window —
  // well under the 18s resolution budget, big drop in burst pressure.
  // CLAUDE.md note: "Total simultaneous request count matters more than
  // per-candidate math."
  // Tighter stagger on retry — first pass already paid the burst-pressure
  // price, retry runs fewer candidates so total in-flight requests stay
  // low even at 75ms spacing.
  const launchSpacingMs = osrmMockEnabled ? 0 : (_retryAttempt === 0 ? 150 : 75);
  for (let idx = 0; idx < candidates.length; idx++) {
    const c = candidates[idx];
    // Candidates with a prefetched result (p2p OSRM-alternatives slots)
    // skip the launch stagger entirely — they don't issue their own OSRM
    // call, just await the shared `alternatives=true` promise that was
    // fired before this loop started.
    const launchDelay = c.prefetchedResult ? 0 : idx * launchSpacingMs;
    const p = (async (): Promise<Tagged> => {
      if (launchDelay > 0) await new Promise((r) => setTimeout(r, launchDelay));
      // 4 retries (5 total attempts). Was 2 (3 attempts), but the per-step
      // scale cap of [0.80, 1.25] meant a candidate starting at ratio 0.4
      // (waypoints landed in a tight pocket) could only reach ratio 0.625
      // after 2 retries — still outside the [0.5, 1.3] hard-reject band.
      // User-reported East Village 4mi refresh failed with q=9 (d=8 of
      // those distance-band rejects); 4 retries lets ratio 0.4 reach 0.97.
      // Worst case latency bounded by the 18s resolution budget +
      // divergence detection (returns best-so-far if attempt 2x worse).
      const result = c.prefetchedResult
        ? await c.prefetchedResult
        : useAdjustment
          ? await fetchOSRMRouteAdjusted(c.waypoints, center, distanceKm, 4, adjustUnits)
          : { route: await fetchOSRMRoute(c.waypoints), waypoints: c.waypoints };
      return { idx, result };
    })();
    pending.set(idx, p);
  }

  // Overall wall-clock budget (set via setResolutionBudgetMs, default 18s).
  // Healthy public OSRM resolves all 7 candidates in ~5s end-to-end; the
  // budget leaves headroom for the long tail without letting the user sit
  // on the spinner for ~60s when the endpoint is degraded (the documented
  // bug). On budget expiry we take whatever candidates have already
  // resolved and pick the best — preserves the best-of-N property when the
  // network is fast, degrades to best-of-what-finished when it's not. Step
  // 3.5 is suppressed in that case (it would only add another ~50s to wait
  // on the same slow endpoint).
  const resolveStartMs = Date.now();
  let budgetExpired = false;
  const budgetSentinel: Promise<'__budget'> = new Promise((resolve) => {
    setTimeout(() => {
      budgetExpired = true;
      resolve('__budget');
    }, RESOLUTION_BUDGET_MS);
  });

  // Build resolved candidates. NEW BEHAVIOR: don't hard-reject candidates
  // that fail strict thresholds — KEEP them with a quality score so we can
  // pick the least-bad survivor instead of falling through to the geometric
  // step-3.5 fallback (which often produces *worse* routes than the
  // candidates we'd otherwise discard). Step-3.5 only fires now when the
  // OSRM call itself returned nothing AND we have budget left AND at least
  // one rejection was for QUALITY (not network — if it was all network,
  // step 3.5 will also fail and just burn more user time).
  const resolved: ResolvedCandidate[] = [];
  // Last-resort pool: candidates that pass every other check but whose
  // distance rounds to the wrong display integer (e.g. 5.6mi for a 5mi
  // request → would display "6 mi"). We keep them so that if NOTHING in
  // `resolved` (right-display) survives — and step 3.5 also can't find a
  // right-display route — we can fall back to the cleanest wrong-display
  // candidate rather than show "no routes found" and strand the user.
  const wrongDisplayFallback: ResolvedCandidate[] = [];
  // Track WHY candidates fell out so step 3.5 can decide whether to even try.
  let osrmNullCount = 0;
  let qualityRejectCount = 0;
  // Per-reason breakdown so the UI banner can tell us which gate dominates
  // when generation fails — q=6 alone hides whether to loosen off-street,
  // backtrack, or distance.
  const rejectReasons = {
    distance: 0, barrier: 0, highway: 0, offStreet: 0, pendantLoop: 0, backtrack: 0,
    aspect: 0, turnDensity: 0, polsbyPopper: 0, turnCluster: 0,
  };
  // Hard rejection only for "completely unusable" cases: distance way off,
  // crosses a clear barrier, or routes along highways. Soft thresholds on
  // retrace/overlap/stubs feed into a quality score; the worst-quality
  // candidates lose to better ones but still beat the geometric fallback.
  while (pending.size > 0) {
    const winner = await Promise.race<Tagged | '__budget'>([
      ...pending.values(),
      budgetSentinel,
    ]);
    if (winner === '__budget') {
      traceEmit('resolution-budget-expired', {
        elapsedMs: Date.now() - resolveStartMs,
        unresolvedCount: pending.size,
        resolvedSoFar: resolved.length,
      });
      break;
    }
    pending.delete(winner.idx);
    const i = winner.idx;
    const osrmResult = winner.result;
    const osrmRoute = osrmResult.route;
    if (osrmRoute) {
      const rawPoints = osrmRoute.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
      const rawDistKm = osrmRoute.distance / 1000;
      const skipLollipopRemoval = routeType === 'out-and-back' || osrmMockEnabled;
      const afterLollipop = skipLollipopRemoval
        ? rawPoints
        : removeSelfintersections(rawPoints);
      let afterLollipopKm = rawDistKm;
      if (afterLollipop !== rawPoints) {
        afterLollipopKm = 0;
        for (let k = 1; k < afterLollipop.length; k++) {
          afterLollipopKm += haversineDistance(afterLollipop[k - 1], afterLollipop[k]);
        }
        traceEmit('post-process-trim', { i, stage: 'lollipop', before: rawDistKm, after: afterLollipopKm });
      }
      // Always trim dead-end stubs. The user explicitly does not want any
      // visible stubs — even one ruins the "can the runner follow this as
      // a single path?" property. Out-and-back routes are exempt because
      // their U-turn at the far end is the intended pattern, not a stub.
      //
      // Stub threshold scales with target distance, capped at 300m. For long
      // routes (4mi+) we want the full 300m to catch peninsula visits like
      // the user's Build 23 N. Williamsburg spur. For short routes (1-2mi)
      // a 300m "stub" is 20-40% of the route — trimming it would gut the
      // geometry, producing a 0.7mi route from a 1mi request. Cap at 8% of
      // target so a 1mi route caps stub trimming at ~130m (no false trims
      // of natural triangle legs).
      const stubThresholdKm = Math.min(0.30, distanceKm * 0.08);
      const afterStubs = routeType === 'out-and-back'
        ? afterLollipop
        : trimStubs(afterLollipop, stubThresholdKm);
      // NOTE: an earlier experiment added a "side-trip detector" via
      // trimDetours() to catch 500m+ peninsula visits with intermediate
      // turns (which trimStubs misses). It chopped 50%+ off legitimate
      // loop routes because in a loop, the start and end region naturally
      // has spatially-close points across a large path span — the
      // detector flagged loop closure itself as a detour. The hard-reject
      // (retraced + overlap > 0.50) covers the truly egregious cases;
      // borderline visible spurs that aren't clean U-turns remain a known
      // gap. Don't reintroduce trimDetours without solving the loop-
      // closure false positive.
      let afterStubsKm = afterLollipopKm;
      if (afterStubs !== afterLollipop) {
        afterStubsKm = 0;
        for (let k = 1; k < afterStubs.length; k++) {
          afterStubsKm += haversineDistance(afterStubs[k - 1], afterStubs[k]);
        }
        traceEmit('post-process-trim', { i, stage: 'stubs', before: afterLollipopKm, after: afterStubsKm });
      }
      // Trim pendant loops — closed sub-loops attached to the rest of the
      // polyline by a single bridge segment that's traversed in both
      // directions (e.g. "go west one block, around a square, back east the
      // same block, continue"). To physically run the polyline as drawn,
      // the runner has to cover the bridge twice. The user explicitly does
      // not want this shape: "users will get so confused about how to run
      // it." Trim is preferable to reject — surfacing "no routes found"
      // when a perfectly fine route exists 50m east is worse UX than
      // showing a slightly-shorter version of the same route. Distance
      // hard-reject (distRatio band) downstream catches candidates whose
      // pendant accounted for most of their length. OAB exempt — its
      // return leg looks like a pendant of every segment.
      const afterPendant = routeType === 'out-and-back'
        ? afterStubs
        : trimPendantLoops(afterStubs);
      let afterPendantKm = afterStubsKm;
      if (afterPendant !== afterStubs) {
        afterPendantKm = 0;
        for (let k = 1; k < afterPendant.length; k++) {
          afterPendantKm += haversineDistance(afterPendant[k - 1], afterPendant[k]);
        }
        traceEmit('post-process-trim', { i, stage: 'pendant-loops', before: afterStubsKm, after: afterPendantKm });
      }
      // Backstop retrace-spur trim (CLAUDE.md #40). Catches stubs that
      // survived trimStubs (which requires ≥150° apex) and trimPendantLoops
      // (which requires endpoint match within 20m). User-reported pendant
      // near Corlears Hook on a 7mi East Village loop slipped past both
      // detectors. Threshold 50m matches the user's spec — any contiguous
      // retrace ≥50m is visible enough to ruin the "single continuous path"
      // property. Bounded blast radius inside the trimmer caps removal at
      // 25% of route length so degenerate near-OAB candidates don't get
      // gutted.
      const points = routeType === 'out-and-back'
        ? afterPendant
        : trimRetracedSpurs(afterPendant, 50);
      if (points !== afterPendant) {
        let retraceTrimKm = 0;
        for (let k = 1; k < points.length; k++) {
          retraceTrimKm += haversineDistance(points[k - 1], points[k]);
        }
        traceEmit('post-process-trim', { i, stage: 'retrace-spurs', before: afterPendantKm, after: retraceTrimKm });
      }
      // Recompute distance from the FINAL points (after both lollipop
      // removal and stub trimming) so the displayed mileage matches the
      // polyline drawn on the map.
      let distKm: number;
      if (points === rawPoints) {
        distKm = osrmRoute.distance / 1000;
      } else {
        distKm = 0;
        for (let k = 1; k < points.length; k++) {
          distKm += haversineDistance(points[k - 1], points[k]);
        }
      }
      const estimatedTime = Math.round(osrmRoute.duration / 60);
      const distRatio = distanceKm > 0 ? distKm / distanceKm : 1;
      // HARD REJECT: distance catastrophically wrong (catches OSRM degenerate cases)
      const maxRatio = routeType === 'point-to-point' ? 3.0 : 1.3;
      const minRatio = routeType === 'point-to-point' ? 0.2 : 0.5;
      if (distRatio > maxRatio || distRatio < minRatio) {
        qualityRejectCount++;
        rejectReasons.distance++;
        traceEmit('candidate-rejected', { i, reason: 'distance', distKm, distRatio, target: distanceKm });
        continue;
      }
      // HARD REJECT: route crosses a clear barrier (tunnel, bridge, water)
      if (routeType !== 'point-to-point' && hasRoutedBarrierCrossing(points, greenSpaces, center, distanceKm)) {
        qualityRejectCount++;
        rejectReasons.barrier++;
        traceEmit('candidate-rejected', { i, reason: 'barrier', distKm });
        continue;
      }
      const hwProximity = computeHighwayProximity(points, highwayPoints);
      // HARD REJECT: route runs alongside major highways. Was 0.15 (15%
      // of route within 100m of a major-road centerpoint), but with the
      // old centroid-only highway dataset, long highways like the BQE
      // were represented by a single point — many sampled route positions
      // weren't "near" the BQE even when running directly along it. The
      // user-reported Williamsburg "Sidestreet Shuffle" hit 19mi and
      // included a long stretch alongside I-278; the centroid was km
      // away so hwProximity barely registered. With highway data now
      // densified (every ~150m along each way), the same proximity
      // measurement is much more accurate, and the previous 15% gate
      // would have caught the BQE case. Tightening to 8% as a margin
      // because runners tolerate near-zero exposure to interstates and
      // 8% of a 30km route is still ~2.4km — generous floor.
      if (hwProximity > 0.08) {
        qualityRejectCount++;
        rejectReasons.highway++;
        traceEmit('candidate-rejected', { i, reason: 'highway', hwProximity });
        continue;
      }
      // HARD REJECT: too much of the route is on unnamed OSM ways outside
      // any known green space. Catches OSRM routing through interior
      // pedestrian paths in private superblocks (residential complexes,
      // hospital/college campuses) — the user reported PCV/Stuy Town as
      // a recurring case where the rendered polyline visibly cuts across
      // blocks where no public street exists. See `computeOffStreetRatio`
      // for the rationale.
      // Threshold scales with distance: short routes (≤5km) keep the
      // original 10% (PCV diagonals on a 3mi route are ~50%, well above
      // the floor). Long routes (≥20km) get up to 15% headroom because
      // the macro-snap strategy + extension into adjacent neighborhoods
      // means more legitimate exposure to brief unnamed-path transitions
      // (housing-project edges, unmapped bridge approaches, college
      // campus crossings). User-reported East Village 16mi case (May 2026,
      // CLAUDE.md #35): 6 of 12 candidates rejected for off-street with
      // the 10% flat threshold — most were extending into Brooklyn or
      // Murray Hill where 1-2km of unnamed pass-through pushed long-route
      // ratios over 10% even though the route was otherwise clean. With
      // 15% at this distance, the same routes would pass while a true
      // PCV-diagonal candidate (>40% off-street) would still be rejected.
      if (routeType !== 'point-to-point') {
        const offStreetRatio = computeOffStreetRatio(osrmRoute, greenSpaces);
        const offStreetThreshold = Math.min(0.15, 0.10 + Math.max(0, distanceKm - 5) * 0.0033);
        if (offStreetRatio > offStreetThreshold) {
          qualityRejectCount++;
          rejectReasons.offStreet++;
          traceEmit('candidate-rejected', { i, reason: 'off-street', offStreetRatio, threshold: offStreetThreshold });
          continue;
        }
      }
      // Extract OSRM maneuvers once so the street-share check below and the
      // candidateRecord construction further down don't both pay the cost.
      const candidateSteps = extractManeuvers(osrmRoute);
      // HARD REJECT: more than 50% of named-street distance on a single
      // street. Catches the "avenue-out, avenue-back" pattern that reads
      // on the map as a real loop (no retrace, no pendant loops, distance
      // matches) but to a runner is "I went up 5th Ave for 3mi, came down
      // 6th Ave for 3mi, that's a glorified out-and-back". Out-and-back
      // exempt — single-street IS the route. Point-to-point exempt — a
      // direct shortest path can legitimately follow one avenue end-to-end.
      // Threshold 0.50 (not 0.30 as originally proposed) because dense
      // urban grids legitimately route up to ~40% on dominant avenues
      // even on coherent loops; 0.50 is the egregious floor.
      if (routeType === 'loop') {
        const streetShare = maxStreetShare(candidateSteps);
        if (streetShare > 0.50) {
          qualityRejectCount++;
          rejectReasons.backtrack++;
          traceEmit('candidate-rejected', { i, reason: 'street-share', streetShare });
          continue;
        }
      }
      // SOFT METRICS: feed into a quality score. Lower retrace/overlap/stubs
      // = higher quality. We KEEP all candidates that pass hard rejection
      // and pick the best by quality at the end. This avoids the past bug
      // where a 28%-retrace candidate was thrown out and replaced by a
      // 50%-retrace step-3.5 fallback.
      const retraced = retraceRatio(points);
      const overlap = overlapSegmentRatio(points);
      // Match the threshold used by trimStubs above so the count agrees with
      // what we actually trimmed — otherwise short routes would report
      // stubs=0 (because countStubs's wider default catches nothing) while
      // longer routes use the full 300m window.
      const stubs = countStubs(points, stubThresholdKm);
      // Safety net: pendant loops should be eliminated by trimPendantLoops
      // upstream. If any survive, something is wrong with the trimmer
      // (overlapping detections, geometry edge case, etc.) — reject rather
      // than ship an unrunnable polyline. OAB exempt for the same reason
      // the trim skipped it: its return leg is the same edges in reverse
      // by design.
      const pendantLoops = routeType === 'out-and-back' ? 0 : countPendantLoops(points);
      if (pendantLoops > 0) {
        qualityRejectCount++;
        rejectReasons.pendantLoop++;
        traceEmit('candidate-rejected', { i, reason: 'pendant-loop', pendantLoops, source: 'post-trim-residual' });
        continue;
      }
      // HARD REJECT: visibly bad backtracking. The user-reported Build 23
      // spur in N. Williamsburg slipped through because the chooser picked
      // a candidate with retrace 22%, overlap 13% over rounding-wrong
      // alternatives — even though the route had a clear out-and-back
      // peninsula visit. The trimStubs threshold bump (150m → 300m) handles
      // the truly stub-shaped cases. This belt-and-suspenders threshold
      // catches what trim missed: rectangular detours, parallel-street
      // doublebacks, and other "visibly broken" patterns that aren't a clean
      // U-turn but still register as 30%+ retrace + overlap. Out-and-back
      // routes exempt — their retrace IS the route.
      // Threshold at retrace+overlap > 0.50. Originally 0.50 (d433ea7), then
      // tightened to 0.35 in ca8dc56 to catch a columbus-7mi case — but in
      // dense Manhattan grids (East Village, LES, Gramercy) every anchored
      // candidate routinely lands at 0.35-0.45 because the grid forces some
      // backtracking around Tompkins/East River Park. With 0.35 the chooser
      // rejected ALL anchored candidates → step 3.5 fired → user got an
      // anchorless geometric rectangle with the SAME or worse shape. Reverted
      // to 0.50: still catches truly broken cases while letting the scorer
      // (which already adds retrace+overlap to qualityPenalty linearly) pick
      // the cleanest of moderately-retracey candidates over the geometric
      // fallback. The columbus-7mi case is now handled by candidate scoring,
      // not hard-reject — anchored candidates with retr=0.21+over=0.19 score
      // ~0.30 vs step-3.5's 0.50, so the reject was the wrong tool anyway.
      if (routeType !== 'out-and-back' && (retraced + overlap) > 0.50) {
        qualityRejectCount++;
        rejectReasons.backtrack++;
        traceEmit('candidate-rejected', { i, reason: 'backtrack', retraced, overlap });
        continue;
      }
      const isOutAndBack = routeType === 'out-and-back';
      const targetMi = distanceKm * 0.621371;
      const actualMi = distKm * 0.621371;
      // HARD REJECT: degenerate-shape loops. The user-reported 3mi East
      // Village "Quiet Lanes" case (May 2026) was a clean closed loop on
      // every existing metric (low retrace/overlap, zero stubs, valid
      // distance) but visibly read as a "through line": outbound and
      // closing legs both ran along E 14th St on opposite sides of start,
      // bbox aspect ~25. Generalizes to squished ovals, snake-shape
      // routes weaving along a single corridor, long-stem lollipops where
      // the stem dominates the bbox. Threshold of 5: a healthy city loop
      // (1.6km × 0.8km rectangle) is aspect 2; aspect 5+ reads as a "line"
      // not a loop on the map. Out-and-back exempt (intentionally 1-D);
      // point-to-point exempt (start-end pair can be far apart along one
      // axis, naturally high aspect).
      const aspectRatio = (isOutAndBack || routeType === 'point-to-point')
        ? 1
        : bboxAspectRatio(points);
      if (!isOutAndBack && routeType !== 'point-to-point' && aspectRatio > 5) {
        qualityRejectCount++;
        rejectReasons.aspect++;
        traceEmit('candidate-rejected', { i, reason: 'aspect', aspectRatio });
        continue;
      }
      // HARD REJECT: extreme turn density. The user complaint pattern
      // (May 2026) is "way too many turns" on routes that pass every
      // other metric. The qualityPenalty already includes a per-km turn
      // penalty above the floor, but in dense grids where every candidate
      // has 4+ t/km that penalty doesn't decisively eliminate the worst
      // offenders. Hard absolute cap: turnsPerKm > 7.0 is a turn every
      // ~140m on average — clearly broken pattern even for the densest
      // urban grid (natural NYC street-grid loops sit at 4-6 t/km even
      // when clean). Threshold tuned so that legitimate dense-grid
      // candidates survive, only egregious zigzag/staircase patterns get
      // rejected. Only applies to routes ≥2mi where the cap leaves room
      // for the baseline turns of a small loop (1mi loops can't get
      // below ~5 t/km even when clean). Out-and-back exempt; the return
      // leg doubles the turn count from a "unique decisions" standpoint.
      const turnsPerKm = isOutAndBack || distKm < 0.1 ? 0 : turnCount(points) / distKm;
      // 1.95mi tolerance instead of literal 2: targetMi is computed by
      // round-tripping the user's mile request through km
      // (2 * 1.60934 → 3.21868 → 1.99999...), which falls just below 2.0
      // and silently disables the gate for exact-2mi user requests.
      if (!isOutAndBack && targetMi >= 1.95 && turnsPerKm > 7.0) {
        qualityRejectCount++;
        rejectReasons.turnDensity++;
        traceEmit('candidate-rejected', { i, reason: 'turn-density', turnsPerKm });
        continue;
      }
      // SOFT METRIC: Polsby-Popper isoperimetric ratio (polyline area /
      // perimeter²). Perfect circle = 1.0; square = 0.785; long thin
      // rectangles, snakes, through-lines fall to 0.05–0.20. Used as a
      // qualityPenalty contributor (NOT a hard reject) because real-OSRM
      // street-grid geometry naturally lowers PP with every sharp corner —
      // a clean dense-grid loop in mock at PP 0.20 may correspond to a
      // real-OSRM PP 0.10, and a hard threshold either rejects everything
      // or catches nothing. The penalty form lets the chooser prefer
      // higher-PP candidates without false-negatives.
      const polsbyP = (isOutAndBack || routeType === 'point-to-point')
        ? 1
        : polsbyPopper(points);
      // SOFT METRIC: localized turn cluster (max turns/km in any 500m
      // window). Same rationale as PP — real-OSRM geometry can produce
      // dense local windows even on healthy loops (corners cluster around
      // intersections), so we feed this into qualityPenalty rather than
      // hard-reject.
      const maxTurnCluster = (isOutAndBack || distKm < 0.5) ? 0
        : maxTurnDensityInWindow(points, 0.5);
      // Quality score: 0 = perfect, higher = worse. Out-and-back is exempt
      // from retrace/overlap. Components:
      //   retrace + overlap: visible polyline ugliness
      //   stubs * 0.10: each dead-end is a UX hit but not catastrophic
      //   |1 - distRatio| * 1.0: hitting target distance is critical — if
      //     a "4 mi route" returns 3 mi the user feels misled
      //   - anchorBonus: small thumb on the scale toward named green
      //     spaces, but small enough that distance / cleanliness still wins
      const anchorBonus = candidates[i].anchors.length >= 2 ? 0.10
        : candidates[i].anchors.length === 1 ? 0.05
        : 0;
      // Rounding penalty. The user-facing distance label rounds to the
      // nearest mile, so a 4mi request returning a route that rounds to
      // 3mi (or 5mi) feels broken even if the absolute error is small.
      // 0.4 per mile of rounded delta — bigger than typical retrace deltas
      // so a candidate that rounds correctly wins even if it's slightly
      // dirtier than one that doesn't. Empirically lifted random-seed
      // pass rate from ~5/15 to ~7/15 across the NYC harness fixtures.
      const roundedDelta = Math.abs(Math.round(actualMi) - Math.round(targetMi));
      const roundingPenalty = roundedDelta * 0.4;
      // Topology penalties: discourage barbells (multi-lobe routes joined
      // through start) and chronic U-turns. Both exempt for out-and-back —
      // its return leg passes through start by design and its far end IS
      // a U-turn.
      const startPasses = isOutAndBack ? 0 : countStartPasses(points);
      const reversalsPerKm = isOutAndBack || distKm < 0.1 ? 0 : reversalCount(points) / distKm;
      // Turn density penalty (in addition to the hard cap above): scales
      // inversely with target distance because short loops have a higher
      // baseline (1mi loops can't get below ~5 t/km even when clean).
      const targetMiForFloor = targetMi;
      const turnFloor = Math.max(2.0, 6.0 / Math.max(0.5, targetMiForFloor));
      const excessTurns = Math.max(0, turnsPerKm - turnFloor);
      // 0.10 per excess turn/km. Sized so a 4mi East Village at 5 t/km pays
      // ~0.30 (loses to a cleaner candidate when one exists), but a clean
      // 2.6 t/km route pays ~0.06 (effectively zero, doesn't override
      // distance/anchoring). Out-and-back exempt.
      const turnPenalty = isOutAndBack ? 0 : excessTurns * 0.10;
      // Polsby-Popper soft penalty: linear from PP=0.5 (no penalty) down
      // to PP=0 (max 0.30 penalty). Catches "this candidate's polyline
      // doesn't enclose meaningful area" without a hard threshold.
      // Sized so a healthy 2:1 rect (PP ≈ 0.7) pays nothing, a squished
      // oval (PP ≈ 0.3) pays 0.12, a snake (PP ≈ 0.1) pays 0.24.
      // Out-and-back exempt (1-D by construction).
      const polsbyPenalty = isOutAndBack ? 0
        : Math.max(0, (0.5 - polsbyP) * 0.6);
      // Localized turn cluster soft penalty. Floor at 8 t/km in any 500m
      // window (legitimate dense intersections). Above that, 0.05 per
      // excess t/km so a 14 t/km cluster pays 0.30, a 10 t/km cluster
      // pays 0.10. Out-and-back exempt.
      const clusterFloor = 8;
      const clusterExcess = Math.max(0, maxTurnCluster - clusterFloor);
      const clusterPenalty = isOutAndBack ? 0 : clusterExcess * 0.05;
      // SOFT METRICS for the new constraints (CLAUDE.md #34):
      //   shortTurnRatio: fraction of route in rapid-fire turning (<200m
      //     between consecutive turns). Catches the "zigzag through one
      //     neighborhood" pattern where the loop makes 5 turns in 1km.
      //   streetShare: max fraction of named-street distance on a single
      //     street. Catches "avenue out, parallel-avenue back" patterns
      //     that pass retrace/overlap but read as out-and-backs.
      // Both loop-only — out-and-back and point-to-point have legitimate
      // single-corridor patterns.
      const shortTurnRatio = (isOutAndBack || routeType === 'point-to-point')
        ? 0
        : shortTurnSegmentRatio(points, 0.2);
      const streetShare = (isOutAndBack || routeType === 'point-to-point')
        ? 0
        : maxStreetShare(candidateSteps);
      // Penalty curve for short-turn ratio: linear from 0.10 (no penalty)
      // up. 0.5 weight, so 0.30 ratio (clearly tangled) costs 0.10 — about
      // a stub's worth, enough to lose to a cleaner candidate.
      const shortTurnPenalty = Math.max(0, (shortTurnRatio - 0.10) * 0.5);
      // Penalty curve for street share: linear from 0.30 (no penalty) up.
      // 1.0 weight, so 0.45 share costs 0.15. Wider buffer than retrace
      // because dominant-avenue routes aren't always broken — sometimes
      // 5th Ave really is the right street to use end-to-end.
      const streetSharePenalty = Math.max(0, (streetShare - 0.30) * 1.0);
      const qualityPenalty = Math.max(0,
        (isOutAndBack ? 0 : retraced) +
        (isOutAndBack ? 0 : overlap) +
        // Out-and-back routes have an intentional U-turn at the far end
        // which countStubs flags; don't penalize it.
        (isOutAndBack ? 0 : stubs * 0.20) +
        // Distance accuracy must dominate the scorer. Originally weighted
        // 1.0×, but that left enough room for the anchor bonus (0.10) +
        // turn-density delta to flip a 4%-off candidate against an 18%-off
        // candidate. The user-reported regression: a 2mi East Village
        // request returning 1.64mi instead of 2.09mi just because the
        // shorter route had named anchors and slightly fewer turns. The
        // right way to reduce turns is to pick a different shape at the
        // requested distance — never to trade distance for a cleaner shape.
        // 2.0× means a 10% miss costs 0.20 (twice the anchor bonus) and an
        // 18% miss costs 0.36 (more than the typical turn-density delta).
        Math.abs(1 - distRatio) * 2.0 +
        roundingPenalty +
        // ~1 stub's worth per extra start-pass; modest enough to lose to
        // a clean candidate but not to override distance/anchoring.
        startPasses * 0.15 +
        // Per-km so longer routes aren't penalized for proportionally
        // more turns. ~0.05 per U-turn per km.
        reversalsPerKm * 0.05 +
        turnPenalty +
        polsbyPenalty +
        clusterPenalty +
        shortTurnPenalty +
        streetSharePenalty -
        anchorBonus
      );
      traceEmit('candidate-evaluated', { i, distKm, distRatio, hwProximity, retraced, overlap, stubs, startPasses, reversalsPerKm, turnsPerKm, turnPenalty, roundingPenalty, aspectRatio, polsbyP, maxTurnCluster, shortTurnRatio, streetShare, qualityPenalty });
      // Final gate: rounded-display match. The user-facing distance label is
      // an integer mile (or km, in metric). A 5mi request that returns a
      // 5.6mi route shows "6 mi" — the user reads it as the wrong route even
      // though every other quality metric is fine. Out-and-back and loop both
      // gated; point-to-point exempt because its distance is fixed by the
      // start/end pair. We don't drop the candidate — we shunt it to a
      // wrong-display fallback pool so the algorithm has something to return
      // even when geometry simply can't fit the requested mile (LES 6mi-
      // sized cases).
      const candidateRecord: ResolvedCandidate = { index: i, variant: candidates[i].variant, points, distKm, estimatedTime, fromOSRM: true, anchors: candidates[i].anchors, qualityPenalty, dirtiness: retraced + overlap, steps: candidateSteps };
      const adjustUnitsForCheck = useAdjustment ? adjustUnits : null;
      if (adjustUnitsForCheck && !roundedDisplayMatches(distKm, distanceKm, adjustUnitsForCheck)) {
        wrongDisplayFallback.push(candidateRecord);
        traceEmit('candidate-wrong-display', { i, distKm, target: distanceKm, units: adjustUnitsForCheck });
        continue;
      }
      resolved.push(candidateRecord);
    } else {
      // OSRM returned nothing — likely network failure, timeout, or no route
      // exists for these waypoints. Skip the candidate entirely. Older code
      // displayed the raw straight-line waypoints here as a "fallback" route,
      // which surfaced as triangles cutting through buildings and across
      // rivers when public OSRM was rate-limited. Better to drop and let
      // either another candidate or step-3.5 fill in.
      osrmNullCount++;
      traceEmit('candidate-rejected', { i, reason: 'osrm-null' });
    }
  }

  // Step 3.5: If all candidates were rejected, fall back to a direct route.
  // SKIP the fallback when:
  //   1. The resolution budget expired (we've already kept the user waiting
  //      ~18s — don't add another ~50s of sequential bearing trials).
  //   2. ALL drops were osrm-null with zero quality rejections AND no wrong-
  //      display candidates (the network is the problem, step 3.5 will hit
  //      the same dead endpoint and just compound the wait). Wrong-display
  //      candidates count as OSRM-responded — different geometry through the
  //      bearing trials may converge to the right display unit.
  // Otherwise (mixed quality rejects + nulls, or pure quality rejects, or
  // wrong-display fallbacks exist) step 3.5 has a real shot at producing a
  // usable direct-bearing route.
  const networkOnlyFailure = osrmNullCount > 0 && qualityRejectCount === 0 && wrongDisplayFallback.length === 0;
  const skipFallback = budgetExpired || networkOnlyFailure;
  if (resolved.length === 0 && !skipFallback) {
    console.log('[RouteScoring] All candidates rejected — generating direct fallback');
    traceEmit('fallback-start', { routeType, distanceKm });

    let chosen: { route: OSRMRoute | null; waypoints: RoutePoint[] };

    if (routeType === 'point-to-point' && end) {
      // Direct route from start to end — only one waypoint option to try.
      // Point-to-point distance is fixed by the start/end pair; rounded-
      // display match doesn't apply because the user can't choose target.
      chosen = await fetchOSRMRouteAdjusted([center, end], center, distanceKm, 3);
    } else {
      // A single random bearing can land in water or impassable terrain —
      // sf-embarcadero-3mi-out hit 11.65km on a 4.83km target because the
      // bearing pointed into the bay, forcing OSRM to detour around it.
      // Try N evenly-spaced bearings in parallel and keep the one whose
      // routed distance lands closest to the target.
      // First pass: 4 bearings spaced 90° apart. If none of them land on
      // the right display unit (mile/km), try 4 more rotated 45° from the
      // first set — gives the algorithm a second shot at hitting the user's
      // requested distance before falling through to a wrong-display result.
      const FIRST_PASS_BEARINGS = 4;
      const SECOND_PASS_BEARINGS = 4;
      const seedBearing = getSeed() % 360;
      const halfDist = distanceKm / (2 * ROUTING_OVERHEAD);
      // Waypoint count scales with target distance to match generateLoopWaypoints.
      // Long-distance targets need more polygon vertices to keep each waypoint
      // close enough to start that it doesn't land in water (Hudson, East River
      // for NYC starts). See generateLoopWaypoints for perimeter-factor derivation.
      const targetMi = distanceKm * 0.621371;
      const numLoopWaypoints = targetMi >= 22 ? 4 : targetMi >= 14 ? 3 : 2;
      const loopPerimeterFactor =
        numLoopWaypoints === 4 ? 6.243 :
        numLoopWaypoints === 3 ? 5.464 :
        LOOP_TRIANGLE_PERIMETER;
      const waypointDist = distanceKm / (loopPerimeterFactor * ROUTING_OVERHEAD);

      // Batched parallel: fire each pass (4 bearings) concurrently, await
      // both, then check early-exit. Was sequential — at 1-3 OSRM calls
      // per bearing × 8 bearings serially that ran 30-60s in degraded
      // network conditions. Batching by pass gives ~4 in-flight requests
      // (well under the 12-candidate burst pressure step 3 tolerates) and
      // halves typical step-3.5 wall-clock. The original "all 8 in
      // parallel" hedge that regressed (CLAUDE.md notes) was 21+ in flight
      // when combined with concurrent step-3 candidates — different
      // failure mode. Step 3.5 only fires AFTER step 3 completes, so its
      // concurrent count IS the in-flight count.
      // Skip the second pass entirely if the first found a right-display
      // route — the extra trials are insurance, not always needed.
      chosen = { route: null, waypoints: [] };
      let bestErr = Infinity;
      let bestIdx = 0;
      let foundRightDisplay = false;

      const buildWaypoints = (bearing: number): RoutePoint[] => {
        if (routeType === 'out-and-back') {
          return [center, destinationPoint(center, bearing, halfDist), center];
        } else if (numLoopWaypoints === 2) {
          return [
            center,
            destinationPoint(center, bearing, waypointDist),
            // Offset wp2 30° from antipodal so the route forms a triangle,
            // not a straight line. OSRM tends to use the same streets
            // both ways on a perfect line, causing high retrace.
            destinationPoint(center, (bearing + 210) % 360, waypointDist),
            center,
          ];
        } else {
          // 3+ waypoints — spread across a 330° arc so the closing leg
          // doesn't parallel the opening leg (which would visibly retrace).
          const arc = 330;
          const step = arc / (numLoopWaypoints - 1);
          const generated: RoutePoint[] = [center];
          for (let k = 0; k < numLoopWaypoints; k++) {
            const angle = (bearing + k * step) % 360;
            generated.push(destinationPoint(center, angle, waypointDist));
          }
          generated.push(center);
          return generated;
        }
      };

      const runPass = async (passIdx: 0 | 1): Promise<void> => {
        const phase = passIdx === 0 ? 0 : 360 / (FIRST_PASS_BEARINGS * 2);
        const trials = await Promise.all(
          Array.from({ length: FIRST_PASS_BEARINGS }, (_, k) => {
            const bearing = (seedBearing + phase + (k * 360) / FIRST_PASS_BEARINGS) % 360;
            const i = passIdx * FIRST_PASS_BEARINGS + k;
            const wps = buildWaypoints(bearing);
            return fetchOSRMRouteAdjusted(wps, center, distanceKm, 3, adjustUnits)
              .then((t) => ({ i, bearing, t }));
          })
        );
        for (const { i, bearing, t } of trials) {
          const trialDisplayMatches = !!t.route && !!adjustUnits &&
            roundedDisplayMatches(t.route.distance / 1000, distanceKm, adjustUnits);
          traceEmit('fallback-trial', {
            i,
            bearing,
            routedKm: t.route ? t.route.distance / 1000 : null,
            ratio: t.route ? (t.route.distance / 1000) / distanceKm : null,
            displayMatches: trialDisplayMatches,
            waypoints: t.waypoints,
          });
          if (!t.route) continue;
          const err = Math.abs(t.route.distance / 1000 - distanceKm);
          // Prefer a right-display route over a closer-by-distance wrong-
          // display one. Within the same display-match status, prefer
          // smaller error.
          const beatsBest =
            (trialDisplayMatches && !foundRightDisplay) ||
            (trialDisplayMatches === foundRightDisplay && err < bestErr);
          if (beatsBest) {
            chosen = t;
            bestErr = err;
            bestIdx = i;
            if (trialDisplayMatches) foundRightDisplay = true;
          }
        }
      };

      await runPass(0);
      if (!foundRightDisplay) await runPass(1);

      traceEmit('fallback-chosen', {
        bestIdx,
        foundRightDisplay,
        routedKm: chosen.route ? chosen.route.distance / 1000 : null,
      });
    }

    if (chosen.route) {
      const rawFallbackPoints = chosen.route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
      // Apply the same pendant-loop trimming as step 3. The geometric bearing
      // fallback is a triangle of waypoints around the center; OSRM can still
      // route through awkward block detours that show as pendant loops. Trim
      // rather than reject — surfacing "no routes" when a trimmed version is
      // available is worse UX. Recompute distance from the trimmed polyline
      // so the displayed mileage matches what's drawn.
      const afterPendantFallback = routeType === 'out-and-back'
        ? rawFallbackPoints : trimPendantLoops(rawFallbackPoints);
      // Same retrace-spur backstop as step 3 (CLAUDE.md #40).
      const points = routeType === 'out-and-back'
        ? afterPendantFallback : trimRetracedSpurs(afterPendantFallback, 50);
      let fallbackDistKm = chosen.route.distance / 1000;
      if (points !== rawFallbackPoints) {
        fallbackDistKm = 0;
        for (let k = 1; k < points.length; k++) {
          fallbackDistKm += haversineDistance(points[k - 1], points[k]);
        }
        traceEmit('post-process-trim', { i: -1, stage: 'pendant-loops', source: 'fallback', before: chosen.route.distance / 1000, after: fallbackDistKm });
      }
      // Safety net: if trim left any pendant loops behind, drop the candidate.
      const fallbackPendant = routeType === 'out-and-back' ? 0 : countPendantLoops(points);
      // Distance sanity. Step 3 candidates pass through this same band
      // (line ~2305), but step 3.5 historically had no distance check at
      // all — so when OSRM returned a degenerate ~0.5km result for a 30mi
      // request (waypoints 9km from center crossing rivers, OSRM gives up),
      // it shipped as a "0 mi" route. This catches that. The wrong-display
      // fallback is for "displays as the wrong integer mile" not "displays
      // as zero" — anything outside the same [0.5, 1.3] band step 3 enforces
      // is catastrophically wrong, never user-facing.
      const fallbackMaxRatio = routeType === 'point-to-point' ? 3.0 : 1.3;
      const fallbackMinRatio = routeType === 'point-to-point' ? 0.2 : 0.5;
      const fallbackDistRatio = distanceKm > 0 ? fallbackDistKm / distanceKm : 1;
      const fallbackDistanceOutOfBand =
        fallbackDistRatio > fallbackMaxRatio || fallbackDistRatio < fallbackMinRatio;
      // Same off-street gate as step 3. The geometric bearing fallback is
      // a generic triangle through arbitrary points around the center —
      // OSRM can land waypoints inside private superblocks just as easily
      // here as in step 3, and we don't want the fallback to be the
      // escape hatch that ships a route through PCV/Stuy Town interior.
      const fallbackOffStreetRatio = routeType === 'point-to-point'
        ? 0
        : computeOffStreetRatio(chosen.route, greenSpaces);
      // Same length-scaled threshold as step 3 (CLAUDE.md #35).
      const fallbackOffStreetThreshold = Math.min(0.15, 0.10 + Math.max(0, distanceKm - 5) * 0.0033);
      const fallbackOffStreet = fallbackOffStreetRatio > fallbackOffStreetThreshold;
      // Same shape gates as step 3. Without these, step 3.5 would happily
      // ship the exact "Quiet Lanes through-line" pattern that motivated
      // the gates in the first place — the bearing-trial chooser only
      // optimizes for distance fit, never for shape. Loops only (OAB is
      // intentionally 1-D; p2p is start-end constrained).
      const fallbackIsLoop = routeType !== 'out-and-back' && routeType !== 'point-to-point';
      const fallbackAspect = fallbackIsLoop ? bboxAspectRatio(points) : 1;
      const fallbackAspectBad = fallbackIsLoop && fallbackAspect > 5;
      const fallbackTargetMi = distanceKm * 0.621371;
      const fallbackTurnsPerKm = fallbackIsLoop && fallbackDistKm > 0.1
        ? turnCount(points) / fallbackDistKm : 0;
      // 1.95 tolerance — see step-3 turn-density gate for rationale.
      const fallbackTurnsBad = fallbackIsLoop && fallbackTargetMi >= 1.95 && fallbackTurnsPerKm > 7.0;
      // Same barrier-crossing check as step 3 (line ~2953). Step 3.5 was
      // historically missing it, so when every step-3 candidate failed the
      // barrier gate (typical for long loops in geographically constrained
      // starts like Manhattan, where most bearings hit a river), the
      // bearing-trial fallback would happily ship a route that crossed the
      // Hudson via Lincoln/Holland Tunnel — visible to the user as straight
      // diagonal lines across water. Loops only; out-and-back is exempt for
      // the same reason as step 3 and point-to-point doesn't have a center
      // baseline to drift from.
      const fallbackBarrier = fallbackIsLoop &&
        hasRoutedBarrierCrossing(points, greenSpaces, center, distanceKm);
      // Same highway-proximity gate as step 3. Step 3.5 was missing this
      // (alongside the barrier check, fixed earlier) — when every step-3
      // candidate failed the highway gate, step 3.5 would happily ship a
      // route with the same problem since none of its other gates check
      // for highway adjacency.
      const fallbackHwProximity = fallbackIsLoop
        ? computeHighwayProximity(points, highwayPoints) : 0;
      const fallbackHighwayBad = fallbackIsLoop && fallbackHwProximity > 0.08;
      if (fallbackPendant > 0) {
        traceEmit('candidate-rejected', { i: -1, reason: 'pendant-loop', pendantLoops: fallbackPendant, source: 'fallback-post-trim-residual' });
      } else if (fallbackDistanceOutOfBand) {
        traceEmit('candidate-rejected', { i: -1, reason: 'distance', distKm: fallbackDistKm, distRatio: fallbackDistRatio, target: distanceKm, source: 'fallback' });
      } else if (fallbackBarrier) {
        traceEmit('candidate-rejected', { i: -1, reason: 'barrier', distKm: fallbackDistKm, source: 'fallback' });
      } else if (fallbackHighwayBad) {
        traceEmit('candidate-rejected', { i: -1, reason: 'highway', hwProximity: fallbackHwProximity, source: 'fallback' });
      } else if (fallbackOffStreet) {
        traceEmit('candidate-rejected', { i: -1, reason: 'off-street', offStreetRatio: fallbackOffStreetRatio, source: 'fallback' });
      } else if (fallbackAspectBad) {
        traceEmit('candidate-rejected', { i: -1, reason: 'aspect', aspectRatio: fallbackAspect, source: 'fallback' });
      } else if (fallbackTurnsBad) {
        traceEmit('candidate-rejected', { i: -1, reason: 'turn-density', turnsPerKm: fallbackTurnsPerKm, source: 'fallback' });
      } else {
        const fallbackRecord: ResolvedCandidate = {
          index: 0,
          variant: 0,
          points,
          distKm: fallbackDistKm,
          estimatedTime: Math.round(chosen.route.duration / 60),
          fromOSRM: true,
          anchors: [],
          qualityPenalty: 0.5, // step-3.5 emergency fallback — no anchors, but real OSRM geometry
          steps: extractManeuvers(chosen.route),
        };
        // Same right-display gate as step 3. If the bearing trials couldn't
        // converge to the requested mile/km, send the result to the wrong-
        // display pool instead of `resolved` — keeps the contract that
        // anything in `resolved` displays the user's requested distance.
        const fallbackUnitsForCheck = routeType === 'point-to-point' ? null : adjustUnits;
        if (fallbackUnitsForCheck && !roundedDisplayMatches(fallbackDistKm, distanceKm, fallbackUnitsForCheck)) {
          wrongDisplayFallback.push(fallbackRecord);
          traceEmit('candidate-wrong-display', { i: -1, distKm: fallbackDistKm, target: distanceKm, units: fallbackUnitsForCheck, source: 'fallback' });
        } else {
          resolved.push(fallbackRecord);
        }
      }
    }
    // If the bearing-trial fallback came back with no OSRM route at all, or
    // trimming somehow left residual pendant loops, resolved stays empty.
  } else if (resolved.length === 0 && skipFallback && wrongDisplayFallback.length === 0) {
    traceEmit('fallback-skipped', {
      reason: budgetExpired ? 'budget-expired' : 'network-only-failure',
      osrmNullCount,
      qualityRejectCount,
      elapsedMs: Date.now() - resolveStartMs,
    });
    // Distinguish "OSRM is down" from "no routes for this area" so the
    // caller can show an honest message. Empty return is reserved for
    // the latter (some OSRM responses came back, just none usable).
    throw new OSRMUnavailableError(
      budgetExpired
        ? `OSRM resolution budget expired after ${Date.now() - resolveStartMs}ms with ${osrmNullCount} nulls`
        : `OSRM unreachable: all ${osrmNullCount} candidates returned null`
    );
  }

  // Wrong-display fallback gated by target distance. Off-by-one mile reads
  // very differently at different scales: 4mi → 3mi is a 25% short delta
  // and feels broken; 10mi → 11mi is 10% and reads as close-enough. User
  // direction (May 2026): for targets < 5 mi, require exact rounded-mile
  // match — no ±1 fallback. Below 5mi we'd rather surface "no routes
  // found" so the user can change distance or location than ship a route
  // that's visibly the wrong mile. ≥ 5mi keeps the ±1 fallback so dense
  // areas don't dead-end users on longer requests.
  const targetMiForFallback = distanceKm * 0.621371;
  const allowWrongDisplayFallback = targetMiForFallback >= 5;
  if (resolved.length === 0 && wrongDisplayFallback.length > 0 && allowWrongDisplayFallback) {
    // ±1 rounded-mile/km guardrail (existing helper). Without this a 4mi
    // request could ship a 7mi route from the wrong-display pool — the
    // candidate distance gate is [0.5, 1.3] of target, wide enough to let
    // that through. ±1 keeps us in "off by one" territory only.
    const fallbackUnits = useAdjustment ? adjustUnits : null;
    const eligible = fallbackUnits
      ? wrongDisplayFallback.filter((c) => nearDisplayMatches(c.distKm, distanceKm, fallbackUnits))
      : wrongDisplayFallback;
    if (eligible.length > 0) {
      const sortedFallback = [...eligible].sort((a, b) => a.qualityPenalty - b.qualityPenalty);
      traceEmit('wrong-display-fallback-used', {
        candidateCount: eligible.length,
        rejectedFarCount: wrongDisplayFallback.length - eligible.length,
        bestDistKm: sortedFallback[0].distKm,
        targetKm: distanceKm,
      });
      resolved.push(...sortedFallback);
    } else {
      traceEmit('wrong-display-fallback-rejected', {
        candidateCount: wrongDisplayFallback.length,
        targetKm: distanceKm,
        reason: 'all-too-far-from-target',
      });
    }
  } else if (resolved.length === 0 && wrongDisplayFallback.length > 0) {
    traceEmit('wrong-display-fallback-suppressed', {
      candidateCount: wrongDisplayFallback.length,
      targetKm: distanceKm,
      reason: 'target-too-small',
      targetMi: targetMiForFallback,
    });
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

  // Step 6: Sort by quality (lower penalty = better) and return top `count`.
  // Was previously generation-order, which assumed candidate 0 = best parks
  // = best route. That assumption broke in dense grids where candidate 0's
  // OSRM output had high retrace despite using "best" parks. Sorting by
  // quality means a candidate-2 with 5% retrace beats candidate-0 with 30%
  // retrace, regardless of which parks each used.
  //
  // Refresh-divergence boost: when the caller passed `excludePoints` (the
  // previous route's polyline), candidates whose geometry is essentially
  // a replay of that polyline get a penalty bump so the chooser prefers a
  // visibly different route. Only applies when there's at least one
  // candidate that IS sufficiently different — otherwise we fall back to
  // showing the best-quality result and let "no different route exists"
  // surface naturally. Threshold: 100m average sample distance — empirically
  // the gap between "OSRM cache replay (same street)" and "different
  // alternative (parallel avenue ≥ 1 block away)".
  const REFRESH_REPLAY_THRESHOLD_KM = 0.10;
  const REFRESH_REPLAY_PENALTY = 1.0;
  let scoredForSort = scored;
  if (excludePoints && excludePoints.length > 0) {
    const annotated = scored.map((s) => {
      const divergence = polylineDivergenceKm(s.candidate.points, excludePoints);
      const isReplay = divergence < REFRESH_REPLAY_THRESHOLD_KM;
      return { entry: s, divergence, isReplay };
    });
    const haveDifferentOption = annotated.some((a) => !a.isReplay);
    if (haveDifferentOption) {
      scoredForSort = annotated.map((a) =>
        a.isReplay
          ? { ...a.entry, candidate: { ...a.entry.candidate, qualityPenalty: a.entry.candidate.qualityPenalty + REFRESH_REPLAY_PENALTY } }
          : a.entry
      );
      traceEmit('refresh-replay-demote', {
        replayCount: annotated.filter((a) => a.isReplay).length,
        differentCount: annotated.filter((a) => !a.isReplay).length,
      });
    }
  }
  const sortedByQuality = [...scoredForSort].sort(
    (a, b) => a.candidate.qualityPenalty - b.candidate.qualityPenalty
  );
  const topCandidates = sortedByQuality.slice(0, count);

  // Snapshot the diagnostic counters when we're about to return an empty
  // route list. Caller (UI) reads this via getLastFailureDiagnostics() to
  // explain WHY no routes survived — without this, the user just sees a
  // generic "no routes found" with no signal about whether OSRM was
  // throttling, the algorithm gates were too tight, or geometry simply
  // couldn't fit the requested mile.
  if (topCandidates.length === 0) {
    // Auto-retry once when the first pass yielded zero candidates due to
    // QUALITY rejections (not pure network failure). Candidate generation is
    // stochastic — a different timeSeed produces different waypoint shapes
    // that may pass gates the first pass missed. The user-reported East
    // Village 9mi case ("first generate failed, refresh worked") was exactly
    // this: same area, same constraints, just an unlucky seed.
    //
    // Skip when:
    //  - already retried (capped at 1)
    //  - quality rejects = 0 (pure network failure; another pass hits the
    //    same dead OSRM endpoint and just compounds the wait)
    //  - elapsed > RETRY_DEADLINE_MS (already burned the budget — retry
    //    would push total wall-clock past the existing degraded ceiling)
    const elapsed = Date.now() - generateStartMs;
    const RETRY_DEADLINE_MS = 12000;
    if (
      _retryAttempt === 0 &&
      qualityRejectCount > 0 &&
      elapsed < RETRY_DEADLINE_MS
    ) {
      traceEmit('auto-retry-start', { elapsed, qualityRejectCount, osrmNullCount });
      return generateOSRMRoutes(
        center, distanceKm, routeType, count, prefs, end, excludeAnchors, excludePoints, 1,
      );
    }
    lastFailureDiagnostics = {
      osrmNullCount,
      qualityRejectCount,
      wrongDisplayCount: wrongDisplayFallback.length,
      budgetExpired,
      rejectReasons,
    };
  }

  // Build final GeneratedRoute objects
  const terrain = routeType === 'point-to-point' ? 'Point to Point'
    : routeType === 'loop' ? 'Loop' : 'Out & Back';

  // Encode green-pool size + refresh flag into the route id so the UI
  // can surface them in the debug suffix. Lets us tell the difference
  // between "Overpass returned 0 greens" (g=0, the algorithm has nothing
  // to work with) and "greens exist but corridor filter rejected all of
  // them" (g>0 but a=0). Removable along with the rest of the debug
  // suffix once the underlying behavior is confirmed.
  const debugGreenCount = greenSpaces.length;
  const debugIsRefresh = excludeAnchors !== undefined ? '1' : '0';

  return topCandidates.map(({ candidate }) => {
    const elevationGain = fabricateElevationGain(candidate.distKm, candidate.variant);
    const difficulty: 'easy' | 'moderate' | 'hard' =
      candidate.distKm < 5 ? 'easy' : candidate.distKm < 10 ? 'moderate' : 'hard';
    const distanceMiles = Math.round(candidate.distKm * 0.621371);

    return {
      id: `route-${candidate.index}-g${debugGreenCount}-r${debugIsRefresh}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: pickRouteName(prefs, candidate.index, center.lat, candidate.anchors, routeType),
      points: candidate.points,
      distance: distanceMiles,
      estimatedTime: candidate.estimatedTime,
      elevationGain,
      terrain,
      difficulty,
      anchorPoints: candidate.anchors.map((a) => a.point),
      routeStyle: routeType,
      steps: candidate.steps,
    };
  });
}
