import {
  DEFAULT_OFF_ROUTE_THRESHOLDS,
  INITIAL_OFF_ROUTE_STATE,
  nearestRouteVertexIdx,
  nextOnRouteTarget,
  updateOffRoute,
} from '../off-route';
import type { RoutePoint } from '../route-generator';

const T0 = 1_000_000_000_000; // arbitrary but fixed "now"
const TH = DEFAULT_OFF_ROUTE_THRESHOLDS;

describe('updateOffRoute', () => {
  test('on-route from the start: nothing fires, state stays initial', () => {
    const r = updateOffRoute(INITIAL_OFF_ROUTE_STATE, false, T0);
    expect(r.shouldShowChip).toBe(false);
    expect(r.shouldSpeak).toBe(false);
    expect(r.shouldRecalc).toBe(false);
    expect(r.shouldReroute).toBe(false);
    expect(r.newState).toEqual(INITIAL_OFF_ROUTE_STATE);
  });

  test('off-route within grace: no chip, no speech, no recalc/reroute', () => {
    let s = INITIAL_OFF_ROUTE_STATE;
    let r = updateOffRoute(s, true, T0);
    expect(r.shouldShowChip).toBe(false);
    // 5 seconds later — still inside grace
    r = updateOffRoute(r.newState, true, T0 + 5_000);
    expect(r.shouldShowChip).toBe(false);
    expect(r.shouldSpeak).toBe(false);
    expect(r.shouldRecalc).toBe(false);
    expect(r.shouldReroute).toBe(false);
  });

  test('at grace: chip on, first speech fires once', () => {
    let s = updateOffRoute(INITIAL_OFF_ROUTE_STATE, true, T0).newState;
    const r = updateOffRoute(s, true, T0 + TH.graceMs);
    expect(r.shouldShowChip).toBe(true);
    expect(r.shouldSpeak).toBe(true);
    expect(r.newState.spokeCount).toBe(1);
    // Immediate next call — should NOT re-speak (cooldown)
    const r2 = updateOffRoute(r.newState, true, T0 + TH.graceMs + 100);
    expect(r2.shouldSpeak).toBe(false);
    expect(r2.newState.spokeCount).toBe(1);
  });

  test('second speech fires after cooldown gap, then caps at speakCap', () => {
    let s = updateOffRoute(INITIAL_OFF_ROUTE_STATE, true, T0).newState;
    s = updateOffRoute(s, true, T0 + TH.graceMs).newState; // first speech
    expect(s.spokeCount).toBe(1);
    // Just before cooldown — no speech
    let r = updateOffRoute(s, true, T0 + TH.graceMs + TH.speakCooldownMs - 1);
    expect(r.shouldSpeak).toBe(false);
    // After cooldown — second speech fires (this is the cap at 2)
    r = updateOffRoute(r.newState, true, T0 + TH.graceMs + TH.speakCooldownMs);
    expect(r.shouldSpeak).toBe(true);
    expect(r.newState.spokeCount).toBe(2);
    // Way later — no more speeches, capped
    r = updateOffRoute(r.newState, true, T0 + 10 * TH.speakCooldownMs);
    expect(r.shouldSpeak).toBe(false);
    expect(r.newState.spokeCount).toBe(2);
  });

  test('recalc fires once at recalcMs, then never again this episode', () => {
    let s = updateOffRoute(INITIAL_OFF_ROUTE_STATE, true, T0).newState;
    // Just before recalcMs — no recalc
    let r = updateOffRoute(s, true, T0 + TH.recalcMs - 1);
    expect(r.shouldRecalc).toBe(false);
    // At recalcMs — fires
    r = updateOffRoute(r.newState, true, T0 + TH.recalcMs);
    expect(r.shouldRecalc).toBe(true);
    expect(r.newState.recalcFired).toBe(true);
    // Next tick — does NOT fire again
    r = updateOffRoute(r.newState, true, T0 + TH.recalcMs + 1_000);
    expect(r.shouldRecalc).toBe(false);
  });

  test('reroute fires once at rerouteMs, then never again this episode', () => {
    let s = updateOffRoute(INITIAL_OFF_ROUTE_STATE, true, T0).newState;
    // Way past reroute threshold (covers recalc too, but reroute is the
    // important one-shot)
    let r = updateOffRoute(s, true, T0 + TH.rerouteMs);
    expect(r.shouldReroute).toBe(true);
    expect(r.newState.rerouteFired).toBe(true);
    r = updateOffRoute(r.newState, true, T0 + TH.rerouteMs + 5_000);
    expect(r.shouldReroute).toBe(false);
  });

  test('returning on-route resets all per-episode counters', () => {
    let s = updateOffRoute(INITIAL_OFF_ROUTE_STATE, true, T0).newState;
    s = updateOffRoute(s, true, T0 + TH.rerouteMs).newState; // fired reroute
    expect(s.rerouteFired).toBe(true);
    // Back on route
    const r = updateOffRoute(s, false, T0 + TH.rerouteMs + 1_000);
    expect(r.newState).toEqual(INITIAL_OFF_ROUTE_STATE);
    expect(r.shouldShowChip).toBe(false);
    expect(r.shouldSpeak).toBe(false);
    // Going off again should be a fresh episode — speech fires when grace
    // is reached for the second time.
    let s2 = updateOffRoute(r.newState, true, T0 + 200_000).newState;
    const r2 = updateOffRoute(s2, true, T0 + 200_000 + TH.graceMs);
    expect(r2.shouldSpeak).toBe(true);
  });

  test('returning on-route mid-episode never fires recalc/reroute', () => {
    let s = updateOffRoute(INITIAL_OFF_ROUTE_STATE, true, T0).newState;
    // 40s off (past grace, before recalc)
    s = updateOffRoute(s, true, T0 + 40_000).newState;
    // Back on route
    const r = updateOffRoute(s, false, T0 + 45_000);
    expect(r.shouldRecalc).toBe(false);
    expect(r.shouldReroute).toBe(false);
  });
});

