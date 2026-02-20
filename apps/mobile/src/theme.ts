import { Platform, StyleSheet } from 'react-native';

export const colors = {
  // Backgrounds
  bgMain:    '#0D1117',
  bgSidebar: '#161B22',
  bgItem:    '#21262D',
  bgInput:   '#161B22',

  // Borders
  border:    '#30363D',

  // Text
  textPrimary: '#E6EDF3',
  textMuted:   '#8B949E',

  // Accent
  accent:        '#E5622A',
  accentPressed: '#C44E1F',

  // Message bubbles
  userBubble: '#1C2128',

  // Status
  statusRunning:  '#3B82F6',
  statusComplete: '#22C55E',
  statusError:    '#EF4444',
  statusIdle:     '#6B7280',

  // Misc
  error:   '#EF4444',
  errorBg: 'rgba(239, 68, 68, 0.1)',
  white:   '#FFFFFF',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  full: 999,
};

export const shadow = StyleSheet.create({
  sm: Platform.select({
    ios: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.3,
      shadowRadius: 6,
    },
    default: { elevation: 3 },
  }) as object,
});

export const typography = {
  largeTitle: {
    fontSize: 24,
    fontWeight: '700' as const,
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },
  headline: {
    fontSize: 15,
    fontWeight: '600' as const,
    color: colors.textPrimary,
  },
  body: {
    fontSize: 14,
    fontWeight: '400' as const,
    color: colors.textPrimary,
    lineHeight: 20,
  },
  caption: {
    fontSize: 12,
    fontWeight: '400' as const,
    color: colors.textMuted,
  },
  mono: {
    fontSize: 12,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    color: colors.textPrimary,
    lineHeight: 18,
  },
};
