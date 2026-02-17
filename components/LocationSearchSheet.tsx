import React, { useState, useRef, useEffect } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, Keyboard, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { Colors, Fonts } from '@/lib/theme';

interface LocationSearchSheetProps {
  visible: boolean;
  title: string;
  placeholder: string;
  onSubmit: (address: string) => Promise<void>;
  onClose: () => void;
}

export function LocationSearchSheet({ visible, title, placeholder, onSubmit, onClose }: LocationSearchSheetProps) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [mounted, setMounted] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const translateY = useSharedValue(400);
  const backdropOpacity = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setText('');
      setIsSearching(false);
      translateY.value = withTiming(0, { duration: 300 });
      backdropOpacity.value = withTiming(1, { duration: 300 });
      setTimeout(() => inputRef.current?.focus(), 350);
    } else {
      Keyboard.dismiss();
      translateY.value = withTiming(400, { duration: 250 });
      backdropOpacity.value = withTiming(0, { duration: 250 }, (finished) => {
        if (finished) runOnJS(setMounted)(false);
      });
    }
  }, [visible]);

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));

  const handleSubmit = async () => {
    if (!text.trim() || isSearching) return;
    setIsSearching(true);
    try {
      await onSubmit(text.trim());
    } finally {
      setIsSearching(false);
    }
  };

  const handleClose = () => {
    Keyboard.dismiss();
    onClose();
  };

  if (!mounted) return null;

  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 500 }]} pointerEvents="box-none">
      {/* Backdrop */}
      <Animated.View style={[styles.backdrop, backdropStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
      </Animated.View>

      {/* Sheet */}
      <Animated.View style={[styles.sheet, sheetStyle, { paddingBottom: Math.max(insets.bottom, 20) + 12 }]}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.grabHandle} />
          <View style={styles.headerRow}>
            <Text style={styles.title}>{title}</Text>
            <Pressable onPress={handleClose} style={styles.cancelBtn}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>

        {/* Search input */}
        <View style={styles.searchContainer}>
          <View style={styles.searchInputRow}>
            <Ionicons name="search" size={18} color={Colors.mutedForeground} />
            <TextInput
              ref={inputRef}
              style={styles.searchInput}
              placeholder={placeholder}
              placeholderTextColor={Colors.mutedForeground}
              value={text}
              onChangeText={setText}
              onSubmitEditing={handleSubmit}
              returnKeyType="search"
              autoCorrect={false}
              autoCapitalize="words"
            />
            {text.length > 0 && !isSearching && (
              <Pressable onPress={() => setText('')} hitSlop={8}>
                <Ionicons name="close-circle" size={18} color={Colors.mutedForeground} />
              </Pressable>
            )}
            {isSearching && (
              <ActivityIndicator size="small" color={Colors.primary} />
            )}
          </View>

          {/* Search button */}
          <Pressable
            onPress={handleSubmit}
            disabled={!text.trim() || isSearching}
            style={({ pressed }) => [
              styles.searchButton,
              text.trim() ? styles.searchButtonActive : styles.searchButtonDisabled,
              pressed && text.trim() && { opacity: 0.8 },
            ]}
          >
            <Ionicons
              name="arrow-forward"
              size={18}
              color={text.trim() ? Colors.primaryForeground : Colors.mutedForeground}
            />
            <Text
              style={[
                styles.searchButtonLabel,
                text.trim() ? styles.searchButtonLabelActive : styles.searchButtonLabelDisabled,
              ]}
            >
              Search
            </Text>
          </Pressable>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: Colors.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  header: {
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  grabHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.mutedForeground + '4D',
    marginTop: 12,
    marginBottom: 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: 16,
  },
  title: {
    fontFamily: Fonts.sansBold,
    fontSize: 18,
    color: Colors.foreground,
  },
  cancelBtn: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  cancelText: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 14,
    color: Colors.mutedForeground,
  },
  searchContainer: {
    paddingHorizontal: 20,
    gap: 12,
  },
  searchInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Colors.secondary,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  searchInput: {
    flex: 1,
    fontFamily: Fonts.sans,
    fontSize: 16,
    color: Colors.foreground,
    padding: 0,
  },
  searchButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 14,
    paddingVertical: 14,
  },
  searchButtonActive: {
    backgroundColor: Colors.primary,
  },
  searchButtonDisabled: {
    backgroundColor: Colors.muted,
  },
  searchButtonLabel: {
    fontFamily: Fonts.sansBold,
    fontSize: 14,
  },
  searchButtonLabelActive: {
    color: Colors.primaryForeground,
  },
  searchButtonLabelDisabled: {
    color: Colors.mutedForeground,
  },
});
