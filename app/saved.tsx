import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAppContext, type FavoriteRoute } from '@/lib/AppContext';
import { FavoritePreview } from '@/components/FavoritePreview';
import { ProfileDrawer, type DrawerView } from '@/components/ProfileDrawer';
import { BottomTabBar } from '@/components/BottomTabBar';
import { getRunHistory, getCachedRunHistory } from '@/lib/firestore';
import type { RunRecord } from '@/lib/types';
import { Colors, Fonts } from '@/lib/theme';
import { distanceUnit, paceUnit } from '@/lib/units';

type Tab = 'favorites' | 'history';

const formatRunDate = (timestamp: number) => {
  const d = new Date(timestamp);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const formatDuration = (seconds: number) => Math.round(seconds / 60);

export default function SavedScreen() {
  const insets = useSafeAreaInsets();
  const ctx = useAppContext();
  const [tab, setTab] = useState<Tab>('favorites');
  const [previewFavorite, setPreviewFavorite] = useState<FavoriteRoute | null>(null);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [drawerInitialView, setDrawerInitialView] = useState<DrawerView>('profile');

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

  const handleRunDetailPress = (run: RunRecord) => {
    setDrawerInitialView('run-detail' as DrawerView);
    setDrawerVisible(true);
  };

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
              <Text style={styles.emptySubtext}>Tap the heart on any generated route to save it here</Text>
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
                  <Pressable
                    key={run.id}
                    style={styles.card}
                    onPress={() => {
                      setDrawerInitialView('history');
                      setDrawerVisible(true);
                    }}
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
});
