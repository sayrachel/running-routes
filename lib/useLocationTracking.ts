import { useState, useRef, useCallback, useEffect } from 'react';
import { Platform } from 'react-native';
import * as Location from 'expo-location';
import type { RoutePoint } from './route-generator';

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

/** Exponential moving average smoothing weight applied to incoming GPS
 *  samples. New point contributes 0.5, previous smoothed point contributes
 *  0.5 — enough to visibly straighten the polyline without introducing
 *  noticeable lag at the 3s sample rate. Higher (e.g., 0.7) tracks raw GPS
 *  more closely; lower (e.g., 0.3) smooths harder but the live cursor lags
 *  behind the runner's actual position. The recorded polyline IS the smoothed
 *  one — moving average doesn't lose path distance for runs, since the
 *  jitter the filter removes was inflating distance to begin with. */
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

// Shared state for background task communication
let sharedCoordinates: RoutePoint[] = [];
let sharedTotalDistance = 0;
let lastBackgroundPoint: RoutePoint | null = null;
let lastBackgroundSmoothed: RoutePoint | null = null;

/** Reset all module-level smoothing/distance state. Called from
 *  `startTracking` so a fresh run never inherits the previous run's
 *  smoothed-tail position or its accumulated distance. */
function resetSmoothingState(): void {
  sharedCoordinates = [];
  sharedTotalDistance = 0;
  lastBackgroundPoint = null;
  lastBackgroundSmoothed = null;
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
          // Drop low-precision samples entirely — they're more likely to
          // distort the smoothed track than to contribute useful position.
          if (
            typeof loc.coords.accuracy === 'number' &&
            loc.coords.accuracy > MAX_ACCEPTED_ACCURACY_M
          ) {
            continue;
          }
          const raw: RoutePoint = {
            lat: loc.coords.latitude,
            lng: loc.coords.longitude,
          };
          const smoothed = smoothGpsSample(lastBackgroundSmoothed, raw);

          if (lastBackgroundSmoothed) {
            const dist = haversineDistance(lastBackgroundSmoothed, smoothed);
            if (dist < 0.003) continue;
          }

          sharedCoordinates.push(smoothed);
          if (lastBackgroundSmoothed) {
            sharedTotalDistance += haversineDistance(lastBackgroundSmoothed, smoothed);
          }
          lastBackgroundPoint = raw;
          lastBackgroundSmoothed = smoothed;
        }
      }
    });
  } catch (err) {
    console.log('TaskManager not available:', err);
  }
}

