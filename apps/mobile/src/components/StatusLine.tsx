import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { StyleSheet, Text } from 'react-native';
import Animated, { FadeInUp } from 'react-native-reanimated';

import type { RunEvent } from '../api/types';
import { useAppTheme, type AppTheme } from '../theme';

interface StatusLineProps {
  event: RunEvent;
}

const labels: Record<string, string> = {
  'run.started': 'Run started',
  'run.completed': 'Run completed',
  'run.failed': 'Run failed',
};

export function StatusLine({ event }: StatusLineProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const icons: Record<string, { name: keyof typeof Ionicons.glyphMap; color: string }> = {
    'run.started': { name: 'play-circle-outline', color: theme.colors.statusRunning },
    'run.completed': { name: 'checkmark-circle-outline', color: theme.colors.statusComplete },
    'run.failed': { name: 'close-circle-outline', color: theme.colors.statusError },
  };
  const label = labels[event.eventType] ?? event.eventType;
  const icon = icons[event.eventType] ?? {
    name: 'ellipse-outline',
    color: theme.colors.textMuted,
  };
  const detail = event.detail;

  return (
    <Animated.View entering={FadeInUp.duration(200)} style={styles.container}>
      <Ionicons name={icon.name} size={14} color={icon.color} />
      <Text style={[styles.text, { color: icon.color }]}>
        {label}
        {detail ? ` — ${detail}` : ''}
      </Text>
    </Animated.View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
    },
    text: {
      ...theme.typography.caption,
      fontStyle: 'italic',
      color: theme.colors.textMuted,
    },
  });
