/**
 * RouteForge Design Tokens
 * Extracted from running-routes-UI/app/globals.css HSL values.
 */

export const Colors = {
  background: '#0b0f14',
  foreground: '#f5f5f5',
  card: '#131921',
  cardForeground: '#f5f5f5',
  primary: '#c8ff00',
  primaryForeground: '#0b0f14',
  secondary: '#1c2430',
  secondaryForeground: '#cccccc',
  muted: '#232b36',
  mutedForeground: '#6b7a8d',
  destructive: '#ef4444',
  destructiveForeground: '#fafafa',
  border: '#232b36',
  accent: '#c8ff00',
  accentForeground: '#0b0f14',
} as const;

export const Fonts = {
  sans: 'Inter_400Regular',
  sansMedium: 'Inter_500Medium',
  sansSemiBold: 'Inter_600SemiBold',
  sansBold: 'Inter_700Bold',
  mono: 'SpaceMono_400Regular',
  monoBold: 'SpaceMono_700Bold',
} as const;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
  '4xl': 40,
} as const;

export const Radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 9999,
} as const;
