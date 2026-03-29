import { Ionicons } from '@expo/vector-icons';
import { useMemo } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';

import { useAppTheme, type AppTheme } from '../theme';

interface ToolBlockProps {
  command: string;
  status: 'running' | 'complete' | 'error';
  icon?: keyof typeof Ionicons.glyphMap;
}

export function ToolBlock({
  command,
  status,
  icon = 'terminal-outline',
}: ToolBlockProps) {
  const theme = useAppTheme();
  const { colors } = theme;
  const styles = useMemo(() => createStyles(theme), [theme]);
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
    <View style={styles.container}>
      <Ionicons name={icon} size={14} color={colors.textSecondary} />
      <Text style={styles.command} numberOfLines={1}>
        {command}
      </Text>
      {status === 'running' ? (
        <ActivityIndicator size="small" color={statusColor} />
      ) : statusIcon ? (
        <Ionicons name={statusIcon} size={14} color={statusColor} />
      ) : null}
    </View>
  );
}

const monoFont = Platform.select({ ios: 'Menlo', default: 'monospace' });

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.toolBlockBg,
      borderLeftWidth: 2,
      borderLeftColor: theme.colors.toolBlockBorder,
      borderRadius: theme.radius.sm,
      marginVertical: theme.spacing.xs,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
    },
    command: {
      flex: 1,
      fontFamily: monoFont,
      fontSize: 12,
      color: theme.colors.textPrimary,
      lineHeight: 18,
    },
  });
