import { Platform } from 'react-native';

export const palette = {
  canvas: '#F4EFE6',
  panel: '#FFFCF7',
  panelMuted: '#F3E9D9',
  border: '#E7D8C1',
  ink: '#1E1A16',
  inkMuted: '#6A5F52',
  accent: '#C24B2A',
  accentPressed: '#A23D21',
  accentSoft: '#F6DCCD',
  positive: '#1E7A53',
  warning: '#B36A06',
  danger: '#B42318',
  night: '#111B27',
  nightSoft: '#1B2A39',
  info: '#235A95'
} as const;

export const radii = {
  sm: 10,
  md: 14,
  lg: 20
} as const;

export const spacing = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24
} as const;

export const fonts = {
  body: Platform.select({ ios: 'AvenirNext-Regular', android: 'sans-serif', default: 'System' }),
  heading: Platform.select({
    ios: 'AvenirNext-DemiBold',
    android: 'sans-serif-medium',
    default: 'System'
  }),
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })
} as const;

export const shadows = {
  card: {
    shadowColor: '#2A1E14',
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2
  }
} as const;
