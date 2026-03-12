import React from 'react';
import { View, StyleSheet } from 'react-native';
import type { GeneratedRoute, RoutePoint } from '@/lib/route-generator';
import { Colors } from '@/lib/theme';

interface RouteMapProps {
  center: RoutePoint;
  routes: GeneratedRoute[];
  selectedRouteId: string | null;
  gpsTrack?: RoutePoint[];
  currentPosition?: RoutePoint | null;
}

export function RouteMap({ center, routes, selectedRouteId, gpsTrack, currentPosition }: RouteMapProps) {
  const selectedRoute = routes.find((r) => r.id === selectedRouteId) ?? null;
  const mapCenter = currentPosition || center;

  const routeCoords = selectedRoute
    ? JSON.stringify(selectedRoute.points.map((p) => [p.lat, p.lng]))
    : '[]';
  const trackCoords = gpsTrack && gpsTrack.length > 1
    ? JSON.stringify(gpsTrack.map((p) => [p.lat, p.lng]))
    : '[]';

  let zoom = 14;
  const allPoints: RoutePoint[] = [];
  if (selectedRoute) allPoints.push(...selectedRoute.points);
  if (gpsTrack && gpsTrack.length > 0) allPoints.push(...gpsTrack);
  if (allPoints.length > 1) {
    const lats = allPoints.map((p) => p.lat);
    const lngs = allPoints.map((p) => p.lng);
    const latSpan = Math.max(...lats) - Math.min(...lats);
    const lngSpan = Math.max(...lngs) - Math.min(...lngs);
    const maxSpan = Math.max(latSpan, lngSpan);
    if (maxSpan > 0.1) zoom = 11;
    else if (maxSpan > 0.05) zoom = 12;
    else if (maxSpan > 0.02) zoom = 13;
    else if (maxSpan > 0.01) zoom = 14;
    else zoom = 15;
  }

  const html = `
    <!DOCTYPE html>
    <html><head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <style>
      body { margin: 0; padding: 0; }
      #map { width: 100%; height: 100vh; }
    </style>
    </head><body>
    <div id="map"></div>
    <script>
      var map = L.map('map', { zoomControl: false }).setView([${mapCenter.lat}, ${mapCenter.lng}], ${zoom});
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '© OpenStreetMap © CARTO',
        maxZoom: 19
      }).addTo(map);

      var routeCoords = ${routeCoords};
      var trackCoords = ${trackCoords};

      if (routeCoords.length > 1) {
        L.polyline(routeCoords, { color: '${Colors.primary}', weight: 4, opacity: 0.9 }).addTo(map);
        L.polyline(routeCoords, { color: '${Colors.primary}', weight: 10, opacity: 0.15 }).addTo(map);
        map.fitBounds(L.polyline(routeCoords).getBounds().pad(0.15));
      }

      if (trackCoords.length > 1) {
        L.polyline(trackCoords, { color: '#00BFFF', weight: 3, opacity: 0.9 }).addTo(map);
      }

      L.circleMarker([${center.lat}, ${center.lng}], {
        radius: 8, fillColor: '${Colors.primary}', color: '#0b0f14', weight: 3, fillOpacity: 1
      }).addTo(map);

      ${currentPosition ? `
        L.circleMarker([${currentPosition.lat}, ${currentPosition.lng}], {
          radius: 7, fillColor: '#00BFFF', color: '#0b0f14', weight: 3, fillOpacity: 1
        }).addTo(map);
      ` : ''}
    </script>
    </body></html>
  `;

  return (
    <View style={styles.container}>
      <iframe
        srcDoc={html}
        style={{ width: '100%', height: '100%', border: 'none' } as any}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
