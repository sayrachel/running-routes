import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import { RouteMap } from '@/components/RouteMap';
import { GpsSignal } from '@/components/GpsSignal';
import { ProfileDrawer } from '@/components/ProfileDrawer';
import type { FavoriteRoute } from '@/components/ProfileDrawer';
import { FavoritePreview } from '@/components/FavoritePreview';
import { useAppContext, type RouteStyle, type RunPreferences } from '@/lib/AppContext';
import { generateRoutes } from '@/lib/route-generator';
import { Colors, Fonts } from '@/lib/theme';

const ROUTE_STYLES: { value: RouteStyle; label: string; desc: string }[] = [
  { value: 'loop', label: 'Loop', desc: 'Start and finish at the same spot' },
  { value: 'point-to-point', label: 'Point to Point', desc: 'Run from A to B in one direction' },
  { value: 'out-and-back', label: 'Out & Back', desc: 'Run out, then retrace your steps' },
];

function mapRouteType(style: RouteStyle): 'loop' | 'out-and-back' | 'any' {
  if (style === 'loop') return 'loop';
  if (style === 'out-and-back') return 'out-and-back';
  return 'out-and-back';
}

export default function SetupScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const ctx = useAppContext();

  const [localRouteStyle, setLocalRouteStyle] = useState<RouteStyle>(ctx.routeStyle);
  const [localPrefs, setLocalPrefs] = useState<RunPreferences>(ctx.prefs);
  const [hasEndLocation, setHasEndLocation] = useState(false);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [previewFavorite, setPreviewFavorite] = useState<FavoriteRoute | null>(null);
  const [showAddressInput, setShowAddressInput] = useState(false);
  const [addressText, setAddressText] = useState('');
  const [isGeocoding, setIsGeocoding] = useState(false);
  const [showEndAddressInput, setShowEndAddressInput] = useState(false);
  const [endAddressText, setEndAddressText] = useState('');
  const [isEndGeocoding, setIsEndGeocoding] = useState(false);

  // Auth redirect
  useEffect(() => {
    if (!ctx.isLoggedIn) {
      router.replace('/landing');
    }
  }, [ctx.isLoggedIn]);

  // GPS simulation
  useEffect(() => {
    const timers = [
      setTimeout(() => ctx.setGpsStrength(1), 800),
      setTimeout(() => ctx.setGpsStrength(2), 1600),
      setTimeout(() => ctx.setGpsStrength(3), 2400),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  // Auto-locate on mount
  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        try {
          const loc = await Location.getCurrentPositionAsync({});
          ctx.setCenter({ lat: loc.coords.latitude, lng: loc.coords.longitude });
          ctx.setHasLocation(true);
        } catch {
          ctx.setHasLocation(true); // use default
        }
      } else {
        ctx.setHasLocation(true); // use default
      }
    })();
  }, []);

  const handleLocateMe = useCallback(async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status === 'granted') {
      try {
        const loc = await Location.getCurrentPositionAsync({});
        ctx.setCenter({ lat: loc.coords.latitude, lng: loc.coords.longitude });
        ctx.setHasLocation(true);
      } catch {
        // keep existing
      }
    }
  }, [ctx]);

  const handleLocationCardPress = useCallback(() => {
    if (ctx.hasLocation) {
      setAddressText('');
      setShowAddressInput(true);
    } else {
      handleLocateMe();
    }
  }, [ctx.hasLocation, handleLocateMe]);

  const handleAddressSubmit = useCallback(async () => {
    if (!addressText.trim()) return;
    setIsGeocoding(true);
    try {
      const results = await Location.geocodeAsync(addressText.trim());
      if (results.length > 0) {
        ctx.setCenter({ lat: results[0].latitude, lng: results[0].longitude });
        ctx.setHasLocation(true);
        setShowAddressInput(false);
        setAddressText('');
        Keyboard.dismiss();
      }
    } catch {
      // keep existing location
    } finally {
      setIsGeocoding(false);
    }
  }, [addressText, ctx]);

  const handleSetEndLocation = useCallback(async () => {
    if (localRouteStyle !== 'point-to-point') {
      setLocalRouteStyle('point-to-point');
    }
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status === 'granted') {
      try {
        const loc = await Location.getCurrentPositionAsync({});
        ctx.setEndLocation({
          lat: loc.coords.latitude + 0.02,
          lng: loc.coords.longitude + 0.015,
        });
        setHasEndLocation(true);
      } catch {
        ctx.setEndLocation({
          lat: ctx.center.lat + 0.02,
          lng: ctx.center.lng + 0.015,
        });
        setHasEndLocation(true);
      }
    } else {
      ctx.setEndLocation({
        lat: ctx.center.lat + 0.02,
        lng: ctx.center.lng + 0.015,
      });
      setHasEndLocation(true);
    }
  }, [localRouteStyle, ctx]);

  const handleEndLocationCardPress = useCallback(() => {
    setEndAddressText('');
    setShowEndAddressInput(true);
    if (localRouteStyle !== 'point-to-point') {
      setLocalRouteStyle('point-to-point');
    }
  }, [localRouteStyle]);

  const handleEndAddressSubmit = useCallback(async () => {
    if (!endAddressText.trim()) return;
    setIsEndGeocoding(true);
    try {
      const results = await Location.geocodeAsync(endAddressText.trim());
      if (results.length > 0) {
        if (localRouteStyle !== 'point-to-point') {
          setLocalRouteStyle('point-to-point');
        }
        ctx.setEndLocation({ lat: results[0].latitude, lng: results[0].longitude });
        setHasEndLocation(true);
        setShowEndAddressInput(false);
        setEndAddressText('');
        Keyboard.dismiss();
      }
    } catch {
      // keep existing
    } finally {
      setIsEndGeocoding(false);
    }
  }, [endAddressText, ctx, localRouteStyle]);

  const handleClearEndLocation = useCallback(() => {
    ctx.setEndLocation(null);
    setHasEndLocation(false);
  }, [ctx]);

  const togglePref = (key: 'scenic' | 'lowTraffic') => {
    setLocalPrefs((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleElevation = () => {
    setLocalPrefs((prev) => ({
      ...prev,
      elevation: prev.elevation === 'flat' ? 'hilly' : 'flat',
    }));
  };

  const handleGenerate = useCallback(() => {
    ctx.setRouteStyle(localRouteStyle);
    ctx.setPrefs(localPrefs);
    ctx.setIsGenerating(true);

    const end =
      localRouteStyle === 'point-to-point' && hasEndLocation
        ? ctx.endLocation
        : null;

    setTimeout(() => {
      const newRoutes = generateRoutes(
        ctx.center,
        ctx.distance,
        mapRouteType(localRouteStyle),
        1,
        localPrefs,
        end
      );
      ctx.setRoutes(newRoutes);
      ctx.setSelectedRoute(newRoutes[0] || null);
      ctx.setIsGenerating(false);
      router.push('/run');
    }, 700);
  }, [ctx, localRouteStyle, localPrefs, hasEndLocation, router]);

  const canGenerate = ctx.hasLocation && ctx.gpsStrength >= 1 && !ctx.isGenerating;

  return (
    <View style={styles.container}>
      {/* Map area */}
      <View style={styles.mapContainer}>
        <RouteMap
          center={ctx.center}
          routes={[]}
          selectedRouteId={null}
        />
      </View>

      {/* Header overlay — absolute over map */}
      <View style={[styles.headerOverlay, { paddingTop: insets.top + 8 }]}>
        <View />
        <View style={styles.headerRight}>
          <View style={styles.gpsChip}>
            <GpsSignal strength={ctx.gpsStrength} />
          </View>
          <Pressable onPress={() => setDrawerVisible(true)} style={styles.settingsBtn}>
            <Ionicons name="settings-outline" size={18} color={Colors.mutedForeground} />
          </Pressable>
        </View>
      </View>

      {/* Bottom panel */}
      <View style={styles.bottomPanel}>
        {/* Grab handle */}
        <View style={styles.grabHandle} />

        {/* Controls */}
        <View style={styles.bottomContent}>
          {/* Starting Location */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>STARTING LOCATION</Text>
            <Pressable
              onPress={handleLocationCardPress}
              style={[
                styles.locationCard,
                ctx.hasLocation ? styles.locationCardActive : styles.locationCardDefault,
              ]}
            >
              <View
                style={[
                  styles.locationIcon,
                  ctx.hasLocation ? styles.locationIconActive : styles.locationIconDefault,
                ]}
              >
                {ctx.hasLocation ? (
                  <Ionicons name="location" size={20} color={Colors.primary} />
                ) : (
                  <Ionicons name="navigate" size={20} color={Colors.mutedForeground} />
                )}
              </View>
              <View style={styles.locationText}>
                {showAddressInput ? (
                  <TextInput
                    style={styles.inlineAddressInput}
                    placeholder="Enter an address..."
                    placeholderTextColor={Colors.mutedForeground}
                    value={addressText}
                    onChangeText={setAddressText}
                    onSubmitEditing={handleAddressSubmit}
                    onBlur={() => { if (!addressText.trim()) setShowAddressInput(false); }}
                    returnKeyType="search"
                    autoFocus
                  />
                ) : ctx.hasLocation ? (
                  <>
                    <Text style={styles.locationTitle}>Location set</Text>
                    <Text style={styles.locationCoords}>
                      {ctx.center.lat.toFixed(4)}, {ctx.center.lng.toFixed(4)}
                    </Text>
                  </>
                ) : (
                  <>
                    <Text style={styles.locationTitle}>Use Current Location</Text>
                    <Text style={styles.locationCoords}>Tap to detect via GPS</Text>
                  </>
                )}
              </View>
              {showAddressInput ? (
                isGeocoding ? (
                  <ActivityIndicator size="small" color={Colors.primary} />
                ) : (
                  <Pressable onPress={handleAddressSubmit}>
                    <Ionicons name="arrow-forward-circle" size={22} color={Colors.primary} />
                  </Pressable>
                )
              ) : ctx.hasLocation ? (
                <Text style={styles.changeLabel}>Change</Text>
              ) : null}
            </Pressable>

            {/* End Location — always visible, dimmed unless point-to-point */}
            <View style={styles.endLocationConnector} />
            <Pressable
              onPress={handleEndLocationCardPress}
              style={[
                styles.locationCard,
                hasEndLocation && localRouteStyle === 'point-to-point'
                  ? styles.locationCardActive
                  : styles.locationCardDashed,
                localRouteStyle !== 'point-to-point' && styles.locationCardDimmed,
              ]}
            >
              <View
                style={[
                  styles.locationIcon,
                  hasEndLocation && localRouteStyle === 'point-to-point'
                    ? styles.locationIconActive
                    : styles.locationIconDefault,
                ]}
              >
                <Ionicons
                  name="location"
                  size={20}
                  color={
                    hasEndLocation && localRouteStyle === 'point-to-point'
                      ? Colors.primary
                      : Colors.mutedForeground
                  }
                />
              </View>
              <View style={styles.locationText}>
                {showEndAddressInput ? (
                  <TextInput
                    style={styles.inlineAddressInput}
                    placeholder="Enter destination address..."
                    placeholderTextColor={Colors.mutedForeground}
                    value={endAddressText}
                    onChangeText={setEndAddressText}
                    onSubmitEditing={handleEndAddressSubmit}
                    onBlur={() => { if (!endAddressText.trim()) setShowEndAddressInput(false); }}
                    returnKeyType="search"
                    autoFocus
                  />
                ) : hasEndLocation && ctx.endLocation ? (
                  <>
                    <Text style={[styles.locationTitle, localRouteStyle !== 'point-to-point' && styles.locationTitleDimmed]}>Destination set</Text>
                    <Text style={styles.locationCoords}>
                      {ctx.endLocation.lat.toFixed(4)}, {ctx.endLocation.lng.toFixed(4)}
                    </Text>
                  </>
                ) : (
                  <>
                    <Text style={[styles.locationTitle, localRouteStyle !== 'point-to-point' && styles.locationTitleDimmed]}>End Location</Text>
                    <Text style={styles.locationCoords}>
                      Tap to set destination
                    </Text>
                  </>
                )}
              </View>
              {showEndAddressInput ? (
                isEndGeocoding ? (
                  <ActivityIndicator size="small" color={Colors.primary} />
                ) : (
                  <Pressable onPress={handleEndAddressSubmit}>
                    <Ionicons name="arrow-forward-circle" size={22} color={Colors.primary} />
                  </Pressable>
                )
              ) : hasEndLocation && localRouteStyle === 'point-to-point' ? (
                <Pressable onPress={(e) => { e.stopPropagation(); handleClearEndLocation(); }} hitSlop={8}>
                  <Text style={styles.clearLabel}>Clear</Text>
                </Pressable>
              ) : (
                <Ionicons name="arrow-forward" size={16} color={Colors.mutedForeground} />
              )}
            </Pressable>
          </View>

          {/* Route Type */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>ROUTE TYPE</Text>
            <View style={styles.routeTypeRow}>
              {ROUTE_STYLES.map((style) => (
                <Pressable
                  key={style.value}
                  onPress={() => setLocalRouteStyle(style.value)}
                  style={[
                    styles.routeTypePill,
                    localRouteStyle === style.value
                      ? styles.routeTypePillSelected
                      : styles.routeTypePillDefault,
                  ]}
                >
                  <Text
                    style={[
                      styles.routeTypePillLabel,
                      localRouteStyle === style.value
                        ? styles.routeTypePillLabelSelected
                        : styles.routeTypePillLabelDefault,
                    ]}
                  >
                    {style.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Preferences */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>ROUTE PREFERENCES</Text>
            <View style={styles.prefRow}>
              <Pressable onPress={toggleElevation} style={styles.prefPill}>
                <Ionicons name="swap-horizontal" size={12} color={Colors.mutedForeground} />
                <Text style={styles.prefPillLabel}>
                  {localPrefs.elevation === 'flat' ? 'Flat' : 'Elevated'}
                </Text>
              </Pressable>
              <Pressable onPress={() => togglePref('scenic')} style={styles.prefPill}>
                <Ionicons name="swap-horizontal" size={12} color={Colors.mutedForeground} />
                <Text style={styles.prefPillLabel}>
                  {localPrefs.scenic ? 'Scenic' : 'Efficient'}
                </Text>
              </Pressable>
              <Pressable onPress={() => togglePref('lowTraffic')} style={styles.prefPill}>
                <Ionicons name="swap-horizontal" size={12} color={Colors.mutedForeground} />
                <Text style={styles.prefPillLabel}>
                  {localPrefs.lowTraffic ? 'Quiet' : 'Busy'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>

        {/* Fixed button area at bottom */}
        <View
          style={[
            styles.fixedButtonArea,
            { paddingBottom: Math.max(insets.bottom, 20) + 12 },
          ]}
        >
          <Pressable
            onPress={handleGenerate}
            disabled={!canGenerate}
            style={({ pressed }) => [
              styles.generateButton,
              canGenerate ? styles.generateButtonActive : styles.generateButtonDisabled,
              pressed && canGenerate && { transform: [{ scale: 0.98 }] },
            ]}
          >
            {ctx.isGenerating ? (
              <ActivityIndicator size="small" color={Colors.primaryForeground} />
            ) : (
              <Ionicons name="arrow-forward" size={20} color={canGenerate ? Colors.primaryForeground : Colors.mutedForeground} />
            )}
            <Text
              style={[
                styles.generateLabel,
                canGenerate ? styles.generateLabelActive : styles.generateLabelDisabled,
              ]}
            >
              {ctx.isGenerating ? 'Generating Route...' : 'Generate Route'}
            </Text>
          </Pressable>
          {!ctx.hasLocation && (
            <Text style={styles.helpText}>Set your location above to continue</Text>
          )}
        </View>
      </View>

      {/* Profile Drawer */}
      <ProfileDrawer
        visible={drawerVisible}
        onClose={() => setDrawerVisible(false)}
        onPreviewFavorite={setPreviewFavorite}
      />

      {/* Favorite Route Preview */}
      {previewFavorite && (
        <FavoritePreview
          favorite={previewFavorite}
          onClose={() => setPreviewFavorite(null)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  mapContainer: {
    flex: 1,
  },
  headerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 30,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 8,
    backgroundColor: Colors.background + '99',
  },
  gpsChip: {
    backgroundColor: Colors.card,
    borderRadius: 9999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  settingsBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomPanel: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderTopColor: Colors.border + '4D',
    backgroundColor: Colors.card,
    marginTop: -24,
    zIndex: 20,
  },
  grabHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.mutedForeground + '4D',
    marginTop: 12,
    marginBottom: 12,
  },
  bottomContent: {
    paddingHorizontal: 20,
    gap: 16,
  },
  section: {
  },
  sectionLabel: {
    fontFamily: Fonts.sansBold,
    fontSize: 10,
    letterSpacing: 2,
    color: Colors.mutedForeground,
    marginBottom: 10,
  },
  locationCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
  },
  locationCardActive: {
    borderColor: Colors.primary + '4D',
    backgroundColor: Colors.primary + '0D',
  },
  locationCardDefault: {
    borderColor: Colors.border,
    backgroundColor: Colors.card,
  },
  locationCardDashed: {
    borderColor: Colors.border,
    borderStyle: 'dashed',
    backgroundColor: Colors.card + '99',
  },
  locationCardDimmed: {
    opacity: 0.45,
  },
  locationIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  locationIconActive: {
    backgroundColor: Colors.primary + '26',
  },
  locationIconDefault: {
    backgroundColor: Colors.secondary,
  },
  locationText: {
    flex: 1,
  },
  locationTitle: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 14,
    color: Colors.foreground,
  },
  locationTitleDimmed: {
    color: Colors.mutedForeground,
  },
  locationCoords: {
    fontFamily: Fonts.mono,
    fontSize: 11,
    color: Colors.mutedForeground,
    marginTop: 1,
  },
  changeLabel: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 10,
    color: Colors.primary,
  },
  clearLabel: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 10,
    color: Colors.destructive,
  },
  inlineAddressInput: {
    fontFamily: Fonts.sans,
    fontSize: 14,
    color: Colors.foreground,
    paddingVertical: 2,
  },
  endLocationConnector: {
    width: 1,
    height: 8,
    backgroundColor: Colors.border,
    marginLeft: 29,
    marginVertical: -1,
  },
  prefRow: {
    flexDirection: 'row',
    gap: 8,
  },
  prefPill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    paddingVertical: 12,
    paddingHorizontal: 8,
  },
  prefPillLabel: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 12,
    color: Colors.mutedForeground,
  },
  routeTypeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  routeTypePill: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  routeTypePillSelected: {
    borderColor: Colors.primary + '66',
    backgroundColor: Colors.primary + '1A',
  },
  routeTypePillDefault: {
    borderColor: Colors.border,
    backgroundColor: Colors.card,
  },
  routeTypePillLabel: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 12,
  },
  routeTypePillLabelSelected: {
    color: Colors.primary,
  },
  routeTypePillLabelDefault: {
    color: Colors.mutedForeground,
  },
  fixedButtonArea: {
    borderTopWidth: 1,
    borderTopColor: Colors.border + '4D',
    backgroundColor: Colors.card,
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  generateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    borderRadius: 16,
    paddingVertical: 16,
  },
  generateButtonActive: {
    backgroundColor: Colors.primary,
  },
  generateButtonDisabled: {
    backgroundColor: Colors.muted,
  },
  generateLabel: {
    fontFamily: Fonts.sansBold,
    fontSize: 14,
  },
  generateLabelActive: {
    color: Colors.primaryForeground,
  },
  generateLabelDisabled: {
    color: Colors.mutedForeground,
  },
  helpText: {
    fontFamily: Fonts.sans,
    fontSize: 11,
    color: Colors.mutedForeground,
    textAlign: 'center',
    marginTop: 8,
  },
});