export function useLocationTracking() {
  const [stats, setStats] = useState<TrackingStats>({
    coordinates: [],
    totalDistanceKm: 0,
    elapsedSeconds: 0,
    currentPace: '--:--',
    avgPace: '--:--',
    splits: [],
    currentPosition: null,
    accuracy: null,
  });

  const [isTracking, setIsTracking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  const watchRef = useRef<Location.LocationSubscription | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const coordinatesRef = useRef<RoutePoint[]>([]);
  const totalDistanceRef = useRef(0);
  const elapsedRef = useRef(0);
  // Last SMOOTHED point we appended to the polyline. Used as the EMA
  // baseline for the next incoming raw sample and as the distance-delta
  // anchor — both display + distance flow through the same smoothed series
  // so a single jittery sample can't inflate distance or visibly squiggle
  // the line.
  const lastPointRef = useRef<RoutePoint | null>(null);
  const splitTimestampsRef = useRef<number[]>([]);
  const accuracyRef = useRef<number | null>(null);
  // Cached snapshot of the coordinates array we last handed to setStats.
  // Reused as the next setStats `coordinates` field when no new GPS points
  // came in, so the reference stays stable and React.memo'd map consumers
  // can skip re-rendering once per second for nothing.
  const lastEmittedCoordsRef = useRef<RoutePoint[]>([]);

  // Elapsed time ticker
  useEffect(() => {
    if (isTracking && !isPaused) {
      timerRef.current = setInterval(() => {
        elapsedRef.current += 1;

        // Sync background coordinates if any
        if (sharedCoordinates.length > coordinatesRef.current.length) {
          coordinatesRef.current = [...sharedCoordinates];
          totalDistanceRef.current = sharedTotalDistance;
        }

        const elapsed = elapsedRef.current;
        const dist = totalDistanceRef.current;
        const coords = coordinatesRef.current;

        // Calculate current pace from last ~30 seconds of movement
        let currentPace = '--:--';
        if (coords.length >= 2 && elapsed > 10) {
          const recentCount = Math.min(coords.length, 10);
          const recentCoords = coords.slice(-recentCount);
          let recentDist = 0;
          for (let j = 1; j < recentCoords.length; j++) {
            recentDist += haversineDistance(recentCoords[j - 1], recentCoords[j]);
          }
          if (recentDist > 0.005) {
            // Estimate time for these points (~3s per point)
            const recentTimeSec = recentCount * 3;
            const paceMinPerKm = (recentTimeSec / 60) / recentDist;
            if (paceMinPerKm > 2 && paceMinPerKm < 15) {
              currentPace = formatPace(paceMinPerKm);
            }
          }
        }

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

        // Only allocate a fresh coordinates array when length actually grew.
        // Otherwise reuse the previously-emitted ref so downstream React.memo
        // checks (RouteMap compares gpsTrack length) skip cleanly.
        const coordsForState = coords.length === lastEmittedCoordsRef.current.length
          ? lastEmittedCoordsRef.current
          : [...coords];
        lastEmittedCoordsRef.current = coordsForState;

        setStats({
          coordinates: coordsForState,
          totalDistanceKm: dist,
          elapsedSeconds: elapsed,
          currentPace,
          avgPace,
          splits,
          currentPosition: coords.length > 0 ? coords[coords.length - 1] : null,
          accuracy: accuracyRef.current,
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

  /** Shared handler for both foreground-watch and resume-watch callbacks.
   *  Filters low-precision samples, applies EMA smoothing, dedupes
   *  sub-3m moves, then appends the smoothed point to the polyline and
   *  syncs to background-task shared state. Kept as a closure (not a
   *  useCallback) so the ref accesses are always current — the watch
   *  subscription captures whatever was the latest closure at start. */
  const handleLocationUpdate = (location: Location.LocationObject) => {
    accuracyRef.current = location.coords.accuracy;
    if (
      typeof location.coords.accuracy === 'number' &&
      location.coords.accuracy > MAX_ACCEPTED_ACCURACY_M
    ) {
      return;
    }
    const raw: RoutePoint = {
      lat: location.coords.latitude,
      lng: location.coords.longitude,
    };
    const smoothed = smoothGpsSample(lastPointRef.current, raw);

    if (lastPointRef.current) {
      const dist = haversineDistance(lastPointRef.current, smoothed);
      if (dist < 0.003) return;
    }

    coordinatesRef.current.push(smoothed);
    if (lastPointRef.current) {
      totalDistanceRef.current += haversineDistance(lastPointRef.current, smoothed);
    }
    lastPointRef.current = smoothed;

    sharedCoordinates = [...coordinatesRef.current];
    sharedTotalDistance = totalDistanceRef.current;
    lastBackgroundPoint = raw;
    lastBackgroundSmoothed = smoothed;
  };

  const startTracking = useCallback(async () => {
    // Reset all state
    coordinatesRef.current = [];
    totalDistanceRef.current = 0;
    elapsedRef.current = 0;
    lastPointRef.current = null;
    splitTimestampsRef.current = [];
    lastEmittedCoordsRef.current = [];
    resetSmoothingState();

    setStats({
      coordinates: [],
      totalDistanceKm: 0,
      elapsedSeconds: 0,
      currentPace: '--:--',
      avgPace: '--:--',
      splits: [],
      currentPosition: null,
      accuracy: null,
    });

    // Request permissions
    const { status: fgStatus } = await Location.requestForegroundPermissionsAsync();
    if (fgStatus !== 'granted') {
      throw new LocationPermissionDeniedError();
    }

    // Start foreground watching
    watchRef.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.High,
        timeInterval: 3000,
        distanceInterval: 3,
      },
      handleLocationUpdate,
    );

    // Try to start background tracking (native only)
    if (Platform.OS !== 'web') {
      try {
        const { status: bgStatus } = await Location.requestBackgroundPermissionsAsync();
        if (bgStatus === 'granted') {
          await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
            accuracy: Location.Accuracy.High,
            timeInterval: 5000,
            distanceInterval: 5,
            showsBackgroundLocationIndicator: true,
            foregroundService: {
              notificationTitle: 'Run Routes',
              notificationBody: 'Tracking your run...',
            },
          });
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
    setIsPaused(true);
    // Stop foreground watch but keep background alive
    if (watchRef.current) {
      watchRef.current.remove();
      watchRef.current = null;
    }
  }, []);

  const resumeTracking = useCallback(async () => {
    setIsPaused(false);

    // Restart foreground watch
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return;

    watchRef.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.High,
        timeInterval: 3000,
        distanceInterval: 3,
      },
      handleLocationUpdate,
    );
  }, []);

  const stopTracking = useCallback(async () => {
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
