import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Colors, Fonts } from '@/lib/theme';

interface RunStatsProps {
  pace: string;
  distance: string;
  time: string;
  isRunning: boolean;
  onStatPress?: () => void;
}

export function RunStats({ pace, distance, time, onStatPress }: RunStatsProps) {
  return (
    <View style={styles.grid}>
      {/* Pace */}
      <Pressable style={[styles.cell, styles.cellSide]} onPress={onStatPress}>
        <Text style={styles.label}>AVG PACE</Text>
        <Text style={[styles.value, styles.valuePrimary]}>{pace}</Text>
        <Text style={styles.unit}>min/km</Text>
      </Pressable>

      {/* Distance */}
      <Pressable style={[styles.cell, styles.cellSide]} onPress={onStatPress}>
        <Text style={styles.label}>DISTANCE</Text>
        <Text style={[styles.value, styles.valuePrimary]}>{distance}</Text>
        <Text style={styles.unit}>km</Text>
      </Pressable>

      {/* Time */}
      <Pressable style={[styles.cell, styles.cellSide]} onPress={onStatPress}>
        <Text style={styles.label}>TIME</Text>
        <Text style={[styles.value, styles.valuePrimary]}>{time}</Text>
        <Text style={styles.unit}>elapsed</Text>
      </Pressable>
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
    paddingHorizontal: 10,
    paddingVertical: 14,
  },
  cellSide: {
    borderColor: Colors.border + '80',
    backgroundColor: Colors.card + '66',
  },
  label: {
    fontFamily: Fonts.sansBold,
    fontSize: 10,
    letterSpacing: 1.5,
    color: Colors.mutedForeground,
  },
  value: {
    fontFamily: Fonts.monoBold,
    lineHeight: 32,
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
