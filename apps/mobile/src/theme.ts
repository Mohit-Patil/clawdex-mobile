import { Platform, StyleSheet } from 'react-native';

export const colors = {
  // Backgrounds
  bgMain: '#000000',
  bgSidebar: '#0C0D10',
  bgItem: '#1B1D21',
  bgInput: '#23262B',

  // Borders
  border: 'rgba(255, 255, 255, 0.18)',
  borderLight: 'rgba(255, 255, 255, 0.12)',
  borderHighlight: 'rgba(255, 255, 255, 0.28)',

  // Text
  textPrimary: '#F3F4F8',
  textSecondary: '#D0D5DF',
  textMuted: 'rgba(232, 236, 244, 0.74)',

  // Accent
  accent: '#B5BDCC',
  accentPressed: '#9CA5B7',

  // User bubble
  userBubble: '#262A31',
  userBubbleBorder: 'rgba(212, 219, 232, 0.32)',

  // Assistant — no bubble
  assistantBubbleBg: 'transparent',
  assistantBubbleBorder: 'transparent',

  // Inline/code highlight
  inlineCodeBg: '#2A303A',
  inlineCodeBorder: 'rgba(197, 206, 223, 0.42)',
  inlineCodeText: '#EEF2FB',

  // Tool block
  toolBlockBg: 'rgba(255, 255, 255, 0.09)',
  toolBlockBorder: '#5A6376',

  // Status
  statusRunning: '#C2C9D8',
  statusComplete: '#C6CDD9',
  statusError: '#EF4444',
  statusIdle: '#B4BCCB',

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
