import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, Linking, ActivityIndicator, Alert } from 'react-native';
import { BlurView } from 'expo-blur';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as StoreReview from 'expo-store-review';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { RouteMap } from '@/components/RouteMap';
import { RunStats } from '@/components/RunStats';
import { StartButton } from '@/components/StartButton';
import { StatsView } from '@/components/StatsView';
import { ProfileDrawer, type DrawerView } from '@/components/ProfileDrawer';
import { useAppContext } from '@/lib/AppContext';
import { formatElevation } from '@/lib/units';
import { useLocationTracking, LocationPermissionDeniedError } from '@/lib/useLocationTracking';
import { saveRunRecord, addPendingRun, getCachedRunHistory } from '@/lib/firestore';
import { buildGoogleMapsUrl } from '@/lib/route-export';
import { BottomTabBar } from '@/components/BottomTabBar';
import { Colors, Fonts } from '@/lib/theme';
import { generateOSRMRoutes, OSRMUnavailableError, getLastFailureDiagnostics, haversineDistance } from '@/lib/osrm';
import { findMatchingHistoricalRoute } from '@/lib/route-history';
import { isDevUser } from '@/lib/dev-mode';
import { INITIAL_TURN_STATE, updateTurnByTurn, type TurnByTurnState } from '@/lib/turn-by-turn';
import { prepareAudioSession, resetSpokenPrompts, maybeFireCues, speakOffCourse } from '@/lib/audio-cues';
import { ManeuverBanner } from '@/components/ManeuverBanner';
import type { ManeuverStep } from '@/lib/route-generator';
import type { RoutePoint } from '@/lib/route-generator';
import { persistOverpassCache } from '@/lib/overpass-persist';
import { persistOSRMCache } from '@/lib/osrm-persist';
import * as Updates from 'expo-updates';

/** Build the same `[n=… q=… (…) w=… v=…]` suffix used by the plan-screen
 *  error banner so refresh failures carry the same diagnostic. Returns ''
 *  for non-dev users (lib/dev-mode.ts) so the banner stays clean for
 *  everyone else. */
function failureDiagSuffix(email: string | null | undefined): string {
  if (!isDevUser(email)) return '';
  const diag = getLastFailureDiagnostics();
  const ver = (Updates.updateId ?? 'embedded').slice(0, 8);
  if (!diag) return ` [v=${ver}]`;
  const rr = diag.rejectReasons;
  const qBreakdown = diag.qualityRejectCount > 0
    ? ` (d=${rr.distance} b=${rr.barrier} h=${rr.highway} o=${rr.offStreet} p=${rr.pendantLoop} t=${rr.backtrack} a=${rr.aspect} tu=${rr.turnDensity})`
    : '';
  return ` [n=${diag.osrmNullCount} q=${diag.qualityRejectCount}${qBreakdown} w=${diag.wrongDisplayCount}${diag.budgetExpired ? ' BUDGET' : ''} v=${ver}]`;
}

/** Min haversine distance from a point to any vertex on the polyline.
 *  Vertex-only (not segment-projected) — fine for OSRM road routes which
 *  sample vertices ~10m apart, well below the 150m off-route threshold.
 *  Returns Infinity if the polyline is empty. */
