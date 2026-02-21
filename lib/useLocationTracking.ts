import { useState, useRef, useCallback, useEffect } from 'react';
import { Platform } from 'react-native';
import * as Location from 'expo-location';
import type { RoutePoint } from './route-generator';

const BACKGROUND_LOCATION_TASK = 'background-location-tracking';

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

/** GPS accuracy to signal strength (0-3) */
export function accuracyToStrength(accuracy: number | null): 0 | 1 | 2 | 3 {
  if (accuracy === null) return 0;
  if (accuracy <= 5) return 3;
  if (accuracy <= 15) return 2;
  if (accuracy <= 30) return 1;
  return 0;
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
          const point: RoutePoint = {
            lat: loc.coords.latitude,
            lng: loc.coords.longitude,
          };

          if (lastBackgroundPoint) {
            const dist = haversineDistance(lastBackgroundPoint, point);
            if (dist < 0.003) continue;
          }

          sharedCoordinates.push(point);
          if (lastBackgroundPoint) {
            sharedTotalDistance += haversineDistance(lastBackgroundPoint, point);
          }
          lastBackgroundPoint = point;
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
  const lastPointRef = useRef<RoutePoint | null>(null);
  const splitTimestampsRef = useRef<number[]>([]);
  const accuracyRef = useRef<number | null>(null);

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

        setStats({
          coordinates: [...coords],
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

  const startTracking = useCallback(async () => {
    // Reset all state
    coordinatesRef.current = [];
    totalDistanceRef.current = 0;
    elapsedRef.current = 0;
    lastPointRef.current = null;
    splitTimestampsRef.current = [];
    sharedCoordinates = [];
    sharedTotalDistance = 0;
    lastBackgroundPoint = null;

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
      console.warn('Foreground location permission denied');
      return;
    }

    // Start foreground watching
    watchRef.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.High,
        timeInterval: 3000,
        distanceInterval: 3,
      },
      (location) => {
        const point: RoutePoint = {
          lat: location.coords.latitude,
          lng: location.coords.longitude,
        };

        accuracyRef.current = location.coords.accuracy;

        // Filter GPS jitter
        if (lastPointRef.current) {
          const dist = haversineDistance(lastPointRef.current, point);
          if (dist < 0.003) return; // less than 3m
        }

        coordinatesRef.current.push(point);
        if (lastPointRef.current) {
          totalDistanceRef.current += haversineDistance(lastPointRef.current, point);
        }
        lastPointRef.current = point;

        // Sync to shared state for background task
        sharedCoordinates = [...coordinatesRef.current];
        sharedTotalDistance = totalDistanceRef.current;
        lastBackgroundPoint = point;
      }
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
              notificationTitle: 'Running Routes',
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
      (location) => {
        const point: RoutePoint = {
          lat: location.coords.latitude,
          lng: location.coords.longitude,
        };

        accuracyRef.current = location.coords.accuracy;

        if (lastPointRef.current) {
          const dist = haversineDistance(lastPointRef.current, point);
          if (dist < 0.003) return;
        }

        coordinatesRef.current.push(point);
        if (lastPointRef.current) {
          totalDistanceRef.current += haversineDistance(lastPointRef.current, point);
        }
        lastPointRef.current = point;

        sharedCoordinates = [...coordinatesRef.current];
        sharedTotalDistance = totalDistanceRef.current;
        lastBackgroundPoint = point;
      }
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
