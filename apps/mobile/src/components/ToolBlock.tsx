import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInUp } from 'react-native-reanimated';

import { colors, radius, spacing } from '../theme';

interface ToolBlockProps {
  command: string;
  status: 'running' | 'complete' | 'error';
}

export function ToolBlock({ command, status }: ToolBlockProps) {
  const statusIcon: keyof typeof Ionicons.glyphMap | null =
    status === 'running'
      ? null
      : status === 'complete'
        ? 'checkmark'
        : 'close';

  const statusColor = status === 'running'
    ? colors.statusRunning
    : status === 'complete'
      ? colors.statusComplete
      : colors.statusError;

  return (
    <Animated.View entering={FadeInUp.duration(300)}>
      <View style={styles.container}>
        <Ionicons name="terminal-outline" size={14} color={colors.textSecondary} />
        <Text style={styles.command} numberOfLines={1}>
          {command}
        </Text>
        {status === 'running' ? (
          <ActivityIndicator size="small" color={statusColor} />
        ) : statusIcon ? (
          <Ionicons name={statusIcon} size={14} color={statusColor} />
        ) : null}
      </View>
    </Animated.View>
  );
}

const monoFont = Platform.select({ ios: 'Menlo', default: 'monospace' });

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.toolBlockBg,
    borderLeftWidth: 2,
    borderLeftColor: colors.toolBlockBorder,
    borderRadius: radius.sm,
    marginVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  command: {
    flex: 1,
    fontFamily: monoFont,
    fontSize: 12,
    color: colors.textPrimary,
    lineHeight: 18,
  },
});
