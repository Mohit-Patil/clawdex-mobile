import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInUp } from 'react-native-reanimated';

import type { RunEvent } from '../api/types';
import { colors, spacing, typography } from '../theme';

interface StatusLineProps {
  event: RunEvent;
}

const labels: Record<string, string> = {
  'run.started': 'Run started',
  'run.completed': 'Run completed',
  'run.failed': 'Run failed',
};

const icons: Record<string, { name: string; color: string }> = {
  'run.started': { name: 'play-circle-outline', color: colors.statusRunning },
  'run.completed': { name: 'checkmark-circle-outline', color: colors.statusComplete },
  'run.failed': { name: 'close-circle-outline', color: colors.statusError },
};

export function StatusLine({ event }: StatusLineProps) {
  const label = labels[event.eventType] ?? event.eventType;
  const icon = icons[event.eventType] ?? { name: 'ellipse-outline', color: colors.textMuted };
  const detail = event.detail;

  return (
    <Animated.View entering={FadeInUp.duration(200)} style={styles.container}>
      <Ionicons name={icon.name as any} size={14} color={icon.color} />
      <Text style={[styles.text, { color: icon.color }]}>
        {label}
        {detail ? ` — ${detail}` : ''}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  text: {
    ...typography.caption,
    fontStyle: 'italic',
    color: colors.accent,
  },
});
