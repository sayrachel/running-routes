import React from 'react';
import { View, StyleSheet } from 'react-native';
import MapView, { Polyline, Marker, PROVIDER_DEFAULT } from 'react-native-maps';
import type { GeneratedRoute, RoutePoint } from '@/lib/route-generator';
import { Colors } from '@/lib/theme';

interface RouteMapProps {
  center: RoutePoint;
  routes: GeneratedRoute[];
  selectedRouteId: string | null;
}

export function RouteMap({ center, routes, selectedRouteId }: RouteMapProps) {
  const selectedRoute = routes.find((r) => r.id === selectedRouteId) ?? null;

  // Calculate region to fit the route
  let latDelta = 0.02;
  let lngDelta = 0.02;
  if (selectedRoute && selectedRoute.points.length > 1) {
    const lats = selectedRoute.points.map((p) => p.lat);
    const lngs = selectedRoute.points.map((p) => p.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    latDelta = Math.max((maxLat - minLat) * 1.5, 0.005);
    lngDelta = Math.max((maxLng - minLng) * 1.5, 0.005);
  }

  return (
    <View style={styles.container}>
      <MapView
        style={styles.map}
        provider={PROVIDER_DEFAULT}
        userInterfaceStyle="dark"
        showsUserLocation
        showsMyLocationButton={false}
        showsCompass={false}
        region={{
          latitude: center.lat,
          longitude: center.lng,
          latitudeDelta: latDelta,
          longitudeDelta: lngDelta,
        }}
      >
        {/* Route glow (wider, semi-transparent) */}
        {selectedRoute && (
          <Polyline
            coordinates={selectedRoute.points.map((p) => ({
              latitude: p.lat,
              longitude: p.lng,
            }))}
            strokeColor={Colors.primary + '33'}
            strokeWidth={10}
          />
        )}

        {/* Route line */}
        {selectedRoute && (
          <Polyline
            coordinates={selectedRoute.points.map((p) => ({
              latitude: p.lat,
              longitude: p.lng,
            }))}
            strokeColor={Colors.primary}
            strokeWidth={4}
            lineCap="round"
            lineJoin="round"
          />
        )}

        {/* Start marker */}
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
      </MapView>

      {routes.length === 0 && (
        <View style={styles.emptyOverlay}>
          <View style={styles.emptyCard}>
          </View>
        </View>
      )}
    </View>
  );
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
