import type { PropsWithChildren } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';

import { fonts, palette, radii, shadows, spacing } from './theme';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

interface ActionButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: ButtonVariant;
  compact?: boolean;
}

export function ScreenSurface({ children }: PropsWithChildren) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View pointerEvents="none" style={[styles.blob, styles.blobA]} />
      <View pointerEvents="none" style={[styles.blob, styles.blobB]} />
      <View style={styles.content}>{children}</View>
    </SafeAreaView>
  );
}

interface PanelProps extends PropsWithChildren {
  style?: StyleProp<ViewStyle>;
}

export function Panel({ children, style }: PanelProps) {
  return <View style={[styles.panel, style]}>{children}</View>;
}

export function ActionButton({
  label,
  onPress,
  disabled = false,
  variant = 'primary',
  compact = false
}: ActionButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        compact ? styles.buttonCompact : undefined,
        variantStyle(variant),
        pressed && !disabled ? pressedStyle(variant) : undefined,
        disabled ? styles.buttonDisabled : undefined
      ]}
    >
      <Text style={[styles.buttonText, textVariantStyle(variant), disabled && styles.buttonTextDisabled]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: palette.canvas
  },
  content: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md
  },
  blob: {
    position: 'absolute',
    borderRadius: 999,
    opacity: 0.3
  },
  blobA: {
    width: 220,
    height: 220,
    backgroundColor: palette.accentSoft,
    top: -60,
    right: -70
  },
  blobB: {
    width: 180,
    height: 180,
    backgroundColor: palette.panelMuted,
    top: 80,
    left: -80
  },
  panel: {
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radii.lg,
    padding: spacing.md,
    ...shadows.card
  },
  button: {
    minHeight: 42,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1
  },
  buttonCompact: {
    minHeight: 34,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm
  },
  buttonDisabled: {
    opacity: 0.6
  },
  buttonText: {
    fontFamily: fonts.heading,
    fontSize: 14,
    letterSpacing: 0.2
  },
  buttonTextDisabled: {
    color: '#7F7670'
  }
});

function variantStyle(variant: ButtonVariant) {
  if (variant === 'secondary') {
    return {
      backgroundColor: palette.panelMuted,
      borderColor: palette.border
    };
  }

  if (variant === 'ghost') {
    return {
      backgroundColor: 'transparent',
      borderColor: palette.border
    };
  }

  return {
    backgroundColor: palette.accent,
    borderColor: palette.accent
  };
}

function pressedStyle(variant: ButtonVariant) {
  if (variant === 'primary') {
    return {
      backgroundColor: palette.accentPressed,
      borderColor: palette.accentPressed
    };
  }

  if (variant === 'secondary') {
    return {
      backgroundColor: '#E9DDCB'
    };
  }

  return {
    backgroundColor: '#EEE3D4'
  };
}

function textVariantStyle(variant: ButtonVariant) {
  if (variant === 'primary') {
    return { color: '#FFF7F2' };
  }

  return { color: palette.ink };
}
