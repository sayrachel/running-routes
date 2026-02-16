import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Colors, Fonts } from '@/lib/theme';

interface RouteTypeOptionProps {
  label: string;
  description: string;
  selected: boolean;
  onPress: () => void;
}

export function RouteTypeOption({ label, description, selected, onPress }: RouteTypeOptionProps) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.container,
        selected ? styles.containerSelected : styles.containerDefault,
      ]}
    >
      <View
        style={[
          styles.radio,
          selected ? styles.radioSelected : styles.radioDefault,
        ]}
      >
        {selected && <View style={styles.radioDot} />}
      </View>
      <View style={styles.textContainer}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.description}>{description}</Text>
      </View>
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
  containerSelected: {
    borderColor: Colors.primary + '66',
    backgroundColor: Colors.primary + '0D',
  },
  containerDefault: {
    borderColor: Colors.border,
    backgroundColor: Colors.card,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primary,
  },
  radioDefault: {
    borderColor: Colors.mutedForeground + '66',
  },
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.primaryForeground,
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
