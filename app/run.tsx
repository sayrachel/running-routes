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
  const [isRunning, setIsRunning] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Timer
  useEffect(() => {
    if (isRunning) {
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
  }, [isRunning]);

  const handleToggleRun = useCallback(() => {
    setIsRunning((prev) => !prev);
  }, []);

  const handleBack = useCallback(() => {
    if (isRunning) return;
    ctx.setRoutes([]);
    ctx.setSelectedRoute(null);
    setElapsedSeconds(0);
    router.back();
  }, [isRunning, ctx, router]);

  const handleOpenGoogleMaps = useCallback(() => {
    if (!ctx.selectedRoute) return;
    const url = buildGoogleMapsUrl(ctx.selectedRoute);
    Linking.openURL(url);
  }, [ctx.selectedRoute]);

  // Derived run data
  const currentPace = simulatePace(elapsedSeconds);
  const runDistance = isRunning
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
    <View style={styles.container}>
      {/* Full-screen map or stats */}
      {showStats ? (
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowStats(false)}>
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
            splits={splits}
            isRunning={isRunning}
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
          disabled={!showStats && isRunning}
          style={[styles.headerBtn, !showStats && isRunning && { opacity: 0.4 }]}
        >
          <Ionicons name="chevron-back" size={16} color={Colors.mutedForeground} />
          <Text style={styles.headerBtnText}>{showStats ? 'Back' : 'Edit'}</Text>
        </Pressable>

        {/* Center: recording indicator */}
        {isRunning && (
          <View style={styles.headerChip}>
            <View style={styles.recordingDotContainer}>
              <Animated.View style={[styles.recordingPing, recordingPingStyle]} />
              <View style={styles.recordingDot} />
            </View>
            <Text style={styles.recordingLabel}>RECORDING</Text>
          </View>
        )}

        {/* Right: actions */}
        <View style={styles.headerActions}>
          {ctx.selectedRoute && !isRunning && (
            <Pressable onPress={handleOpenGoogleMaps} style={styles.headerIconBtn}>
              <Ionicons name="open-outline" size={16} color={Colors.mutedForeground} />
            </Pressable>
          )}
        </View>
      </View>

      {/* Bottom sheet */}
      <View style={[styles.bottomSheet, { paddingBottom: Math.max(insets.bottom, 20) + 12 }]}>
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
            isRunning={isRunning}
            onToggle={handleToggleRun}
            disabled={!ctx.hasLocation || ctx.gpsStrength < 2}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
