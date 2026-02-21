import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
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
  splits: { km: number; pace: string; time: string }[];
  isRunning: boolean;
  isFinished?: boolean;
  isFavorited?: boolean;
  onToggleFavorite?: () => void;
  onDiscard?: () => void;
  onSave?: () => void;
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
  pace,
  distance,
  time,
  calories,
  elevation,
  avgPace,
  splits,
  isRunning,
  isFinished,
  isFavorited,
  onToggleFavorite,
  onDiscard,
  onSave,
}: StatsViewProps) {
  // Finished state — match history run-detail layout
  if (isFinished) {
    return (
      <ScrollView
        style={styles.finishedContainer}
        contentContainerStyle={styles.finishedContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <Text style={styles.finishedHeader}>Run Summary</Text>

        {/* Stats grid */}
        <View style={styles.statsGrid}>
          <View style={styles.statCell}>
            <Text style={styles.statCellValue}>{time}</Text>
            <Text style={styles.statCellLabel}>time</Text>
          </View>
          <View style={styles.statCell}>
            <Text style={styles.statCellValue}>{avgPace || pace}</Text>
            <Text style={styles.statCellLabel}>min/mi</Text>
          </View>
          <View style={styles.statCell}>
            <Text style={styles.statCellValue}>{distance}</Text>
            <Text style={styles.statCellLabel}>mi</Text>
          </View>
        </View>

        {/* Splits table */}
        {splits.length > 0 && (
          <>
            <Text style={styles.finishedSplitsTitle}>Splits</Text>
            <View style={styles.splitsTable}>
              <View style={styles.splitsTableHeader}>
                <Text style={styles.splitsHeaderText}>MILE</Text>
                <Text style={styles.splitsHeaderText}>TIME</Text>
              </View>
              {splits.map((split) => (
                <View key={split.km} style={styles.splitsTableRow}>
                  <Text style={styles.splitsTableKm}>{split.km}</Text>
                  <Text style={styles.splitsTablePace}>{split.time}</Text>
                </View>
              ))}
            </View>
          </>
        )}

        {/* Favorite */}
        {onToggleFavorite && (
          <>
            <View style={styles.actionsDivider} />
            <Pressable
              onPress={(e) => { e.stopPropagation(); onToggleFavorite(); }}
              style={styles.favoriteBtn}
            >
              <Ionicons
                name={isFavorited ? 'heart' : 'heart-outline'}
                size={22}
                color={isFavorited ? Colors.destructive : Colors.mutedForeground}
              />
              <Text style={[styles.favoriteLabel, isFavorited && { color: Colors.destructive }]}>
                {isFavorited ? 'Favorited' : 'Add to Favorites'}
              </Text>
            </Pressable>
          </>
        )}

        {/* Discard / Save */}
        {onDiscard && onSave && (
          <View style={styles.actionsColumn}>
            <Pressable
              onPress={(e) => { e.stopPropagation(); onSave(); }}
              style={({ pressed }) => [styles.saveBtn, pressed && { transform: [{ scale: 0.98 }] }]}
            >
              <Ionicons name="checkmark" size={20} color={Colors.primaryForeground} />
              <Text style={styles.saveLabel}>Save Activity</Text>
            </Pressable>
            <Pressable
              onPress={(e) => { e.stopPropagation(); onDiscard(); }}
              style={({ pressed }) => [styles.discardBtn, pressed && { opacity: 0.7 }]}
            >
              <Ionicons name="trash-outline" size={16} color={Colors.mutedForeground} />
              <Text style={styles.discardLabel}>Discard</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
    );
  }

  // In-run stats view (tap stats row to see)
  return (
    <View style={styles.container}>
      <View style={styles.metricsGrid}>
        <StatCard
          icon={<Ionicons name="flame" size={20} color={Colors.primary} />}
          label="CALORIES"
          value={String(calories)}
        />
        <StatCard
          icon={<Ionicons name="trending-up" size={20} color={Colors.primary} />}
          label="ELEVATION"
          value={`${elevation}m`}
        />
      </View>

      {splits.length > 0 && (
        <View style={styles.splitsSection}>
          <Text style={styles.inRunSplitsTitle}>SPLITS</Text>
          {splits.map((item) => (
            <View key={item.km} style={styles.inRunSplitRow}>
              <Text style={styles.inRunSplitKm}>MILE {item.km}</Text>
              <Text style={styles.inRunSplitPace}>{item.time}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // In-run stats
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
  inRunSplitsTitle: {
    fontFamily: Fonts.sansBold,
    fontSize: 10,
    letterSpacing: 2,
    color: Colors.mutedForeground,
    marginBottom: 8,
  },
  inRunSplitRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: Colors.card + '66',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 4,
  },
  inRunSplitKm: {
    fontFamily: Fonts.sans,
    fontSize: 12,
    color: Colors.mutedForeground,
  },
  inRunSplitPace: {
    fontFamily: Fonts.monoBold,
    fontSize: 14,
    color: Colors.primary,
  },

  // Finished stats (matches history run-detail)
  finishedContainer: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  finishedContent: {
    paddingHorizontal: 20,
    paddingTop: 80,
    paddingBottom: 40,
    gap: 16,
  },
  finishedHeader: {
    fontFamily: Fonts.sansBold,
    fontSize: 22,
    color: Colors.foreground,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  statCell: {
    width: '30%',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    padding: 12,
    alignItems: 'center',
    gap: 2,
  },
  statCellValue: {
    fontFamily: Fonts.sansBold,
    fontSize: 18,
    color: Colors.primary,
  },
  statCellLabel: {
    fontFamily: Fonts.sans,
    fontSize: 10,
    color: Colors.mutedForeground,
    textTransform: 'uppercase',
  },
  finishedSplitsTitle: {
    fontFamily: Fonts.sansBold,
    fontSize: 14,
    color: Colors.foreground,
  },
  splitsTable: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    overflow: 'hidden',
  },
  splitsTableHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  splitsHeaderText: {
    fontFamily: Fonts.sansBold,
    fontSize: 10,
    color: Colors.mutedForeground,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  splitsTableRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  splitsTableKm: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 13,
    color: Colors.foreground,
  },
  splitsTablePace: {
    fontFamily: Fonts.sansMedium,
    fontSize: 13,
    color: Colors.mutedForeground,
  },

  // Favorite button
  favoriteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    paddingVertical: 14,
  },
  favoriteLabel: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 14,
    color: Colors.mutedForeground,
  },
  actionsDivider: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: 4,
  },

  // Discard / Save
  actionsColumn: {
    gap: 12,
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    borderRadius: 16,
    paddingVertical: 16,
    backgroundColor: Colors.primary,
  },
  saveLabel: {
    fontFamily: Fonts.sansBold,
    fontSize: 14,
    color: Colors.primaryForeground,
  },
  discardBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
  },
  discardLabel: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 13,
    color: Colors.mutedForeground,
  },
});
