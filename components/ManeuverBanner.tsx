import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Fonts } from '@/lib/theme';
import type { ManeuverStep } from '@/lib/route-generator';
import type { UnitSystem } from '@/lib/units';

interface Props {
  step: ManeuverStep;
  distanceM: number;
  units: UnitSystem;
}

/** Strava-Premium-style top banner for the next maneuver: arrow icon +
 *  distance + (optional) street name. Bare "Turn right" when the OSM way is
 *  unnamed — same fallback Strava uses. */
export function ManeuverBanner({ step, distanceM, units }: Props) {
  const iconName = iconForStep(step);
  const actionLabel = labelForStep(step);
  const distanceLabel = formatApproachDistance(distanceM, units);

  return (
    <View style={styles.container}>
      <View style={styles.iconBubble}>
        <Ionicons name={iconName} size={22} color={Colors.primaryForeground} />
      </View>
      <View style={styles.textCol}>
        <Text style={styles.distance}>{distanceLabel}</Text>
        <Text style={styles.action} numberOfLines={1}>
          {actionLabel}
          {step.name ? <Text style={styles.onto}> onto {step.name}</Text> : null}
        </Text>
      </View>
    </View>
  );
}

function iconForStep(step: ManeuverStep): React.ComponentProps<typeof Ionicons>['name'] {
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

function labelForStep(step: ManeuverStep): string {
  const m = step.modifier ?? '';
  if (m === 'uturn') return 'Make a U-turn';
  if (m === 'sharp left') return 'Sharp left';
  if (m === 'sharp right') return 'Sharp right';
  if (m === 'slight left') return 'Bear left';
  if (m === 'slight right') return 'Bear right';
  if (m === 'left') return 'Turn left';
  if (m === 'right') return 'Turn right';
  if (m === 'straight') return 'Continue straight';
  if (step.type === 'fork') return 'Take the fork';
  if (step.type === 'merge') return 'Merge';
  if (step.type === 'roundabout' || step.type === 'rotary') return 'Enter the roundabout';
  if (step.type === 'continue') return 'Continue';
  return 'Turn';
}

function formatApproachDistance(m: number, units: UnitSystem): string {
  if (m <= 10) return 'Now';
  if (units === 'imperial') {
    const ft = m * 3.28084;
    if (ft < 528) {
      // < 0.1 mi — show feet, rounded to 50.
      const rounded = Math.max(50, Math.round(ft / 50) * 50);
      return `${rounded} ft`;
    }
    const mi = m / 1609.34;
    return `${mi < 0.2 ? mi.toFixed(2) : mi.toFixed(1)} mi`;
  }
  if (m < 1000) {
    const rounded = Math.max(10, Math.round(m / 10) * 10);
    return `${rounded} m`;
  }
  const km = m / 1000;
  return `${km < 1.5 ? km.toFixed(2) : km.toFixed(1)} km`;
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: 'rgba(20, 20, 24, 0.92)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    marginHorizontal: 12,
    marginTop: 8,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  iconBubble: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textCol: {
    flex: 1,
    minWidth: 0,
  },
  distance: {
    color: Colors.primaryForeground,
    fontSize: 18,
    fontFamily: Fonts.sansBold,
    lineHeight: 22,
  },
  action: {
    color: Colors.primaryForeground,
    fontSize: 13,
    fontFamily: Fonts.sans,
    opacity: 0.85,
    lineHeight: 17,
  },
  onto: {
    opacity: 0.7,
  },
});
