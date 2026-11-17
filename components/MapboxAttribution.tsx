import React from 'react';
import { View, Text, Image, Pressable, StyleSheet, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Attribution for routes from Mapbox Directions (CLAUDE.md #64). Mapbox's
 * product terms require the Mapbox logo plus "© Mapbox" (linking to
 * mapbox.com/about/maps) and "© OpenStreetMap" (linking to
 * openstreetmap.org/about) wherever its results are shown, displayed
 * prominently on or next to the (here: Apple) map. Sits top-left under the
 * screen headers because bottom sheets cover the bottom of the map; Apple's
 * own logo and legal link stay where MapKit puts them.
 */
export function MapboxAttribution() {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { top: insets.top + 56 }]} pointerEvents="box-none">
      <Pressable
        onPress={() => Linking.openURL('https://www.mapbox.com/about/maps/')}
        accessibilityRole="link"
        accessibilityLabel="Directions by Mapbox"
        hitSlop={6}
      >
        <Image source={require('../assets/mapbox-logo.png')} style={styles.logo} resizeMode="contain" />
      </Pressable>
      <Text style={styles.text}>
        <Text onPress={() => Linking.openURL('https://www.mapbox.com/about/maps/')}>© Mapbox</Text>
        {'  '}
        <Text onPress={() => Linking.openURL('https://www.openstreetmap.org/about/')}>© OpenStreetMap</Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  logo: {
    width: 81,
    height: 20,
  },
  text: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.85)',
  },
});
