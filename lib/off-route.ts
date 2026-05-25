import type { RoutePoint } from './route-generator';

/** Tiered off-route response strategy:
 *  - 30s off: visual chip + one audible "off course" cue
 *  - 60s off: silent recalc — fetch directions back to the planned route
 *  - 90s off: full reroute — replace the planned route from current position
 *
 *  Each tier is one-shot per "off-route episode". An episode begins when the
 *  user crosses the off-route distance threshold for at least the grace
 *  period and ends when they get back within the threshold. Returning on
 *  resets every counter so a second episode in the same run plays the full
 *  sequence again.
 *
 *  The voice cooldown is per-episode too: at most 2 spoken cues per episode,
 *  with a minimum 30s gap. Past two cues the app stops nagging and lets the
 *  rerouting do the talking (banner / map polyline update).
 *
 *  All time values are in milliseconds for direct comparison with Date.now().
 */
export interface OffRouteThresholds {
  graceMs: number;
  recalcMs: number;
  rerouteMs: number;
  speakCooldownMs: number;
  speakCap: number;
}

export const DEFAULT_OFF_ROUTE_THRESHOLDS: OffRouteThresholds = {
  graceMs: 30000,
  recalcMs: 60000,
  rerouteMs: 90000,
  speakCooldownMs: 30000,
  speakCap: 2,
};

export interface OffRouteState {
  /** Timestamp when the current off-route episode began, or null if the user
   *  is currently on-route. Elapsed off-route time is now - offSinceTs. */
  offSinceTs: number | null;
  /** Timestamp of the most recent off-course speech cue, or null if none has
   *  fired this episode. Used to enforce the speakCooldownMs gap. */
  lastSpokeTs: number | null;
  /** Number of off-course speech cues fired this episode. Capped at
   *  speakCap; further offRoute time triggers silent reroute only. */
  spokeCount: number;
  /** True if the recalc tier has fired for this episode (one-shot). */
  recalcFired: boolean;
  /** True if the reroute tier has fired for this episode (one-shot). */
  rerouteFired: boolean;
}

export const INITIAL_OFF_ROUTE_STATE: OffRouteState = {
  offSinceTs: null,
  lastSpokeTs: null,
  spokeCount: 0,
  recalcFired: false,
  rerouteFired: false,
};

export interface OffRouteUpdate {
  newState: OffRouteState;
  /** True iff the visual chip should be displayed (past grace period). */
  shouldShowChip: boolean;
  /** True iff a voice cue should be spoken on THIS update (false→true
   *  edges only — already-handled by the state machine, caller just plays). */
  shouldSpeak: boolean;
  /** True iff the recalc tier should fire on THIS update (one-shot per
   *  episode). Caller is responsible for actually firing the OSRM call. */
  shouldRecalc: boolean;
  /** True iff the full reroute tier should fire on THIS update (one-shot per
   *  episode). Caller is responsible for actually firing the OSRM call. */
  shouldReroute: boolean;
}

/** Advance the off-route state given the current "is off route?" signal and
 *  the current time. Pure function — caller owns the state and the side
 *  effects.
 *
 *  Callers should treat the action booleans as edges: each is true on
 *  exactly the update that the action should fire on. State persists the
 *  "this episode already did X" flag so the boolean returns to false on
 *  subsequent calls.
 */
export function updateOffRoute(
  state: OffRouteState,
  isOff: boolean,
  now: number,
  thresholds: OffRouteThresholds = DEFAULT_OFF_ROUTE_THRESHOLDS,
): OffRouteUpdate {
  if (!isOff) {
    // Back on route — reset every counter so the next episode plays the
    // sequence from the beginning.
    return {
      newState: INITIAL_OFF_ROUTE_STATE,
      shouldShowChip: false,
      shouldSpeak: false,
      shouldRecalc: false,
      shouldReroute: false,
    };
  }

  const offSinceTs = state.offSinceTs ?? now;
  const elapsed = now - offSinceTs;

  const shouldShowChip = elapsed >= thresholds.graceMs;

  let shouldSpeak = false;
  let lastSpokeTs = state.lastSpokeTs;
  let spokeCount = state.spokeCount;
  if (shouldShowChip && spokeCount < thresholds.speakCap) {
    const cooldownPassed =
      lastSpokeTs === null || now - lastSpokeTs >= thresholds.speakCooldownMs;
    if (cooldownPassed) {
      shouldSpeak = true;
      lastSpokeTs = now;
      spokeCount = spokeCount + 1;
    }
  }

  const shouldRecalc = !state.recalcFired && elapsed >= thresholds.recalcMs;
  const shouldReroute = !state.rerouteFired && elapsed >= thresholds.rerouteMs;

  return {
    newState: {
      offSinceTs,
      lastSpokeTs,
      spokeCount,
      recalcFired: state.recalcFired || shouldRecalc,
      rerouteFired: state.rerouteFired || shouldReroute,
    },
    shouldShowChip,
    shouldSpeak,
    shouldRecalc,
    shouldReroute,
  };
}

/** Find the index of the planned-route vertex closest to the given point.
 *  Used by the recalc tier to pick the "next on-route waypoint" to navigate
 *  back to. Vertex-only (not segment-projected) — fine for OSRM road routes
 *  which sample vertices ~10m apart. Returns -1 for an empty polyline. */
export function nearestRouteVertexIdx(
  point: RoutePoint,
  polyline: RoutePoint[],
): number {
  if (polyline.length === 0) return -1;
  let minIdx = 0;
  let minDistSq = Infinity;
  for (let i = 0; i < polyline.length; i++) {
    const dLat = polyline[i].lat - point.lat;
    const dLng = polyline[i].lng - point.lng;
    const distSq = dLat * dLat + dLng * dLng;
    if (distSq < minDistSq) {
      minDistSq = distSq;
      minIdx = i;
    }
  }
  return minIdx;
}

/** Pick the next planned-route vertex that's "ahead" of the user, biased
 *  toward forward progress. Starts the search at the nearest vertex and
 *  walks forward until a vertex at least `lookAheadM` meters away is found.
 *  Falls back to the nearest vertex if none qualifies (end of route).
 *
 *  Without the lookAhead bias, the recalc target would be the user's
 *  closest planned vertex — often *behind* them on a passed segment, which
 *  would send the audio cues into "turn around, retrace" loops.
 */
export function nextOnRouteTarget(
  point: RoutePoint,
  polyline: RoutePoint[],
  lookAheadM: number = 150,
): RoutePoint | null {
  if (polyline.length === 0) return null;
  const nearest = nearestRouteVertexIdx(point, polyline);
  if (nearest < 0) return null;
  const lookAheadKm = lookAheadM / 1000;
  for (let i = nearest; i < polyline.length; i++) {
    const dLat = polyline[i].lat - point.lat;
    const dLng = polyline[i].lng - point.lng;
    // ~111km per degree latitude; rough but adequate for the lookAhead gate
    const approxKm = Math.sqrt(dLat * dLat + dLng * dLng) * 111;
    if (approxKm >= lookAheadKm) return polyline[i];
  }
  return polyline[nearest];
}
