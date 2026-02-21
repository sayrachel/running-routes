import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, Linking, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
import { useLocationTracking, accuracyToStrength } from '@/lib/useLocationTracking';
import { saveRunRecord, addPendingRun, getCachedRunHistory } from '@/lib/firestore';
import { generateOSRMRoutes } from '@/lib/osrm';
import { buildGoogleMapsUrl } from '@/lib/route-export';
import { Colors, Fonts } from '@/lib/theme';

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
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [drawerInitialView, setDrawerInitialView] = useState<DrawerView>('profile');
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

  // Update GPS strength from tracking accuracy
  useEffect(() => {
    if (tracking.stats.accuracy !== null) {
      ctx.setGpsStrength(accuracyToStrength(tracking.stats.accuracy));
    }
  }, [tracking.stats.accuracy]);

  const handleStart = useCallback(async () => {
    setRunState('running');
    try {
      await tracking.startTracking();
    } catch {
      // Location tracking may not be available (e.g. on web)
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
    // Open history view after saving
    setDrawerInitialView('history');
    setDrawerVisible(true);
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

  const handleRegenerate = useCallback(async () => {
    if (isRegenerating || hasStarted) return;
    setIsRegenerating(true);
    try {
      const end =
        ctx.routeStyle === 'point-to-point' && ctx.endLocation
          ? ctx.endLocation
          : null;
      const newRoutes = await generateOSRMRoutes(
        ctx.center,
        ctx.distance * 1.60934,
        ctx.routeStyle === 'point-to-point' ? 'point-to-point' : ctx.routeStyle === 'out-and-back' ? 'out-and-back' : 'loop',
        1,
        ctx.prefs,
        end
      );
      ctx.setRoutes(newRoutes);
      ctx.setSelectedRoute(newRoutes[0] || null);
    } catch (err) {
      console.error('Route regeneration error:', err);
    } finally {
      setIsRegenerating(false);
    }
  }, [ctx, isRegenerating, hasStarted]);

  // Real GPS-derived stats
  const { totalDistanceKm, elapsedSeconds, currentPace, avgPace, splits, coordinates, currentPosition } = tracking.stats;
  const runDistance = hasStarted
    ? totalDistanceKm.toFixed(2)
    : ctx.selectedRoute
      ? ctx.selectedRoute.distance.toFixed(2)
      : '0.00';
  const timeStr = formatTime(elapsedSeconds);
  const calories = Math.round(elapsedSeconds * 0.18);
  const elevation = ctx.selectedRoute ? ctx.selectedRoute.elevationGain : 0;

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
            />
          </View>
        )}

        {/* Header overlay */}
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          {/* Back */}
          <Pressable
            onPress={showStats ? () => setShowStats(false) : handleBack}
            disabled={!showStats && hasStarted}
            style={[styles.headerBtn, !showStats && hasStarted && { opacity: 0.4 }]}
          >
            <Ionicons name="chevron-back" size={16} color={Colors.mutedForeground} />
          </Pressable>

          {/* Center: recording indicator */}
          {hasStarted && (
            <View style={styles.headerChip}>
              <View style={styles.recordingDotContainer}>
                <Animated.View style={[styles.recordingPing, recordingPingStyle]} />
                <View style={styles.recordingDot} />
              </View>
              <Text style={styles.recordingLabel}>{isPaused ? 'PAUSED' : 'RECORDING'}</Text>
            </View>
          )}

          {/* Right: actions */}
          <View style={styles.headerActions}>
            {ctx.selectedRoute && !hasStarted && !isFinished && (
              <>
                <Pressable
                  onPress={handleRegenerate}
                  disabled={isRegenerating}
                  style={[styles.headerIconBtn, isRegenerating && { opacity: 0.5 }]}
                >
                  {isRegenerating ? (
                    <ActivityIndicator size="small" color={Colors.mutedForeground} />
                  ) : (
                    <Ionicons name="refresh" size={16} color={Colors.mutedForeground} />
                  )}
                </Pressable>
                <Pressable onPress={handleOpenGoogleMaps} style={styles.headerIconBtn}>
                  <Ionicons name="open-outline" size={16} color={Colors.mutedForeground} />
                </Pressable>
              </>
            )}
          </View>
        </View>

        {/* Bottom sheet — hidden when finished */}
        {!isFinished && (
        <View style={styles.bottomSheet}>
          {/* Grab handle */}
          <View style={styles.grabHandle} />

          {/* Stats row */}
          <RunStats
            pace={currentPace}
            distance={runDistance}
            time={timeStr}
            isRunning={isRunning}
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
        </View>
        )}
      </View>

      {/* Profile Drawer */}
      <ProfileDrawer
        visible={drawerVisible}
        onClose={() => setDrawerVisible(false)}
        initialView={drawerInitialView}
      />
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
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
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
    backgroundColor: Colors.card + '99',
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 4,
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
});
