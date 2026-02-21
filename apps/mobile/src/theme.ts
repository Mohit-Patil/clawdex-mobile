import { Platform, StyleSheet } from 'react-native';

export const colors = {
  // Backgrounds
  bgMain: '#05050A', // Pure black context for liquid glass
  bgSidebar: 'rgba(24, 24, 27, 0.4)', // Frost for drawer
  bgItem: 'rgba(39, 39, 42, 0.35)', // Frost for cards
  bgInput: 'rgba(24, 24, 27, 0.55)', // Frost for input

  // Borders
  border: 'rgba(255, 255, 255, 0.1)',
  borderLight: 'rgba(255, 255, 255, 0.05)',
  borderHighlight: 'rgba(255, 255, 255, 0.15)',

  // Text
  textPrimary: '#FFFFFF',
  textSecondary: 'rgba(255, 255, 255, 0.85)',
  textMuted: 'rgba(255, 255, 255, 0.5)',

  // Accent
  accent: '#6366F1', // Indigo 500
  accentPressed: '#4F46E5', // Indigo 600

  // Gradients
  userBubbleStart: '#8B5CF6', // Violet 500
  userBubbleEnd: '#3B82F6', // Blue 500

  // Message bubbles
  userBubble: '#8B5CF6', // Fallback
  assistantBubbleBg: 'rgba(39, 39, 42, 0.45)',
  assistantBubbleBorder: 'rgba(255, 255, 255, 0.15)',

  // Status
  statusRunning: '#3B82F6',
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
