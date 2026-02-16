import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Colors } from '@/lib/theme';

interface GpsSignalProps {
  strength: 0 | 1 | 2 | 3;
}

const BAR_HEIGHTS = [6, 10, 14];

export function GpsSignal({ strength }: GpsSignalProps) {
  return (
    <View style={styles.container}>
      <View style={styles.bars}>
        {[1, 2, 3].map((bar) => (
          <View
            key={bar}
            style={[
              styles.bar,
              { height: BAR_HEIGHTS[bar - 1] },
              { backgroundColor: bar <= strength ? Colors.primary : Colors.mutedForeground + '4D' },
            ]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  bars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
  },
  bar: {
    width: 4,
    borderRadius: 9999,
  },
});
