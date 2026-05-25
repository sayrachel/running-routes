import { smoothGpsSample } from '../useLocationTracking';
import type { RoutePoint } from '../route-generator';

describe('smoothGpsSample', () => {
  test('first sample passes through unchanged (no prior to blend with)', () => {
    const raw: RoutePoint = { lat: 40.7, lng: -74.0 };
    expect(smoothGpsSample(null, raw)).toEqual(raw);
  });

  test('EMA blend matches the documented 0.5/0.5 weighting', () => {
    const prev: RoutePoint = { lat: 40.0, lng: -74.0 };
    const raw: RoutePoint = { lat: 40.001, lng: -74.001 };
    const smoothed = smoothGpsSample(prev, raw);
    // alpha = 0.5 → midpoint of prev and raw
    expect(smoothed.lat).toBeCloseTo(40.0005, 6);
    expect(smoothed.lng).toBeCloseTo(-74.0005, 6);
  });

  test('a single jittery sample is dampened (not propagated 1:1)', () => {
    // Runner moving steadily north — raw[N-1] = 40.001, raw[N] jitters to
    // 40.0015 (5m east-jitter wouldn't be lat, but pretend for the test).
    // The smoothed series should lie BETWEEN the previous smoothed and the
    // jitter, not at the jitter — confirming the filter is actually filtering.
    const prevSmoothed: RoutePoint = { lat: 40.001, lng: -74.0 };
    const jitter: RoutePoint = { lat: 40.0015, lng: -74.0 };
    const smoothed = smoothGpsSample(prevSmoothed, jitter);
    expect(smoothed.lat).toBeGreaterThan(prevSmoothed.lat);
    expect(smoothed.lat).toBeLessThan(jitter.lat);
  });

  test('successive constant samples converge toward the input', () => {
    // If the runner stops and GPS reports the same position repeatedly,
    // the smoothed point should converge there (within a few iterations).
    const target: RoutePoint = { lat: 40.5, lng: -74.5 };
    let smoothed: RoutePoint = { lat: 40.0, lng: -74.0 };
    for (let i = 0; i < 20; i++) {
      smoothed = smoothGpsSample(smoothed, target);
    }
    expect(smoothed.lat).toBeCloseTo(target.lat, 4);
    expect(smoothed.lng).toBeCloseTo(target.lng, 4);
  });
});
