import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Colors, Fonts } from '@/lib/theme';

interface RunStatsProps {
  pace: string;
  distance: string;
  time: string;
  isRunning: boolean;
}

export function RunStats({ pace, distance, time }: RunStatsProps) {
  return (
    <View style={styles.grid}>
      {/* Time */}
      <View style={[styles.cell, styles.cellSide]}>
        <Text style={styles.label}>TIME</Text>
        <Text style={[styles.value, styles.valuePrimary]}>{time}</Text>
      </View>

      {/* Pace */}
      <View style={[styles.cell, styles.cellSide]}>
        <Text style={styles.label} numberOfLines={1}>AVG PACE (/MI)</Text>
        <Text style={[styles.value, styles.valuePrimary]}>{pace}</Text>
      </View>

      {/* Distance */}
      <View style={[styles.cell, styles.cellSide]}>
        <Text style={styles.label} numberOfLines={1}>DISTANCE (MI)</Text>
        <Text style={[styles.value, styles.valuePrimary]}>{distance}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    gap: 10,
  },
  cell: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 10,
  },
  cellSide: {
    borderColor: Colors.border + '80',
    backgroundColor: Colors.card + '66',
  },
  label: {
    fontFamily: Fonts.sansBold,
    fontSize: 9,
    letterSpacing: 1,
    color: Colors.mutedForeground,
  },
  value: {
    fontFamily: Fonts.monoBold,
    lineHeight: 28,
  },
  valuePrimary: {
    fontSize: 26,
    color: Colors.primary,
  },
  unit: {
    fontFamily: Fonts.sans,
    fontSize: 10,
    color: Colors.mutedForeground,
  },
});
