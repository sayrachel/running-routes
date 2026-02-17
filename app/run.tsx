import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, Linking } from 'react-native';
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
import { BottomTabBar } from '@/components/BottomTabBar';
import { useAppContext } from '@/lib/AppContext';
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

function simulatePace(seconds: number): string {
  const base = 5.5;
  const variation = Math.sin(seconds * 0.05) * 0.4;
  const pace = base + variation;
  const mins = Math.floor(pace);
  const secs = Math.round((pace - mins) * 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export default function RunScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const ctx = useAppContext();

  const [showStats, setShowStats] = useState(false);
  const [runState, setRunState] = useState<'idle' | 'running' | 'paused'>('idle');
  const [isFinished, setIsFinished] = useState(false);
  const [finishedSplits, setFinishedSplits] = useState<{ km: number; pace: string }[]>([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isRunning = runState === 'running';
  const isPaused = runState === 'paused';
  const hasStarted = runState !== 'idle';

  const isFavorited = ctx.selectedRoute
    ? ctx.favorites.some((f) => f.id === `run-${ctx.selectedRoute!.id}`)
    : false;

  const handleToggleFavorite = useCallback(() => {
    if (!ctx.selectedRoute) return;
    const favId = `run-${ctx.selectedRoute.id}`;
    if (isFavorited) {
      ctx.removeFavorite(favId);
    } else {
      ctx.addFavorite({
        id: favId,
        routeName: ctx.selectedRoute.name,
        distance: parseFloat(ctx.selectedRoute.distance.toFixed(1)),
        terrain: (ctx.selectedRoute.terrain as 'Loop' | 'Out & Back' | 'Point to Point') || 'Loop',
        lat: ctx.center.lat,
        lng: ctx.center.lng,
      });
    }
  }, [ctx, isFavorited]);

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

  // Timer — only ticks while running, pauses when paused
  useEffect(() => {
    if (runState === 'running') {
      intervalRef.current = setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
      }, 1000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [runState]);

  const handleStart = useCallback(() => {
    setRunState('running');
  }, []);

  const handlePause = useCallback(() => {
    setRunState('paused');
  }, []);

  const handleResume = useCallback(() => {
    setRunState('running');
  }, []);

  const handleFinish = useCallback(() => {
    // Snapshot splits in the same format as the history page
    const dist = elapsedSeconds > 0 ? (elapsedSeconds / 60) / 5.5 : 0;
    const timeMin = elapsedSeconds / 60;
    const avgPace = dist > 0 ? timeMin / dist : 0;
    const fullKms = Math.floor(dist);
    const snapshotSplits: { km: number; pace: string }[] = [];
    for (let i = 1; i <= fullKms; i++) {
      const variation = (Math.random() - 0.5) * 0.6;
      snapshotSplits.push({ km: i, pace: (avgPace + variation).toFixed(1) });
    }
    const remaining = dist - fullKms;
    if (remaining > 0.1) {
      const variation = (Math.random() - 0.5) * 0.6;
      snapshotSplits.push({ km: parseFloat(dist.toFixed(1)), pace: (avgPace + variation).toFixed(1) });
    }
    setFinishedSplits(snapshotSplits);
    setRunState('idle');
    setIsFinished(true);
    setShowStats(true);
  }, [elapsedSeconds]);

  const handleDiscard = useCallback(() => {
    setIsFinished(false);
    setShowStats(false);
    setElapsedSeconds(0);
    ctx.setRoutes([]);
    ctx.setSelectedRoute(null);
    router.replace('/');
  }, [ctx, router]);

  const handleSave = useCallback(() => {
    // Save to history would go here in a real app
    setIsFinished(false);
    setShowStats(false);
    setElapsedSeconds(0);
    ctx.setRoutes([]);
    ctx.setSelectedRoute(null);
    router.replace('/');
  }, [ctx, router]);

  const handleBack = useCallback(() => {
    if (hasStarted) return;
    ctx.setRoutes([]);
    ctx.setSelectedRoute(null);
    setElapsedSeconds(0);
    router.replace('/');
  }, [hasStarted, ctx, router]);

  const handleOpenGoogleMaps = useCallback(() => {
    if (!ctx.selectedRoute) return;
    const url = buildGoogleMapsUrl(ctx.selectedRoute);
    Linking.openURL(url);
  }, [ctx.selectedRoute]);

  // Derived run data
  const currentPace = simulatePace(elapsedSeconds);
  const runDistance = elapsedSeconds > 0
    ? ((elapsedSeconds / 60) / 5.5).toFixed(2)
    : ctx.selectedRoute
      ? ctx.selectedRoute.distance.toFixed(2)
      : '0.00';
  const timeStr = formatTime(elapsedSeconds);
  const calories = Math.round(elapsedSeconds * 0.18);
  const elevation = ctx.selectedRoute ? ctx.selectedRoute.elevationGain : 0;

  const completedKms = Math.floor(parseFloat(runDistance));
  const splits = Array.from(
    { length: Math.min(completedKms, 10) },
    (_, i) => ({
      km: i + 1,
      pace: simulatePace((i + 1) * 330 + i * 17),
    })
  );

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
              cadence={
                isRunning
                  ? 168 + Math.floor(Math.sin(elapsedSeconds * 0.1) * 6)
                  : 0
              }
              avgPace={
                isRunning
                  ? simulatePace(Math.floor(elapsedSeconds / 2))
                  : '--:--'
              }
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
            {ctx.selectedRoute && !hasStarted && (
              <Pressable onPress={handleOpenGoogleMaps} style={styles.headerIconBtn}>
                <Ionicons name="open-outline" size={16} color={Colors.mutedForeground} />
              </Pressable>
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
            onStatPress={() => setShowStats((prev) => !prev)}
          />

          {/* Start button */}
          <View style={styles.startRow}>
            <StartButton
              runState={runState}
              onStart={handleStart}
              onPause={handlePause}
              onResume={handleResume}
              onFinish={handleFinish}
              disabled={!ctx.hasLocation || ctx.gpsStrength < 2}
            />
          </View>
        </View>
        )}
      </View>

      {/* Bottom Tab Bar */}
      <BottomTabBar />
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
  headerBtnText: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 12,
    color: Colors.mutedForeground,
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
    paddingTop: 12,
    paddingBottom: 12,
  },
  grabHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.mutedForeground + '4D',
    marginBottom: 16,
  },
  startRow: {
    alignItems: 'center',
    marginTop: 16,
  },
});
