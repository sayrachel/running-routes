import type { RoutePoint, ManeuverStep } from './route-generator';

/** How many consecutive GPS samples must agree on the same step index before
 *  we commit to advancing the banner / firing prompts. Higher = more
 *  debouncing, more lag. 3 was picked to ride out a single 30 m GPS jump
 *  (typical urban-canyon noise) without making turn alerts feel late. */
export const STEP_CONFIRM_COUNT = 3;

/** GPS samples worse than this accuracy (meters) are ignored for step
 *  matching — they're more likely to flip the "nearest step" calculation
 *  around than to advance it correctly. Position is still recorded for
 *  GPS-track display elsewhere; this gate is only for turn-by-turn. */
export const MAX_ACCURACY_M = 25;

export interface TurnByTurnState {
  /** Index of the most recently committed step (next maneuver the user is
   *  approaching). -1 means "none committed yet"; the UI shows step 0. */
  committedIdx: number;
  /** Step index the most recent GPS sample suggested. Held until
   *  STEP_CONFIRM_COUNT consecutive samples agree, then promoted to
   *  committedIdx. */
  pendingIdx: number;
  /** How many consecutive samples have agreed on pendingIdx. */
  pendingCount: number;
}

export const INITIAL_TURN_STATE: TurnByTurnState = {
  committedIdx: -1,
  pendingIdx: -1,
  pendingCount: 0,
};

export interface TurnByTurnUpdate {
  newState: TurnByTurnState;
  /** Step the user is currently heading toward (next maneuver). */
  currentStep: ManeuverStep | null;
  /** Index of currentStep within the steps[] array. */
  currentIdx: number;
  /** Meters from the GPS position to currentStep's maneuver point. */
  distanceToManeuverM: number | null;
  /** True iff this update advanced committedIdx past its previous value —
   *  the caller can use this edge to fire a haptic buzz / "now" voice cue. */
  advanced: boolean;
}

export function updateTurnByTurn(
  state: TurnByTurnState,
  position: RoutePoint,
  accuracy: number | null,
  steps: ManeuverStep[],
): TurnByTurnUpdate {
  if (steps.length === 0) {
    return { newState: state, currentStep: null, currentIdx: -1, distanceToManeuverM: null, advanced: false };
  }

  // Noisy sample: leave state untouched, but still report the currently
  // committed step so the banner doesn't blank out.
  if (accuracy !== null && accuracy > MAX_ACCURACY_M) {
    const idx = state.committedIdx >= 0 ? state.committedIdx : 0;
    const step = steps[idx] ?? null;
    return {
      newState: state,
      currentStep: step,
      currentIdx: idx,
      distanceToManeuverM: step ? haversineMeters(position, step.location) : null,
      advanced: false,
    };
  }

  // Find the closest upcoming step. Search starts at committedIdx (or 0 if
  // none committed) so we never go backward — once we've passed step N,
  // step N-1 is irrelevant even if a noisy GPS sample lands closer to it.
  const searchStart = Math.max(0, state.committedIdx);
  let nearestIdx = searchStart;
  let nearestDistM = Infinity;
  for (let i = searchStart; i < steps.length; i++) {
    const distM = haversineMeters(position, steps[i].location);
    if (distM < nearestDistM) {
      nearestDistM = distM;
      nearestIdx = i;
    }
  }

  // Debounce: increment count when this sample agrees with the last one's
  // suggestion; reset when it differs. Confirmation only counts samples
  // suggesting an ADVANCE (idx > committedIdx) — staying on the current
  // step doesn't need to be confirmed, it's the default.
  const suggestsAdvance = nearestIdx > state.committedIdx;
  let newPendingIdx: number;
  let newPendingCount: number;
  if (suggestsAdvance && nearestIdx === state.pendingIdx) {
    newPendingIdx = nearestIdx;
    newPendingCount = state.pendingCount + 1;
  } else if (suggestsAdvance) {
    newPendingIdx = nearestIdx;
    newPendingCount = 1;
  } else {
    // No advance suggested — keep current state's pending values so the
    // next "advance" sample doesn't wrongly inherit a stale pendingCount.
    newPendingIdx = state.committedIdx;
    newPendingCount = 0;
  }

  let newCommittedIdx = state.committedIdx;
  let advanced = false;
  if (newPendingCount >= STEP_CONFIRM_COUNT && newPendingIdx > state.committedIdx) {
    newCommittedIdx = newPendingIdx;
    advanced = true;
  }

  const newState: TurnByTurnState = {
    committedIdx: newCommittedIdx,
    pendingIdx: newPendingIdx,
    pendingCount: newPendingCount,
  };

  // Banner shows the next step the user is heading toward. Before the first
  // commit, that's step 0 (the first turn).
  const reportedIdx = newCommittedIdx >= 0 ? newCommittedIdx : 0;
  const currentStep = steps[reportedIdx] ?? null;
  const distM = currentStep ? haversineMeters(position, currentStep.location) : null;

  return {
    newState,
    currentStep,
    currentIdx: reportedIdx,
    distanceToManeuverM: distM,
    advanced,
  };
}

/** Haversine distance in meters between two lat/lng points. */
export function haversineMeters(p1: RoutePoint, p2: RoutePoint): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(p2.lat - p1.lat);
  const dLng = toRad(p2.lng - p1.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(p1.lat)) * Math.cos(toRad(p2.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
