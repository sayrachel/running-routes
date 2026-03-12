import React from 'react';
import { View, StyleSheet } from 'react-native';
import MapView, { Polyline, Marker } from 'react-native-maps';
import type { GeneratedRoute, RoutePoint } from '@/lib/route-generator';
import { Colors } from '@/lib/theme';

interface RouteMapProps {
  center: RoutePoint;
  routes: GeneratedRoute[];
  selectedRouteId: string | null;
  /** Live GPS track coordinates to draw during a run */
  gpsTrack?: RoutePoint[];
  /** Current user position during a run */
  currentPosition?: RoutePoint | null;
}

export function RouteMap({ center, routes, selectedRouteId, gpsTrack, currentPosition }: RouteMapProps) {
  const selectedRoute = routes.find((r) => r.id === selectedRouteId) ?? null;

  let latDelta = 0.02;
  let lngDelta = 0.02;

  const allPoints: RoutePoint[] = [];
  if (selectedRoute) allPoints.push(...selectedRoute.points);
  if (gpsTrack && gpsTrack.length > 0) allPoints.push(...gpsTrack);

  if (allPoints.length > 1) {
    const lats = allPoints.map((p) => p.lat);
    const lngs = allPoints.map((p) => p.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    latDelta = Math.max((maxLat - minLat) * 1.5, 0.005);
    lngDelta = Math.max((maxLng - minLng) * 1.5, 0.005);
  }

  const mapCenter = currentPosition || center;

  return (
    <View style={styles.container}>
      <MapView
        style={styles.map}
        provider={undefined}
        userInterfaceStyle="dark"
        showsUserLocation={!currentPosition}
        showsMyLocationButton={false}
        showsCompass={false}
        region={{
          latitude: mapCenter.lat,
          longitude: mapCenter.lng,
          latitudeDelta: latDelta,
          longitudeDelta: lngDelta,
        }}
      >
        {selectedRoute && (
          <Polyline
            coordinates={selectedRoute.points.map((p: RoutePoint) => ({
              latitude: p.lat,
              longitude: p.lng,
            }))}
            strokeColor={Colors.primary + '33'}
            strokeWidth={10}
          />
        )}

        {selectedRoute && (
          <Polyline
            coordinates={selectedRoute.points.map((p: RoutePoint) => ({
              latitude: p.lat,
              longitude: p.lng,
            }))}
            strokeColor={Colors.primary}
            strokeWidth={4}
            lineCap="round"
            lineJoin="round"
          />
        )}

        {gpsTrack && gpsTrack.length > 1 && (
          <Polyline
            coordinates={gpsTrack.map((p) => ({
              latitude: p.lat,
              longitude: p.lng,
            }))}
            strokeColor="#00BFFF33"
            strokeWidth={8}
          />
        )}

        {gpsTrack && gpsTrack.length > 1 && (
          <Polyline
            coordinates={gpsTrack.map((p) => ({
              latitude: p.lat,
              longitude: p.lng,
            }))}
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
