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
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import { RouteMap } from '@/components/RouteMap';
import { ProfileDrawer } from '@/components/ProfileDrawer';
import { useAppContext, type RouteStyle, type RunPreferences } from '@/lib/AppContext';
import { distanceUnit } from '@/lib/units';
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

/** Continuous slider for distance selection.
 *  Thumb follows finger smoothly; displayed value snaps to whole numbers.
 *  First half of track: 1–5. Second half: 5–max. */
function DistanceSlider({
  value,
  onChange,
  disabled,
  onDragStart,
  onDragEnd,
  maxValue = 30,
  unit = 'mi',
}: {
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  maxValue?: number;
  unit?: string;
}) {
  const sliderRef = useRef<View>(null);
  const trackLayout = useRef({ pageX: 0, width: 0 });
  const lastRounded = useRef(value);
  const [dragging, setDragging] = useState(false);

  const midpoint = Math.min(5, maxValue);
  const valToFrac = (v: number) => {
    if (v <= midpoint) return ((v - 1) / (midpoint - 1)) * 0.5;
    return 0.5 + ((v - midpoint) / (maxValue - midpoint)) * 0.5;
  };
  const fracToVal = (f: number) => {
    if (f <= 0.5) return 1 + (f / 0.5) * (midpoint - 1);
    return midpoint + ((f - 0.5) / 0.5) * (maxValue - midpoint);
  };

  const [rawFraction, setRawFraction] = useState(() => valToFrac(value));

  // Piecewise linear: [0, 0.5] → [1, midpoint], [0.5, 1] → [midpoint, maxValue]
  const fraction = dragging ? rawFraction : valToFrac(value);

  const processTouch = useCallback((pageX: number) => {
    if (disabled) return;
    const { pageX: trackX, width } = trackLayout.current;
    if (width === 0) return;
    const relative = Math.max(0, Math.min(1, (pageX - trackX) / width));
    setRawFraction(relative);
    const raw = fracToVal(relative);
    const clamped = Math.max(1, Math.min(maxValue, raw));
    const rounded = Math.round(clamped);
    if (rounded !== lastRounded.current) {
      lastRounded.current = rounded;
      onChange(rounded);
    }
  }, [onChange, disabled, maxValue]);

  const handleGrant = useCallback((e: any) => {
    if (disabled) return;
    setDragging(true);
    lastRounded.current = value;
    onDragStart?.();
    sliderRef.current?.measure((_x: number, _y: number, width: number, _h: number, px: number) => {
      trackLayout.current = { pageX: px, width };
      processTouch(e.nativeEvent.pageX);
    });
  }, [processTouch, disabled, onDragStart, value]);

  const handleRelease = useCallback(() => {
    setDragging(false);
    onDragEnd?.();
  }, [onDragEnd]);

  return (
    <View style={disabled ? { opacity: 0.45 } : undefined}>
      <View style={styles.sliderValueRow}>
        <Text style={styles.sliderValue}>{value}</Text>
        <Text style={styles.sliderUnit}>{unit}</Text>
      </View>
      <View
        ref={sliderRef}
        style={styles.sliderTrack}
        onStartShouldSetResponder={() => !disabled}
        onMoveShouldSetResponder={() => !disabled}
        onResponderGrant={handleGrant}
        onResponderMove={(e) => processTouch(e.nativeEvent.pageX)}
        onResponderRelease={handleRelease}
        onResponderTerminate={handleRelease}
      >
        <View style={styles.sliderTrackBar}>
          <View style={[styles.sliderFill, { width: `${fraction * 100}%` }]} />
        </View>
        <View style={[styles.sliderThumb, { left: `${fraction * 100}%` }]} />
      </View>
      <View style={styles.sliderRangeLabels}>
        <Text style={styles.sliderLabelText}>1</Text>
        <Text style={styles.sliderLabelText}>{midpoint}</Text>
        <Text style={styles.sliderLabelText}>{maxValue}</Text>
      </View>
    </View>
  );
}

const ROUTE_STYLES: { value: RouteStyle; label: string; desc: string }[] = [
  { value: 'loop', label: 'Loop', desc: 'Start and finish at the same spot' },
  { value: 'point-to-point', label: 'Point to Point', desc: 'Run from A to B in one direction' },
];

const PHOTON_BASE = 'https://photon.komoot.io/api';

