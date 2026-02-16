import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Fonts } from '@/lib/theme';

interface ViewToggleProps {
  view: 'map' | 'stats';
  onViewChange: (view: 'map' | 'stats') => void;
}

export function ViewToggle({ view, onViewChange }: ViewToggleProps) {
  return (
    <View style={styles.container}>
      <Pressable
        onPress={() => onViewChange('map')}
        style={[styles.segment, view === 'map' && styles.segmentActive]}
      >
        <Ionicons
          name="map"
          size={14}
          color={view === 'map' ? Colors.primaryForeground : Colors.mutedForeground}
        />
        <Text
          style={[styles.label, view === 'map' ? styles.labelActive : styles.labelInactive]}
        >
          Map
        </Text>
      </Pressable>
      <Pressable
        onPress={() => onViewChange('stats')}
        style={[styles.segment, view === 'stats' && styles.segmentActive]}
      >
        <Ionicons
          name="bar-chart"
          size={14}
          color={view === 'stats' ? Colors.primaryForeground : Colors.mutedForeground}
        />
        <Text
          style={[styles.label, view === 'stats' ? styles.labelActive : styles.labelInactive]}
        >
          Stats
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    borderRadius: 9999,
    borderWidth: 1,
    borderColor: Colors.border + '80',
    backgroundColor: Colors.card + '99',
    padding: 4,
  },
  segment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 9999,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  segmentActive: {
    backgroundColor: Colors.primary,
  },
  label: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 12,
  },
  labelActive: {
    color: Colors.primaryForeground,
  },
  labelInactive: {
    color: Colors.mutedForeground,
  },
});
