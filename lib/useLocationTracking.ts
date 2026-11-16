import { useState, useRef, useCallback, useEffect } from 'react';
import { Platform } from 'react-native';
import * as Location from 'expo-location';
import type { RoutePoint } from './route-generator';
import { fetchOSRMNearest } from './osrm';

const BACKGROUND_LOCATION_TASK = 'background-location-tracking';

/** Thrown by `startTracking` when the user denies the foreground location
 *  permission. Caller should surface a permission alert rather than letting
 *  the run start silently — the recording chip would tick with no GPS data
 *  captured, which historically led users to finish a 30-min run with 0.0 km
 *  recorded. Distinct from generic errors (web/native unavailability) so the
 *  caller can branch on it. */
export class LocationPermissionDeniedError extends Error {
  constructor() {
    super('Location permission denied');
    this.name = 'LocationPermissionDeniedError';
  }
}

/** Haversine distance in km */
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

/** Foreground watch config while a run is recording (CLAUDE.md #55).
 *  `BestForNavigation` = `kCLLocationAccuracyBestForNavigation`, Apple's
 *  highest-accuracy mode (GPS fused with the motion sensors). Do NOT go back
 *  to `Accuracy.High`: on iOS expo-location maps it to
 *  `kCLLocationAccuracyNearestTenMeters`, a coarse 10m-class mode — the root
 *  cause underneath the jittery / off-road live track fixed symptomatically
 *  in #44, #50, #52. Built in a function (not a module constant) so the
 *  expo-location enums are only touched when tracking actually starts. */
function foregroundWatchOptions(): Location.LocationOptions {
  return {
    accuracy: Location.Accuracy.BestForNavigation,
    // No distance filter: every fix Core Location produces (~1 Hz). The
    // recorder drops sub-3m moves itself and the live /nearest snap is
    // distance-throttled, so the denser feed costs nothing downstream.
    distanceInterval: 0,
    // Android only — expo-location ignores timeInterval on iOS (which is
    // why the old "one point per 3s" pace math was wrong there; #56).
    timeInterval: 1000,
  };
}

/** Background task config (CLAUDE.md #55). Runs whenever the phone is
 *  locked/backgrounded — i.e. most of a typical run. */
function backgroundTaskOptions(): Location.LocationTaskOptions {
  return {
    accuracy: Location.Accuracy.BestForNavigation,
    distanceInterval: 5,
    timeInterval: 5000, // Android only
    // Tells Core Location this is a workout, so its pause heuristics are
    // tuned for running rather than generic use (default: .other).
    activityType: Location.ActivityType.Fitness,
    // expo-location's NATIVE default is true (EXLocationTaskConsumer.m
    // `defaultValue:true`) even though its TS docs say false. With it on,
    // iOS may pause updates when the runner stops (a red light) and does
    // not restart them on its own while the phone is locked — the rest of
    // the run degrades to sparse significant-change points.
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Run Routes',
      notificationBody: 'Tracking your run...',
    },
  };
}

/** Exponential moving average smoothing weight applied to incoming GPS
 *  samples. New point contributes 0.5, previous smoothed point contributes
 *  0.5 — enough to visibly straighten the polyline without noticeable lag
 *  at the ~1 Hz rate Core Location delivers while running (lag ≈ one fix).
 *  Higher (e.g., 0.7) tracks raw GPS more closely; lower (e.g., 0.3) smooths
 *  harder but the recorded track lags further behind the runner. The
 *  recorded polyline IS the smoothed one — moving average doesn't lose path
 *  distance for runs, since the jitter the filter removes was inflating
 *  distance to begin with. */
const SMOOTH_ALPHA = 0.5;

/** Apply EMA smoothing to a new raw GPS sample. Returns the smoothed point
 *  to use as the next polyline vertex. Exported for unit testing.  */
