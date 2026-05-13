import React, { useRef, useEffect, useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import MapView, { Polyline, Marker } from 'react-native-maps';
import { Ionicons } from '@expo/vector-icons';
import type { GeneratedRoute, RoutePoint, ManeuverStep } from '@/lib/route-generator';
import { Colors } from '@/lib/theme';

interface RouteMapProps {
  center: RoutePoint;
  routes: GeneratedRoute[];
  selectedRouteId: string | null;
  /** Live GPS track coordinates to draw during a run */
  gpsTrack?: RoutePoint[];
  /** Current user position during a run */
  currentPosition?: RoutePoint | null;
  /** When set, a directional arrow marker is rendered at the next maneuver
   *  point — the visual half of turn-by-turn navigation. Pass null when no
   *  step is active (idle / finished / between routes / off-route). */
  nextManeuver?: ManeuverStep | null;
  /** Fires when the user pans/zooms to a new region. Receives the lat/lng
   *  of the new region center. The Setup screen wires this to Overpass
   *  prefetch so panning to a new neighborhood pre-populates the cache
   *  before Generate is tapped. */
  onRegionChanged?: (center: RoutePoint) => void;
}

function RouteMapImpl({ center, routes, selectedRouteId, gpsTrack, currentPosition, nextManeuver, onRegionChanged }: RouteMapProps) {
  const selectedRoute = routes.find((r) => r.id === selectedRouteId) ?? null;

  // Convert {lat, lng} → {latitude, longitude} once per route/track change.
  // Without this, every render rebuilds the array — costly during a run when
  // gpsTrack grows to hundreds of points and the map re-renders frequently.
  const selectedRouteCoords = useMemo(
    () => selectedRoute?.points.map((p: RoutePoint) => ({ latitude: p.lat, longitude: p.lng })) ?? null,
    [selectedRoute],
  );
  const gpsTrackCoords = useMemo(
    () => gpsTrack?.map((p) => ({ latitude: p.lat, longitude: p.lng })) ?? null,
    [gpsTrack],
  );

  // Recompute region whenever the underlying inputs change. Memoized so
  // the useEffect below doesn't re-fire on unrelated re-renders.
  const region = useMemo(() => {
    let latDelta = 0.02;
    let lngDelta = 0.02;
    const allPoints: RoutePoint[] = [];
    if (selectedRoute) allPoints.push(...selectedRoute.points);
    if (gpsTrack && gpsTrack.length > 0) allPoints.push(...gpsTrack);
    if (allPoints.length > 1) {
      const lats = allPoints.map((p) => p.lat);
      const lngs = allPoints.map((p) => p.lng);
      latDelta = Math.max((Math.max(...lats) - Math.min(...lats)) * 1.5, 0.005);
      lngDelta = Math.max((Math.max(...lngs) - Math.min(...lngs)) * 1.5, 0.005);
    }
    const mapCenter = currentPosition || center;
    return {
      latitude: mapCenter.lat,
      longitude: mapCenter.lng,
      latitudeDelta: latDelta,
      longitudeDelta: lngDelta,
    };
  }, [selectedRoute, gpsTrack, currentPosition, center]);

  // Animate camera on region changes after first mount. Setting `region`
  // as a controlled prop on MapView caused abrupt single-frame snaps
  // when the route changed — refresh would jump straight from the old
  // route's bounds to the new route's bounds, which read as a glitch
  // ("a route flashes for a second then updates to the actual route").
  // Using `initialRegion` for first paint and `animateToRegion` for
  // subsequent changes gives a smooth ~400ms transition.
  const mapRef = useRef<MapView>(null);
  const isFirstMountRef = useRef(true);
  useEffect(() => {
    if (isFirstMountRef.current) {
      isFirstMountRef.current = false;
      return;
    }
    mapRef.current?.animateToRegion(region, 400);
  }, [region]);

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={undefined}
        userInterfaceStyle="dark"
        showsUserLocation={!currentPosition}
        showsMyLocationButton={false}
        showsCompass={false}
        initialRegion={region}
        onRegionChangeComplete={onRegionChanged ? (r) => {
          // Fires after the user finishes a pan/zoom gesture (or after
          // animateToRegion settles). Our own animateToRegion call (above)
          // would trigger this too, which is fine — the Setup-screen
          // listener debounces and the prefetch is idempotent (cache hit).
          onRegionChanged({ lat: r.latitude, lng: r.longitude });
        } : undefined}
      >
        {selectedRouteCoords && (
          <Polyline
            coordinates={selectedRouteCoords}
            strokeColor={Colors.primary + '33'}
            strokeWidth={10}
          />
        )}

        {selectedRouteCoords && (
          <Polyline
            coordinates={selectedRouteCoords}
            strokeColor={Colors.primary}
            strokeWidth={4}
            lineCap="round"
            lineJoin="round"
          />
        )}

        {gpsTrackCoords && gpsTrackCoords.length > 1 && (
          <Polyline
            coordinates={gpsTrackCoords}
            strokeColor="#00BFFF33"
            strokeWidth={8}
          />
        )}

        {gpsTrackCoords && gpsTrackCoords.length > 1 && (
          <Polyline
            coordinates={gpsTrackCoords}
            strokeColor="#00BFFF"
            strokeWidth={3}
            lineCap="round"
            lineJoin="round"
          />
        )}

        {currentPosition && (
          <Marker
            coordinate={{
              latitude: currentPosition.lat,
              longitude: currentPosition.lng,
            }}
            anchor={{ x: 0.5, y: 0.5 }}
          >
            <View style={styles.currentPosContainer}>
              <View style={styles.currentPosGlow} />
              <View style={styles.currentPosBody} />
            </View>
          </Marker>
        )}

        <Marker
          coordinate={{ latitude: center.lat, longitude: center.lng }}
          anchor={{ x: 0.5, y: 0.5 }}
        >
          <View style={styles.markerContainer}>
            <View style={styles.markerGlowOuter} />
            <View style={styles.markerGlowInner} />
            <View style={styles.markerBody}>
              <View style={styles.markerDot} />
            </View>
          </View>
        </Marker>

        {nextManeuver && (
          <Marker
            coordinate={{ latitude: nextManeuver.location.lat, longitude: nextManeuver.location.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            // Stable id so the marker is reused (not re-mounted) when the
            // maneuver is the same step across renders. Coord-based key
            // means a different step gets a fresh marker.
            identifier={`maneuver-${nextManeuver.location.lat.toFixed(5)},${nextManeuver.location.lng.toFixed(5)}`}
          >
            <View style={styles.maneuverContainer}>
              <Ionicons
                name={iconForManeuver(nextManeuver)}
                size={18}
                color={Colors.primaryForeground}
              />
            </View>
          </Marker>
        )}
      </MapView>

      {routes.length === 0 && !gpsTrack?.length && (
        <View style={styles.emptyOverlay}>
          <View style={styles.emptyCard}>
          </View>
        </View>
      )}
    </View>
  );
}

// Custom equality: skip re-render unless something visible changed.
// Route ids are uniquely generated per generation, so id-equality covers
// "same route data." gpsTrack length is the only thing that changes during
// a run (we only ever append). currentPosition lat/lng catch live position
// movement. center catches start-marker repositioning.
export const RouteMap = React.memo(RouteMapImpl, (prev, next) => {
  if (prev.selectedRouteId !== next.selectedRouteId) return false;
  if (prev.routes.length !== next.routes.length) return false;
  if ((prev.gpsTrack?.length ?? 0) !== (next.gpsTrack?.length ?? 0)) return false;
  if (prev.currentPosition?.lat !== next.currentPosition?.lat) return false;
  if (prev.currentPosition?.lng !== next.currentPosition?.lng) return false;
  if (prev.center.lat !== next.center.lat) return false;
  if (prev.center.lng !== next.center.lng) return false;
  // Re-render when the next-maneuver target changes (different turn point)
  // or when it appears/disappears (started/stopped running, off-route flip).
  if ((prev.nextManeuver?.location.lat ?? null) !== (next.nextManeuver?.location.lat ?? null)) return false;
  if ((prev.nextManeuver?.location.lng ?? null) !== (next.nextManeuver?.location.lng ?? null)) return false;
  return true;
});

function iconForManeuver(step: ManeuverStep): React.ComponentProps<typeof Ionicons>['name'] {
  const m = step.modifier ?? '';
  if (m === 'uturn') return 'return-down-back';
  if (m === 'sharp left') return 'arrow-back';
  if (m === 'sharp right') return 'arrow-forward';
  if (m === 'slight left' || m === 'left') return 'arrow-back-outline';
  if (m === 'slight right' || m === 'right') return 'arrow-forward-outline';
  if (m === 'straight') return 'arrow-up-outline';
  if (step.type === 'fork') return 'git-branch-outline';
  if (step.type === 'roundabout' || step.type === 'rotary') return 'sync-outline';
  return 'arrow-up-outline';
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  map: {
    flex: 1,
  },
  markerContainer: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markerGlowOuter: {
    position: 'absolute',
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primary + '14',
  },
  markerGlowInner: {
    position: 'absolute',
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.primary + '26',
  },
  markerBody: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: Colors.primary,
    borderWidth: 3,
    borderColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markerDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: Colors.background,
  },
  currentPosContainer: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  currentPosGlow: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#00BFFF33',
  },
  currentPosBody: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#00BFFF',
    borderWidth: 3,
    borderColor: Colors.background,
  },
  maneuverContainer: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.background,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  emptyOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  emptyCard: {
    borderRadius: 16,
    backgroundColor: Colors.card + '66',
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
});
