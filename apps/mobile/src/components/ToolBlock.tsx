import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInUp } from 'react-native-reanimated';

import { colors, radius, spacing } from '../theme';

interface ToolBlockProps {
  command: string;
  status: 'running' | 'complete' | 'error';
  output?: string;
  durationMs?: number;
}

export function ToolBlock({ command, status, output, durationMs }: ToolBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = status === 'running'
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
      <Pressable
        style={styles.container}
        onPress={() => setExpanded(!expanded)}
      >
        <View style={styles.header}>
          <Ionicons name="folder-open" size={14} color={colors.accent} />
          <Text style={styles.command} numberOfLines={expanded ? undefined : 1}>
            {command}
          </Text>
          <View style={styles.statusRow}>
            {status === 'running' ? (
              <ActivityIndicator size="small" color={statusColor} />
            ) : (
              <>
                {statusIcon && (
                  <Ionicons name={statusIcon as any} size={14} color={statusColor} />
                )}
                {durationMs != null && (
                  <Text style={[styles.duration, { color: statusColor }]}>
                    {durationMs}ms
                  </Text>
                )}
              </>
            )}
            <Ionicons
              name={expanded ? 'chevron-up' : 'chevron-down'}
              size={14}
              color={colors.textMuted}
            />
          </View>
        </View>
        {expanded && output ? (
          <Text style={styles.output}>{output}</Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

const monoFont = Platform.select({ ios: 'Menlo', default: 'monospace' });

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.toolBlockBg,
    borderLeftWidth: 3,
    borderLeftColor: colors.toolBlockBorder,
    borderRadius: radius.sm,
    marginVertical: spacing.sm,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  command: {
    flex: 1,
    fontFamily: monoFont,
    fontSize: 12,
    color: colors.textPrimary,
    lineHeight: 18,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 0,
  },
  duration: {
    fontFamily: monoFont,
    fontSize: 11,
  },
  output: {
    fontFamily: monoFont,
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: 16,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    paddingTop: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
  },
});
