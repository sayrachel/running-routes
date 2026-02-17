import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, Alert, Image, Dimensions, ActionSheetIOS, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { useAppContext, type FavoriteRoute } from '@/lib/AppContext';
export type { FavoriteRoute };
import { Colors, Fonts } from '@/lib/theme';

type DrawerView = 'profile' | 'history' | 'favorites' | 'run-detail';

const SCREEN_WIDTH = Dimensions.get('window').width;

const MOCK_HISTORY = [
  { id: '1', routeName: 'Morning Loop', distance: 5.2, time: 32, date: 'Feb 15, 2026', elevation: 48, calories: 345 },
  { id: '2', routeName: 'River Trail', distance: 8.4, time: 54, date: 'Feb 13, 2026', elevation: 22, calories: 580 },
  { id: '3', routeName: 'Hill Climb', distance: 6.1, time: 42, date: 'Feb 10, 2026', elevation: 134, calories: 460 },
  { id: '4', routeName: 'Park Circuit', distance: 3.8, time: 22, date: 'Feb 8, 2026', elevation: 12, calories: 230 },
];

type HistoryRun = typeof MOCK_HISTORY[0];

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
  const insets = useSafeAreaInsets();
  const ctx = useAppContext();
  const translateX = useSharedValue(SCREEN_WIDTH);
  const [mounted, setMounted] = useState(false);
  const [deleteLabel, setDeleteLabel] = useState('Delete Account');
  const [view, setView] = useState<DrawerView>('profile');
  const [selectedRun, setSelectedRun] = useState<HistoryRun | null>(null);
  const [profileImage, setProfileImage] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setDeleteLabel('Delete Account');
      setView('profile');
      setSelectedRun(null);
      translateX.value = withTiming(0, { duration: 300 });
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
    } else if (view !== 'profile') {
      setView('profile');
    } else {
      onClose();
    }
  };

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
    ctx.removeFavorite(id);
  };

  const handlePreviewFavorite = (route: FavoriteRoute) => {
    onClose();
    onPreviewFavorite?.(route);
  };

  const [showPhotoMenu, setShowPhotoMenu] = useState(false);

  const handleAvatarPress = () => {
    if (Platform.OS === 'ios') {
      const hasPhoto = !!profileImage;
      const options = hasPhoto
        ? ['Choose Existing', 'Take Picture', 'Delete Picture', 'Cancel']
        : ['Choose Existing', 'Take Picture', 'Cancel'];
      const cancelIndex = options.length - 1;
      const destructiveIndex = hasPhoto ? 2 : undefined;

      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: cancelIndex, destructiveButtonIndex: destructiveIndex },
        (index) => {
          if (index === 0) pickFromLibrary();
          else if (index === 1) takePhoto();
          else if (hasPhoto && index === 2) setProfileImage(null);
        },
      );
    } else if (Platform.OS === 'android') {
      const hasPhoto = !!profileImage;
      const buttons: { text: string; onPress?: () => void; style?: 'destructive' | 'cancel' }[] = [
        { text: 'Choose Existing', onPress: pickFromLibrary },
        { text: 'Take Picture', onPress: takePhoto },
      ];
      if (hasPhoto) {
        buttons.push({ text: 'Delete Picture', style: 'destructive', onPress: () => setProfileImage(null) });
      }
      buttons.push({ text: 'Cancel', style: 'cancel' });
      Alert.alert('Profile Photo', undefined, buttons);
    } else {
      setShowPhotoMenu(true);
    }
  };

  const pickFromLibrary = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow access to your photo library.');
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

  const takePhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Please allow access to your camera.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) {
      setProfileImage(result.assets[0].uri);
    }
  };

  if (!mounted) return null;

  const viewTitle = view === 'history' ? 'History' : view === 'favorites' ? 'Favorites' : view === 'run-detail' && selectedRun ? selectedRun.routeName : 'Settings';

  const renderRunDetail = () => {
    if (!selectedRun) return null;
    const pace = (selectedRun.time / selectedRun.distance).toFixed(1);
    const splits = generateSplits(selectedRun.distance, selectedRun.time);

    return (
      <ScrollView
        style={styles.scrollContent}
        contentContainerStyle={styles.scrollContentInner}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.runDetailDate}>{selectedRun.date}</Text>

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
              <Pressable onPress={handleAvatarPress}>
                <View style={styles.avatar}>
                  {profileImage ? (
                    <Image source={{ uri: profileImage }} style={styles.avatarImage} />
                  ) : (
                    <Ionicons name="person" size={40} color={Colors.primary} />
                  )}
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

            <View style={styles.actionsSpacer} />

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
          </ScrollView>
        ) : view === 'run-detail' ? (
          renderRunDetail()
        ) : (
          <ScrollView
            style={styles.scrollContent}
            contentContainerStyle={styles.scrollContentInner}
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
        )}
      </View>

      {/* Web action sheet for profile photo */}
      {showPhotoMenu && (
        <>
          <Pressable style={styles.photoMenuBackdrop} onPress={() => setShowPhotoMenu(false)} />
          <View style={styles.photoMenuContainer}>
            <View style={styles.photoMenuGroup}>
              <Pressable
                style={styles.photoMenuItem}
                onPress={() => { setShowPhotoMenu(false); pickFromLibrary(); }}
              >
                <Ionicons name="images-outline" size={20} color={Colors.foreground} />
                <Text style={styles.photoMenuText}>Choose Existing</Text>
              </Pressable>
              <View style={styles.photoMenuDivider} />
              <Pressable
                style={styles.photoMenuItem}
                onPress={() => { setShowPhotoMenu(false); takePhoto(); }}
              >
                <Ionicons name="camera-outline" size={20} color={Colors.foreground} />
                <Text style={styles.photoMenuText}>Take Picture</Text>
              </Pressable>
              {profileImage && (
                <>
                  <View style={styles.photoMenuDivider} />
                  <Pressable
                    style={styles.photoMenuItem}
                    onPress={() => { setShowPhotoMenu(false); setProfileImage(null); }}
                  >
                    <Ionicons name="trash-outline" size={20} color={Colors.destructive} />
                    <Text style={[styles.photoMenuText, { color: Colors.destructive }]}>Delete Picture</Text>
                  </Pressable>
                </>
              )}
            </View>
            <Pressable
              style={styles.photoMenuCancel}
              onPress={() => setShowPhotoMenu(false)}
            >
              <Text style={styles.photoMenuCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </>
      )}
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
  photoMenuBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    zIndex: 2000,
  },
  photoMenuContainer: {
    position: 'absolute',
    bottom: 40,
    left: 16,
    right: 16,
    zIndex: 2001,
    gap: 8,
  },
  photoMenuGroup: {
    backgroundColor: Colors.card,
    borderRadius: 14,
    overflow: 'hidden',
  },
  photoMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 16,
    paddingHorizontal: 20,
  },
  photoMenuText: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 16,
    color: Colors.foreground,
  },
  photoMenuDivider: {
    height: 1,
    backgroundColor: Colors.border,
    marginHorizontal: 16,
  },
  photoMenuCancel: {
    backgroundColor: Colors.card,
    borderRadius: 14,
    alignItems: 'center',
    paddingVertical: 16,
  },
  photoMenuCancelText: {
    fontFamily: Fonts.sansBold,
    fontSize: 16,
    color: Colors.mutedForeground,
  },
});
