import { Platform } from 'react-native';

export type FontPreference =
  | 'system'
  | 'ibmPlex'
  | 'spaceGrotesk'
  | 'jetbrainsMono'
  | 'sourceCodePro'
  | 'firaCode'
  | 'spaceMono';

export interface AppFontFamilies {
  regular?: string;
  medium?: string;
  semibold?: string;
  bold?: string;
  monoRegular: string;
  monoMedium: string;
  monoBold: string;
}

export interface FontPreferenceOption {
  key: FontPreference;
  title: string;
  description: string;
}

export const DEFAULT_FONT_PREFERENCE: FontPreference = 'system';

const SYSTEM_MONO_FAMILY = Platform.select({ ios: 'Menlo', default: 'monospace' }) ?? 'monospace';

const FONT_FAMILIES: Record<FontPreference, AppFontFamilies> = {
  system: {
    monoRegular: SYSTEM_MONO_FAMILY,
    monoMedium: SYSTEM_MONO_FAMILY,
    monoBold: SYSTEM_MONO_FAMILY,
  },
  ibmPlex: {
    regular: 'IBMPlexSans_400Regular',
    medium: 'IBMPlexSans_500Medium',
    semibold: 'IBMPlexSans_600SemiBold',
    bold: 'IBMPlexSans_700Bold',
    monoRegular: 'IBMPlexMono_400Regular',
    monoMedium: 'IBMPlexMono_500Medium',
    monoBold: 'IBMPlexMono_700Bold',
  },
  spaceGrotesk: {
    regular: 'SpaceGrotesk_400Regular',
    medium: 'SpaceGrotesk_500Medium',
    semibold: 'SpaceGrotesk_600SemiBold',
    bold: 'SpaceGrotesk_700Bold',
    monoRegular: 'JetBrainsMono_400Regular',
    monoMedium: 'JetBrainsMono_500Medium',
    monoBold: 'JetBrainsMono_700Bold',
  },
  jetbrainsMono: {
    regular: 'JetBrainsMono_400Regular',
    medium: 'JetBrainsMono_500Medium',
    semibold: 'JetBrainsMono_600SemiBold',
    bold: 'JetBrainsMono_700Bold',
    monoRegular: 'JetBrainsMono_400Regular',
    monoMedium: 'JetBrainsMono_500Medium',
    monoBold: 'JetBrainsMono_700Bold',
  },
  sourceCodePro: {
    regular: 'SourceCodePro_400Regular',
    medium: 'SourceCodePro_500Medium',
    semibold: 'SourceCodePro_600SemiBold',
    bold: 'SourceCodePro_700Bold',
    monoRegular: 'SourceCodePro_400Regular',
    monoMedium: 'SourceCodePro_500Medium',
    monoBold: 'SourceCodePro_700Bold',
  },
  firaCode: {
    regular: 'FiraCode_400Regular',
    medium: 'FiraCode_500Medium',
    semibold: 'FiraCode_600SemiBold',
    bold: 'FiraCode_700Bold',
    monoRegular: 'FiraCode_400Regular',
    monoMedium: 'FiraCode_500Medium',
    monoBold: 'FiraCode_700Bold',
  },
  spaceMono: {
    regular: 'SpaceMono_400Regular',
    medium: 'SpaceMono_400Regular',
    semibold: 'SpaceMono_700Bold',
    bold: 'SpaceMono_700Bold',
    monoRegular: 'SpaceMono_400Regular',
    monoMedium: 'SpaceMono_400Regular',
    monoBold: 'SpaceMono_700Bold',
  },
};

export const FONT_PREFERENCE_OPTIONS: readonly FontPreferenceOption[] = [
  {
    key: 'system',
    title: 'System',
    description: 'Keep the platform default UI font stack.',
  },
  {
    key: 'ibmPlex',
    title: 'IBM Plex',
    description: 'Balanced, readable text with a technical mono companion.',
  },
  {
    key: 'spaceGrotesk',
    title: 'Space Grotesk',
    description: 'Sharper geometric text paired with JetBrains Mono.',
  },
  {
    key: 'jetbrainsMono',
    title: 'JetBrains Mono',
    description: 'A full technical mono treatment across the app.',
  },
  {
    key: 'sourceCodePro',
    title: 'Source Code Pro',
    description: 'Clean and neutral, with a classic editor feel.',
  },
  {
    key: 'firaCode',
    title: 'Fira Code',
    description: 'A sharper coding face with familiar developer character.',
  },
  {
    key: 'spaceMono',
    title: 'Space Mono',
    description: 'Retro and expressive, but still readable in compact UI.',
  },
] as const;

