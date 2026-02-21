import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  FlatList,
  ScrollView,
  Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import { RouteMap } from '@/components/RouteMap';
import { ProfileDrawer } from '@/components/ProfileDrawer';
import { FavoritePreview } from '@/components/FavoritePreview';
import { useAppContext, type RouteStyle, type RunPreferences, type FavoriteRoute } from '@/lib/AppContext';
import { generateOSRMRoutes } from '@/lib/osrm';
import { accuracyToStrength } from '@/lib/useLocationTracking';
import { BottomTabBar } from '@/components/BottomTabBar';
import { Colors, Fonts } from '@/lib/theme';
import type { GeocodeSuggestion } from '@/lib/types';

/** Haversine distance in miles between two lat/lng points */
function haversineDistanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3958.8; // Earth radius in miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Continuous slider for distance selection (1–30 mi, whole-mile increments).
 *  First half: 1–5 mi equally spaced. Second half: 5–30 mi equally spaced. */
function DistanceSlider({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  const sliderRef = useRef<View>(null);
  const STEP = 1;

  // Piecewise linear: [0, 0.5] → [1, 5], [0.5, 1] → [5, 30]
  const valueToFraction = (v: number) => {
    if (v <= 5) return ((v - 1) / 4) * 0.5;
    return 0.5 + ((v - 5) / 25) * 0.5;
  };

  const fractionToValue = (f: number) => {
    if (f <= 0.5) return 1 + (f / 0.5) * 4;
    return 5 + ((f - 0.5) / 0.5) * 25;
  };

  const fraction = Math.max(0, Math.min(1, valueToFraction(value)));

  const snapToStep = (raw: number) => {
    const clamped = Math.max(1, Math.min(30, raw));
    return Math.round(clamped / STEP) * STEP;
  };

  const handleTouch = useCallback((pageX: number) => {
    if (disabled) return;
    sliderRef.current?.measure((_x, _y, width, _h, px) => {
      const relative = Math.max(0, Math.min(1, (pageX - px) / width));
      onChange(snapToStep(fractionToValue(relative)));
    });
  }, [onChange, disabled]);

  return (
    <View style={disabled ? { opacity: 0.45 } : undefined}>
      <View style={styles.sliderValueRow}>
        <Text style={styles.sliderValue}>{value}</Text>
        <Text style={styles.sliderUnit}>mi</Text>
      </View>
      <View
        ref={sliderRef}
        style={styles.sliderTrack}
        onStartShouldSetResponder={() => !disabled}
        onMoveShouldSetResponder={() => !disabled}
        onResponderGrant={(e) => handleTouch(e.nativeEvent.pageX)}
        onResponderMove={(e) => handleTouch(e.nativeEvent.pageX)}
      >
        <View style={[styles.sliderFill, { width: `${fraction * 100}%` }]} />
        <View style={[styles.sliderThumb, { left: `${fraction * 100}%` }]} />
      </View>
      <View style={styles.sliderRangeLabels}>
        <Text style={styles.sliderLabelText}>1</Text>
        <Text style={styles.sliderLabelText}>5</Text>
        <Text style={styles.sliderLabelText}>30</Text>
      </View>
    </View>
  );
}

const ROUTE_STYLES: { value: RouteStyle; label: string; desc: string }[] = [
  { value: 'loop', label: 'Loop', desc: 'Start and finish at the same spot' },
  { value: 'out-and-back', label: 'Out & Back', desc: 'Run out, then retrace your steps' },
  { value: 'point-to-point', label: 'Point to Point', desc: 'Run from A to B in one direction' },
];

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';

/** Debounced Nominatim geocoding for address autocomplete, biased to user location */
async function searchAddresses(query: string, center?: { lat: number; lng: number }): Promise<GeocodeSuggestion[]> {
  if (query.trim().length < 3) return [];
  try {
    const params = new URLSearchParams({
      q: query.trim(),
      format: 'json',
      limit: '5',
      addressdetails: '0',
    });
    // Strictly limit results to within ~50km of the user's current location
    if (center) {
      const offset = 0.5; // ~50km in degrees
      params.set('viewbox', `${center.lng - offset},${center.lat + offset},${center.lng + offset},${center.lat - offset}`);
      params.set('bounded', '1'); // strictly limit results to viewbox
    }
    const res = await fetch(`${NOMINATIM_BASE}?${params}`, {
      headers: { 'User-Agent': 'RunningRoutes/1.0' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.map((item: any) => ({
      placeId: String(item.place_id),
      displayName: item.display_name,
      lat: parseFloat(item.lat),
      lng: parseFloat(item.lon),
    }));
  } catch {
    return [];
  }
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
  const [startLocationName, setStartLocationName] = useState<string | null>(null);
  const [endLocationName, setEndLocationName] = useState<string | null>(null);
  const [currentLocationAddress, setCurrentLocationAddress] = useState<string | null>(null);

  // Start location search
  const [showStartSearch, setShowStartSearch] = useState(false);
  const [startAddressText, setStartAddressText] = useState('');
  const [isStartGeocoding, setIsStartGeocoding] = useState(false);
  const [startSuggestions, setStartSuggestions] = useState<GeocodeSuggestion[]>([]);
  const startInputRef = useRef<TextInput>(null);
  const startDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressStartBlurRef = useRef(false);

  // End location search
  const [showEndSearch, setShowEndSearch] = useState(false);
  const [endAddressText, setEndAddressText] = useState('');
  const [isEndGeocoding, setIsEndGeocoding] = useState(false);
  const [endSuggestions, setEndSuggestions] = useState<GeocodeSuggestion[]>([]);
  const endInputRef = useRef<TextInput>(null);
  const endDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auth redirect — disabled for testing
  // TODO: re-enable when done testing
  // useEffect(() => {
  //   if (!ctx.isLoggedIn) {
  //     router.replace('/landing');
  //   }
  // }, [ctx.isLoggedIn]);

  // Real GPS strength from location accuracy
  useEffect(() => {
    let subscription: Location.LocationSubscription | null = null;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        ctx.setGpsStrength(0);
        return;
      }

      subscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 5000 },
        (loc) => {
          ctx.setGpsStrength(accuracyToStrength(loc.coords.accuracy));
        }
      );
    })();

    return () => {
      subscription?.remove();
    };
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
          ctx.setGpsStrength(accuracyToStrength(loc.coords.accuracy));
          // Reverse geocode to get a readable address
          try {
            const [geo] = await Location.reverseGeocodeAsync({
              latitude: loc.coords.latitude,
              longitude: loc.coords.longitude,
            });
            if (geo) {
              const parts: string[] = [];
              if (geo.streetNumber && geo.street) parts.push(`${geo.streetNumber} ${geo.street}`);
              else if (geo.street) parts.push(geo.street);
              else if (geo.name) parts.push(geo.name);
              if (geo.city) parts.push(geo.city);
              if (parts.length > 0) setCurrentLocationAddress(parts.join(', '));
            }
          } catch {}
        } catch {
          ctx.setHasLocation(true);
        }
      } else {
        ctx.setHasLocation(true);
      }
    })();
  }, []);

  // Debounced start address autocomplete
  const handleStartAddressChange = useCallback((text: string) => {
    setStartAddressText(text);
    if (startDebounceRef.current) clearTimeout(startDebounceRef.current);
    if (text.trim().length < 3) {
      setStartSuggestions([]);
      return;
    }
    startDebounceRef.current = setTimeout(async () => {
      const results = await searchAddresses(text, ctx.center);
      setStartSuggestions(results);
    }, 400);
  }, [ctx.center]);

  // Debounced end address autocomplete
  const handleEndAddressChange = useCallback((text: string) => {
    setEndAddressText(text);
    if (endDebounceRef.current) clearTimeout(endDebounceRef.current);
    if (text.trim().length < 3) {
      setEndSuggestions([]);
      return;
    }
    endDebounceRef.current = setTimeout(async () => {
      const results = await searchAddresses(text, ctx.center);
      setEndSuggestions(results);
    }, 400);
  }, [ctx.center]);

  const selectStartSuggestion = useCallback((suggestion: GeocodeSuggestion) => {
    Keyboard.dismiss();
    ctx.setCenter({ lat: suggestion.lat, lng: suggestion.lng });
    ctx.setHasLocation(true);
    setStartLocationName(suggestion.displayName);
    setShowStartSearch(false);
    setStartAddressText('');
    setStartSuggestions([]);
  }, [ctx]);

  const selectEndSuggestion = useCallback((suggestion: GeocodeSuggestion) => {
    Keyboard.dismiss();
    if (localRouteStyle !== 'point-to-point') {
      setLocalRouteStyle('point-to-point');
    }
    ctx.setEndLocation({ lat: suggestion.lat, lng: suggestion.lng });
    setHasEndLocation(true);
    setEndLocationName(suggestion.displayName);
    setShowEndSearch(false);
    setEndAddressText('');
    setEndSuggestions([]);
  }, [ctx, localRouteStyle]);

  const handleUseCurrentLocation = useCallback(async () => {
    suppressStartBlurRef.current = true;
    Keyboard.dismiss();
    setShowStartSearch(false);
    setStartSuggestions([]);
    setStartAddressText('');
    setStartLocationName(null); // null means use currentLocationAddress
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status === 'granted') {
      try {
        const loc = await Location.getCurrentPositionAsync({});
        ctx.setCenter({ lat: loc.coords.latitude, lng: loc.coords.longitude });
        ctx.setHasLocation(true);
        ctx.setGpsStrength(accuracyToStrength(loc.coords.accuracy));
        // Reverse geocode
        try {
          const [geo] = await Location.reverseGeocodeAsync({
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
          });
          if (geo) {
            const parts: string[] = [];
            if (geo.streetNumber && geo.street) parts.push(`${geo.streetNumber} ${geo.street}`);
            else if (geo.street) parts.push(geo.street);
            else if (geo.name) parts.push(geo.name);
            if (geo.city) parts.push(geo.city);
            if (parts.length > 0) setCurrentLocationAddress(parts.join(', '));
          }
        } catch {}
      } catch {
        // keep existing location
      }
    }
  }, [ctx]);

  const handleLocationCardPress = useCallback(() => {
    if (ctx.hasLocation) {
      setStartAddressText('');
      setStartSuggestions([]);
      setShowStartSearch(true);
      setTimeout(() => startInputRef.current?.focus(), 100);
    } else {
      handleUseCurrentLocation();
    }
  }, [ctx.hasLocation, handleUseCurrentLocation]);

  const handleStartSearchSubmit = useCallback(async () => {
    if (!startAddressText.trim() || isStartGeocoding) return;
    setIsStartGeocoding(true);
    try {
      const results = await searchAddresses(startAddressText, ctx.center);
      if (results.length > 0) {
        selectStartSuggestion(results[0]);
      }
    } finally {
      setIsStartGeocoding(false);
    }
  }, [startAddressText, isStartGeocoding, selectStartSuggestion, ctx.center]);

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
    setEndSuggestions([]);
    setShowEndSearch(true);
    if (localRouteStyle !== 'point-to-point') {
      setLocalRouteStyle('point-to-point');
    }
    setTimeout(() => endInputRef.current?.focus(), 100);
  }, [localRouteStyle]);

  const handleEndSearchSubmit = useCallback(async () => {
    if (!endAddressText.trim() || isEndGeocoding) return;
    setIsEndGeocoding(true);
    try {
      const results = await searchAddresses(endAddressText, ctx.center);
      if (results.length > 0) {
        selectEndSuggestion(results[0]);
      }
    } finally {
      setIsEndGeocoding(false);
    }
  }, [endAddressText, isEndGeocoding, selectEndSuggestion, ctx.center]);

  const handleClearEndLocation = useCallback(() => {
    ctx.setEndLocation(null);
    setHasEndLocation(false);
    setEndLocationName(null);
  }, [ctx]);

  const toggleTraffic = () => {
    setLocalPrefs((prev) => ({ ...prev, lowTraffic: !prev.lowTraffic }));
  };

  const handleGenerate = useCallback(async () => {
    ctx.setRouteStyle(localRouteStyle);
    ctx.setPrefs(localPrefs);
    ctx.setIsGenerating(true);

    const end =
      localRouteStyle === 'point-to-point' && hasEndLocation
        ? ctx.endLocation
        : null;

    // Convert miles to km for OSRM
    const distanceKm = ctx.distance * 1.60934;

    try {
      const newRoutes = await generateOSRMRoutes(
        ctx.center,
        distanceKm,
        localRouteStyle === 'point-to-point' ? 'point-to-point' : localRouteStyle === 'out-and-back' ? 'out-and-back' : 'loop',
        1,
        localPrefs,
        end
      );
      ctx.setRoutes(newRoutes);
      ctx.setSelectedRoute(newRoutes[0] || null);
    } catch (err: any) {
      console.warn('Route generation failed, starting without route:', err);
      // Continue to run screen even without a generated route
    } finally {
      ctx.setIsGenerating(false);
      router.replace('/run');
    }
  }, [ctx, localRouteStyle, localPrefs, hasEndLocation, router]);

  const p2pDistance = useMemo(() => {
    if (localRouteStyle === 'point-to-point' && hasEndLocation && ctx.endLocation) {
      return Math.round(haversineDistanceMiles(ctx.center.lat, ctx.center.lng, ctx.endLocation.lat, ctx.endLocation.lng) * 10) / 10;
    }
    return null;
  }, [localRouteStyle, hasEndLocation, ctx.center, ctx.endLocation]);

  const canGenerate = ctx.hasLocation && !ctx.isGenerating && ctx.distance > 0;

  const renderSuggestion = ({ item, onSelect }: { item: GeocodeSuggestion; onSelect: (s: GeocodeSuggestion) => void }) => (
    <Pressable
      style={styles.suggestionItem}
      onPress={() => onSelect(item)}
    >
      <Ionicons name="location-outline" size={14} color={Colors.mutedForeground} />
      <Text style={styles.suggestionText} numberOfLines={2}>{item.displayName}</Text>
    </Pressable>
  );

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
          <Pressable onPress={() => setDrawerVisible(true)} style={styles.settingsBtn}>
            <Ionicons name="settings-outline" size={18} color={Colors.mutedForeground} />
          </Pressable>
        </View>
      </View>

      {/* Bottom panel */}
      <View style={styles.bottomPanel}>
        {/* Grab handle */}
        <View style={styles.grabHandle} />

        <ScrollView
          style={styles.bottomScrollView}
          contentContainerStyle={styles.bottomScrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
        {/* Controls */}
        <View style={styles.bottomContent}>
          {/* Route Type */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>PLAN YOUR RUN</Text>
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

          {/* Location Cards — combined box */}
          <View style={[styles.section, { zIndex: 20 }]}>
            <View style={styles.locationGroup}>
              {/* Start Location */}
              {showStartSearch ? (
                <View style={styles.locationCardTop}>
                  <View style={[styles.locationIcon, styles.locationIconStart]}>
                    <View style={styles.startDot} />
                  </View>
                  <View style={styles.locationText}>
                    <TextInput
                      ref={startInputRef}
                      style={styles.inlineInput}
                      placeholder="Enter starting location"
                      placeholderTextColor={Colors.mutedForeground}
                      value={startAddressText}
                      onChangeText={handleStartAddressChange}
                      onSubmitEditing={handleStartSearchSubmit}
                      onBlur={() => {
                        setTimeout(() => {
                          if (suppressStartBlurRef.current) {
                            suppressStartBlurRef.current = false;
                            return;
                          }
                          setShowStartSearch(false);
                          setStartSuggestions([]);
                        }, 200);
                      }}
                      returnKeyType="search"
                      autoFocus
                    />
                  </View>
                  {isStartGeocoding ? (
                    <ActivityIndicator size="small" color={Colors.primary} />
                  ) : startAddressText.trim() ? (
                    <Pressable onPress={handleStartSearchSubmit}>
                      <Ionicons name="arrow-forward-circle" size={24} color={Colors.primary} />
                    </Pressable>
                  ) : (
                    <Pressable onPress={handleUseCurrentLocation} style={styles.useCurrentBtn} hitSlop={8}>
                      <Ionicons name="navigate" size={13} color={Colors.primary} />
                    </Pressable>
                  )}
                </View>
              ) : (
                <Pressable
                  onPress={handleLocationCardPress}
                  style={styles.locationCardTop}
                >
                  <View style={[styles.locationIcon, styles.locationIconStart]}>
                    <View style={styles.startDot} />
                  </View>
                  <View style={styles.locationText}>
                    {ctx.hasLocation ? (
                      <Text style={[styles.locationTitle, !startLocationName && styles.locationTitleDimmed]} numberOfLines={1}>{startLocationName || currentLocationAddress || 'Current Location'}</Text>
                    ) : (
                      <Text style={styles.locationTitle}>Use Current Location</Text>
                    )}
                  </View>
                </Pressable>
              )}

              {/* Start address suggestions dropdown */}
              {showStartSearch && startSuggestions.length > 0 && (
                <ScrollView style={styles.suggestionsContainerInGroup} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                  {startSuggestions.map((s) => (
                    <Pressable
                      key={s.placeId}
                      style={styles.suggestionItem}
                      onPress={() => selectStartSuggestion(s)}
                    >
                      <Ionicons name="location-outline" size={14} color={Colors.mutedForeground} />
                      <Text style={styles.suggestionText} numberOfLines={2}>{s.displayName}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              )}

              {/* Divider */}
              <View style={styles.locationGroupDivider} />

              {/* End Location */}
              <Pressable
                onPress={handleEndLocationCardPress}
                style={styles.locationCardBottom}
              >
                <View style={[styles.locationIcon, styles.locationIconEnd]}>
                  <Ionicons name="flag" size={14} color={Colors.destructive} />
                </View>
                <View style={styles.locationText}>
                  {showEndSearch ? (
                    <TextInput
                      ref={endInputRef}
                      style={styles.inlineInput}
                      placeholder="Enter end location"
                      placeholderTextColor={Colors.mutedForeground}
                      value={endAddressText}
                      onChangeText={handleEndAddressChange}
                      onSubmitEditing={handleEndSearchSubmit}
                      onBlur={() => {
                        setTimeout(() => {
                          setShowEndSearch(false);
                          setEndSuggestions([]);
                        }, 200);
                      }}
                      returnKeyType="search"
                      autoFocus
                    />
                  ) : localRouteStyle !== 'point-to-point' ? (
                    <Text style={[styles.locationTitle, styles.locationTitleDimmed]} numberOfLines={1}>{startLocationName || currentLocationAddress || 'Current Location'}</Text>
                  ) : hasEndLocation && ctx.endLocation ? (
                    <Text style={styles.locationTitle} numberOfLines={1}>{endLocationName || 'Destination set'}</Text>
                  ) : (
                    <Text style={[styles.locationTitle, styles.locationTitleHighlight]}>Set end location</Text>
                  )}
                </View>
                {showEndSearch ? (
                  isEndGeocoding ? (
                    <ActivityIndicator size="small" color={Colors.primary} />
                  ) : endAddressText.trim() ? (
                    <Pressable onPress={handleEndSearchSubmit}>
                      <Ionicons name="arrow-forward-circle" size={24} color={Colors.primary} />
                    </Pressable>
                  ) : null
                ) : null}
              </Pressable>

              {/* End address suggestions dropdown */}
              {showEndSearch && endSuggestions.length > 0 && (
                <ScrollView style={styles.suggestionsContainerInGroup} nestedScrollEnabled keyboardShouldPersistTaps="handled">
                  {endSuggestions.map((s) => (
                    <Pressable
                      key={s.placeId}
                      style={styles.suggestionItem}
                      onPress={() => selectEndSuggestion(s)}
                    >
                      <Ionicons name="location-outline" size={14} color={Colors.mutedForeground} />
                      <Text style={styles.suggestionText} numberOfLines={2}>{s.displayName}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              )}
            </View>
          </View>

          {/* Distance */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>DISTANCE</Text>
            {localRouteStyle === 'point-to-point' ? (
              <DistanceSlider
                value={p2pDistance ?? ctx.distance}
                onChange={() => {}}
                disabled
              />
            ) : (
              <DistanceSlider value={ctx.distance} onChange={ctx.setDistance} />
            )}
          </View>

          {/* Preferences */}
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>ROUTE PREFERENCES</Text>
            <Pressable onPress={toggleTraffic} style={styles.toggleRow}>
              <View style={styles.toggleLabelRow}>
                <Ionicons name="car-outline" size={14} color={Colors.mutedForeground} />
                <Text style={styles.toggleLabel}>Avoid Traffic</Text>
              </View>
              <View style={[
                styles.toggleTrack,
                localPrefs.lowTraffic ? styles.toggleTrackOn : undefined,
              ]}>
                <View style={[
                  styles.toggleThumb,
                  localPrefs.lowTraffic ? styles.toggleThumbOn : undefined,
                ]} />
              </View>
            </Pressable>
          </View>
        </View>

        {/* Fixed button area at bottom */}
        </ScrollView>
        <View
          style={styles.fixedButtonArea}
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
    maxHeight: '60%',
  },
  bottomScrollView: {
    flexGrow: 0,
  },
  bottomScrollContent: {
    paddingBottom: 4,
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
    gap: 12,
  },
  section: {
  },
  sectionLabel: {
    fontFamily: Fonts.sansBold,
    fontSize: 10,
    letterSpacing: 2,
    color: Colors.mutedForeground,
    marginBottom: 6,
  },
  locationGroup: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    overflow: 'hidden',
  },
  locationCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  locationCardBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  locationGroupDivider: {
    height: 1,
    backgroundColor: Colors.border,
    marginHorizontal: 12,
  },
  suggestionsContainerInGroup: {
    maxHeight: 160,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
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
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  locationIconStart: {
    backgroundColor: Colors.primary + '1A',
  },
  startDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: Colors.primary,
  },
  locationIconEnd: {
    backgroundColor: Colors.destructive + '1A',
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
    fontSize: 13,
    color: Colors.foreground,
  },
  locationTitleDimmed: {
    color: Colors.mutedForeground,
  },
  locationTitleHighlight: {
    color: Colors.primary,
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
  cancelLabel: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 12,
    color: Colors.mutedForeground,
  },
  inlineInput: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 14,
    color: Colors.foreground,
    padding: 0,
  },
  searchActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  useCurrentBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.primary + '1A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  suggestionsContainer: {
    maxHeight: 180,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    marginTop: 4,
    overflow: 'hidden',
  },
  suggestionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  suggestionText: {
    flex: 1,
    fontFamily: Fonts.sans,
    fontSize: 12,
    color: Colors.foreground,
  },
  clearLabel: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 10,
    color: Colors.destructive,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.card,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  toggleLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  toggleLabel: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 12,
    color: Colors.mutedForeground,
  },
  toggleTrack: {
    width: 36,
    height: 20,
    borderRadius: 10,
    backgroundColor: Colors.muted,
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  toggleTrackOn: {
    backgroundColor: Colors.primary + '66',
  },
  toggleThumb: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: Colors.mutedForeground,
  },
  toggleThumbOn: {
    alignSelf: 'flex-end',
    backgroundColor: Colors.primary,
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
  sliderValueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    gap: 4,
    marginBottom: 12,
  },
  sliderValue: {
    fontFamily: Fonts.sansBold,
    fontSize: 28,
    color: Colors.foreground,
  },
  sliderUnit: {
    fontFamily: Fonts.sans,
    fontSize: 14,
    color: Colors.mutedForeground,
  },
  sliderTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.secondary,
    justifyContent: 'center',
  },
  sliderFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 3,
    backgroundColor: Colors.primary,
  },
  sliderThumb: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: Colors.primary,
    borderWidth: 3,
    borderColor: Colors.background,
    marginLeft: -11,
    top: -8,
  },
  sliderRangeLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  sliderLabelText: {
    fontFamily: Fonts.sans,
    fontSize: 9,
    color: Colors.mutedForeground,
  },
  fixedButtonArea: {
    borderTopWidth: 1,
    borderTopColor: Colors.border + '4D',
    backgroundColor: Colors.card,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
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
