import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, usePathname } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Fonts } from '@/lib/theme';

type TabKey = 'plan' | 'run';

const TABS: { key: TabKey; label: string; icon: keyof typeof Ionicons.glyphMap; activeIcon: keyof typeof Ionicons.glyphMap; route: string }[] = [
  { key: 'plan', label: 'Plan', icon: 'map-outline', activeIcon: 'map', route: '/' },
  { key: 'run', label: 'Run', icon: 'stats-chart-outline', activeIcon: 'stats-chart', route: '/run' },
];

export function BottomTabBar() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();

  const activeTab: TabKey = pathname === '/run' ? 'run' : 'plan';

  const handleTabPress = (tab: typeof TABS[0]) => {
    if (tab.key === activeTab) return;
    if (tab.key === 'plan') {
      router.replace('/');
    } else {
      router.replace('/run');
    }
  };

  return (
    <View style={[styles.container, { paddingBottom: Math.max(insets.bottom, 8) }]}>
      {TABS.map((tab) => {
        const isActive = tab.key === activeTab;
        return (
          <Pressable
            key={tab.key}
            onPress={() => handleTabPress(tab)}
            style={styles.tab}
          >
            <Ionicons
              name={isActive ? tab.activeIcon : tab.icon}
              size={22}
              color={isActive ? Colors.primary : Colors.mutedForeground}
            />
            <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    backgroundColor: Colors.card,
    paddingTop: 8,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 4,
  },
  tabLabel: {
    fontFamily: Fonts.sansMedium,
    fontSize: 11,
    color: Colors.mutedForeground,
  },
  tabLabelActive: {
    color: Colors.primary,
    fontFamily: Fonts.sansBold,
  },
});