export function smoothGpsSample(prev: RoutePoint | null, raw: RoutePoint): RoutePoint {
  if (!prev) return raw;
  return {
    lat: SMOOTH_ALPHA * raw.lat + (1 - SMOOTH_ALPHA) * prev.lat,
    lng: SMOOTH_ALPHA * raw.lng + (1 - SMOOTH_ALPHA) * prev.lng,
  };
}

/** Reject samples whose reported accuracy is worse than this many meters.
 *  Position quality below this is dominated by multipath errors (urban
 *  canyons, indoor refraction); smoothing can't recover them and they drag
 *  the EMA toward fictitious positions. 50m was picked because typical
 *  outdoor reception is 5-15m and we still want the run to start recording
 *  while GPS is warming up at the start of a session. */
const MAX_ACCEPTED_ACCURACY_M = 50;

/** Smoothed points closer than this (km) to the previous recorded point are
 *  dropped — sub-3m moves are jitter while standing still, not running. */
const MIN_APPEND_DISTANCE_KM = 0.003;

/** If no usable fix arrived for this long (tunnel, GPS dropout, or the app
 *  backgrounded without background permission), the next fix starts a fresh
 *  smoothing segment instead of being averaged with the stale pre-gap point.
 *  Averaging across a gap put the recorded position (and everything keyed
 *  off it: off-route, auto-finish, turn prompts) hundreds of meters behind
 *  the runner for several seconds (CLAUDE.md #56). The straight-line
 *  distance across the gap still counts — the runner did cover it. */
const GAP_RESEED_MS = 15_000;

/** A fix timestamped this far BEFORE the newest one seen is treated as a
 *  device clock reset rather than an out-of-order duplicate — otherwise
 *  every fix would be dropped until the clock caught back up. */
const CLOCK_RESET_MS = 5 * 60_000;

/** Current pace = time / distance over this trailing window of fixes. */
const PACE_WINDOW_MS = 30_000;
/** Don't report a current pace from less than this much data. */
const PACE_MIN_SPAN_MS = 10_000;
/** Newest recorded point older than this → runner has stopped; show
 *  '--:--' rather than freezing the last running pace on screen. */
const PACE_STALE_MS = 10_000;

/** Minimum distance (km) the smoothed sample must move from the previous
 *  snap-attempt point before we fire another /nearest call. At running pace
 *  (~3 m/s) the 20m throttle means one snap roughly every ~7s — high enough
 *  that the live blue track snaps onto the road within a few seconds of
 *  going off, low enough that we don't burn the public-OSRM /nearest
 *  budget. Distance-based, so the call rate doesn't depend on fix cadence. */
const SNAP_THROTTLE_DISTANCE_KM = 0.020;

/** Should we kick off a /nearest snap for this smoothed sample? True iff
 *  no snap has been attempted yet this run, or the sample has moved far
 *  enough from the last attempt to justify another call. Pure function so
 *  the throttle policy is unit-testable in isolation. */
export function shouldSnapToRoad(
  lastAttempt: RoutePoint | null,
  current: RoutePoint,
  thresholdKm: number = SNAP_THROTTLE_DISTANCE_KM,
): boolean {
  if (!lastAttempt) return true;
  return haversineDistance(lastAttempt, current) >= thresholdKm;
}

/** One location fix from Core Location, via either stream. */
export interface GpsFix {
  lat: number;
  lng: number;
  /** Horizontal accuracy radius in meters, or null if unknown. */
  accuracy: number | null;
  /** Fix time in ms since epoch (CLLocation.timestamp). */
  timestamp: number;
}

export interface PaceSample {
  ts: number;
  distanceKm: number;
}

/** All recording state for one run. There is exactly ONE of these, fed by
 *  BOTH the foreground watch and the background task (CLAUDE.md #56).
 *  Previously each stream kept its own smoothing anchor and its own copy of
 *  the track, synced by array copies — after the phone was locked and
 *  unlocked mid-run, the foreground stream averaged its first new fix with
 *  where the runner had been BEFORE locking. */
