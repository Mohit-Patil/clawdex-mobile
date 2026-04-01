import {
  createContext,
  createElement,
  useContext,
  useMemo,
  type PropsWithChildren,
} from 'react';
import {
  Platform,
  type ColorSchemeName,
  type TextStyle,
} from 'react-native';

export type AppearancePreference = 'system' | 'light' | 'dark';
export type ThemeMode = 'light' | 'dark';

export interface AppColors {
  bgMain: string;
  bgSidebar: string;
  bgItem: string;
  bgInput: string;
  bgElevated: string;
  bgCanvasAccent: string;
  border: string;
  borderLight: string;
  borderHighlight: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentPressed: string;
  accentText: string;
  userBubble: string;
  userBubbleBorder: string;
  assistantBubbleBg: string;
  assistantBubbleBorder: string;
  inlineCodeBg: string;
  inlineCodeBorder: string;
  inlineCodeText: string;
  toolBlockBg: string;
  toolBlockBorder: string;
  statusRunning: string;
  statusComplete: string;
  statusError: string;
  statusIdle: string;
  warning: string;
  warningBg: string;
  error: string;
  errorBg: string;
  shadow: string;
  overlayBackdrop: string;
  white: string;
  black: string;
  transparent: string;
}

export type AppTypography = {
  largeTitle: TextStyle;
  headline: TextStyle;
  body: TextStyle;
  caption: TextStyle;
  mono: TextStyle;
};

export interface AppTheme {
  mode: ThemeMode;
  isDark: boolean;
  colors: AppColors;
  spacing: typeof spacing;
  radius: typeof radius;
  shadow: typeof shadow;
  typography: AppTypography;
  keyboardAppearance: 'light' | 'dark';
  blurTint: 'light' | 'dark';
  activityBarTint: 'light' | 'dark' | 'systemUltraThinMaterialLight' | 'systemUltraThinMaterialDark';
  statusBarStyle: 'dark-content' | 'light-content';
}

const darkColors: AppColors = {
  bgMain: '#000000',
  bgSidebar: '#0C0D10',
  bgItem: '#1B1D21',
  bgInput: '#23262B',
  bgElevated: '#0E1116',
  bgCanvasAccent: 'rgba(255, 255, 255, 0.04)',
  border: 'rgba(255, 255, 255, 0.18)',
  borderLight: 'rgba(255, 255, 255, 0.12)',
  borderHighlight: 'rgba(255, 255, 255, 0.28)',
  textPrimary: '#F3F4F8',
  textSecondary: '#D0D5DF',
  textMuted: 'rgba(232, 236, 244, 0.74)',
  accent: '#B5BDCC',
  accentPressed: '#9CA5B7',
  accentText: '#000000',
  userBubble: '#262A31',
  userBubbleBorder: 'rgba(212, 219, 232, 0.32)',
  assistantBubbleBg: 'transparent',
  assistantBubbleBorder: 'transparent',
  inlineCodeBg: '#2A303A',
  inlineCodeBorder: 'rgba(197, 206, 223, 0.42)',
  inlineCodeText: '#EEF2FB',
  toolBlockBg: 'rgba(255, 255, 255, 0.09)',
  toolBlockBorder: '#5A6376',
  statusRunning: '#C2C9D8',
  statusComplete: '#C6CDD9',
  statusError: '#EF4444',
  statusIdle: '#B4BCCB',
  warning: '#F7D27E',
  warningBg: 'rgba(247, 210, 126, 0.08)',
  error: '#EF4444',
  errorBg: 'rgba(239, 68, 68, 0.15)',
  shadow: '#000000',
  overlayBackdrop: 'rgba(0, 0, 0, 0.52)',
  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',
};

