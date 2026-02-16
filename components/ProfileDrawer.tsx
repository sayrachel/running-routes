import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, Alert, Image } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
export type { FavoriteRoute };
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { useAppContext } from '@/lib/AppContext';
import { Colors, Fonts } from '@/lib/theme';

type DrawerView = 'profile' | 'history' | 'favorites' | 'run-detail';

const MOCK_HISTORY = [
  { id: '1', routeName: 'Morning Loop', distance: 5.2, time: 32, date: 'Feb 15, 2026', elevation: 48, calories: 345 },
  { id: '2', routeName: 'River Trail', distance: 8.4, time: 54, date: 'Feb 13, 2026', elevation: 22, calories: 580 },
  { id: '3', routeName: 'Hill Climb', distance: 6.1, time: 42, date: 'Feb 10, 2026', elevation: 134, calories: 460 },
  { id: '4', routeName: 'Park Circuit', distance: 3.8, time: 22, date: 'Feb 8, 2026', elevation: 12, calories: 230 },
];

type HistoryRun = typeof MOCK_HISTORY[0];

const INITIAL_FAVORITES = [
  { id: '1', routeName: 'Lakeside Loop', distance: 7.5, terrain: 'Loop' as const, lat: 40.7580, lng: -73.9855 },
  { id: '2', routeName: 'Forest Path', distance: 5.0, terrain: 'Out & Back' as const, lat: 40.7829, lng: -73.9654 },
  { id: '3', routeName: 'City Circuit', distance: 10.2, terrain: 'Loop' as const, lat: 40.7484, lng: -73.9857 },
];

type FavoriteRoute = typeof INITIAL_FAVORITES[0];

function generateSplits(distance: number, time: number) {
  const fullKms = Math.floor(distance);
  const avgPace = time / distance;
  const splits: { km: number; pace: string }[] = [];
  for (let i = 1; i <= fullKms; i++) {
    const variation = (Math.random() - 0.5) * 0.6;
    const pace = avgPace + variation;
    splits.push({ km: i, pace: pace.toFixed(1) });
  }
  const remaining = distance - fullKms;
  if (remaining > 0.1) {
    const variation = (Math.random() - 0.5) * 0.6;
    const pace = avgPace + variation;
    splits.push({ km: parseFloat(distance.toFixed(1)), pace: pace.toFixed(1) });
  }
  return splits;
}

interface ProfileDrawerProps {
  visible: boolean;
  onClose: () => void;
  onPreviewFavorite?: (favorite: FavoriteRoute) => void;
}