export interface TrackRecorder {
  /** Recorded (smoothed) track, oldest first. Only ever appended to, except
   *  that the live /nearest snap swaps a point in place. */
  coords: RoutePoint[];
  totalDistanceKm: number;
  /** Last smoothed point appended: the EMA anchor and the distance-delta
   *  anchor. Never the snapped value (CLAUDE.md #50). */
  lastSmoothed: RoutePoint | null;
  /** Newest fix timestamp seen from either stream — the dedupe guard. */
  lastFixTs: number | null;
  /** Newest fix that passed the accuracy gate — for gap detection. */
  lastAcceptedTs: number | null;
  /** Set on resume: the next accepted fix starts a fresh segment. */
  restartSegment: boolean;
  /** Paused or stopped: every fix is ignored. */
  paused: boolean;
  /** Accuracy of the newest fix (accepted or not), for the GPS chip. */
  lastAccuracy: number | null;
  /** Trailing (timestamp, cumulative distance) samples for current pace. */
  paceSamples: PaceSample[];
}

export function createTrackRecorder(): TrackRecorder {
  return {
    coords: [],
    totalDistanceKm: 0,
    lastSmoothed: null,
    lastFixTs: null,
    lastAcceptedTs: null,
    restartSegment: false,
    paused: false,
    lastAccuracy: null,
    paceSamples: [],
  };
}

/** Feed one fix into the recorder. Returns the point appended to the track,
 *  or null if the fix was dropped (paused, duplicate, inaccurate, jitter).
 *  Pure apart from mutating `rec`; exported for unit testing. */
export function ingestFix(rec: TrackRecorder, fix: GpsFix): RoutePoint | null {
  if (rec.paused) return null;

  // While the app is foregrounded, the foreground watch and the background
  // task are two separate CLLocationManagers and BOTH receive each fix.
  // Process a fix only if it's newer than anything seen from either stream;
  // this also discards out-of-order deliveries.
  if (rec.lastFixTs !== null && fix.timestamp <= rec.lastFixTs) {
    if (rec.lastFixTs - fix.timestamp < CLOCK_RESET_MS) return null;
    // Device clock jumped backwards: restart time-based bookkeeping.
    rec.lastAcceptedTs = null;
    rec.paceSamples = [];
  }
  rec.lastFixTs = fix.timestamp;
  rec.lastAccuracy = fix.accuracy;

  if (fix.accuracy !== null && fix.accuracy > MAX_ACCEPTED_ACCURACY_M) return null;

  const prev = rec.lastSmoothed;
  const raw: RoutePoint = { lat: fix.lat, lng: fix.lng };
  const resuming = rec.restartSegment;
  const afterGap = rec.lastAcceptedTs !== null && fix.timestamp - rec.lastAcceptedTs > GAP_RESEED_MS;
  rec.lastAcceptedTs = fix.timestamp;

  let point: RoutePoint;
  if (prev === null || resuming || afterGap) {
    point = raw;
  } else {
    point = smoothGpsSample(prev, raw);
    if (haversineDistance(prev, point) < MIN_APPEND_DISTANCE_KM) return null;
  }

  rec.coords.push(point);
  // Distance across a pause is NOT run distance (the clock was stopped too).
  if (prev !== null && !resuming) rec.totalDistanceKm += haversineDistance(prev, point);
  rec.lastSmoothed = point;
  rec.restartSegment = false;

  rec.paceSamples.push({ ts: fix.timestamp, distanceKm: rec.totalDistanceKm });
  const cutoff = fix.timestamp - PACE_WINDOW_MS;
  while (rec.paceSamples.length > 2 && rec.paceSamples[1].ts <= cutoff) rec.paceSamples.shift();

  return point;
}

/** Pause recording. The background task stays registered through a pause
 *  (restarting it on resume could re-prompt or fail), so the recorder must
 *  ignore what it delivers. Previously it kept recording during a pause and
 *  the distance moved while paused was added to the run on resume. */
