import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useAppTheme, type AppTheme } from '../theme';

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

export function ActivityBar({ title, detail, tone }: ActivityBarProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const colorByTone: Record<ActivityTone, string> = {
    running: theme.colors.statusRunning,
    complete: theme.colors.statusComplete,
    error: theme.colors.statusError,
    idle: theme.colors.statusIdle,
  };
  const color = colorByTone[tone];
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
  const normalizedDetail = detail?.trim() ?? '';
  const hasDetail = normalizedDetail.length > 0;
  const normalizedTitle = title.trim();
  const titleText = `${normalizedTitle || title}${dots}`;
  const singleLineText = titleText;

  return (
    <BlurView
      intensity={42}
      tint={theme.activityBarTint}
      blurMethod="dimezisBlurViewSdk31Plus"
      style={styles.container}
    >
      <View
        style={[
          styles.content,
          hasDetail && tone !== 'running' ? styles.contentExpanded : null,
        ]}
      >
        <View
          style={[
            styles.iconWrap,
            hasDetail && tone !== 'running' ? styles.iconWrapExpanded : null,
          ]}
        >
          {tone === 'running' ? (
            <ActivityIndicator size="small" color={color} />
          ) : (
            <Ionicons name={ICON_BY_TONE[tone]} size={13} color={color} />
          )}
        </View>
        {hasDetail && tone !== 'running' ? (
          <View style={styles.textColumn}>
            <Text style={styles.titleText} numberOfLines={1}>
              {titleText}
            </Text>
            <Text style={styles.detailText} numberOfLines={1}>
              {normalizedDetail}
            </Text>
          </View>
        ) : hasDetail ? (
          <Text style={styles.summaryText} numberOfLines={1}>
            {normalizedDetail}
          </Text>
        ) : (
          <Text style={styles.titleText} numberOfLines={1}>
            {singleLineText}
          </Text>
        )}
      </View>
    </BlurView>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      borderRadius: 10,
      overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.isDark
        ? 'rgba(18, 22, 28, 0.16)'
        : 'rgba(255, 255, 255, 0.70)',
      marginHorizontal: theme.spacing.lg,
      marginBottom: theme.spacing.xs / 2,
    },
    content: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.sm + 2,
      paddingVertical: 3,
    },
    contentExpanded: {
      alignItems: 'flex-start',
      paddingVertical: 5,
    },
    iconWrap: {
      width: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconWrapExpanded: {
      paddingTop: 1,
    },
    textColumn: {
      flex: 1,
      minWidth: 0,
    },
    titleText: {
      ...theme.typography.caption,
      fontSize: 11,
      lineHeight: 15,
      fontWeight: '600',
      color: theme.colors.textPrimary,
      flex: 1,
    },
    detailText: {
      ...theme.typography.caption,
      fontSize: 11,
      lineHeight: 14,
      fontWeight: '500',
      color: theme.colors.textMuted,
    },
    summaryText: {
      ...theme.typography.caption,
      fontSize: 11,
      lineHeight: 14,
      fontWeight: '600',
      color: theme.colors.textPrimary,
      flex: 1,
    },
  });
