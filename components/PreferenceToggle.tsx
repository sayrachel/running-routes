import React from 'react';
import { View, Text, Switch, StyleSheet, Pressable } from 'react-native';
import { Colors, Fonts } from '@/lib/theme';

interface PreferenceToggleProps {
  icon: React.ReactNode;
  label: string;
  description: string;
  value: boolean;
  onToggle: () => void;
}

export function PreferenceToggle({ icon, label, description, value, onToggle }: PreferenceToggleProps) {
  return (
    <Pressable
      onPress={onToggle}
      style={[
        styles.container,
        value ? styles.containerActive : styles.containerInactive,
      ]}
    >
      <View style={[styles.iconBox, value ? styles.iconBoxActive : styles.iconBoxInactive]}>
        {icon}
      </View>
      <View style={styles.textContainer}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.description}>{description}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={onToggle}
        trackColor={{ false: Colors.secondary, true: Colors.primary }}
        thumbColor={value ? Colors.primaryForeground : Colors.mutedForeground}
        ios_backgroundColor={Colors.secondary}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
  },
  containerActive: {
    borderColor: Colors.primary + '4D',
    backgroundColor: Colors.primary + '0D',
  },
  containerInactive: {
    borderColor: Colors.border,
    backgroundColor: Colors.card,
  },
  iconBox: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBoxActive: {
    backgroundColor: Colors.primary + '26',
  },
  iconBoxInactive: {
    backgroundColor: Colors.secondary,
  },
  textContainer: {
    flex: 1,
  },
  label: {
    fontFamily: Fonts.sansSemiBold,
    fontSize: 14,
    color: Colors.foreground,
  },
  description: {
    fontFamily: Fonts.sans,
    fontSize: 11,
    color: Colors.mutedForeground,
    marginTop: 1,
  },
});