function pointToPolylineKm(point: RoutePoint, polyline: RoutePoint[]): number {
  let min = Infinity;
  for (const v of polyline) {
    const d = haversineDistance(point, v);
    if (d < min) min = d;
  }
  return min;
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function RunScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const ctx = useAppContext();
  const tracking = useLocationTracking();

  const [showStats, setShowStats] = useState(false);
  const [runState, setRunState] = useState<'idle' | 'running' | 'paused'>('idle');
  const [isFinished, setIsFinished] = useState(false);
  const [finishedSplits, setFinishedSplits] = useState<{ km: number; pace: string; time: string }[]>([]);
  const [routeIndex, setRouteIndex] = useState(0);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [drawerInitialView, setDrawerInitialView] = useState<DrawerView>('profile');
  // Banner shown when refresh produces no usable route. Keeps the current
  // route visible (don't bounce to plan — the user loses context and gets
  // stuck in a loop if generation keeps failing) and tells them what happened.
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshErrorTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (refreshErrorTimeout.current) clearTimeout(refreshErrorTimeout.current);
    };
  }, []);

  // Off-route indicator. Passive: shows a chip when the user has been more
  // than 150m from the planned polyline for at least 30 continuous seconds.
  // Doesn't change the route or stats — just tells the user. Threshold is
  // generous enough to ignore typical detours (water fountain, traffic light)
  // and the 30s grace prevents the chip from flickering on momentary GPS
  // jumps or single-block deviations.
  const [isOffRoute, setIsOffRoute] = useState(false);
  const offRouteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Turn-by-turn state. The internal debounce/commit state lives in a ref so
  // GPS samples don't trigger re-renders just to update it; the UI-facing
  // values (current step + distance) live in React state and re-render the
  // ManeuverBanner when they change.
  const turnStateRef = useRef<TurnByTurnState>(INITIAL_TURN_STATE);
  const [navStep, setNavStep] = useState<ManeuverStep | null>(null);
  const [navDistanceM, setNavDistanceM] = useState<number | null>(null);

  // Audio session setup happens once per mount. Idempotent — safe even if
  // the user never starts a run.
  useEffect(() => {
    prepareAudioSession();
  }, []);

  // Reset turn-by-turn state and the spoken-prompt cache whenever the route
  // changes (initial gen, refresh, history fallback). Otherwise prompts
  // already fired on the previous route would be marked "spoken" and the
  // new route's identical-coord steps (rare but possible) would skip them.
  useEffect(() => {
    turnStateRef.current = INITIAL_TURN_STATE;
    setNavStep(null);
    setNavDistanceM(null);
    resetSpokenPrompts();
  }, [ctx.selectedRoute?.id]);
  useEffect(() => {
    return () => {
      if (offRouteTimerRef.current) clearTimeout(offRouteTimerRef.current);
    };
  }, []);
  const runSessionId = useRef(`run-${Date.now()}`);

  const isRunning = runState === 'running';
  const isPaused = runState === 'paused';
  const hasStarted = runState !== 'idle';

  const favId = ctx.selectedRoute ? `run-${ctx.selectedRoute.id}` : runSessionId.current;
  const isFavorited = ctx.favorites.some((f) => f.id === favId);

  const handleToggleFavorite = useCallback(() => {
    if (isFavorited) {
      ctx.removeFavorite(favId);
    } else {
      ctx.addFavorite({
        id: favId,
        routeName: ctx.selectedRoute?.name || 'Run',
        distance: parseFloat((ctx.selectedRoute?.distance || tracking.stats.totalDistanceKm).toFixed(1)),
        terrain: (ctx.selectedRoute?.terrain as 'Loop' | 'Out & Back' | 'Point to Point') || 'Loop',
        lat: ctx.center.lat,
        lng: ctx.center.lng,
        points: ctx.selectedRoute?.points,
      });
    }
  }, [ctx, isFavorited, favId, tracking.stats.totalDistanceKm]);

  // Recording indicator ping animation
  const recordingPing = useSharedValue(1);
  useEffect(() => {
    if (isRunning) {
      recordingPing.value = withRepeat(
        withTiming(0, { duration: 1000, easing: Easing.out(Easing.ease) }),
        -1,
        false
      );
    } else {
      recordingPing.value = 1;
    }
  }, [isRunning]);

  const recordingPingStyle = useAnimatedStyle(() => ({
    opacity: recordingPing.value * 0.75,
    transform: [{ scale: 1 + (1 - recordingPing.value) * 0.6 }],
  }));

  // Off-route detection: re-evaluates only when a new GPS point arrives,
  // because tracking.stats.currentPosition is reference-stable between ticks
  // when no new point came in (see useLocationTracking.ts perf fix).
  const OFF_ROUTE_THRESHOLD_KM = 0.15;
  const OFF_ROUTE_GRACE_MS = 30000;
  useEffect(() => {
    const pos = tracking.stats.currentPosition;
    const route = ctx.selectedRoute?.points;
    if (!isRunning || !pos || !route || route.length < 2) {
      if (offRouteTimerRef.current) {
        clearTimeout(offRouteTimerRef.current);
        offRouteTimerRef.current = null;
      }
      if (isOffRoute) setIsOffRoute(false);
      return;
    }
    const distance = pointToPolylineKm(pos, route);
    if (distance > OFF_ROUTE_THRESHOLD_KM) {
      // Off route — start the grace timer if not already running and not
      // already showing the chip. This is what enforces the 30s of continuous
      // deviation before we surface the indicator.
      if (!offRouteTimerRef.current && !isOffRoute) {
        offRouteTimerRef.current = setTimeout(() => {
          setIsOffRoute(true);
          offRouteTimerRef.current = null;
        }, OFF_ROUTE_GRACE_MS);
      }
    } else {
      // Back on route — drop the indicator and cancel any pending arming.
      if (offRouteTimerRef.current) {
        clearTimeout(offRouteTimerRef.current);
        offRouteTimerRef.current = null;
      }
      if (isOffRoute) setIsOffRoute(false);
    }
  }, [tracking.stats.currentPosition, ctx.selectedRoute, isRunning, isOffRoute]);

  // Turn-by-turn update on each new GPS sample. Skips when not running, when
  // the route has no steps (mock OSRM / firestore-loaded routes), or when
  // currently flagged off-route (banner instructions would be misleading
  // until the user is back on track). Fires haptic + voice prompts via
  // maybeFireCues — that helper deduplicates per step+threshold so this
  // effect is safe to run on every GPS tick.
  useEffect(() => {
    const pos = tracking.stats.currentPosition;
    const steps = ctx.selectedRoute?.steps;
    if (!isRunning || !pos || !steps || steps.length === 0 || isOffRoute) return;
    const result = updateTurnByTurn(turnStateRef.current, pos, tracking.stats.accuracy, steps);
    turnStateRef.current = result.newState;
    setNavStep(result.currentStep);
    setNavDistanceM(result.distanceToManeuverM);
    if (result.currentStep && result.distanceToManeuverM !== null) {
      maybeFireCues({
        step: result.currentStep,
        distanceM: result.distanceToManeuverM,
        advanced: result.advanced,
        voiceEnabled: ctx.prefs.voicePrompts,
        hapticEnabled: ctx.prefs.hapticPrompts,
      });
    }
  }, [tracking.stats.currentPosition, tracking.stats.accuracy, ctx.selectedRoute, isRunning, isOffRoute, ctx.prefs.voicePrompts, ctx.prefs.hapticPrompts]);

  // Off-course voice cue — fires once on the false→true edge of isOffRoute.
  // The visual chip (rendered separately) stays up the whole time the user
  // is off-route; this is the audible nudge.
  const wasOffRouteRef = useRef(false);
  useEffect(() => {
    if (isOffRoute && !wasOffRouteRef.current) {
      speakOffCourse(ctx.prefs.voicePrompts);
    }
    wasOffRouteRef.current = isOffRoute;
  }, [isOffRoute, ctx.prefs.voicePrompts]);

  const handleStart = useCallback(async () => {
    // Optimistically flip to 'running' so the StartButton morphs immediately —
    // the permission prompt below can take 1–3 seconds the first time. Revert
    // on failure so the user isn't left with a recording chip pulsing over a
    // run that was never actually tracking.
    setRunState('running');
    try {
      await tracking.startTracking();
    } catch (err) {
      setRunState('idle');
      if (err instanceof LocationPermissionDeniedError) {
        Alert.alert(
          'Location Access Needed',
          'Run Routes needs location access to track your run. Enable it in Settings to continue.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ],
        );
        return;
      }
      console.warn('Tracking start failed:', err);
    }
  }, [tracking]);

  const handlePause = useCallback(() => {
    setRunState('paused');
    try {
      tracking.pauseTracking();
    } catch {
      // Tracking may not have started
    }
  }, [tracking]);

  const handleResume = useCallback(async () => {
    setRunState('running');
    setShowStats(false);
    try {
      await tracking.resumeTracking();
    } catch {
      // Location tracking may not be available
    }
  }, [tracking]);

  const handleFinish = useCallback(async () => {
    try {
      await tracking.stopTracking();
    } catch {
      // Tracking may not have started
    }

    // Snapshot final stats
    const { splits, totalDistanceKm, elapsedSeconds, avgPace } = tracking.stats;
    setFinishedSplits(splits.length > 0 ? splits : []);
    setRunState('idle');
    setIsFinished(true);
    setShowStats(true);
  }, [tracking]);

  const handleDiscard = useCallback(() => {
    setIsFinished(false);
    setShowStats(false);
    ctx.setRoutes([]);
    ctx.setSelectedRoute(null);
    router.replace('/');
  }, [ctx, router]);

  const handleSave = useCallback(async () => {
    const { totalDistanceKm, elapsedSeconds, avgPace, currentPace, splits, coordinates } = tracking.stats;

    const runData = {
      date: Date.now(),
      routeName: ctx.selectedRoute?.name || 'Run',
      distance: Math.round(totalDistanceKm * 100) / 100,
      duration: elapsedSeconds,
      pace: currentPace,
      avgPace,
      calories: Math.round(elapsedSeconds * 0.18),
      elevation: ctx.selectedRoute?.elevationGain || 0,
      splits,
      gpsTrack: coordinates,
      terrain: ctx.selectedRoute?.terrain || 'Loop',
    };

    // Save to local cache immediately so history drawer shows it
    const runRecord = { id: `local-${Date.now()}`, ...runData };
    try {
      const cached = await getCachedRunHistory();
      cached.unshift(runRecord as any);
      await AsyncStorage.setItem('@running_routes_run_history', JSON.stringify(cached));
    } catch {}

    // Save to Firestore, queue offline if it fails
    if (ctx.firebaseUid) {
      try {
        await saveRunRecord(ctx.firebaseUid, runData);
      } catch {
        await addPendingRun(ctx.firebaseUid, runData);
      }
    }

    setIsFinished(false);
    setShowStats(false);
    ctx.setRoutes([]);
    ctx.setSelectedRoute(null);
    router.replace('/');

    // App Store review prompt after 3rd save
    try {
      const prompted = await AsyncStorage.getItem('@running_routes_review_prompted');
      if (!prompted) {
        const countStr = await AsyncStorage.getItem('@running_routes_save_count');
        const count = (parseInt(countStr || '0', 10) || 0) + 1;
        await AsyncStorage.setItem('@running_routes_save_count', String(count));
        if (count === 3) {
          await AsyncStorage.setItem('@running_routes_review_prompted', 'true');
          if (await StoreReview.hasAction()) {
            await StoreReview.requestReview();
          }
        }
      }
    } catch {}
  }, [ctx, tracking.stats]);

  const handleBack = useCallback(() => {
    if (hasStarted) return;
    ctx.setRoutes([]);
    ctx.setSelectedRoute(null);
    router.replace('/');
  }, [hasStarted, ctx, router]);

  const handleOpenGoogleMaps = useCallback(() => {
    if (!ctx.selectedRoute) return;
    const url = buildGoogleMapsUrl(ctx.selectedRoute);
    Linking.openURL(url);
  }, [ctx.selectedRoute]);

  const handlePrevRoute = useCallback(() => {
    const newIndex = Math.max(0, routeIndex - 1);
    setRouteIndex(newIndex);
    if (ctx.routes[newIndex]) {
      ctx.setSelectedRoute(ctx.routes[newIndex]);
    }
  }, [routeIndex, ctx]);

  const handleNextRoute = useCallback(() => {
    const newIndex = Math.min(ctx.routes.length - 1, routeIndex + 1);
    setRouteIndex(newIndex);
    if (ctx.routes[newIndex]) {
      ctx.setSelectedRoute(ctx.routes[newIndex]);
    }
  }, [routeIndex, ctx]);

  // Regenerate the current route with the same parameters. Two behaviors that
  // matter here:
  //   1. We pass the previous route's anchorPoints as `excludeAnchors` so
  //      generateOSRMRoutes drops those parks from the candidate pool. Without
  //      this, dense urban areas with few high-scoring parks deterministically
  //      replay the same top picks → identical waypoints → OSRM cache hit →
  //      same route. The seed-based variant shuffling alone isn't enough.
  //   2. We do NOT clear ctx.routes/selectedRoute synchronously here. Doing
  //      so forced the MapView to re-render with an empty polyline mid-press,
  //      which intermittently crashed the app on iOS. Instead we just flip
  //      isGenerating — the bottom sheet swaps to the spinner while the old
  //      route stays visible on the map until the new one swaps in atomically.
  const showRefreshError = useCallback((msg: string) => {
    setRefreshError(msg);
    if (refreshErrorTimeout.current) clearTimeout(refreshErrorTimeout.current);
    // Bumped 5s → 30s. The shorter window wasn't enough time to read the
    // failure diagnostic suffix ("[n=… q=… (d=… b=… h=… o=… p=… t=…) w=… v=…]"),
    // and refresh failures still need to auto-dismiss eventually so a stale
    // banner doesn't sit there after the user has moved on.
    refreshErrorTimeout.current = setTimeout(() => setRefreshError(null), 30000);
  }, []);

  const handleRefresh = useCallback(async () => {
    if (ctx.isGenerating || hasStarted) return;

    const distanceKm = ctx.prefs.units === 'metric'
      ? ctx.distance
      : ctx.distance * 1.60934;

    const previousAnchors = ctx.selectedRoute?.anchorPoints ?? null;
    // Polyline of the route the user is currently looking at. Passed to
    // generateOSRMRoutes so the chooser can demote any candidate whose
    // geometry replays it — without this, p2p refresh in green-poor
    // corridors deterministically picks the same OSRM alternative every
    // time (alt 1 always wins on quality penalty against alt 2), and the
    // user sees the same route forever.
    const previousPoints = ctx.selectedRoute?.points ?? null;

    ctx.setIsGenerating(true);
    setRouteIndex(0);
    setRefreshError(null);

    try {
      const newRoutes = await generateOSRMRoutes(
        ctx.center,
        distanceKm,
        ctx.routeStyle === 'point-to-point' ? 'point-to-point'
          : ctx.routeStyle === 'out-and-back' ? 'out-and-back'
          : 'loop',
        1,
        ctx.prefs,
        ctx.endLocation,
        previousAnchors,
        previousPoints,
      );
      ctx.setIsGenerating(false);
      if (newRoutes.length === 0) {
        // Cycle-to-history safety net: when generation fails, swap to a
        // historical route matching the same distance + style + start. Silent
        // on success — the user just sees a different route, same as a
        // normal refresh. Parameter-matched (not just any historical route)
        // so a 4mi refresh never silently swaps to a 6mi.
        const styleNormalized = ctx.routeStyle === 'point-to-point' ? 'point-to-point'
          : ctx.routeStyle === 'out-and-back' ? 'out-and-back'
          : 'loop';
        const cycleCandidate = findMatchingHistoricalRoute(
          ctx.routeHistory,
          ctx.distance,
          ctx.prefs.units,
          styleNormalized,
          ctx.center,
          ctx.endLocation,
          ctx.selectedRoute?.id ?? null,
        );
        if (cycleCandidate) {
          ctx.setRoutes([cycleCandidate]);
          ctx.setSelectedRoute(cycleCandidate);
          ctx.pushRouteToHistory(cycleCandidate); // promote to front so we cycle through history
          return;
        }
        // No matching history to cycle to — surface a banner so the user
        // knows the refresh did fail (otherwise tapping refresh appears to
        // do nothing).
        showRefreshError(`Couldn't find a different route. Try again or change distance.${failureDiagSuffix(ctx.user?.email)}`);
        return;
      }
      ctx.setRoutes(newRoutes);
      ctx.setSelectedRoute(newRoutes[0]);
      ctx.pushRouteToHistory(newRoutes[0]);
      persistOverpassCache();
      persistOSRMCache();
    } catch (err) {
      console.warn('Route refresh failed:', err);
      ctx.setIsGenerating(false);
      const verSuffix = isDevUser(ctx.user?.email)
        ? ` [v=${(Updates.updateId ?? 'embedded').slice(0, 8)}]`
        : '';
      const msg = err instanceof OSRMUnavailableError
        ? `Routing service is slow. Please try again in a moment.${verSuffix}`
        : `Couldn't refresh route. Check your connection and try again.${verSuffix}`;
      showRefreshError(msg);
    }
  }, [ctx, hasStarted, showRefreshError]);

  // Real GPS-derived stats
  const { totalDistanceKm, elapsedSeconds, currentPace, avgPace, splits, coordinates, currentPosition } = tracking.stats;
  const isMetric = ctx.prefs.units === 'metric';
  const runDistance = hasStarted
    ? isMetric
      ? totalDistanceKm.toFixed(1)
      : (totalDistanceKm * 0.621371).toFixed(1)
    : ctx.selectedRoute
      ? String(ctx.selectedRoute.distance)
      : '0';
  const timeStr = formatTime(elapsedSeconds);
  const calories = Math.round(elapsedSeconds * 0.18);
  const elevation = ctx.selectedRoute
    ? parseInt(formatElevation(ctx.selectedRoute.elevationGain, ctx.prefs.units), 10)
    : 0;

  return (
    <View style={styles.outerContainer}>
      <View style={styles.container}>
        {/* Full-screen map or stats */}
        {showStats ? (
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={isFinished ? undefined : () => setShowStats(false)}
            disabled={isFinished}
          >
            <StatsView
              pace={currentPace}
              distance={runDistance}
              time={timeStr}
              calories={calories}
              elevation={elevation}
              cadence={0}
              avgPace={avgPace}
              splits={isFinished ? finishedSplits : splits}
              isRunning={isRunning}
              isFinished={isFinished}
              isFavorited={isFavorited}
              onToggleFavorite={handleToggleFavorite}
              onDiscard={handleDiscard}
              onSave={handleSave}
              units={ctx.prefs.units}
            />
          </Pressable>
        ) : (
          <View style={StyleSheet.absoluteFill}>
            <RouteMap
              center={ctx.center}
              routes={ctx.routes}
              selectedRouteId={ctx.selectedRoute?.id || null}
              gpsTrack={hasStarted ? coordinates : undefined}
              currentPosition={hasStarted ? currentPosition : undefined}
              nextManeuver={hasStarted && !isOffRoute ? navStep : null}
            />
            {/* Dark overlay to dim the map behind the bottom sheet */}
            {!hasStarted && (
              <View style={styles.mapOverlay} pointerEvents="none" />
            )}
          </View>
        )}

        {/* Header overlay */}
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          {/* Left */}
          <View style={styles.headerSide}>
            {/* Back button only renders when it has a real action: closing
              * the stats overlay, OR navigating back to plan when no run is
              * in progress. Once a run has started (running or paused) and
              * stats aren't open, the button has no destination — tapping
              * mid-run shouldn't lose the user's progress. Was previously
              * shown-but-disabled (opacity 0.4), which read as broken. */}
            {(showStats || !hasStarted) && (
              <Pressable
                onPress={showStats ? () => setShowStats(false) : handleBack}
                style={styles.headerBtn}
              >
                <Ionicons name="chevron-back" size={16} color={Colors.mutedForeground} />
              </Pressable>
            )}
          </View>

          {/* Center: recording indicator + off-route chip */}
          <View style={styles.headerCenter}>
            {hasStarted && (
              <View style={styles.headerChip}>
                <View style={styles.recordingDotContainer}>
                  <Animated.View style={[styles.recordingPing, recordingPingStyle]} />
                  <View style={styles.recordingDot} />
                </View>
                <Text style={styles.recordingLabel}>{isPaused ? 'PAUSED' : 'RECORDING'}</Text>
              </View>
            )}
            {isOffRoute && (
              <View style={styles.offRouteChip}>
                <Ionicons name="alert-circle" size={12} color={Colors.warning} />
                <Text style={styles.offRouteLabel}>OFF ROUTE</Text>
              </View>
            )}
          </View>

          {/* Right: actions */}
          <View style={[styles.headerSide, { alignItems: 'flex-end' }]}>
            <View style={styles.headerActions}>
              {ctx.selectedRoute && !hasStarted && !isFinished && (
                <Pressable onPress={handleOpenGoogleMaps} style={styles.headerIconBtn}>
                  <Ionicons name="open-outline" size={16} color={Colors.mutedForeground} />
                </Pressable>
              )}
            </View>
          </View>
        </View>

        {/* Turn-by-turn banner — only when actively running, route has step
          * data, and we're not currently flagged off-route (instructions
          * would be misleading until the user is back on the polyline). */}
        {hasStarted && !isFinished && !isOffRoute && navStep && navDistanceM !== null && (
          <ManeuverBanner step={navStep} distanceM={navDistanceM} units={ctx.prefs.units} />
        )}

        {/* Return-to-summary pill — shown when finished but viewing the map */}
        {isFinished && !showStats && (
          <View style={styles.returnPillContainer}>
            <Pressable
              onPress={() => setShowStats(true)}
              style={({ pressed }) => [styles.returnPill, pressed && { transform: [{ scale: 0.96 }] }]}
            >
              <Ionicons name="chevron-up" size={14} color={Colors.primaryForeground} />
              <Text style={styles.returnPillLabel}>Run Summary</Text>
            </Pressable>
          </View>
        )}

        {/* Bottom sheet — hidden when finished */}
        {!isFinished && (
        <BlurView intensity={80} tint="dark" style={styles.bottomSheet}>
          {/* Grab handle */}
          <View style={styles.grabHandle} />

          {ctx.isGenerating ? (
            <View style={styles.loadingState}>
              <ActivityIndicator size="large" color={Colors.primary} />
              <Text style={styles.loadingText}>Generating Route...</Text>
            </View>
          ) : ctx.routes.length === 0 && !ctx.selectedRoute && !hasStarted ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateText}>No route loaded</Text>
              <Text style={styles.emptyStateSubtext}>Generate a route from the Plan tab</Text>
            </View>
          ) : (
          <>
          {/* Favorite + refresh actions */}
          {ctx.routes.length >= 1 && !hasStarted && (
            <View style={styles.routeSelector}>
              <Text style={styles.routeCounter}>
                {ctx.selectedRoute?.name || 'Route'}
              </Text>
              <View style={styles.routeActions}>
                {ctx.routeStyle !== 'point-to-point' && (
                  <Pressable
                    onPress={handleRefresh}
                    disabled={ctx.isGenerating}
                    hitSlop={8}
                    style={[styles.routeActionBtn, ctx.isGenerating && { opacity: 0.4 }]}
                    accessibilityLabel="Generate a different route"
                  >
                    <Ionicons name="refresh" size={18} color={Colors.mutedForeground} />
                  </Pressable>
                )}
                <Pressable onPress={handleToggleFavorite} hitSlop={8} style={styles.routeActionBtn}>
                  <Ionicons
                    name={isFavorited ? 'heart' : 'heart-outline'}
                    size={18}
                    color={isFavorited ? Colors.destructive : Colors.mutedForeground}
                  />
                </Pressable>
              </View>
            </View>
          )}

          {refreshError && !hasStarted && (
            <View style={styles.refreshErrorBanner}>
              <Ionicons name="alert-circle" size={14} color={Colors.destructive} />
              <Text style={styles.refreshErrorText} selectable>{refreshError}</Text>
            </View>
          )}

          {/* Stats */}
          <RunStats
            pace={currentPace}
            distance={runDistance}
            time={timeStr}
            isRunning={isRunning}
            units={ctx.prefs.units}
          />

          {/* Start button */}
          <View style={styles.startRow}>
            <StartButton
              runState={runState}
              onStart={handleStart}
              onPause={handlePause}
              onResume={handleResume}
              onFinish={handleFinish}
            />
          </View>
          </>
          )}
        </BlurView>
        )}
      </View>

      {/* Profile Drawer */}
      <ProfileDrawer
        visible={drawerVisible}
        onClose={() => setDrawerVisible(false)}
        initialView={drawerInitialView}
      />

      {/* Bottom Tab Bar — show when no run is active */}
      {!hasStarted && !isFinished && <BottomTabBar />}
    </View>
  );
}

