import {
  createTrackRecorder,
  ingestFix,
  pauseRecorder,
  resumeRecorder,
  computeCurrentPace,
  type GpsFix,
  type TrackRecorder,
} from '../useLocationTracking';

// Runs head due north from East Village. Haversine with R=6371km makes one
// degree of latitude 111,195m, so north-offsets convert exactly.
const T0 = 1_760_000_000_000;
const ORIGIN = { lat: 40.7265, lng: -73.9815 };
const M_PER_DEG_LAT = 111_195;

function fix(tSec: number, northM: number, accuracy: number | null = 5): GpsFix {
  return { lat: ORIGIN.lat + northM / M_PER_DEG_LAT, lng: ORIGIN.lng, accuracy, timestamp: T0 + tSec * 1000 };
}

const northOf = (p: { lat: number }) => (p.lat - ORIGIN.lat) * M_PER_DEG_LAT;

/** Steady run north at 3 m/s, one fix every `everySec` for t in [from, to]. */
function feedRun(rec: TrackRecorder, from: number, to: number, everySec = 1, speed = 3): void {
  for (let t = from; t <= to; t += everySec) ingestFix(rec, fix(t, t * speed));
}

describe('ingestFix', () => {
  test('a steady run records the true distance (within one fix of smoothing lag)', () => {
    const rec = createTrackRecorder();
    feedRun(rec, 0, 120); // 360m
    expect(rec.totalDistanceKm * 1000).toBeGreaterThan(360 * 0.98);
    expect(rec.totalDistanceKm * 1000).toBeLessThanOrEqual(360);
  });

  test('a fix delivered by both location streams is recorded once', () => {
    // Foreground watch gets every fix; the background task (5m filter) gets
    // every other one, with the same CLLocation timestamp, in either order.
    const single = createTrackRecorder();
    const both = createTrackRecorder();
    for (let t = 0; t <= 300; t++) {
      const f = fix(t, t * 3);
      ingestFix(single, f);
      if (t % 2 === 0) {
        if (t % 4 === 0) { ingestFix(both, { ...f }); ingestFix(both, f); }
        else { ingestFix(both, f); ingestFix(both, { ...f }); }
      } else {
        ingestFix(both, f);
      }
    }
    expect(both.totalDistanceKm).toBe(single.totalDistanceKm);
    expect(both.coords).toEqual(single.coords);
  });

  test('out-of-order fixes are dropped', () => {
    const rec = createTrackRecorder();
    ingestFix(rec, fix(10, 30));
    expect(ingestFix(rec, fix(9, 60))).toBeNull();
    expect(rec.coords).toHaveLength(1);
  });

  test('a backwards device-clock jump of minutes is a reset, not a reason to drop every fix', () => {
    const rec = createTrackRecorder();
    feedRun(rec, 0, 100);
    const before = rec.coords.length;
    // Clock jumps back 10 minutes; recording must continue.
    for (let i = 1; i <= 10; i++) ingestFix(rec, fix(100 - 600 + i, (100 + i) * 3));
    expect(rec.coords.length).toBeGreaterThan(before + 3);
  });

  test('low-accuracy fixes are ignored but their accuracy is still reported', () => {
    const rec = createTrackRecorder();
    expect(ingestFix(rec, fix(0, 0, 80))).toBeNull();
    expect(rec.lastAccuracy).toBe(80);
    expect(rec.coords).toHaveLength(0);
    // Unknown accuracy (null) is accepted.
    expect(ingestFix(rec, fix(1, 0, null))).not.toBeNull();
  });

  test('sub-3m jitter while standing still is not recorded', () => {
    const rec = createTrackRecorder();
    for (let t = 0; t < 30; t++) ingestFix(rec, fix(t, t % 2 === 0 ? 1 : -1));
    expect(rec.coords).toHaveLength(1);
    expect(rec.totalDistanceKm).toBe(0);
  });

  test('regression #56: after locking/unlocking mid-run the recorded position stays with the runner', () => {
    // Screen on for 2 min (both streams), locked 2:00-8:00 (background task
    // only, ~every 2s), unlocked again. The old code averaged the first
    // unlocked fix with where the runner was BEFORE locking (~100-200m
    // behind) and mis-counted the locked stretch by 15-25%.
    const rec = createTrackRecorder();
    for (let t = 0; t <= 600; t++) {
      const f = fix(t, t * 3);
      const locked = t > 120 && t < 480;
      if (locked) {
        if (t % 2 === 0) ingestFix(rec, f);
      } else {
        const appended = ingestFix(rec, f) ?? ingestFix(rec, { ...f });
        if (t === 480 && appended) expect(Math.abs(northOf(appended) - t * 3)).toBeLessThan(6);
      }
    }
    const last = rec.coords[rec.coords.length - 1];
    expect(Math.abs(northOf(last) - 1800)).toBeLessThan(6);
    expect(rec.totalDistanceKm * 1000).toBeGreaterThan(1800 * 0.99);
    expect(rec.totalDistanceKm * 1000).toBeLessThanOrEqual(1800);
  });

  test('after a gap with no fixes, the next fix is recorded as-is and the gap distance counts once', () => {
    const rec = createTrackRecorder();
    feedRun(rec, 0, 30); // 90m
    // No fixes for 60s (tunnel / no background permission); runner keeps going.
    const f = fix(90, 270);
    const appended = ingestFix(rec, f);
    expect(appended).toEqual({ lat: f.lat, lng: f.lng });
    expect(rec.totalDistanceKm * 1000).toBeGreaterThan(270 * 0.98);
    expect(rec.totalDistanceKm * 1000).toBeLessThanOrEqual(270);
  });

  test('pausing ignores both streams; resuming starts a fresh segment without counting the pause', () => {
    const rec = createTrackRecorder();
    feedRun(rec, 0, 60); // ~180m
    const atPause = rec.totalDistanceKm;
    pauseRecorder(rec);
    // Runner walks 180m further while paused — none of it is recorded.
    for (let t = 61; t <= 120; t++) expect(ingestFix(rec, fix(t, t * 3))).toBeNull();
    expect(rec.totalDistanceKm).toBe(atPause);

    resumeRecorder(rec);
    const f = fix(121, 363);
    expect(ingestFix(rec, f)).toEqual({ lat: f.lat, lng: f.lng });
    expect(rec.totalDistanceKm).toBe(atPause);
    feedRun(rec, 122, 150); // +87m after resume
    const expected = atPause * 1000 + 87;
    expect(rec.totalDistanceKm * 1000).toBeGreaterThan(expected - 4);
    expect(rec.totalDistanceKm * 1000).toBeLessThanOrEqual(expected);
  });
});