export function pauseRecorder(rec: TrackRecorder): void {
  rec.paused = true;
}

/** Resume as a fresh segment: the first fix after resume is recorded as-is
 *  (not averaged with the pre-pause point), the displacement across the
 *  pause isn't counted as distance, and current pace restarts so paused
 *  time doesn't drag it down. */
export function resumeRecorder(rec: TrackRecorder): void {
  rec.paused = false;
  rec.restartSegment = true;
  rec.paceSamples = [];
}

/** Current pace from real fix timestamps: time / distance over the trailing
 *  PACE_WINDOW_MS of recorded points. Replaces the old estimate that assumed
 *  one point per 3s — true on Android, but iOS ignores `timeInterval` and
 *  delivers ~1 fix/s, so the readout showed ~2x too slow or '--:--'
 *  (CLAUDE.md #56). Exported for unit testing. */
export function computeCurrentPace(samples: PaceSample[], nowMs: number): string {
  if (samples.length < 2) return '--:--';
  const last = samples[samples.length - 1];
  if (nowMs - last.ts > PACE_STALE_MS) return '--:--';
  const windowStart = last.ts - PACE_WINDOW_MS;
  let first = last;
  for (let i = samples.length - 2; i >= 0 && samples[i].ts >= windowStart; i--) {
    first = samples[i];
  }
  const spanMs = last.ts - first.ts;
  const distKm = last.distanceKm - first.distanceKm;
  if (spanMs < PACE_MIN_SPAN_MS || distKm < 0.005) return '--:--';
  const paceMinPerKm = spanMs / 60000 / distKm;
  if (paceMinPerKm <= 2 || paceMinPerKm >= 15) return '--:--';
  return formatPace(paceMinPerKm);
}

