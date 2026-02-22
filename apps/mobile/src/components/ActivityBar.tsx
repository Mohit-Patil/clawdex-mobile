import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { colors, spacing, typography } from '../theme';

export type ActivityTone = 'running' | 'complete' | 'error' | 'idle';

interface ActivityBarProps {
  title: string;
  detail?: string | null;
  tone: ActivityTone;
}

const ICON_BY_TONE: Record<ActivityTone, keyof typeof Ionicons.glyphMap> = {
  running: 'sparkles-outline',
  complete: 'checkmark-circle-outline',
  error: 'close-circle-outline',
  idle: 'ellipse-outline',
};

const COLOR_BY_TONE: Record<ActivityTone, string> = {
  running: colors.statusRunning,
  complete: colors.statusComplete,
  error: colors.statusError,
  idle: colors.statusIdle,
};

export function ActivityBar({ title, detail, tone }: ActivityBarProps) {
  const color = COLOR_BY_TONE[tone];
  const [dotFrame, setDotFrame] = useState(0);

  useEffect(() => {
    setDotFrame(0);
    if (tone !== 'running') {
      return;
    }
    const timer = setInterval(() => {
      setDotFrame((prev) => (prev + 1) % 4);
    }, 450);
    return () => clearInterval(timer);
  }, [tone]);

  const dots = tone === 'running' ? '.'.repeat(dotFrame) : '';
  const suffix = detail ? ` · ${detail}` : '';
  const text = `${title}${suffix}${dots}`;

  return (
    <View style={styles.container}>
      {tone === 'running' ? (
        <ActivityIndicator size="small" color={color} />
      ) : (
        <Ionicons name={ICON_BY_TONE[tone]} size={14} color={color} />
      )}
      <Text style={styles.text} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  text: {
    ...typography.caption,
    fontWeight: '600',
    color: colors.textPrimary,
    flex: 1,
  },
});
