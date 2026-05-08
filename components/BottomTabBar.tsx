import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, usePathname } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Colors, Fonts } from '@/lib/theme';

type TabKey = 'plan' | 'run' | 'saved';

// Each tab provides its own render fn so the Run tab can pull from
// MaterialCommunityIcons (the only set with a true running pose that
// matches the app icon — Ionicons only ships `walk`).
const TABS: { key: TabKey; label: string; render: (color: string, active: boolean) => React.ReactNode; route: string }[] = [
  {
    key: 'plan',
    label: 'Plan',
    render: (color, active) => <Ionicons name={active ? 'map' : 'map-outline'} size={22} color={color} />,
    route: '/',
  },
  {
    key: 'run',
    label: 'Run',
    render: (color) => <MaterialCommunityIcons name="run" size={24} color={color} />,
    route: '/run',
  },
  {
    key: 'saved',
    label: 'Saved',
    render: (color, active) => <Ionicons name={active ? 'bookmark' : 'bookmark-outline'} size={22} color={color} />,
    route: '/saved',
  },
];

export function BottomTabBar() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();

  const activeTab: TabKey = pathname === '/run' ? 'run' : pathname === '/saved' ? 'saved' : 'plan';

  const handleTabPress = (tab: typeof TABS[0]) => {
    if (tab.key === activeTab) return;
    router.replace(tab.route as any);
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
            {tab.render(isActive ? Colors.primary : Colors.mutedForeground, isActive)}
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