const styles = StyleSheet.create({
  outerContainer: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 30,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  headerSide: {
    flex: 1,
    alignItems: 'flex-start',
  },
  headerCenter: {
    alignItems: 'center',
    gap: 6,
  },
  headerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.card + '99',
    borderRadius: 9999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  headerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.card + '99',
    borderRadius: 9999,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  recordingDotContainer: {
    width: 8,
    height: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordingPing: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.destructive,
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.destructive,
  },
  recordingLabel: {
    fontFamily: Fonts.sansBold,
    fontSize: 12,
    color: Colors.destructive,
    letterSpacing: 1.5,
  },
  offRouteChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.card + '99',
    borderRadius: 9999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  offRouteLabel: {
    fontFamily: Fonts.sansBold,
    fontSize: 11,
    color: Colors.warning,
    letterSpacing: 1.5,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.card + '99',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mapOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  bottomSheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 20,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderTopColor: Colors.border + '4D',
    overflow: 'hidden',
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 4,
  },
  loadingState: {
    alignItems: 'center',
    gap: 16,
    paddingVertical: 32,
  },
  loadingText: {
    fontFamily: Fonts.sansMedium,
    fontSize: 14,
    color: Colors.mutedForeground,
  },
  grabHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.mutedForeground + '4D',
    marginBottom: 6,
  },
  startRow: {
    alignItems: 'center',
    marginTop: 4,
  },
  routeSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingVertical: 4,
  },
  routeNavBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  routeCounter: {
    fontFamily: Fonts.sansMedium,
    fontSize: 12,
    color: Colors.mutedForeground,
  },
  routeActions: {
    position: 'absolute',
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  routeActionBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  refreshErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.destructive + '1A',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginTop: 8,
    marginHorizontal: 4,
  },
  refreshErrorText: {
    flex: 1,
    fontFamily: Fonts.sans,
    fontSize: 11,
    color: Colors.destructive,
  },
  emptyState: {
    alignItems: 'center',
    gap: 12,
    paddingVertical: 16,
  },
  emptyStateText: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 14,
    color: Colors.mutedForeground,
  },
  emptyStateSubtext: {
    fontFamily: Fonts.sans,
    fontSize: 12,
    color: Colors.mutedForeground,
  },
  emptyStateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.primary + '1A',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  emptyStateBtnLabel: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 13,
    color: Colors.primary,
  },
  returnPillContainer: {
    position: 'absolute',
    bottom: 40,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 20,
  },
  returnPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.primary,
    borderRadius: 9999,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  returnPillLabel: {
    fontFamily: Fonts.sansBold,
    fontSize: 13,
    color: Colors.primaryForeground,
    letterSpacing: 0.5,
  },
});
