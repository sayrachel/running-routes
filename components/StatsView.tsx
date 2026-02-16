import React from 'react';
import { View, Text, FlatList, StyleSheet } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Colors, Fonts } from '@/lib/theme';

interface StatsViewProps {
  pace: string;
  distance: string;
  time: string;
  calories: number;
  elevation: number;
  cadence: number;
  avgPace: string;
  splits: { km: number; pace: string }[];
  isRunning: boolean;
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.statCard}>
      <View style={styles.statIconBox}>{icon}</View>
      <View>
        <Text style={styles.statLabel}>{label}</Text>
        <Text style={styles.statValue}>{value}</Text>
      </View>
    </View>
  );
}

export function StatsView({
  calories,
  elevation,
  avgPace,
  splits,
}: StatsViewProps) {
  return (
    <View style={styles.container}>
      {/* Metrics grid */}
      <View style={styles.metricsGrid}>
        <StatCard
          icon={<Ionicons name="flame" size={20} color={Colors.primary} />}
          label="CALORIES"
          value={String(calories)}
        />
        <StatCard
          icon={<MaterialCommunityIcons name="mountain" size={20} color={Colors.primary} />}
          label="ELEVATION"
          value={`${elevation}m`}
        />
      </View>

      {/* Splits */}
      {splits.length > 0 && (
        <View style={styles.splitsSection}>
          <Text style={styles.splitsTitle}>SPLITS</Text>
          <FlatList
            data={splits}
            keyExtractor={(item) => String(item.km)}
            scrollEnabled={false}
            renderItem={({ item }) => (
              <View style={styles.splitRow}>
                <Text style={styles.splitKm}>KM {item.km}</Text>
                <Text style={styles.splitPace}>{item.pace}</Text>
              </View>
            )}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
    paddingHorizontal: 20,
    paddingBottom: 240,
    paddingTop: 80,
    justifyContent: 'center',
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  statCard: {
    width: '48%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border + '80',
    backgroundColor: Colors.card + '99',
    padding: 14,
  },
  statIconBox: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: Colors.primary + '1A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statLabel: {
    fontFamily: Fonts.sansBold,
    fontSize: 10,
    letterSpacing: 1.5,
    color: Colors.mutedForeground,
  },
  statValue: {
    fontFamily: Fonts.monoBold,
    fontSize: 20,
    color: Colors.foreground,
  },
  splitsSection: {
    marginTop: 16,
  },
  splitsTitle: {
    fontFamily: Fonts.sansBold,
    fontSize: 10,
    letterSpacing: 2,
    color: Colors.mutedForeground,
    marginBottom: 8,
  },
  splitRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: Colors.card + '66',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 4,
  },
  splitKm: {
    fontFamily: Fonts.sans,
    fontSize: 12,
    color: Colors.mutedForeground,
  },
  splitPace: {
    fontFamily: Fonts.monoBold,
    fontSize: 14,
    color: Colors.primary,
  },
});
