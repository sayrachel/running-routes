import React, { useEffect } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  Easing,
} from 'react-native-reanimated';
import { Colors, Fonts } from '@/lib/theme';

type RunState = 'idle' | 'running' | 'paused';

interface StartButtonProps {
  runState: RunState;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onFinish: () => void;
  disabled?: boolean;
}

export function StartButton({ runState, onStart, onPause, onResume, onFinish, disabled }: StartButtonProps) {
  const glowOpacity = useSharedValue(0.3);
  const pingScale = useSharedValue(1);
  const pingOpacity = useSharedValue(0.6);

  useEffect(() => {
    if (runState === 'idle' && !disabled) {
      glowOpacity.value = withRepeat(
        withSequence(
          withTiming(0.5, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.3, { duration: 1200, easing: Easing.inOut(Easing.ease) })
        ),
        -1,
        true
      );
      pingScale.value = withRepeat(
        withTiming(1.6, { duration: 1500, easing: Easing.out(Easing.ease) }),
        -1,
        false
      );
      pingOpacity.value = withRepeat(
        withTiming(0, { duration: 1500, easing: Easing.out(Easing.ease) }),
        -1,
        false
      );
    } else {
      glowOpacity.value = 0;
      pingScale.value = 1;
      pingOpacity.value = 0;
    }
  }, [runState, disabled]);

  const glowStyle = useAnimatedStyle(() => ({
    opacity: glowOpacity.value,
  }));

  const pingStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pingScale.value }],
    opacity: pingOpacity.value,
  }));

  const handleMainPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    if (runState === 'idle') onStart();
    else if (runState === 'running') onPause();
    else if (runState === 'paused') onResume();
  };

  const handleFinish = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    onFinish();
  };

  if (runState === 'paused') {
    return (
      <View style={styles.pausedWrapper}>
        <View style={styles.pausedRow}>
          {/* Resume button */}
          <Pressable
            onPress={handleMainPress}
            style={({ pressed }) => [
              styles.pausedButton,
              styles.resumeButton,
              pressed && { transform: [{ scale: 0.95 }] },
            ]}
          >
            <Ionicons name="play" size={24} color={Colors.primaryForeground} style={{ marginLeft: 2 }} />
          </Pressable>

          {/* Finish button */}
          <Pressable
            onPress={handleFinish}
            style={({ pressed }) => [
              styles.pausedButton,
              styles.finishButton,
              pressed && { transform: [{ scale: 0.95 }] },
            ]}
          >
            <Ionicons name="stop" size={22} color={Colors.destructiveForeground} />
          </Pressable>
        </View>
        <View style={styles.pausedLabels}>
          <Text style={styles.resumeLabel}>RESUME</Text>
          <Text style={styles.finishLabel}>FINISH</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.wrapper}>
      <View style={styles.buttonContainer}>
        {runState === 'idle' && !disabled && (
          <Animated.View
            style={[styles.pingRing, pingStyle]}
            pointerEvents="none"
          />
        )}
        {runState === 'idle' && !disabled && (
          <Animated.View
            style={[styles.glow, glowStyle]}
            pointerEvents="none"
          />
        )}

        <Pressable
          onPress={handleMainPress}
          disabled={disabled}
          style={({ pressed }) => [
            styles.button,
            runState === 'running' ? styles.buttonPause : styles.buttonStart,
            disabled && styles.buttonDisabled,
            pressed && { transform: [{ scale: 0.95 }] },
          ]}
        >
          {runState === 'running' ? (
            <Ionicons name="pause" size={28} color={Colors.foreground} />
          ) : (
            <Ionicons
              name="play"
              size={32}
              color={Colors.primaryForeground}
              style={{ marginLeft: 3 }}
            />
          )}
        </Pressable>
      </View>

      <Text
        style={[
          styles.label,
          runState === 'running'
            ? styles.labelPause
            : disabled
              ? styles.labelDisabled
              : styles.labelStart,
        ]}
      >
        {runState === 'running' ? 'PAUSE' : 'START RUN'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
    gap: 10,
  },
  buttonContainer: {
    width: 80,
    height: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pingRing: {
    position: 'absolute',
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: Colors.primary + '4D',
  },
  glow: {
    position: 'absolute',
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: Colors.primary + '33',
  },
  button: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonStart: {
    backgroundColor: Colors.primary,
  },
  buttonPause: {
    backgroundColor: Colors.muted,
    borderWidth: 2,
    borderColor: Colors.border,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  label: {
    fontFamily: Fonts.sansBold,
    fontSize: 12,
    letterSpacing: 2,
  },
  labelStart: {
    color: Colors.primary,
  },
  labelPause: {
    color: Colors.mutedForeground,
  },
  labelDisabled: {
    color: Colors.mutedForeground,
  },
  // Paused state styles
  pausedWrapper: {
    alignItems: 'center',
    gap: 10,
  },
  pausedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 24,
  },
  pausedButton: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resumeButton: {
    backgroundColor: Colors.primary,
  },
  finishButton: {
    backgroundColor: Colors.destructive,
  },
  pausedLabels: {
    flexDirection: 'row',
    gap: 24,
  },
  resumeLabel: {
    width: 64,
    textAlign: 'center',
    fontFamily: Fonts.sansBold,
    fontSize: 11,
    letterSpacing: 2,
    color: Colors.primary,
  },
  finishLabel: {
    width: 64,
    textAlign: 'center',
    fontFamily: Fonts.sansBold,
    fontSize: 11,
    letterSpacing: 2,
    color: Colors.destructive,
  },
});
