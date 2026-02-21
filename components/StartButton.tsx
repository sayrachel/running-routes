import React, { useEffect, useState } from 'react';
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
  interpolateColor,
} from 'react-native-reanimated';
import { Colors, Fonts } from '@/lib/theme';

type RunState = 'idle' | 'running' | 'paused';

const FINISH_COLOR = '#FFFFFF';
const ANIM_DURATION = 300;
const ANIM_EASING = Easing.out(Easing.cubic);

interface StartButtonProps {
  runState: RunState;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onFinish: () => void;
  disabled?: boolean;
}

export function StartButton({ runState, onStart, onPause, onResume, onFinish, disabled }: StartButtonProps) {
  // Glow/ping animations (idle only)
  const glowOpacity = useSharedValue(0.3);
  const pingScale = useSharedValue(1);
  const pingOpacity = useSharedValue(0.6);

  // Morphing shared values
  const mainWidth = useSharedValue(80);
  const mainHeight = useSharedValue(80);
  const mainTranslateX = useSharedValue(0);
  // 0 = primary (idle/resume), 1 = muted (running/pause)
  const colorProgress = useSharedValue(0);
  const finishOpacity = useSharedValue(0);
  const finishTranslateX = useSharedValue(80);
  const finishScale = useSharedValue(0.5);
  const labelOpacity = useSharedValue(1);
  const labelMaxHeight = useSharedValue(24);

  // Display state for non-animatable props (icon, label)
  const [displayState, setDisplayState] = useState<RunState>(runState);

  useEffect(() => {
    const timing = { duration: ANIM_DURATION, easing: ANIM_EASING };

    if (runState === 'idle') {
      mainWidth.value = withTiming(80, timing);
      mainHeight.value = withTiming(80, timing);
      mainTranslateX.value = withTiming(0, timing);
      colorProgress.value = withTiming(0, timing);
      finishOpacity.value = withTiming(0, timing);
      finishTranslateX.value = 80;
      finishScale.value = 0.5;
      labelOpacity.value = withTiming(1, timing);
      labelMaxHeight.value = withTiming(24, timing);
      setDisplayState('idle');

      // Glow animations
      if (!disabled) {
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
      }
    } else if (runState === 'running') {
      // Morph to wide flat pill, centered
      mainWidth.value = withTiming(120, timing);
      mainHeight.value = withTiming(48, timing);
      mainTranslateX.value = withTiming(0, timing);
      colorProgress.value = withTiming(1, timing);
      finishOpacity.value = withTiming(0, timing);
      finishTranslateX.value = withTiming(80, timing);
      finishScale.value = withTiming(0.5, timing);

      // Fade out label
      labelOpacity.value = withTiming(0, timing);
      labelMaxHeight.value = withTiming(0, timing);

      // Kill glow
      glowOpacity.value = 0;
      pingScale.value = 1;
      pingOpacity.value = 0;

      // Swap icon at midpoint
      setTimeout(() => setDisplayState('running'), ANIM_DURATION / 2);
    } else if (runState === 'paused') {
      // Shrink to resume pill, shift left; finish pill appears right
      mainWidth.value = withTiming(112, timing);
      mainHeight.value = withTiming(44, timing);
      mainTranslateX.value = withTiming(-62, timing);
      colorProgress.value = withTiming(0, timing);
      finishOpacity.value = withTiming(1, timing);
      finishTranslateX.value = withTiming(62, timing);
      finishScale.value = withTiming(1, timing);

      // Kill glow
      glowOpacity.value = 0;
      pingScale.value = 1;
      pingOpacity.value = 0;

      // Label stays hidden
      labelOpacity.value = 0;
      labelMaxHeight.value = 0;

      // Swap icon at midpoint
      setTimeout(() => setDisplayState('paused'), ANIM_DURATION / 2);
    }
  }, [runState, disabled]);

  // Animated styles
  const mainButtonStyle = useAnimatedStyle(() => {
    const bgColor = interpolateColor(
      colorProgress.value,
      [0, 1],
      [Colors.primary, Colors.muted]
    );
    return {
      width: mainWidth.value,
      height: mainHeight.value,
      borderRadius: mainHeight.value / 2,
      backgroundColor: bgColor,
      borderWidth: colorProgress.value > 0.5 ? 2 : 0,
      borderColor: Colors.border,
    };
  });

  const mainContainerStyle = useAnimatedStyle(() => ({
    width: mainWidth.value,
    height: mainHeight.value,
    transform: [{ translateX: mainTranslateX.value }],
  }));

  const labelAnimStyle = useAnimatedStyle(() => ({
    opacity: labelOpacity.value,
    maxHeight: labelMaxHeight.value,
    overflow: 'hidden' as const,
  }));

  const glowStyle = useAnimatedStyle(() => ({
    opacity: glowOpacity.value,
  }));

  const pingStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pingScale.value }],
    opacity: pingOpacity.value,
  }));

  const finishAnimStyle = useAnimatedStyle(() => ({
    opacity: finishOpacity.value,
    transform: [
      { translateX: finishTranslateX.value },
      { scale: finishScale.value },
    ],
  }));

  // Derived: whether finish button should receive touches
  const finishPointerEvents = runState === 'paused' ? 'auto' as const : 'none' as const;

  const handleMainPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    if (runState === 'idle') onStart();
    else if (runState === 'running') onPause();
    else if (runState === 'paused') onResume();
  };

  const handleFinishPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    onFinish();
  };

  // Icon and inline label based on displayState
  const mainIconName = displayState === 'running' ? 'pause' : 'play';
  const mainIconSize = displayState === 'idle' ? 32 : 18;
  const mainIconColor = displayState === 'running' ? Colors.foreground : Colors.primaryForeground;
  const inlineLabel = displayState === 'running' ? 'PAUSE' : displayState === 'paused' ? 'RESUME' : null;
  const inlineLabelColor = displayState === 'running' ? Colors.foreground : Colors.primaryForeground;

  return (
    <View style={styles.wrapper}>
      <View style={styles.buttonRow}>
        {/* Main button area */}
        <Animated.View style={[styles.mainContainer, mainContainerStyle]}>
          {/* Ping ring — idle only */}
          {displayState === 'idle' && !disabled && (
            <Animated.View
              style={[styles.pingRing, pingStyle]}
              pointerEvents="none"
            />
          )}
          {/* Glow — idle only */}
          {displayState === 'idle' && !disabled && (
            <Animated.View
              style={[styles.glow, glowStyle]}
              pointerEvents="none"
            />
          )}

          <Pressable
            onPress={handleMainPress}
            disabled={disabled}
            style={({ pressed }) => [pressed && { transform: [{ scale: 0.95 }] }]}
          >
            <Animated.View
              style={[
                styles.mainButton,
                mainButtonStyle,
                disabled && styles.buttonDisabled,
              ]}
            >
              {inlineLabel ? (
                <View style={styles.pillContent}>
                  <Ionicons name={mainIconName} size={mainIconSize} color={mainIconColor} />
                  <Text style={[styles.pillLabel, { color: inlineLabelColor }]}>{inlineLabel}</Text>
                </View>
              ) : (
                <Ionicons
                  name="play"
                  size={32}
                  color={Colors.primaryForeground}
                  style={{ marginLeft: 3 }}
                />
              )}
            </Animated.View>
          </Pressable>
        </Animated.View>

        {/* Finish button — always rendered, opacity-controlled */}
        <Animated.View
          style={[styles.finishContainer, finishAnimStyle]}
          pointerEvents={finishPointerEvents}
        >
          <Pressable
            onPress={handleFinishPress}
            style={({ pressed }) => [pressed && { transform: [{ scale: 0.95 }] }]}
          >
            <View style={styles.finishButton}>
              <Ionicons name="flag" size={18} color={Colors.primaryForeground} />
              <Text style={styles.finishButtonText}>FINISH</Text>
            </View>
          </Pressable>
        </Animated.View>
      </View>

      {/* Label — smoothly fades out when not idle */}
      <Animated.View style={labelAnimStyle}>
        <Text
          style={[
            styles.label,
            disabled ? styles.labelDisabled : styles.labelPrimary,
          ]}
        >
          START
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 80,
    width: 260,
  },
  mainContainer: {
    position: 'absolute',
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
  mainButton: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  pillContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pillLabel: {
    fontFamily: Fonts.sansBold,
    fontSize: 12,
    letterSpacing: 1,
  },
  finishContainer: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  finishButton: {
    width: 112,
    height: 44,
    borderRadius: 22,
    backgroundColor: FINISH_COLOR,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  finishButtonText: {
    fontFamily: Fonts.sansBold,
    fontSize: 12,
    letterSpacing: 1,
    color: Colors.primaryForeground,
  },
  label: {
    fontFamily: Fonts.sansBold,
    fontSize: 12,
    letterSpacing: 2,
    marginTop: 10,
  },
  labelPrimary: {
    color: Colors.primary,
  },
  labelDisabled: {
    color: Colors.mutedForeground,
  },
});
