import { Platform, StyleSheet } from 'react-native';

export const colors = {
  // Backgrounds
  bgMain: '#0D0D0D',
  bgSidebar: '#1A1A1A',
  bgItem: '#1A1A1A',
  bgInput: 'rgba(255, 255, 255, 0.06)',

  // Borders
  border: 'rgba(255, 255, 255, 0.1)',
  borderLight: 'rgba(255, 255, 255, 0.05)',
  borderHighlight: 'rgba(255, 255, 255, 0.12)',

  // Text
  textPrimary: '#E8E8E8',
  textSecondary: '#999999',
  textMuted: 'rgba(255, 255, 255, 0.4)',

  // Accent — gold/amber
  accent: '#C8A946',
  accentPressed: '#B89A3A',

  // User bubble
  userBubble: '#1E1E1E',
  userBubbleBorder: 'rgba(255, 255, 255, 0.1)',

  // Assistant — no bubble
  assistantBubbleBg: 'transparent',
  assistantBubbleBorder: 'transparent',

  // Tool block
  toolBlockBg: 'rgba(255, 255, 255, 0.04)',
  toolBlockBorder: '#C8A946',

  // Status
  statusRunning: '#C8A946',
  statusComplete: '#10B981',
  statusError: '#EF4444',
  statusIdle: 'rgba(255, 255, 255, 0.4)',

  // Misc
  error: '#EF4444',
  errorBg: 'rgba(239, 68, 68, 0.15)',
  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',
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