/** Autocomplete geocoding via Photon (Komoot), biased toward user location */
async function searchAddresses(query: string, center?: { lat: number; lng: number }): Promise<GeocodeSuggestion[]> {
  if (query.trim().length < 2) return [];
  try {
    const params = new URLSearchParams({
      q: query.trim(),
      limit: '5',
    });
    // Bias results toward user location (soft bias, not a hard boundary)
    if (center) {
      params.set('lat', String(center.lat));
      params.set('lon', String(center.lng));
    }
    const res = await fetch(`${PHOTON_BASE}?${params}`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.features || []).map((f: any) => {
      const p = f.properties || {};
      const parts: string[] = [];
      if (p.housenumber && p.street) parts.push(`${p.housenumber} ${p.street}`);
      else if (p.street) parts.push(p.street);
      else if (p.name) parts.push(p.name);
      if (p.city || p.town || p.village) parts.push(p.city || p.town || p.village);
      if (p.state) parts.push(p.state);
      const displayName = parts.length > 0 ? parts.join(', ') : (p.name || 'Unknown');
      const [lng, lat] = f.geometry.coordinates;
      return {
        placeId: String(p.osm_id || `${lat},${lng}`),
        displayName,
        lat,
        lng,
      };
    });
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

  // Sync localPrefs when units change in settings
  useEffect(() => {
    setLocalPrefs(ctx.prefs);
  }, [ctx.prefs]);
  const [hasEndLocation, setHasEndLocation] = useState(false);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [sliderActive, setSliderActive] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // Bottom sheet collapse
  const [isSheetCollapsed, setIsSheetCollapsed] = useState(false);
  const sheetContentHeight = useSharedValue(500);
  const sheetGestureY = useRef(0);

  const toggleSheet = useCallback(() => {
    if (isSheetCollapsed) {
      sheetContentHeight.value = withTiming(500, { duration: 300 });
      setIsSheetCollapsed(false);
    } else {
      sheetContentHeight.value = withTiming(0, { duration: 300 });
      setIsSheetCollapsed(true);
    }
  }, [isSheetCollapsed]);

  const sheetContentStyle = useAnimatedStyle(() => ({
    maxHeight: sheetContentHeight.value,
    overflow: 'hidden' as const,
    opacity: sheetContentHeight.value > 10 ? 1 : 0,
  }));
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
  const startRequestIdRef = useRef(0);
  const suppressStartBlurRef = useRef(false);

  // End location search
  const [showEndSearch, setShowEndSearch] = useState(false);
  const [endAddressText, setEndAddressText] = useState('');
  const [isEndGeocoding, setIsEndGeocoding] = useState(false);
  const [endSuggestions, setEndSuggestions] = useState<GeocodeSuggestion[]>([]);
  const endInputRef = useRef<TextInput>(null);
  const sheetScrollRef = useRef<ScrollView>(null);
  const endDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endRequestIdRef = useRef(0);

  // Auth redirect
  useEffect(() => {
    if (!ctx.isLoggedIn) {
      router.replace('/landing');
    }
  }, [ctx.isLoggedIn]);

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

  // Re-fetch GPS every time the screen is focused, but only if the user hasn't
  // manually set a start location. This ensures returning from a run resets
  // center to the user's actual position, while preserving any typed address.
  useFocusEffect(
    useCallback(() => {
      // Only auto-update location if user hasn't manually set one
      if (startLocationName) return;
      (async () => {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          try {
            const loc = await Location.getCurrentPositionAsync({});
            ctx.setCenter({ lat: loc.coords.latitude, lng: loc.coords.longitude });
            ctx.setHasLocation(true);
            ctx.setGpsStrength(accuracyToStrength(loc.coords.accuracy));
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
    }, [startLocationName])
  );

  // Debounced start address autocomplete
  const handleStartAddressChange = useCallback((text: string) => {
    setStartAddressText(text);
    if (startDebounceRef.current) clearTimeout(startDebounceRef.current);
    if (text.trim().length < 2) {
      setStartSuggestions([]);
      return;
    }
    const requestId = ++startRequestIdRef.current;
    startDebounceRef.current = setTimeout(async () => {
      const results = await searchAddresses(text, ctx.center);
      // Only update if this is still the latest request
      if (requestId === startRequestIdRef.current) {
        setStartSuggestions(results);
      }
    }, 200);
  }, [ctx.center]);

  // Debounced end address autocomplete
  const handleEndAddressChange = useCallback((text: string) => {
    setEndAddressText(text);
    if (endDebounceRef.current) clearTimeout(endDebounceRef.current);
    if (text.trim().length < 2) {
      setEndSuggestions([]);
      return;
    }
    const requestId = ++endRequestIdRef.current;
    endDebounceRef.current = setTimeout(async () => {
      const results = await searchAddresses(text, ctx.center);
      // Only update if this is still the latest request
      if (requestId === endRequestIdRef.current) {
        setEndSuggestions(results);
      }
    }, 200);
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

  const p2pDistance = useMemo(() => {
    if (localRouteStyle === 'point-to-point' && hasEndLocation && ctx.endLocation) {
      const miles = haversineDistanceMiles(ctx.center.lat, ctx.center.lng, ctx.endLocation.lat, ctx.endLocation.lng);
      const value = localPrefs.units === 'metric' ? miles * 1.60934 : miles;
      return Math.round(value * 10) / 10;
    }
    return null;
  }, [localRouteStyle, hasEndLocation, ctx.center, ctx.endLocation, localPrefs.units]);

  const handleGenerate = useCallback(async () => {
    ctx.setRouteStyle(localRouteStyle);
    ctx.setPrefs(localPrefs);
    ctx.setIsGenerating(true);
    setGenerateError(null);

    // Use local copies so geocoded values are available in the same tick
    let resolvedCenter = ctx.center;
    let resolvedEnd = ctx.endLocation;
    let resolvedHasEnd = hasEndLocation;

    // Resolve any unsubmitted start address text before generating
    if (startAddressText.trim().length >= 3) {
      try {
        const results = await searchAddresses(startAddressText, ctx.center);
        if (results.length > 0) {
          resolvedCenter = { lat: results[0].lat, lng: results[0].lng };
          ctx.setCenter(resolvedCenter);
          ctx.setHasLocation(true);
          setStartLocationName(results[0].displayName);
          setStartAddressText('');
          setStartSuggestions([]);
          setShowStartSearch(false);
        }
      } catch {}
    }

    // Resolve any unsubmitted end address text before generating
    if (endAddressText.trim().length >= 3 && localRouteStyle === 'point-to-point') {
      try {
        const results = await searchAddresses(endAddressText, resolvedCenter);
        if (results.length > 0) {
          resolvedEnd = { lat: results[0].lat, lng: results[0].lng };
          ctx.setEndLocation(resolvedEnd);
          resolvedHasEnd = true;
          setHasEndLocation(true);
          setEndLocationName(results[0].displayName);
          setEndAddressText('');
          setEndSuggestions([]);
          setShowEndSearch(false);
        }
      } catch {}
    }

    const end =
      localRouteStyle === 'point-to-point' && resolvedHasEnd
        ? resolvedEnd
        : null;

    // Convert to km for OSRM
    // p2pDistance is already in the user's selected unit
    const distanceKm =
      localRouteStyle === 'point-to-point' && p2pDistance != null
        ? (localPrefs.units === 'metric' ? p2pDistance : p2pDistance * 1.60934)
        : localPrefs.units === 'metric'
          ? ctx.distance
          : ctx.distance * 1.60934;

    // Clear previous routes so the run page starts fresh with the loading spinner
    ctx.setRoutes([]);
    ctx.setSelectedRoute(null);

    // Navigate to run page immediately so the user sees the loading spinner
    router.replace('/run');

    try {
      const newRoutes = await generateOSRMRoutes(
        resolvedCenter,
        distanceKm,
        localRouteStyle === 'point-to-point' ? 'point-to-point' : localRouteStyle === 'out-and-back' ? 'out-and-back' : 'loop',
        3,
        localPrefs,
        end
      );
      if (newRoutes.length === 0) {
        ctx.setIsGenerating(false);
        // Navigate back so user can retry
        router.replace('/');
        setTimeout(() => setGenerateError('No routes found for this area. Try a different location or distance.'), 100);
        return;
      }
      ctx.setRoutes(newRoutes);
      ctx.setSelectedRoute(newRoutes[0] || null);
      ctx.setIsGenerating(false);
    } catch (err: any) {
      console.warn('Route generation failed:', err);
      ctx.setIsGenerating(false);
      router.replace('/');
      setTimeout(() => setGenerateError("Couldn't generate a route. Check your connection and try again."), 100);
    }
  }, [ctx, localRouteStyle, localPrefs, hasEndLocation, p2pDistance, router, startAddressText, endAddressText]);

  const canGenerate = ctx.hasLocation && !ctx.isGenerating && ctx.distance > 0
    && (localRouteStyle !== 'point-to-point' || hasEndLocation);

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
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
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
        {/* Grab handle with gesture support */}
        <View
          style={styles.grabHandleArea}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={(e) => { sheetGestureY.current = e.nativeEvent.pageY; }}
          onResponderRelease={(e) => {
            const dy = e.nativeEvent.pageY - sheetGestureY.current;
            if (dy > 30 && !isSheetCollapsed) {
              sheetContentHeight.value = withTiming(0, { duration: 300 });
              setIsSheetCollapsed(true);
            } else if (dy < -30 && isSheetCollapsed) {
              sheetContentHeight.value = withTiming(500, { duration: 300 });
              setIsSheetCollapsed(false);
            } else if (Math.abs(dy) < 10) {
              toggleSheet();
            }
          }}
        >
          <View style={styles.grabHandle} />
        </View>

        <Animated.View style={sheetContentStyle}>
        <ScrollView
          ref={sheetScrollRef}
          style={styles.bottomScrollView}
          contentContainerStyle={styles.bottomScrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          scrollEnabled={!sliderActive}
          bounces={false}
          overScrollMode="never"
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
                  onPress={() => {
                    setLocalRouteStyle(style.value);
                    // Dismiss any active end location search
                    setShowEndSearch(false);
                    setEndSuggestions([]);
                    setEndAddressText('');
                    Keyboard.dismiss();
                    if (style.value === 'loop') {
                      // Loop ends where it starts — set immediately
                      ctx.setEndLocation(ctx.center);
                      setHasEndLocation(true);
                      setEndLocationName(startLocationName || currentLocationAddress || 'Current Location');
                    } else if (style.value === 'out-and-back') {
                      handleClearEndLocation();
                    } else if (style.value === 'point-to-point') {
                      // Clear end location — loop pre-fills it with the start,
                      // and that should not carry over to point-to-point
                      handleClearEndLocation();
                    }
                  }}
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
                        setTimeout(async () => {
                          if (suppressStartBlurRef.current) {
                            suppressStartBlurRef.current = false;
                            return;
                          }
                          // Auto-geocode typed text that wasn't resolved via suggestion
                          if (startAddressText.trim().length >= 3) {
                            setIsStartGeocoding(true);
                            try {
                              const results = await searchAddresses(startAddressText, ctx.center);
                              if (results.length > 0) {
                                selectStartSuggestion(results[0]);
                                return;
                              }
                            } finally {
                              setIsStartGeocoding(false);
                            }
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
                      onFocus={() => {
                        // Expand sheet fully and scroll to make input visible above keyboard
                        if (isSheetCollapsed) {
                          sheetContentHeight.value = withTiming(500, { duration: 300 });
                          setIsSheetCollapsed(false);
                        }
                        setTimeout(() => {
                          sheetScrollRef.current?.scrollTo({ y: 200, animated: true });
                        }, 300);
                      }}
                      onBlur={() => {
                        setTimeout(async () => {
                          // Auto-geocode typed text that wasn't resolved via suggestion
                          if (endAddressText.trim().length >= 3) {
                            setIsEndGeocoding(true);
                            try {
                              const results = await searchAddresses(endAddressText, ctx.center);
                              if (results.length > 0) {
                                selectEndSuggestion(results[0]);
                                return;
                              }
                            } finally {
                              setIsEndGeocoding(false);
                            }
                          }
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
            <View style={styles.sectionLabelRow}>
              <Text style={styles.sectionLabel}>DISTANCE</Text>
            </View>
            {localRouteStyle === 'point-to-point' ? (
              <DistanceSlider
                value={p2pDistance ?? ctx.distance}
                onChange={() => {}}
                disabled
                unit={distanceUnit(localPrefs.units)}
                maxValue={localPrefs.units === 'metric' ? 50 : 30}
              />
            ) : (
              <DistanceSlider
                value={ctx.distance}
                onChange={ctx.setDistance}
                onDragStart={() => setSliderActive(true)}
                onDragEnd={() => setSliderActive(false)}
                unit={distanceUnit(localPrefs.units)}
                maxValue={localPrefs.units === 'metric' ? 50 : 30}
              />
            )}
          </View>

        </View>

        {/* Fixed button area at bottom */}
        </ScrollView>
        </Animated.View>
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
          {generateError && (
            <View style={styles.errorBanner}>
              <Ionicons name="alert-circle" size={16} color={Colors.destructive} />
              <Text style={styles.errorText}>{generateError}</Text>
            </View>
          )}
        </View>
      </View>

      {/* Profile Drawer */}
      <ProfileDrawer
        visible={drawerVisible}
        onClose={() => setDrawerVisible(false)}
      />

      {/* Bottom Tab Bar */}
      <BottomTabBar />
    </KeyboardAvoidingView>
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
  },
  grabHandleArea: {
    paddingTop: 12,
    paddingBottom: 12,
    alignItems: 'center',
    justifyContent: 'center',
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
  sectionLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
    height: 34,
    justifyContent: 'center',
  },
  sliderTrackBar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.secondary,
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
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: Colors.primary,
    borderWidth: 3,
    borderColor: Colors.background,
    marginLeft: -12,
    top: 5,
  },
  sliderRangeLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 2,
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
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.destructive + '1A',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginTop: 10,
  },
  errorText: {
    flex: 1,
    fontFamily: Fonts.sans,
    fontSize: 12,
    color: Colors.destructive,
  },
});