/** Format pace from min/km number to mm:ss string */
function formatPace(paceMinPerKm: number): string {
  if (!isFinite(paceMinPerKm) || paceMinPerKm <= 0) return '--:--';
  const mins = Math.floor(paceMinPerKm);
  const secs = Math.round((paceMinPerKm - mins) * 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function formatSplitTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export interface TrackingStats {
  coordinates: RoutePoint[];
  totalDistanceKm: number;
  elapsedSeconds: number;
  currentPace: string; // mm:ss per km
  avgPace: string; // mm:ss per km
  splits: { km: number; pace: string; time: string }[];
  currentPosition: RoutePoint | null;
  accuracy: number | null;
}

function emptyStats(): TrackingStats {
  return {
    coordinates: [],
    totalDistanceKm: 0,
    elapsedSeconds: 0,
    currentPace: '--:--',
    avgPace: '--:--',
    splits: [],
    currentPosition: null,
    accuracy: null,
  };
}

/** The recorder for the active run. Module-level (not hook state) because
 *  the background TaskManager task, defined at module scope, must write to
 *  the same series as the foreground watch. Replaced by `startTracking`;
 *  readers always go through this binding so they see the current run. */
let recorder: TrackRecorder = createTrackRecorder();

function locationToFix(loc: Location.LocationObject): GpsFix {
  return {
    lat: loc.coords.latitude,
    lng: loc.coords.longitude,
    accuracy: typeof loc.coords.accuracy === 'number' ? loc.coords.accuracy : null,
    timestamp: typeof loc.timestamp === 'number' ? loc.timestamp : Date.now(),
  };
}

// Register background location task (native only)
if (Platform.OS !== 'web') {
  try {
    const TaskManager = require('expo-task-manager');
    TaskManager.defineTask(BACKGROUND_LOCATION_TASK, ({ data, error }: any) => {
      if (error) {
        console.warn('Background location error:', error);
        return;
      }
      if (data) {
        const { locations } = data as { locations: Location.LocationObject[] };
        for (const loc of locations) {
          ingestFix(recorder, locationToFix(loc));
        }
      }
    });
  } catch (err) {
    console.log('TaskManager not available:', err);
  }
}

export function useLocationTracking() {
  const [stats, setStats] = useState<TrackingStats>(emptyStats);

  const [isTracking, setIsTracking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef(0);
  const splitTimestampsRef = useRef<number[]>([]);
  // Cached snapshot of the coordinates array we last handed to setStats.
  // Reused as the next setStats `coordinates` field when no new GPS points
  // came in, so the reference stays stable and React.memo'd map consumers
  // can skip re-rendering once per second for nothing.
  const lastEmittedCoordsRef = useRef<RoutePoint[]>([]);
  // Tracks the smoothed point we last submitted to /nearest, so we don't
  // re-snap the same patch of road on every fix (the throttle window is
  // SNAP_THROTTLE_DISTANCE_KM).
  const lastSnappedAttemptRef = useRef<RoutePoint | null>(null);
  // Set to true by the snap callback when it mutates the track in place.
  // The timer's array-rebuild check uses length only — without this flag,
  // an in-place index swap would skip emission and the snapped point
  // wouldn't reach the map until the NEXT GPS sample arrived.
  const snapPendingEmitRef = useRef(false);

  // Elapsed time ticker
  useEffect(() => {
    if (isTracking && !isPaused) {
      timerRef.current = setInterval(() => {
        elapsedRef.current += 1;

        const elapsed = elapsedRef.current;
        const dist = recorder.totalDistanceKm;
        const coords = recorder.coords;

        const currentPace = computeCurrentPace(recorder.paceSamples, Date.now());

        // Average pace
        let avgPace = '--:--';
        if (dist > 0.01 && elapsed > 5) {
          const avgPaceVal = (elapsed / 60) / dist;
          if (avgPaceVal > 2 && avgPaceVal < 15) {
            avgPace = formatPace(avgPaceVal);
          }
        }

        // Calculate splits
        const splits: { km: number; pace: string; time: string }[] = [];
        const fullKms = Math.floor(dist);

        // Check for new km crossing
        while (splitTimestampsRef.current.length < fullKms) {
          splitTimestampsRef.current.push(elapsed);
        }

        for (let k = 0; k < splitTimestampsRef.current.length; k++) {
          const splitTime = k === 0
            ? splitTimestampsRef.current[0]
            : splitTimestampsRef.current[k] - splitTimestampsRef.current[k - 1];
          splits.push({
            km: k + 1,
            pace: formatPace(splitTime / 60),
            time: formatSplitTime(splitTime),
          });
        }

        // Only allocate a fresh coordinates array when length actually grew
        // OR when a snap callback mutated the track in-place since the last
        // emit. Either condition means downstream consumers need to
        // re-render; otherwise reuse the previously-emitted ref so
        // React.memo'd map components skip cleanly.
        const snapDirty = snapPendingEmitRef.current;
        const coordsForState =
          coords.length === lastEmittedCoordsRef.current.length && !snapDirty
            ? lastEmittedCoordsRef.current
            : [...coords];
        lastEmittedCoordsRef.current = coordsForState;
        snapPendingEmitRef.current = false;

        setStats({
          coordinates: coordsForState,
          totalDistanceKm: dist,
          elapsedSeconds: elapsed,
          currentPace,
          avgPace,
          splits,
          currentPosition: coords.length > 0 ? coords[coords.length - 1] : null,
          accuracy: recorder.lastAccuracy,
        });
      }, 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isTracking, isPaused]);

  /** Foreground-watch callback. Feeds the shared recorder (same path as the
   *  background task), then kicks off a throttled /nearest snap to nudge
   *  the just-recorded point onto a real road. Kept as a closure (not a
   *  useCallback) — it only touches refs and the module-level recorder, so
   *  the instance captured by the watch subscription is always current. */
  const handleLocationUpdate = (location: Location.LocationObject) => {
    ingestFix(recorder, locationToFix(location));

    // Throttled live road-snap of the NEWEST recorded point, whichever
    // stream recorded it: when the background task's copy of this fix won
    // the dedupe race, ingestFix returned null here but the point is in the
    // track all the same. Triggered only from the foreground watch (so only
    // while the app is foregrounded — async network calls from the
    // background task are fragile on iOS, CLAUDE.md #50). Fires
    // asynchronously; the run is never blocked on the snap resolving.
    const track = recorder.coords;
    const snapIndex = track.length - 1;
    const newest = recorder.lastSmoothed;
    // Nothing recorded yet, or the newest point was already snapped.
    if (!newest || track[snapIndex] !== newest) return;
    if (!shouldSnapToRoad(lastSnappedAttemptRef.current, newest)) return;
    lastSnappedAttemptRef.current = newest;
    fetchOSRMNearest(newest)
      .then((snapped) => {
        // No-op if /nearest returned the input unchanged.
        if (snapped.lat === newest.lat && snapped.lng === newest.lng) return;
        // Drop the snap if a new run replaced the recorder while we were
        // awaiting, or the slot no longer holds the exact point we sent.
        if (recorder.coords !== track || track[snapIndex] !== newest) return;
        track[snapIndex] = snapped;
        snapPendingEmitRef.current = true;
      })
      .catch(() => {
        // fetchOSRMNearest already swallows internal errors; defensive
        // catch so any unexpected rejection doesn't take down the run.
      });
  };

  const startTracking = useCallback(async () => {
    // Fresh recorder: a new run never inherits the previous run's track,
    // smoothing anchor, distance, or pause state.
    recorder = createTrackRecorder();
    elapsedRef.current = 0;
    splitTimestampsRef.current = [];
    lastEmittedCoordsRef.current = [];
    lastSnappedAttemptRef.current = null;
    snapPendingEmitRef.current = false;

    setStats(emptyStats());

    // Request permissions
    const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
    if (fgStatus !== 'granted') {
      throw new LocationPermissionDeniedError();
    }

    // Start foreground watching
    watchRef.current = await Location.watchPositionAsync(
      foregroundWatchOptions(),
      handleLocationUpdate,
    );

    // Try to start background tracking (native only)
    if (Platform.OS !== 'web') {
      try {
        const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
        if (bgStatus === 'granted') {
          await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, backgroundTaskOptions());
        }
      } catch (err) {
        // Background tracking is optional; foreground is sufficient
        console.log('Background location not available:', err);
      }
    }

    setIsTracking(true);
    setIsPaused(false);
  }, []);

  const pauseTracking = useCallback(() => {
    pauseRecorder(recorder);
    setIsPaused(true);
    // Stop foreground watch but keep background alive
    if (watchRef.current) {
      watchRef.current.remove();
      watchRef.current = null;
    }
  }, []);

  const resumeTracking = useCallback(async () => {
    resumeRecorder(recorder);
    setIsPaused(false);

    // Restart foreground watch
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return;

    watchRef.current = await Location.watchPositionAsync(
      foregroundWatchOptions(),
      handleLocationUpdate,
    );
  }, []);

  const stopTracking = useCallback(async () => {
    // Freeze the recorder so a straggling fix (delivered before the location
    // managers actually stop) can't append after the run ends.
    pauseRecorder(recorder);

    if (watchRef.current) {
      watchRef.current.remove();
      watchRef.current = null;
    }

    if (Platform.OS !== 'web') {
      try {
        const TaskManager = require('expo-task-manager');
        const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
        if (isRegistered) {
          await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
        }
      } catch (err) {
        console.log('Error stopping background location:', err);
      }
    }

    setIsTracking(false);
    setIsPaused(false);
  }, []);

  return {
    stats,
    isTracking,
    isPaused,
    startTracking,
    pauseTracking,
    resumeTracking,
    stopTracking,
  };
}
