import React from 'react';
import { View, Text, Pressable, StyleSheet, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { RouteMap } from '@/components/RouteMap';
import { useAppContext } from '@/lib/AppContext';
import { generateRoutes } from '@/lib/route-generator';
import type { FavoriteRoute } from '@/components/ProfileDrawer';
import { Colors, Fonts } from '@/lib/theme';

interface FavoritePreviewProps {
  favorite: FavoriteRoute;
  onClose: () => void;
}

function mapTerrain(terrain: string): 'loop' | 'out-and-back' | 'any' {
  if (terrain === 'Loop') return 'loop';
  if (terrain === 'Out & Back') return 'out-and-back';
  return 'out-and-back';
}

export function FavoritePreview({ favorite, onClose }: FavoritePreviewProps) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const ctx = useAppContext();

  const center = { lat: favorite.lat, lng: favorite.lng };
  const routeType = mapTerrain(favorite.terrain);

  // Generate a preview route from the favorite data
  const previewRoutes = generateRoutes(
    center,
    favorite.distance,
    routeType,
    1,
    ctx.prefs,
  );
  const previewRoute = previewRoutes[0] ?? null;

  const handleNavigateToStart = () => {
    Linking.openURL(
      `https://www.google.com/maps/dir/?api=1&destination=${favorite.lat},${favorite.lng}&travelmode=walking`
    );
  };

  const handleStartFromHere = () => {
    // Generate route from user's current location
    const currentRouteType = mapTerrain(favorite.terrain);
    const routes = generateRoutes(
      ctx.center,
      favorite.distance,
      currentRouteType,
      1,
      ctx.prefs,
    );
    ctx.setRoutes(routes);
    ctx.setSelectedRoute(routes[0] || null);
    onClose();
    router.push('/run');
  };

  return (
    <View style={styles.container}>
      {/* Full-screen map */}
      <View style={StyleSheet.absoluteFill}>
        <RouteMap
          center={center}
          routes={previewRoute ? [previewRoute] : []}
          selectedRouteId={previewRoute?.id ?? null}
        />
      </View>

      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={onClose} style={styles.headerBtn}>
          <Ionicons name="chevron-back" size={16} color={Colors.mutedForeground} />
          <Text style={styles.headerBtnText}>Back</Text>
        </Pressable>
      </View>

      {/* Bottom panel */}
      <View style={[styles.bottomPanel, { paddingBottom: Math.max(insets.bottom, 20) + 12 }]}>
        <View style={styles.grabHandle} />

        {/* Route info */}
        <Text style={styles.routeName}>{favorite.routeName}</Text>
        <View style={styles.routeMeta}>
          <View style={styles.metaItem}>
            <Ionicons name="navigate-outline" size={14} color={Colors.mutedForeground} />
            <Text style={styles.metaText}>{favorite.distance} km</Text>
          </View>
          <View style={styles.metaItem}>
            <Ionicons name="map-outline" size={14} color={Colors.mutedForeground} />
            <Text style={styles.metaText}>{favorite.terrain}</Text>
          </View>
        </View>

        {/* Action buttons */}
        <View style={styles.actions}>
          <Pressable
            onPress={handleNavigateToStart}
            style={({ pressed }) => [
              styles.secondaryBtn,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Ionicons name="navigate" size={18} color={Colors.primary} />
            <Text style={styles.secondaryBtnText}>Navigate to Start</Text>
          </Pressable>

          <Pressable
            onPress={handleStartFromHere}
            style={({ pressed }) => [
              styles.primaryBtn,
              pressed && { transform: [{ scale: 0.98 }] },
            ]}
          >
            <Ionicons name="play" size={18} color={Colors.primaryForeground} />
            <Text style={styles.primaryBtnText}>Start from Here</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 900,
    backgroundColor: Colors.background,
  },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 30,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  headerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.card + '99',
    borderRadius: 9999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  headerBtnText: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 12,
    color: Colors.mutedForeground,
  },
  bottomPanel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 20,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderTopColor: Colors.border + '4D',
    backgroundColor: Colors.card,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  grabHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.mutedForeground + '4D',
    marginBottom: 16,
  },
  routeName: {
    fontFamily: Fonts.sansBold,
    fontSize: 20,
    color: Colors.foreground,
    marginBottom: 8,
  },
  routeMeta: {
    flexDirection: 'row',
    gap: 16,
    marginBottom: 20,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  metaText: {
    fontFamily: Fonts.sansMedium,
    fontSize: 13,
    color: Colors.mutedForeground,
  },
  actions: {
    gap: 10,
  },
  secondaryBtn: {
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
  secondaryBtnText: {
    fontFamily: Fonts.sansBold,
    fontSize: 14,
    color: Colors.foreground,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 16,
    backgroundColor: Colors.primary,
    paddingVertical: 14,
  },
  primaryBtnText: {
    fontFamily: Fonts.sansBold,
    fontSize: 14,
    color: Colors.primaryForeground,
  },
});
