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

interface StartButtonProps {
  isRunning: boolean;
  onToggle: () => void;
  disabled?: boolean;
}

export function StartButton({ isRunning, onToggle, disabled }: StartButtonProps) {
  // Pulse glow animation
  const glowOpacity = useSharedValue(0.3);
  // Ping ring animation
  const pingScale = useSharedValue(1);
  const pingOpacity = useSharedValue(0.6);

  useEffect(() => {
    if (!isRunning && !disabled) {
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
  }, [isRunning, disabled]);

  const glowStyle = useAnimatedStyle(() => ({
    opacity: glowOpacity.value,
  }));

  const pingStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pingScale.value }],
    opacity: pingOpacity.value,
  }));

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    onToggle();
  };

  return (
    <View style={styles.wrapper}>
      <View style={styles.buttonContainer}>
        {/* Ping ring */}
        {!isRunning && !disabled && (
          <Animated.View
            style={[styles.pingRing, pingStyle]}
            pointerEvents="none"
          />
        )}

        {/* Glow */}
        {!isRunning && !disabled && (
          <Animated.View
            style={[styles.glow, glowStyle]}
            pointerEvents="none"
          />
        )}

        <Pressable
          onPress={handlePress}
          disabled={disabled}
          style={({ pressed }) => [
            styles.button,
            isRunning ? styles.buttonStop : styles.buttonStart,
            disabled && styles.buttonDisabled,
            pressed && { transform: [{ scale: 0.95 }] },
          ]}
        >
          {isRunning ? (
            <Ionicons name="stop" size={28} color={Colors.destructiveForeground} />
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
          isRunning
            ? styles.labelStop
            : disabled
              ? styles.labelDisabled
              : styles.labelStart,
        ]}
      >
        {isRunning ? 'STOP' : 'START RUN'}
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
  buttonStop: {
    backgroundColor: Colors.destructive,
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
  labelStop: {
    color: Colors.destructive,
  },
  labelDisabled: {
    color: Colors.mutedForeground,
  },
});
