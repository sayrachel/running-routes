import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, Image, Dimensions, Share, Linking } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { useAppContext, type FavoriteRoute } from '@/lib/AppContext';
export type { FavoriteRoute };
import { getRunHistory, getCachedRunHistory } from '@/lib/firestore';
import type { RunRecord } from '@/lib/types';
import { Colors, Fonts } from '@/lib/theme';

export type DrawerView = 'profile' | 'history' | 'favorites' | 'run-detail' | 'contact';

const SCREEN_WIDTH = Dimensions.get('window').width;

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

interface ProfileDrawerProps {
  visible: boolean;
  onClose: () => void;
  onPreviewFavorite?: (favorite: FavoriteRoute) => void;
  initialView?: DrawerView;
}

export function ProfileDrawer({ visible, onClose, onPreviewFavorite, initialView }: ProfileDrawerProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const ctx = useAppContext();
  const translateX = useSharedValue(SCREEN_WIDTH);
  const [mounted, setMounted] = useState(false);
  const [deleteLabel, setDeleteLabel] = useState('Delete Account');
  const [view, setView] = useState<DrawerView>('profile');
  const [selectedRun, setSelectedRun] = useState<RunRecord | null>(null);
  const [runHistory, setRunHistory] = useState<RunRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFromCache, setHistoryFromCache] = useState(false);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setDeleteLabel('Delete Account');
      setView(initialView || 'profile');
      setSelectedRun(null);
      translateX.value = withTiming(0, { duration: 300 });

      // Load run history: try Firestore first, fall back to cache
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
        // No auth — load from local cache
        getCachedRunHistory()
          .then((cached) => {
            setRunHistory(cached);
            setHistoryFromCache(cached.length > 0);
          })
          .catch(() => {})
          .finally(() => setHistoryLoading(false));
      }
    } else {
      translateX.value = withTiming(SCREEN_WIDTH, { duration: 300 }, (finished) => {
        if (finished) {
          runOnJS(setMounted)(false);
        }
      });
    }
  }, [visible]);

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const handleBack = () => {
    if (view === 'run-detail') {
      setView('history');
      setSelectedRun(null);
    } else if (view !== 'profile' && initialView && initialView !== 'profile') {
      // Opened directly to history/favorites — back closes the drawer
      onClose();
    } else if (view !== 'profile') {
      setView('profile');
    } else {
      onClose();
    }
  };

  const SUPPORT_EMAIL = 'support@runroutes.app';

  const [emailCopied, setEmailCopied] = useState(false);

  const handleCopyEmail = async () => {
    await Clipboard.setStringAsync(SUPPORT_EMAIL);
    setEmailCopied(true);
    setTimeout(() => setEmailCopied(false), 2000);
  };

  const handleOpenGmail = () => {
    const gmailUrl = `https://mail.google.com/mail/?view=cm&to=${SUPPORT_EMAIL}&su=Running%20Routes%20Support`;
    Linking.openURL(gmailUrl);
  };

  const handleLogout = async () => {
    await ctx.signOutUser();
    onClose();
    router.replace('/landing');
  };

  const handleDelete = () => {
    if (deleteLabel === 'Delete Account') {
      setDeleteLabel('Tap again to confirm');
      return;
    }
    ctx.signOutUser();
    onClose();
    router.replace('/landing');
  };

  const handleRemoveFavorite = (id: string) => {
    ctx.removeFavorite(id);
  };

  const handlePreviewFavorite = (route: FavoriteRoute) => {
    onClose();
    onPreviewFavorite?.(route);
  };

  if (!mounted) return null;

  const viewTitle = view === 'history' ? 'History' : view === 'favorites' ? 'Favorites' : view === 'contact' ? 'Contact Us' : view === 'run-detail' && selectedRun ? selectedRun.routeName : 'Settings';

  const formatRunDate = (timestamp: number) => {
    const d = new Date(timestamp);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatDuration = (seconds: number) => {
    return Math.round(seconds / 60);
  };

  const renderRunDetail = () => {
    if (!selectedRun) return null;
    const durationMin = formatDuration(selectedRun.duration);
    const pace = selectedRun.avgPace || (durationMin / selectedRun.distance).toFixed(1);
    const splits = selectedRun.splits && selectedRun.splits.length > 0
      ? selectedRun.splits
      : generateSplits(selectedRun.distance, durationMin);

    return (
      <ScrollView
        style={styles.scrollContent}
        contentContainerStyle={styles.scrollContentInner}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.runDetailDate}>{formatRunDate(selectedRun.date)}</Text>

        {/* Stats grid */}
        <View style={styles.statsGrid}>
          <View style={styles.statCell}>
            <Text style={styles.statCellValue}>{durationMin}</Text>
            <Text style={styles.statCellLabel}>min</Text>
          </View>
          <View style={styles.statCell}>
            <Text style={styles.statCellValue}>{pace}</Text>
            <Text style={styles.statCellLabel}>min/mi</Text>
          </View>
          <View style={styles.statCell}>
            <Text style={styles.statCellValue}>{selectedRun.distance}</Text>
            <Text style={styles.statCellLabel}>mi</Text>
          </View>
        </View>

        {/* Splits */}
        <Text style={styles.splitsTitle}>Splits</Text>
        <View style={styles.splitsTable}>
          <View style={styles.splitsHeader}>
            <Text style={styles.splitsHeaderText}>MILE</Text>
            <Text style={styles.splitsHeaderText}>TIME</Text>
          </View>
          {splits.map((split) => (
            <View key={split.km} style={styles.splitRow}>
              <Text style={styles.splitKm}>{split.km}</Text>
              <Text style={styles.splitPace}>{split.time || split.pace}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    );
  };

  return (
    <Animated.View style={[styles.fullScreen, drawerStyle]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={handleBack} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={Colors.mutedForeground} />
        </Pressable>
        <Text style={styles.headerTitle}>{viewTitle}</Text>
        <View style={styles.headerSpacer} />
      </View>

      {/* Content */}
      <View style={styles.content}>
        {view === 'profile' ? (
          <ScrollView
            style={styles.scrollContent}
            contentContainerStyle={styles.scrollContentInner}
            showsVerticalScrollIndicator={false}
          >
            {/* Profile */}
            <View style={styles.profileSection}>
              <View style={styles.avatar}>
                {ctx.user?.avatar ? (
                  <Image source={{ uri: ctx.user.avatar }} style={styles.avatarImage} />
                ) : (
                  <Ionicons name="person" size={40} color={Colors.primary} />
                )}
              </View>
              <Text style={styles.userEmail}>{ctx.user?.email ?? ''}</Text>
            </View>

            <View style={styles.divider} />

            {/* Runs */}
            <Text style={styles.sectionLabel}>RUNS</Text>
            <View style={styles.menuSection}>
              <Pressable style={styles.menuRow} onPress={() => setView('history')}>
                <Ionicons name="time-outline" size={20} color={Colors.mutedForeground} />
                <Text style={styles.menuLabel}>History</Text>
                <Ionicons name="chevron-forward" size={16} color={Colors.mutedForeground} />
              </Pressable>

              <Pressable style={styles.menuRow} onPress={() => setView('favorites')}>
                <Ionicons name="heart-outline" size={20} color={Colors.mutedForeground} />
                <Text style={styles.menuLabel}>Favorites</Text>
                <Ionicons name="chevron-forward" size={16} color={Colors.mutedForeground} />
              </Pressable>
            </View>

            {/* Support */}
            <Text style={styles.sectionLabel}>SUPPORT</Text>
            <View style={styles.menuSection}>
              <Pressable style={styles.menuRow} onPress={async () => {
                try {
                  await Share.share({
                    message: 'Discover Run Routes: your personal running route generator based on your preferences. https://runroutes.app',
                  });
                } catch {}
              }}>
                <Ionicons name="share-outline" size={20} color={Colors.mutedForeground} />
                <Text style={styles.menuLabel}>Share Run Routes</Text>
                <Ionicons name="chevron-forward" size={16} color={Colors.mutedForeground} />
              </Pressable>

              <Pressable style={styles.menuRow} onPress={() => setView('contact')}>
                <Ionicons name="mail-outline" size={20} color={Colors.mutedForeground} />
                <Text style={styles.menuLabel}>Contact Us</Text>
                <Ionicons name="chevron-forward" size={16} color={Colors.mutedForeground} />
              </Pressable>
            </View>

            {/* Legal */}
            <Text style={styles.sectionLabel}>LEGAL</Text>
            <View style={styles.menuSection}>
              <Pressable style={styles.menuRow} onPress={() => Linking.openURL('https://runroutes.app/terms')}>
                <Ionicons name="document-text-outline" size={20} color={Colors.mutedForeground} />
                <Text style={styles.menuLabel}>Terms of Service</Text>
                <Ionicons name="chevron-forward" size={16} color={Colors.mutedForeground} />
              </Pressable>

              <Pressable style={styles.menuRow} onPress={() => Linking.openURL('https://runroutes.app/privacy')}>
                <Ionicons name="shield-checkmark-outline" size={20} color={Colors.mutedForeground} />
                <Text style={styles.menuLabel}>Privacy Policy</Text>
                <Ionicons name="chevron-forward" size={16} color={Colors.mutedForeground} />
              </Pressable>
            </View>

            {/* Account */}
            <Text style={styles.sectionLabel}>ACCOUNT</Text>
            <View style={styles.menuSection}>
              <Pressable
                onPress={handleLogout}
                style={styles.menuRow}
              >
                <Ionicons name="log-out-outline" size={20} color={Colors.mutedForeground} />
                <Text style={styles.menuLabel}>Log Out</Text>
                <Ionicons name="chevron-forward" size={16} color={Colors.mutedForeground} />
              </Pressable>

              <Pressable
                onPress={handleDelete}
                style={styles.menuRow}
              >
                <Ionicons name="trash-outline" size={20} color={Colors.destructive} />
                <Text style={[styles.menuLabel, { color: Colors.destructive }]}>{deleteLabel}</Text>
                <Ionicons name="chevron-forward" size={16} color={Colors.mutedForeground} />
              </Pressable>
            </View>
          </ScrollView>
        ) : view === 'run-detail' ? (
          renderRunDetail()
        ) : view === 'contact' ? (
          <ScrollView
            style={styles.scrollContent}
            contentContainerStyle={styles.scrollContentInner}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.contactDescription}>
              Our customer service team is here to help you with any questions or issues you might have with Running Routes.
            </Text>

            <Text style={styles.sectionLabel}>EMAIL SUPPORT</Text>
            <View style={styles.contactEmailCard}>
              <Ionicons name="mail-outline" size={20} color={Colors.primary} />
              <Text style={styles.contactEmail}>{SUPPORT_EMAIL}</Text>
              <Pressable onPress={handleCopyEmail} hitSlop={8}>
                <Ionicons name={emailCopied ? "checkmark-circle" : "copy-outline"} size={20} color={emailCopied ? Colors.primary : Colors.mutedForeground} />
              </Pressable>
              <Pressable onPress={handleOpenGmail} hitSlop={8}>
                <Ionicons name="open-outline" size={20} color={Colors.mutedForeground} />
              </Pressable>
            </View>
          </ScrollView>
        ) : (
          <ScrollView
            style={styles.scrollContent}
            contentContainerStyle={styles.scrollContentInner}
            showsVerticalScrollIndicator={false}
          >
            {view === 'history' && (
              historyLoading ? (
                <View style={styles.emptyState}>
                  <Text style={styles.emptyText}>Loading history...</Text>
                </View>
              ) : runHistory.length === 0 ? (
                <View style={styles.emptyState}>
                  <Ionicons name="time-outline" size={32} color={Colors.mutedForeground} />
                  <Text style={styles.emptyText}>No runs yet</Text>
                </View>
              ) : (
                <>
                  {historyFromCache && (
                    <Text style={styles.cacheIndicator}>Showing cached data (offline)</Text>
                  )}
                  {runHistory.map((run) => {
                    const durationMin = formatDuration(run.duration);
                    const pace = run.avgPace || (durationMin / run.distance).toFixed(1);
                    return (
                      <Pressable
                        key={run.id}
                        style={styles.card}
                        onPress={() => { setSelectedRun(run); setView('run-detail'); }}
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
                            <Text style={styles.statText}>{pace} min/mi</Text>
                          </View>
                          <View style={styles.stat}>
                            <Ionicons name="navigate-outline" size={12} color={Colors.mutedForeground} />
                            <Text style={styles.statText}>{run.distance} mi</Text>
                          </View>
                        </View>
                      </Pressable>
                    );
                  })}
                </>
              )
            )}

            {view === 'favorites' &&
              (ctx.favorites.length === 0 ? (
                <View style={styles.emptyState}>
                  <Ionicons name="heart-outline" size={32} color={Colors.mutedForeground} />
                  <Text style={styles.emptyText}>No favorites yet</Text>
                </View>
              ) : (
                ctx.favorites.map((route) => (
                  <View key={route.id} style={styles.card}>
                    <View style={styles.favRow}>
                      <Pressable style={{ flex: 1 }} onPress={() => handlePreviewFavorite(route)}>
                        <Text style={styles.cardTitle}>{route.routeName}</Text>
                        <View style={styles.statsRow}>
                          <View style={styles.stat}>
                            <Ionicons name="navigate-outline" size={12} color={Colors.mutedForeground} />
                            <Text style={styles.statText}>{route.distance} mi</Text>
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
              ))}
          </ScrollView>
        )}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fullScreen: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.background,
    zIndex: 1000,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.background,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    flex: 1,
    fontFamily: Fonts.sansBold,
    fontSize: 18,
    color: Colors.foreground,
    textAlign: 'center',
  },
  headerSpacer: {
    width: 36,
  },
  content: {
    flex: 1,
  },
  scrollContent: {
    flex: 1,
  },
  scrollContentInner: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 40,
    gap: 10,
  },
  profileSection: {
    alignItems: 'center',
    gap: 8,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: Colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImage: {
    width: 80,
    height: 80,
    borderRadius: 40,
  },
  userName: {
    fontFamily: Fonts.sansBold,
    fontSize: 18,
    color: Colors.foreground,
  },
  userEmail: {
    fontFamily: Fonts.sans,
    fontSize: 13,
    color: Colors.mutedForeground,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.border,
    marginVertical: 10,
  },
  menuSection: {
    gap: 8,
  },
  sectionLabel: {
    fontFamily: Fonts.sansBold,
    fontSize: 10,
    letterSpacing: 2,
    color: Colors.mutedForeground,
    marginTop: 16,
    marginBottom: 4,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    padding: 16,
  },
  menuLabel: {
    flex: 1,
    fontFamily: Fonts.sansSemiBold,
    fontSize: 14,
    color: Colors.foreground,
  },
  actionsSpacer: {
    height: 40,
  },
  actionsSection: {
    gap: 12,
  },
  secondaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    paddingVertical: 16,
  },
  secondaryButtonText: {
    fontFamily: Fonts.sansBold,
    fontSize: 14,
    color: Colors.foreground,
  },
  deleteButtonText: {
    fontFamily: Fonts.sansBold,
    fontSize: 14,
    color: Colors.mutedForeground,
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
  emptyState: {
    alignItems: 'center',
    gap: 8,
    paddingVertical: 32,
  },
  emptyText: {
    fontFamily: Fonts.sans,
    fontSize: 13,
    color: Colors.mutedForeground,
  },
  cacheIndicator: {
    fontFamily: Fonts.sans,
    fontSize: 11,
    color: Colors.mutedForeground,
    textAlign: 'center',
    fontStyle: 'italic',
    marginBottom: 8,
  },
  contactDescription: {
    fontFamily: Fonts.sans,
    fontSize: 14,
    color: Colors.foreground,
    lineHeight: 22,
    marginBottom: 20,
  },
  contactEmailCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    padding: 16,
  },
  contactEmail: {
    flex: 1,
    fontFamily: Fonts.sansSemiBold,
    fontSize: 14,
    color: Colors.foreground,
  },
  contactButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.primary,
    borderRadius: 16,
    paddingVertical: 16,
    marginTop: 12,
  },
  contactButtonText: {
    fontFamily: Fonts.sansBold,
    fontSize: 14,
    color: Colors.primaryForeground,
  },
  runDetailDate: {
    fontFamily: Fonts.sans,
    fontSize: 13,
    color: Colors.mutedForeground,
    marginBottom: 12,
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
  splitsTitle: {
    fontFamily: Fonts.sansBold,
    fontSize: 14,
    color: Colors.foreground,
    marginTop: 16,
    marginBottom: 8,
  },
  splitsTable: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    overflow: 'hidden',
  },
  splitsHeader: {
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
  splitRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  splitKm: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 13,
    color: Colors.foreground,
  },
  splitPace: {
    fontFamily: Fonts.sansMedium,
    fontSize: 13,
    color: Colors.mutedForeground,
  },
});
