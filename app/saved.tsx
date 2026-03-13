import React, { useState, useEffect, useRef } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, Animated, PanResponder } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAppContext, type FavoriteRoute } from '@/lib/AppContext';
import { FavoritePreview } from '@/components/FavoritePreview';
import { ProfileDrawer, type DrawerView } from '@/components/ProfileDrawer';
import { BottomTabBar } from '@/components/BottomTabBar';
import { getRunHistory, getCachedRunHistory, deleteRunRecord } from '@/lib/firestore';
import type { RunRecord } from '@/lib/types';
import { Colors, Fonts } from '@/lib/theme';
import { distanceUnit, paceUnit } from '@/lib/units';

type Tab = 'favorites' | 'history';

const formatRunDate = (timestamp: number) => {
  const d = new Date(timestamp);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const formatDuration = (seconds: number) => Math.round(seconds / 60);

function formatSplitTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function generateSplits(distance: number, time: number) {
  const fullKms = Math.floor(distance);
  const avgPace = time / distance;
  const splits: { km: number; pace: string; time: string }[] = [];
  for (let i = 1; i <= fullKms; i++) {
    const variation = (Math.random() - 0.5) * 0.6;
    const pace = avgPace + variation;
    splits.push({ km: i, pace: pace.toFixed(1), time: formatSplitTime(pace * 60) });
  }
  const remaining = distance - fullKms;
  if (remaining > 0.1) {
    const variation = (Math.random() - 0.5) * 0.6;
    const pace = avgPace + variation;
    splits.push({ km: parseFloat(distance.toFixed(1)), pace: pace.toFixed(1), time: formatSplitTime(pace * 60) });
  }
  return splits;
}

/** Swipeable card that reveals a delete button */
function SwipeableCard({ onDelete, children }: { onDelete: () => void; children: React.ReactNode }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_, g) => {
        if (g.dx < 0) translateX.setValue(Math.max(g.dx, -80));
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx < -40) {
          Animated.spring(translateX, { toValue: -72, useNativeDriver: true }).start();
        } else {
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
        }
      },
    })
  ).current;

  return (
    <View style={swipeStyles.container}>
      <Pressable onPress={onDelete} style={swipeStyles.deleteBtn}>
        <Ionicons name="trash" size={18} color="#fff" />
      </Pressable>
      <Animated.View style={[swipeStyles.card, { transform: [{ translateX }] }]} {...panResponder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

const swipeStyles = StyleSheet.create({
  container: {
    position: 'relative',
    borderRadius: 12,
    overflow: 'hidden',
  },
  deleteBtn: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 72,
    backgroundColor: Colors.destructive,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
  },
  card: {
    backgroundColor: Colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
});

export default function SavedScreen() {
  const insets = useSafeAreaInsets();
  const ctx = useAppContext();
  const [tab, setTab] = useState<Tab>('favorites');
  const [previewFavorite, setPreviewFavorite] = useState<FavoriteRoute | null>(null);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [drawerInitialView, setDrawerInitialView] = useState<DrawerView>('profile');
  const [selectedRun, setSelectedRun] = useState<RunRecord | null>(null);

  // History state
  const [runHistory, setRunHistory] = useState<RunRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFromCache, setHistoryFromCache] = useState(false);

  useEffect(() => {
    setHistoryLoading(true);
    setHistoryFromCache(false);
    if (ctx.firebaseUid) {
      getRunHistory(ctx.firebaseUid)
        .then((runs) => {
          setRunHistory(runs);
          setHistoryFromCache(false);
        })
        .catch(async () => {
          const cached = await getCachedRunHistory();
          setRunHistory(cached);
          setHistoryFromCache(cached.length > 0);
        })
        .finally(() => setHistoryLoading(false));
    } else {
      getCachedRunHistory()
        .then((cached) => {
          setRunHistory(cached);
          setHistoryFromCache(false);
        })
        .catch(() => {})
        .finally(() => setHistoryLoading(false));
    }
  }, [ctx.firebaseUid]);

  const handleRemoveFavorite = (id: string) => {
    ctx.removeFavorite(id);
  };

  const handlePreviewFavorite = (route: FavoriteRoute) => {
    setPreviewFavorite(route);
  };

  const handleDeleteRun = async (runId: string) => {
    if (selectedRun?.id === runId) setSelectedRun(null);
    setRunHistory((prev) => prev.filter((r) => r.id !== runId));
    await deleteRunRecord(ctx.firebaseUid, runId);
  };

  // Run detail view
  if (selectedRun) {
    const durationMin = formatDuration(selectedRun.duration);
    const pace = selectedRun.avgPace || (durationMin / selectedRun.distance).toFixed(1);
    const pLabel = ctx.prefs.units === 'metric' ? 'min/km' : 'min/mi';
    const dLabel = distanceUnit(ctx.prefs.units);
    const splitLabel = ctx.prefs.units === 'metric' ? 'KM' : 'MILE';
    const splits = selectedRun.splits && selectedRun.splits.length > 0
      ? selectedRun.splits
      : generateSplits(selectedRun.distance, durationMin);

    return (
      <View style={styles.container}>
        {/* Header */}
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <Pressable onPress={() => setSelectedRun(null)} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={20} color={Colors.mutedForeground} />
          </Pressable>
          <Text style={styles.detailHeaderTitle} numberOfLines={1}>{selectedRun.routeName}</Text>
          <View style={{ width: 36 }} />
        </View>

        <ScrollView
          style={styles.scrollContent}
          contentContainerStyle={styles.scrollContentInner}
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.cardSubtitle}>{formatRunDate(selectedRun.date)}</Text>

          {/* Stats grid */}
          <View style={styles.detailStatsGrid}>
            <View style={styles.detailStatCell}>
              <Text style={styles.detailStatValue}>{durationMin}</Text>
              <Text style={styles.detailStatLabel}>min</Text>
            </View>
            <View style={styles.detailStatCell}>
              <Text style={styles.detailStatValue}>{pace}</Text>
              <Text style={styles.detailStatLabel}>{pLabel}</Text>
            </View>
            <View style={styles.detailStatCell}>
              <Text style={styles.detailStatValue}>{selectedRun.distance}</Text>
              <Text style={styles.detailStatLabel}>{dLabel}</Text>
            </View>
          </View>

          {/* Splits */}
          {splits.length > 0 && (
            <>
              <Text style={styles.detailSplitsTitle}>Splits</Text>
              <View style={styles.detailSplitsTable}>
                <View style={styles.detailSplitsHeader}>
                  <Text style={styles.detailSplitsHeaderText}>{splitLabel}</Text>
                  <Text style={styles.detailSplitsHeaderText}>TIME</Text>
                </View>
                {splits.map((split) => (
                  <View key={split.km} style={styles.detailSplitRow}>
                    <Text style={styles.detailSplitKm}>{split.km}</Text>
                    <Text style={styles.detailSplitPace}>{split.time || split.pace}</Text>
                  </View>
                ))}
              </View>
            </>
          )}

          {/* Delete */}
          <Pressable
            onPress={() => handleDeleteRun(selectedRun.id!)}
            style={({ pressed }) => [styles.deleteBtn, pressed && { opacity: 0.7 }]}
          >
            <Ionicons name="trash-outline" size={16} color={Colors.destructive} />
            <Text style={styles.deleteBtnText}>Delete Run</Text>
          </Pressable>
        </ScrollView>

        <BottomTabBar />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={styles.headerTitle}>Saved</Text>
        <Pressable onPress={() => { setDrawerInitialView('profile'); setDrawerVisible(true); }} style={styles.settingsBtn}>
          <Ionicons name="settings-outline" size={18} color={Colors.mutedForeground} />
        </Pressable>
      </View>

      {/* Tab switcher */}
      <View style={styles.tabRow}>
        <Pressable
          onPress={() => setTab('favorites')}
          style={[styles.tabPill, tab === 'favorites' && styles.tabPillActive]}
        >
          <Ionicons
            name={tab === 'favorites' ? 'heart' : 'heart-outline'}
            size={16}
            color={tab === 'favorites' ? Colors.primary : Colors.mutedForeground}
          />
          <Text style={[styles.tabLabel, tab === 'favorites' && styles.tabLabelActive]}>
            Favorites
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setTab('history')}
          style={[styles.tabPill, tab === 'history' && styles.tabPillActive]}
        >
          <Ionicons
            name={tab === 'history' ? 'time' : 'time-outline'}
            size={16}
            color={tab === 'history' ? Colors.primary : Colors.mutedForeground}
          />
          <Text style={[styles.tabLabel, tab === 'history' && styles.tabLabelActive]}>
            History
          </Text>
        </Pressable>
      </View>

      {/* Content */}
      <ScrollView
        style={styles.scrollContent}
        contentContainerStyle={styles.scrollContentInner}
        showsVerticalScrollIndicator={false}
      >
        {tab === 'favorites' && (
          ctx.favorites.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="heart-outline" size={32} color={Colors.mutedForeground} />
              <Text style={styles.emptyText}>No favorites yet</Text>
              <Text style={styles.emptySubtext}>Tap the heart on any route to save it here</Text>
            </View>
          ) : (
            [...ctx.favorites]
              .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
              .map((route) => (
              <View key={route.id} style={styles.card}>
                <View style={styles.favRow}>
                  <Pressable style={{ flex: 1 }} onPress={() => handlePreviewFavorite(route)}>
                    <Text style={styles.cardTitle}>{route.routeName}</Text>
                    {route.createdAt && (
                      <Text style={styles.cardSubtitle}>{formatRunDate(route.createdAt)}</Text>
                    )}
                    <View style={styles.statsRow}>
                      <View style={styles.stat}>
                        <Ionicons name="navigate-outline" size={12} color={Colors.mutedForeground} />
                        <Text style={styles.statText}>{route.distance} {distanceUnit(ctx.prefs.units)}</Text>
                      </View>
                      <View style={styles.stat}>
                        <Ionicons name="map-outline" size={12} color={Colors.mutedForeground} />
                        <Text style={styles.statText}>{route.terrain}</Text>
                      </View>
                    </View>
                  </Pressable>
                  <Pressable
                    onPress={() => handleRemoveFavorite(route.id)}
                    hitSlop={8}
                  >
                    <Ionicons name="heart" size={18} color={Colors.destructive} />
                  </Pressable>
                </View>
              </View>
            ))
          )
        )}

        {tab === 'history' && (
          historyLoading ? (
            <View style={styles.emptyState}>
              <ActivityIndicator size="large" color={Colors.primary} />
              <Text style={styles.emptyText}>Loading history...</Text>
            </View>
          ) : runHistory.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="time-outline" size={32} color={Colors.mutedForeground} />
              <Text style={styles.emptyText}>No runs yet</Text>
              <Text style={styles.emptySubtext}>Your completed runs will appear here</Text>
            </View>
          ) : (
            <>
              {historyFromCache && (
                <Text style={styles.cacheIndicator}>Showing cached data (offline)</Text>
              )}
              {[...runHistory].sort((a, b) => b.date - a.date).map((run) => {
                const durationMin = formatDuration(run.duration);
                const pace = run.avgPace || (durationMin / run.distance).toFixed(1);
                return (
                  <SwipeableCard key={run.id} onDelete={() => handleDeleteRun(run.id!)}>
                    <Pressable
                      style={styles.cardInner}
                      onPress={() => setSelectedRun(run)}
                    >
                      <Text style={styles.cardTitle}>{run.routeName}</Text>
                      <Text style={styles.cardSubtitle}>{formatRunDate(run.date)}</Text>
                      <View style={styles.statsRow}>
                        <View style={styles.stat}>
                          <Ionicons name="time-outline" size={12} color={Colors.mutedForeground} />
                          <Text style={styles.statText}>{durationMin} min</Text>
                        </View>
                        <View style={styles.stat}>
                          <Ionicons name="speedometer-outline" size={12} color={Colors.mutedForeground} />
                          <Text style={styles.statText}>{pace} min{paceUnit(ctx.prefs.units)}</Text>
                        </View>
                        <View style={styles.stat}>
                          <Ionicons name="navigate-outline" size={12} color={Colors.mutedForeground} />
                          <Text style={styles.statText}>{run.distance} {distanceUnit(ctx.prefs.units)}</Text>
                        </View>
                      </View>
                    </Pressable>
                  </SwipeableCard>
                );
              })}
            </>
          )
        )}
      </ScrollView>

      {/* Favorite Route Preview */}
      {previewFavorite && (
        <FavoritePreview
          favorite={previewFavorite}
          onClose={() => setPreviewFavorite(null)}
        />
      )}

      {/* Profile Drawer */}
      <ProfileDrawer
        visible={drawerVisible}
        onClose={() => setDrawerVisible(false)}
        onPreviewFavorite={setPreviewFavorite}
        initialView={drawerInitialView}
      />

      {/* Bottom Tab Bar */}
      <BottomTabBar />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  headerTitle: {
    fontFamily: Fonts.sansBold,
    fontSize: 28,
    color: Colors.foreground,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailHeaderTitle: {
    flex: 1,
    fontFamily: Fonts.sansBold,
    fontSize: 18,
    color: Colors.foreground,
    textAlign: 'center',
  },
  settingsBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 20,
    marginBottom: 16,
  },
  tabPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    paddingVertical: 10,
  },
  tabPillActive: {
    borderColor: Colors.primary + '66',
    backgroundColor: Colors.primary + '1A',
  },
  tabLabel: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 13,
    color: Colors.mutedForeground,
  },
  tabLabelActive: {
    color: Colors.primary,
  },
  scrollContent: {
    flex: 1,
  },
  scrollContentInner: {
    paddingHorizontal: 20,
    paddingBottom: 40,
    gap: 10,
  },
  emptyState: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 48,
  },
  emptyText: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 15,
    color: Colors.mutedForeground,
  },
  emptySubtext: {
    fontFamily: Fonts.sans,
    fontSize: 13,
    color: Colors.mutedForeground,
    textAlign: 'center',
    paddingHorizontal: 40,
  },
  card: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    padding: 14,
    gap: 6,
  },
  cardInner: {
    padding: 14,
    gap: 6,
  },
  cardTitle: {
    fontFamily: Fonts.sansBold,
    fontSize: 14,
    color: Colors.foreground,
  },
  cardSubtitle: {
    fontFamily: Fonts.sans,
    fontSize: 11,
    color: Colors.mutedForeground,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 4,
  },
  stat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  statText: {
    fontFamily: Fonts.sansMedium,
    fontSize: 11,
    color: Colors.mutedForeground,
  },
  favRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  cacheIndicator: {
    fontFamily: Fonts.sans,
    fontSize: 11,
    color: Colors.mutedForeground,
    textAlign: 'center',
    fontStyle: 'italic',
    marginBottom: 8,
  },

  // Run detail styles
  detailStatsGrid: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  detailStatCell: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    padding: 12,
    alignItems: 'center',
    gap: 2,
  },
  detailStatValue: {
    fontFamily: Fonts.sansBold,
    fontSize: 18,
    color: Colors.primary,
  },
  detailStatLabel: {
    fontFamily: Fonts.sans,
    fontSize: 10,
    color: Colors.mutedForeground,
    textTransform: 'uppercase',
  },
  detailSplitsTitle: {
    fontFamily: Fonts.sansBold,
    fontSize: 14,
    color: Colors.foreground,
    marginTop: 8,
  },
  detailSplitsTable: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    overflow: 'hidden',
  },
  detailSplitsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  detailSplitsHeaderText: {
    fontFamily: Fonts.sansBold,
    fontSize: 10,
    color: Colors.mutedForeground,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  detailSplitRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  detailSplitKm: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 13,
    color: Colors.foreground,
  },
  detailSplitPace: {
    fontFamily: Fonts.sansMedium,
    fontSize: 13,
    color: Colors.mutedForeground,
  },
  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 12,
    paddingVertical: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.destructive + '33',
    backgroundColor: Colors.destructive + '0D',
  },
  deleteBtnText: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 14,
    color: Colors.destructive,
  },
});