const lightColors: AppColors = {
  bgMain: '#DDE7F0',
  bgSidebar: '#D2DCE7',
  bgItem: '#F3F7FB',
  bgInput: '#EAF0F6',
  bgElevated: '#F6F9FC',
  bgCanvasAccent: 'rgba(41, 58, 84, 0.09)',
  border: 'rgba(44, 62, 88, 0.22)',
  borderLight: 'rgba(44, 62, 88, 0.16)',
  borderHighlight: 'rgba(67, 96, 126, 0.34)',
  textPrimary: '#102030',
  textSecondary: '#203A55',
  textMuted: 'rgba(44, 62, 88, 0.82)',
  accent: '#384F6A',
  accentPressed: '#293E56',
  accentText: '#FFFFFF',
  userBubble: '#EFF3F7',
  userBubbleBorder: 'rgba(67, 96, 126, 0.24)',
  assistantBubbleBg: 'transparent',
  assistantBubbleBorder: 'transparent',
  inlineCodeBg: '#DFE8F2',
  inlineCodeBorder: 'rgba(70, 96, 126, 0.30)',
  inlineCodeText: '#102030',
  toolBlockBg: 'rgba(67, 96, 126, 0.12)',
  toolBlockBorder: '#7289A4',
  statusRunning: '#3C5674',
  statusComplete: '#0E9F6E',
  statusError: '#D92D20',
  statusIdle: '#566C87',
  warning: '#C56A12',
  warningBg: 'rgba(197, 106, 18, 0.14)',
  error: '#D92D20',
  errorBg: 'rgba(217, 45, 32, 0.10)',
  shadow: '#0F1F36',
  overlayBackdrop: 'rgba(15, 31, 54, 0.20)',
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

export const shadow = {
  sm: {
    boxShadow: '0px 2px 6px rgba(0, 0, 0, 0.3)',
  },
} as const;

function createTypography(colors: AppColors): AppTypography {
  return {
    largeTitle: {
      fontSize: 24,
      fontWeight: '700',
      color: colors.textPrimary,
      letterSpacing: -0.3,
    },
    headline: {
      fontSize: 15,
      fontWeight: '600',
      color: colors.textPrimary,
    },
    body: {
      fontSize: 14,
      fontWeight: '400',
      color: colors.textPrimary,
      lineHeight: 20,
    },
    caption: {
      fontSize: 12,
      fontWeight: '400',
      color: colors.textMuted,
    },
    mono: {
      fontSize: 12,
      fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
      color: colors.textPrimary,
      lineHeight: 18,
    },
  };
}

export function resolveThemeMode(
  preference: AppearancePreference,
  systemScheme: ColorSchemeName
): ThemeMode {
  if (preference === 'light' || preference === 'dark') {
    return preference;
  }

  return systemScheme === 'light' ? 'light' : 'dark';
}

export function createAppTheme(mode: ThemeMode): AppTheme {
  const colors = mode === 'light' ? lightColors : darkColors;
  const isDark = mode === 'dark';
  return {
    mode,
    isDark,
    colors,
    spacing,
    radius,
    shadow,
    typography: createTypography(colors),
    keyboardAppearance: isDark ? 'dark' : 'light',
    blurTint: isDark ? 'dark' : 'light',
    activityBarTint: Platform.OS === 'ios'
      ? isDark
        ? 'systemUltraThinMaterialDark'
        : 'systemUltraThinMaterialLight'
      : isDark
        ? 'dark'
        : 'light',
    statusBarStyle: isDark ? 'light-content' : 'dark-content',
  };
}

const fallbackTheme = createAppTheme('dark');
export const colors: AppColors = { ...fallbackTheme.colors };
export const typography: AppTypography = { ...fallbackTheme.typography };

const AppThemeContext = createContext<AppTheme>(fallbackTheme);

export function AppThemeProvider({
  theme,
  children,
}: PropsWithChildren<{ theme: AppTheme }>) {
  Object.assign(colors, theme.colors);
  Object.assign(typography, theme.typography);
  return createElement(AppThemeContext.Provider, { value: theme }, children);
}

export function useAppTheme(): AppTheme {
  return useContext(AppThemeContext);
}

export function useThemeStyles<T>(factory: (theme: AppTheme) => T): T {
  const theme = useAppTheme();
  return useMemo(() => factory(theme), [factory, theme]);
}
