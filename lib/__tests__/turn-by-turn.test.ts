import {
  INITIAL_TURN_STATE,
  STEP_CONFIRM_COUNT,
  MAX_ACCURACY_M,
  updateTurnByTurn,
  haversineMeters,
} from '../turn-by-turn';
import type { ManeuverStep, RoutePoint } from '../route-generator';

// Synthetic 3-turn route along a meridian: each maneuver is ~200m apart on a
// straight north-south line. Lets us simulate "user runs north" trivially —
// just nudge lat upward each sample.
function makeSteps(): ManeuverStep[] {
  // 200m of latitude ≈ 0.0018 degrees.
  return [
    { type: 'turn', modifier: 'right', name: 'First St', distanceM: 200, location: { lat: 40.7000, lng: -74.0000 } },
    { type: 'turn', modifier: 'left', name: 'Second St', distanceM: 200, location: { lat: 40.7018, lng: -74.0000 } },
    { type: 'turn', modifier: 'right', name: 'Third St', distanceM: 200, location: { lat: 40.7036, lng: -74.0000 } },
  ];
}

const STEPS = makeSteps();

function pos(lat: number, lng = -74.0000): RoutePoint {
  return { lat, lng };
}

describe('haversineMeters', () => {
  test('returns ~111m for 0.001° latitude separation', () => {
    const d = haversineMeters({ lat: 40.7, lng: -74 }, { lat: 40.701, lng: -74 });
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(115);
  });
});

describe('updateTurnByTurn — empty inputs', () => {
  test('returns nulls when steps is empty', () => {
    const r = updateTurnByTurn(INITIAL_TURN_STATE, pos(40.7), 5, []);
    expect(r.currentStep).toBeNull();
    expect(r.distanceToManeuverM).toBeNull();
    expect(r.advanced).toBe(false);
  });
});

describe('updateTurnByTurn — initial state shows first step', () => {
  test('before first commit, currentStep is steps[0]', () => {
    const r = updateTurnByTurn(INITIAL_TURN_STATE, pos(40.6995), 5, STEPS);
    expect(r.currentStep).toBe(STEPS[0]);
    expect(r.currentIdx).toBe(0);
    expect(r.distanceToManeuverM).not.toBeNull();
    expect(r.advanced).toBe(false);
  });
});

describe('updateTurnByTurn — debouncing prevents single-sample false advance', () => {
  test('one noisy sample near step 1 does not commit advance', () => {
    // Start near step 0, then a single sample teleports to step 1 (would be
    // a 200m+ GPS jump in real life), then back near step 0.
    let state = INITIAL_TURN_STATE;
    let r = updateTurnByTurn(state, pos(40.7000), 5, STEPS);
    state = r.newState;
    expect(state.committedIdx).toBe(-1);

    // Outlier: jumps to step 1's location.
    r = updateTurnByTurn(state, pos(40.7018), 5, STEPS);
    state = r.newState;
    // Pending=1, not yet committed.
    expect(state.committedIdx).toBe(-1);
    expect(r.advanced).toBe(false);

    // Back near step 0 — committedIdx still -1 since the outlier never got
    // 3 consecutive confirmations and the next sample broke the streak.
    r = updateTurnByTurn(state, pos(40.7001), 5, STEPS);
    state = r.newState;
    expect(state.committedIdx).toBe(-1);
    expect(r.currentIdx).toBe(0);
  });

  test('STEP_CONFIRM_COUNT consecutive samples DO commit advance', () => {
    let state = INITIAL_TURN_STATE;
    let lastUpdate;
    // STEP_CONFIRM_COUNT samples all near step 1 → should advance.
    for (let i = 0; i < STEP_CONFIRM_COUNT; i++) {
      lastUpdate = updateTurnByTurn(state, pos(40.7018), 5, STEPS);
      state = lastUpdate.newState;
    }
    expect(state.committedIdx).toBe(1);
    expect(lastUpdate!.advanced).toBe(true);
    // The advance flag should fire only on the sample that committed it.
    const next = updateTurnByTurn(state, pos(40.7018), 5, STEPS);
    expect(next.advanced).toBe(false);
  });
});

describe('updateTurnByTurn — never go backward', () => {
  test('after committing step 2, a sample near step 0 does not regress', () => {
    let state = INITIAL_TURN_STATE;
    // Commit step 2 (need to advance through pending three times).
    for (let i = 0; i < STEP_CONFIRM_COUNT; i++) {
      state = updateTurnByTurn(state, pos(40.7036), 5, STEPS).newState;
    }
    expect(state.committedIdx).toBe(2);

    // Now a sample suggests step 0 — should be ignored.
    const r = updateTurnByTurn(state, pos(40.7000), 5, STEPS);
    expect(r.newState.committedIdx).toBe(2);
    expect(r.currentIdx).toBe(2);
  });
});

describe('updateTurnByTurn — accuracy gate', () => {
  test('a sample with poor accuracy does not advance state', () => {
    let state = INITIAL_TURN_STATE;
    // Three samples near step 1 BUT all with bad accuracy.
    for (let i = 0; i < STEP_CONFIRM_COUNT; i++) {
      state = updateTurnByTurn(state, pos(40.7018), MAX_ACCURACY_M + 1, STEPS).newState;
    }
    expect(state.committedIdx).toBe(-1);
  });

  test('null accuracy is allowed (legacy callers / older platforms)', () => {
    let state = INITIAL_TURN_STATE;
    for (let i = 0; i < STEP_CONFIRM_COUNT; i++) {
      state = updateTurnByTurn(state, pos(40.7018), null, STEPS).newState;
    }
    expect(state.committedIdx).toBe(1);
  });
});

describe('updateTurnByTurn — sequential progression through all steps', () => {
  test('runner advances through 3 steps in order', () => {
    let state = INITIAL_TURN_STATE;
    const targets = [40.7018, 40.7036];
    for (const targetLat of targets) {
      for (let i = 0; i < STEP_CONFIRM_COUNT; i++) {
        state = updateTurnByTurn(state, pos(targetLat), 5, STEPS).newState;
      }
    }
    expect(state.committedIdx).toBe(2);
  });
});

describe('updateTurnByTurn — distanceToManeuver decreases as runner approaches', () => {
  test('runner approaching step 0 sees decreasing distance', () => {
    let prev = Infinity;
    let state = INITIAL_TURN_STATE;
    // Walk lat from 40.6982 (200m south of step 0) to 40.7000 (at step 0).
    for (const lat of [40.6982, 40.6987, 40.6992, 40.6997, 40.7000]) {
      const r = updateTurnByTurn(state, pos(lat), 5, STEPS);
      state = r.newState;
      expect(r.distanceToManeuverM).not.toBeNull();
      expect(r.distanceToManeuverM!).toBeLessThanOrEqual(prev);
      prev = r.distanceToManeuverM!;
    }
  });
});
