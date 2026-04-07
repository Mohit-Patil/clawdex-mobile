import { Platform } from 'react-native';
import {
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium,
  IBMPlexMono_700Bold,
} from '@expo-google-fonts/ibm-plex-mono';
import {
  IBMPlexSans_400Regular,
  IBMPlexSans_500Medium,
  IBMPlexSans_600SemiBold,
  IBMPlexSans_700Bold,
} from '@expo-google-fonts/ibm-plex-sans';
import {
  FiraCode_400Regular,
  FiraCode_500Medium,
  FiraCode_600SemiBold,
  FiraCode_700Bold,
} from '@expo-google-fonts/fira-code';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_600SemiBold,
  JetBrainsMono_700Bold,
} from '@expo-google-fonts/jetbrains-mono';
import {
  SourceCodePro_400Regular,
  SourceCodePro_500Medium,
  SourceCodePro_600SemiBold,
  SourceCodePro_700Bold,
} from '@expo-google-fonts/source-code-pro';
import {
  SpaceGrotesk_400Regular,
  SpaceGrotesk_500Medium,
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
} from '@expo-google-fonts/space-grotesk';
import {
  SpaceMono_400Regular,
  SpaceMono_700Bold,
} from '@expo-google-fonts/space-mono';

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
  IBMPlexSans_400Regular,
  IBMPlexSans_500Medium,
  IBMPlexSans_600SemiBold,
  IBMPlexSans_700Bold,
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium,
  IBMPlexMono_700Bold,
  SpaceGrotesk_400Regular,
  SpaceGrotesk_500Medium,
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_600SemiBold,
  JetBrainsMono_700Bold,
  SourceCodePro_400Regular,
  SourceCodePro_500Medium,
  SourceCodePro_600SemiBold,
  SourceCodePro_700Bold,
  FiraCode_400Regular,
  FiraCode_500Medium,
  FiraCode_600SemiBold,
  FiraCode_700Bold,
  SpaceMono_400Regular,
  SpaceMono_700Bold,
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