export const APP_FONT_ASSETS = {
  IBMPlexSans_400Regular: require('@expo-google-fonts/ibm-plex-sans/400Regular/IBMPlexSans_400Regular.ttf'),
  IBMPlexSans_500Medium: require('@expo-google-fonts/ibm-plex-sans/500Medium/IBMPlexSans_500Medium.ttf'),
  IBMPlexSans_600SemiBold: require('@expo-google-fonts/ibm-plex-sans/600SemiBold/IBMPlexSans_600SemiBold.ttf'),
  IBMPlexSans_700Bold: require('@expo-google-fonts/ibm-plex-sans/700Bold/IBMPlexSans_700Bold.ttf'),
  IBMPlexMono_400Regular: require('@expo-google-fonts/ibm-plex-mono/400Regular/IBMPlexMono_400Regular.ttf'),
  IBMPlexMono_500Medium: require('@expo-google-fonts/ibm-plex-mono/500Medium/IBMPlexMono_500Medium.ttf'),
  IBMPlexMono_700Bold: require('@expo-google-fonts/ibm-plex-mono/700Bold/IBMPlexMono_700Bold.ttf'),
  SpaceGrotesk_400Regular: require('@expo-google-fonts/space-grotesk/400Regular/SpaceGrotesk_400Regular.ttf'),
  SpaceGrotesk_500Medium: require('@expo-google-fonts/space-grotesk/500Medium/SpaceGrotesk_500Medium.ttf'),
  SpaceGrotesk_600SemiBold: require('@expo-google-fonts/space-grotesk/600SemiBold/SpaceGrotesk_600SemiBold.ttf'),
  SpaceGrotesk_700Bold: require('@expo-google-fonts/space-grotesk/700Bold/SpaceGrotesk_700Bold.ttf'),
  JetBrainsMono_400Regular: require('@expo-google-fonts/jetbrains-mono/400Regular/JetBrainsMono_400Regular.ttf'),
  JetBrainsMono_500Medium: require('@expo-google-fonts/jetbrains-mono/500Medium/JetBrainsMono_500Medium.ttf'),
  JetBrainsMono_600SemiBold: require('@expo-google-fonts/jetbrains-mono/600SemiBold/JetBrainsMono_600SemiBold.ttf'),
  JetBrainsMono_700Bold: require('@expo-google-fonts/jetbrains-mono/700Bold/JetBrainsMono_700Bold.ttf'),
  SourceCodePro_400Regular: require('@expo-google-fonts/source-code-pro/400Regular/SourceCodePro_400Regular.ttf'),
  SourceCodePro_500Medium: require('@expo-google-fonts/source-code-pro/500Medium/SourceCodePro_500Medium.ttf'),
  SourceCodePro_600SemiBold: require('@expo-google-fonts/source-code-pro/600SemiBold/SourceCodePro_600SemiBold.ttf'),
  SourceCodePro_700Bold: require('@expo-google-fonts/source-code-pro/700Bold/SourceCodePro_700Bold.ttf'),
  FiraCode_400Regular: require('@expo-google-fonts/fira-code/400Regular/FiraCode_400Regular.ttf'),
  FiraCode_500Medium: require('@expo-google-fonts/fira-code/500Medium/FiraCode_500Medium.ttf'),
  FiraCode_600SemiBold: require('@expo-google-fonts/fira-code/600SemiBold/FiraCode_600SemiBold.ttf'),
  FiraCode_700Bold: require('@expo-google-fonts/fira-code/700Bold/FiraCode_700Bold.ttf'),
  SpaceMono_400Regular: require('@expo-google-fonts/space-mono/400Regular/SpaceMono_400Regular.ttf'),
  SpaceMono_700Bold: require('@expo-google-fonts/space-mono/700Bold/SpaceMono_700Bold.ttf'),
} as const;

export function normalizeFontPreference(value: unknown): FontPreference {
  if (
    value === 'system' ||
    value === 'ibmPlex' ||
    value === 'spaceGrotesk' ||
    value === 'jetbrainsMono' ||
    value === 'sourceCodePro' ||
    value === 'firaCode' ||
    value === 'spaceMono'
  ) {
    return value;
  }

  return DEFAULT_FONT_PREFERENCE;
}

export function getFontFamilies(preference: FontPreference): AppFontFamilies {
  return FONT_FAMILIES[preference];
}

export function getFontPreferenceLabel(preference: FontPreference): string {
  return FONT_PREFERENCE_OPTIONS.find((option) => option.key === preference)?.title ?? 'System';
}