describe('nearestRouteVertexIdx', () => {
  test('empty polyline returns -1', () => {
    expect(nearestRouteVertexIdx({ lat: 0, lng: 0 }, [])).toBe(-1);
  });

  test('returns nearest vertex by squared distance', () => {
    const poly: RoutePoint[] = [
      { lat: 40.0, lng: -74.0 },
      { lat: 40.01, lng: -74.0 },
      { lat: 40.02, lng: -74.0 },
      { lat: 40.03, lng: -74.0 },
    ];
    // 40.018 is closest to index 2 (40.02)
    expect(nearestRouteVertexIdx({ lat: 40.018, lng: -74.0 }, poly)).toBe(2);
    // Exactly on a vertex
    expect(nearestRouteVertexIdx({ lat: 40.01, lng: -74.0 }, poly)).toBe(1);
  });
});

describe('nextOnRouteTarget', () => {
  test('returns null for empty polyline', () => {
    expect(nextOnRouteTarget({ lat: 0, lng: 0 }, [])).toBeNull();
  });

  test('returns a vertex at least lookAheadM meters ahead of nearest', () => {
    // 0.001 degree latitude ≈ 111m; build vertices spaced ~111m apart.
    const poly: RoutePoint[] = [
      { lat: 40.0000, lng: -74.0 },
      { lat: 40.0010, lng: -74.0 }, // ~111m N of v0
      { lat: 40.0020, lng: -74.0 }, // ~222m N of v0
      { lat: 40.0030, lng: -74.0 }, // ~333m N of v0
    ];
    // User at v0, lookAhead=150m → should pick v2 (222m), not v1 (111m).
    const t = nextOnRouteTarget({ lat: 40.0000, lng: -74.0 }, poly, 150);
    expect(t).toEqual(poly[2]);
  });

  test('falls back to nearest when end-of-route is reached', () => {
    const poly: RoutePoint[] = [
      { lat: 40.0000, lng: -74.0 },
      { lat: 40.0010, lng: -74.0 },
    ];
    // User AT the last vertex; no forward lookAhead exists → return nearest.
    const t = nextOnRouteTarget({ lat: 40.0010, lng: -74.0 }, poly, 500);
    expect(t).toEqual(poly[1]);
  });
});