describe('computeCurrentPace', () => {
  const nowAfter = (rec: TrackRecorder) => rec.paceSamples[rec.paceSamples.length - 1].ts + 500;
  // 3 m/s = 333 s/km (5:33). Allow ±8 s/km: at exactly 3 m/s with 1 Hz
  // fixes each smoothed step sits right on the 3m append threshold, so the
  // smoothing lag of the window's end points varies between ~3m and ~4.5m —
  // up to 1.5m over a ~85m window, i.e. ~±6 s/km. Real GPS noise is larger.
  const paceSec = (p: string) => { const [m, s] = p.split(':').map(Number); return m * 60 + s; };
  const expectNear533 = (p: string) => {
    expect(p).not.toBe('--:--');
    expect(Math.abs(paceSec(p) - 333)).toBeLessThanOrEqual(8);
  };

  test('3 m/s reads 5:33/km whether fixes arrive every 1s (iOS) or every 3s', () => {
    for (const everySec of [1, 3]) {
      const rec = createTrackRecorder();
      feedRun(rec, 0, 90, everySec);
      expectNear533(computeCurrentPace(rec.paceSamples, nowAfter(rec)));
    }
  });

  test('shows --:-- once the runner has stopped for more than 10s', () => {
    const rec = createTrackRecorder();
    feedRun(rec, 0, 60);
    const lastTs = rec.paceSamples[rec.paceSamples.length - 1].ts;
    expectNear533(computeCurrentPace(rec.paceSamples, lastTs + 9_000));
    expect(computeCurrentPace(rec.paceSamples, lastTs + 11_000)).toBe('--:--');
  });

  test('needs at least 10s of movement', () => {
    const rec = createTrackRecorder();
    feedRun(rec, 0, 8);
    expect(computeCurrentPace(rec.paceSamples, nowAfter(rec))).toBe('--:--');
  });

  test('paused time does not drag pace down after resuming', () => {
    const rec = createTrackRecorder();
    feedRun(rec, 0, 60);
    pauseRecorder(rec);
    resumeRecorder(rec);
    // Resume 2 minutes later at a different spot and keep running at 3 m/s.
    // (45s, so the window is past the few seconds the smoothing lag takes
    // to build up after a fresh segment.) Without the reset on resume, the
    // 2-minute pause would sit inside the window and read as '--:--'.
    for (let t = 180; t <= 225; t++) ingestFix(rec, fix(t, 1000 + (t - 180) * 3));
    expectNear533(computeCurrentPace(rec.paceSamples, nowAfter(rec)));
  });
});
