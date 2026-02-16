import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { GeneratedRoute, RoutePoint } from '@/lib/route-generator';
import { Colors, Fonts } from '@/lib/theme';

interface RouteMapProps {
  center: RoutePoint;
  routes: GeneratedRoute[];
  selectedRouteId: string | null;
}

export function RouteMap({ center, routes, selectedRouteId }: RouteMapProps) {

  return (
    <View style={styles.container}>
      <View style={styles.mapPlaceholder}>
        <Text style={styles.icon}>🗺️</Text>
        <Text style={styles.title}>Map View</Text>
        <Text style={styles.subtitle}>
          Native maps are not available on web.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  mapPlaceholder: {
    flex: 1,
    backgroundColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  icon: {
    fontSize: 48,
    marginBottom: 16,
  },
  title: {
    fontFamily: Fonts.sansBold,
    fontSize: 18,
    color: Colors.foreground,
    marginBottom: 4,
  },
  subtitle: {
    fontFamily: Fonts.sans,
    fontSize: 13,
    color: Colors.mutedForeground,
    textAlign: 'center',
  },
});