export function ProfileDrawer({ visible, onClose, onPreviewFavorite }: ProfileDrawerProps) {
  const router = useRouter();
  const ctx = useAppContext();
  const translateX = useSharedValue(400);
  const [mounted, setMounted] = useState(false);
  const [deleteLabel, setDeleteLabel] = useState('Delete Account');
  const [view, setView] = useState<DrawerView>('profile');
  const [selectedRun, setSelectedRun] = useState<HistoryRun | null>(null);
  const [favorites, setFavorites] = useState(INITIAL_FAVORITES);
  const [profileImage, setProfileImage] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setDeleteLabel('Delete Account');
      setView('profile');
      setSelectedRun(null);
      translateX.value = withTiming(0, { duration: 300 });
    } else {
      translateX.value = withTiming(400, { duration: 300 }, (finished) => {
        if (finished) {
          runOnJS(setMounted)(false);
        }
      });
    }
  }, [visible]);

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const handleLogout = () => {
    ctx.setIsLoggedIn(false);
    ctx.setUser(null);
    onClose();
    router.replace('/landing');
  };

  const handleDelete = () => {
    if (deleteLabel === 'Delete Account') {
      setDeleteLabel('Tap again to confirm');
      return;
    }
    ctx.setIsLoggedIn(false);
    ctx.setUser(null);
    onClose();
    router.replace('/landing');
  };

  const handleRemoveFavorite = (id: string) => {
    setFavorites((prev) => prev.filter((f) => f.id !== id));
  };

  const handlePreviewFavorite = (route: FavoriteRoute) => {
    onClose();
    onPreviewFavorite?.(route);
  };

  const handleAvatarPress = () => {
    if (profileImage) {
      Alert.alert('Profile Photo', 'What would you like to do?', [
        { text: 'Upload New Photo', onPress: pickImage },
        { text: 'Remove Photo', style: 'destructive', onPress: () => setProfileImage(null) },
        { text: 'Cancel', style: 'cancel' },
      ]);
    } else {
      pickImage();
    }
  };

  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow access to your photo library to upload a profile picture.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) {
      setProfileImage(result.assets[0].uri);
    }
  };

  if (!mounted) return null;

  const renderRunDetail = () => {
    if (!selectedRun) return null;
    const pace = (selectedRun.time / selectedRun.distance).toFixed(1);
    const splits = generateSplits(selectedRun.distance, selectedRun.time);

    return (
      <>
        <Pressable style={styles.backRow} onPress={() => { setView('history'); setSelectedRun(null); }}>
          <Ionicons name="chevron-back" size={16} color={Colors.mutedForeground} />
          <Text style={styles.backText}>History</Text>
        </Pressable>

        <Text style={styles.subViewTitle}>{selectedRun.routeName}</Text>
        <Text style={styles.runDetailDate}>{selectedRun.date}</Text>

        <ScrollView
          style={styles.subViewScroll}
          contentContainerStyle={styles.subViewContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Stats grid */}
          <View style={styles.statsGrid}>
            <View style={styles.statCell}>
              <Text style={styles.statCellValue}>{selectedRun.distance}</Text>
              <Text style={styles.statCellLabel}>km</Text>
            </View>
            <View style={styles.statCell}>
              <Text style={styles.statCellValue}>{selectedRun.time}</Text>
              <Text style={styles.statCellLabel}>min</Text>
            </View>
            <View style={styles.statCell}>
              <Text style={styles.statCellValue}>{pace}</Text>
              <Text style={styles.statCellLabel}>min/km</Text>
            </View>
            <View style={styles.statCell}>
              <Text style={styles.statCellValue}>{selectedRun.elevation}</Text>
              <Text style={styles.statCellLabel}>m elev</Text>
            </View>
            <View style={styles.statCell}>
              <Text style={styles.statCellValue}>{selectedRun.calories}</Text>
              <Text style={styles.statCellLabel}>cal</Text>
            </View>
          </View>

          {/* Splits */}
          <Text style={styles.splitsTitle}>Splits</Text>
          <View style={styles.splitsTable}>
            <View style={styles.splitsHeader}>
              <Text style={styles.splitsHeaderText}>KM</Text>
              <Text style={styles.splitsHeaderText}>PACE</Text>
            </View>
            {splits.map((split) => (
              <View key={split.km} style={styles.splitRow}>
                <Text style={styles.splitKm}>{split.km}</Text>
                <Text style={styles.splitPace}>{split.pace} min/km</Text>
              </View>
            ))}
          </View>
        </ScrollView>
      </>
    );
  };

  return (
    <>
      <Pressable style={styles.backdrop} onPress={onClose} />

      <Animated.View style={[styles.drawer, drawerStyle]}>
        {/* Close button */}
        <Pressable onPress={onClose} style={styles.closeBtn}>
          <Ionicons name="close" size={24} color={Colors.mutedForeground} />
        </Pressable>

        {view === 'profile' ? (
          <>
            {/* Profile */}
            <View style={styles.profileSection}>
              <Pressable onPress={handleAvatarPress}>
                <View style={styles.avatar}>
                  {profileImage ? (
                    <Image source={{ uri: profileImage }} style={styles.avatarImage} />
                  ) : (
                    <Ionicons name="person" size={40} color={Colors.primary} />
                  )}
                  <View style={styles.avatarBadge}>
                    <Ionicons name="camera" size={12} color={Colors.foreground} />
                  </View>
                </View>
              </Pressable>
              <Text style={styles.userName}>{ctx.user?.name ?? 'User'}</Text>
              <Text style={styles.userEmail}>{ctx.user?.email ?? ''}</Text>
            </View>

            <View style={styles.divider} />

            {/* Menu */}
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

            <View style={{ flex: 1 }} />

            {/* Actions */}
            <View style={styles.actionsSection}>
              <Pressable
                onPress={handleLogout}
                style={({ pressed }) => [
                  styles.secondaryButton,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={styles.secondaryButtonText}>Log Out</Text>
              </Pressable>

              <Pressable
                onPress={handleDelete}
                style={({ pressed }) => [
                  styles.secondaryButton,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={styles.deleteButtonText}>{deleteLabel}</Text>
              </Pressable>
            </View>
          </>
        ) : view === 'run-detail' ? (
          renderRunDetail()
        ) : (
          <>
            {/* Sub-view header */}
            <Pressable style={styles.backRow} onPress={() => setView('profile')}>
              <Ionicons name="chevron-back" size={16} color={Colors.mutedForeground} />
              <Text style={styles.backText}>Profile</Text>
            </Pressable>

            <Text style={styles.subViewTitle}>
              {view === 'history' ? 'History' : 'Favorites'}
            </Text>

            <ScrollView
              style={styles.subViewScroll}
              contentContainerStyle={styles.subViewContent}
              showsVerticalScrollIndicator={false}
            >
              {view === 'history' &&
                MOCK_HISTORY.map((run) => {
                  const pace = (run.time / run.distance).toFixed(1);
                  return (
                    <Pressable
                      key={run.id}
                      style={styles.card}
                      onPress={() => { setSelectedRun(run); setView('run-detail'); }}
                    >
                      <Text style={styles.cardTitle}>{run.routeName}</Text>
                      <Text style={styles.cardSubtitle}>{run.date}</Text>
                      <View style={styles.statsRow}>
                        <View style={styles.stat}>
                          <Ionicons name="navigate-outline" size={12} color={Colors.mutedForeground} />
                          <Text style={styles.statText}>{run.distance} km</Text>
                        </View>
                        <View style={styles.stat}>
                          <Ionicons name="time-outline" size={12} color={Colors.mutedForeground} />
                          <Text style={styles.statText}>{run.time} min</Text>
                        </View>
                        <View style={styles.stat}>
                          <Ionicons name="speedometer-outline" size={12} color={Colors.mutedForeground} />
                          <Text style={styles.statText}>{pace} min/km</Text>
                        </View>
                      </View>
                    </Pressable>
                  );
                })}

              {view === 'favorites' &&
                (favorites.length === 0 ? (
                  <View style={styles.emptyState}>
                    <Ionicons name="heart-outline" size={32} color={Colors.mutedForeground} />
                    <Text style={styles.emptyText}>No favorites yet</Text>
                  </View>
                ) : (
                  favorites.map((route) => (
                    <View key={route.id} style={styles.card}>
                      <View style={styles.favRow}>
                        <Pressable style={{ flex: 1 }} onPress={() => handlePreviewFavorite(route)}>
                          <Text style={styles.cardTitle}>{route.routeName}</Text>
                          <View style={styles.statsRow}>
                            <View style={styles.stat}>
                              <Ionicons name="navigate-outline" size={12} color={Colors.mutedForeground} />
                              <Text style={styles.statText}>{route.distance} km</Text>
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
          </>
        )}
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.background + 'CC',
    zIndex: 999,
  },
  drawer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: 300,
    backgroundColor: Colors.card,
    borderLeftWidth: 1,
    borderLeftColor: Colors.border,
    zIndex: 1000,
    paddingTop: 60,
    paddingHorizontal: 20,
    paddingBottom: 40,
  },
  closeBtn: {
    position: 'absolute',
    top: 54,
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileSection: {
    alignItems: 'center',
    marginTop: 16,
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
  avatarBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: Colors.muted,
    borderWidth: 2,
    borderColor: Colors.card,
    alignItems: 'center',
    justifyContent: 'center',
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
    marginVertical: 20,
  },
  menuSection: {
    gap: 8,
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
  // Sub-view styles
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 8,
    marginBottom: 12,
  },
  backText: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 13,
    color: Colors.mutedForeground,
  },
  subViewTitle: {
    fontFamily: Fonts.sansBold,
    fontSize: 18,
    color: Colors.foreground,
    marginBottom: 16,
  },
  subViewScroll: {
    flex: 1,
  },
  subViewContent: {
    gap: 10,
    paddingBottom: 20,
  },
  card: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.background,
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
  // Run-detail styles
  runDetailDate: {
    fontFamily: Fonts.sans,
    fontSize: 13,
    color: Colors.mutedForeground,
    marginTop: -12,
    marginBottom: 16,
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
    backgroundColor: Colors.background,
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
    backgroundColor: Colors.background,
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
