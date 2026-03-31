import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ComposerUsageLimitBadgeModel } from './usageLimitBadges';
import { useAppTheme, type AppTheme } from '../theme';

const BATTERY_BODY_WIDTH = 16;

interface ComposerUsageLimitsProps {
  limits: ComposerUsageLimitBadgeModel[];
}

export function ComposerUsageLimits({ limits }: ComposerUsageLimitsProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const toneColors = useMemo(() => createToneColors(theme), [theme]);
  if (limits.length === 0) {
    return null;
  }

  return (
    <View style={styles.row}>
      {limits.map((limit) => (
        <View
          key={limit.id}
          style={[
            styles.badge,
            {
              backgroundColor: toneColors[limit.tone].badgeBackground,
              borderColor: toneColors[limit.tone].badgeBorder,
            },
          ]}
        >
          <View
            style={[
              styles.toneDot,
              {
                backgroundColor: toneColors[limit.tone].accent,
              },
            ]}
          />
          <Text style={styles.labelText}>{limit.label}</Text>
          <View style={styles.meterRow}>
            <View style={styles.batteryWrap}>
              <View
                style={[
                  styles.batteryBody,
                  {
                    borderColor: toneColors[limit.tone].batteryBorder,
                    backgroundColor: toneColors[limit.tone].batteryBackground,
                  },
                ]}
              >
                <View
                  style={[
                    styles.batteryFill,
                    {
                      width: Math.max(
                        0,
                        Math.round((BATTERY_BODY_WIDTH - 2) * (limit.remainingPercent / 100))
                      ),
                      backgroundColor: toneColors[limit.tone].accent,
                    },
                  ]}
                />
              </View>
              <View
                style={[
                  styles.batteryCap,
                  {
                    backgroundColor: toneColors[limit.tone].accent,
                  },
                ]}
              />
            </View>
            <Text
              style={[
                styles.valueText,
                {
                  color: toneColors[limit.tone].valueText,
                },
              ]}
            >
              {formatPercent(limit.remainingPercent)}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

function formatPercent(value: number): string {
  if (value >= 100) {
    return '100';
  }

  if (value <= 0) {
    return '0';
  }

  return `${String(value)}%`;
}

function createToneColors(theme: AppTheme) {
  if (theme.isDark) {
    return {
      neutral: {
        badgeBackground: 'rgba(52, 199, 89, 0.14)',
        badgeBorder: 'rgba(52, 199, 89, 0.24)',
        batteryBackground: 'rgba(255, 255, 255, 0.06)',
        batteryBorder: 'rgba(52, 199, 89, 0.30)',
        accent: '#34C759',
        valueText: '#A7F3C1',
      },
      warning: {
        badgeBackground: 'rgba(245, 158, 11, 0.14)',
        badgeBorder: 'rgba(245, 158, 11, 0.24)',
        batteryBackground: 'rgba(255, 255, 255, 0.06)',
        batteryBorder: 'rgba(245, 158, 11, 0.28)',
        accent: '#F59E0B',
        valueText: '#FFE2A8',
      },
      critical: {
        badgeBackground: 'rgba(239, 68, 68, 0.14)',
        badgeBorder: 'rgba(239, 68, 68, 0.24)',
        batteryBackground: 'rgba(255, 255, 255, 0.06)',
        batteryBorder: 'rgba(239, 68, 68, 0.28)',
        accent: '#EF4444',
        valueText: '#FFC1C1',
      },
    } as const;
  }

  return {
    neutral: {
      badgeBackground: 'rgba(14, 159, 110, 0.10)',
      badgeBorder: 'rgba(14, 159, 110, 0.22)',
      batteryBackground: 'rgba(255, 255, 255, 0.80)',
      batteryBorder: 'rgba(14, 159, 110, 0.34)',
      accent: '#0E9F6E',
      valueText: '#0B7A55',
    },
    warning: {
      badgeBackground: 'rgba(197, 106, 18, 0.10)',
      badgeBorder: 'rgba(197, 106, 18, 0.22)',
      batteryBackground: 'rgba(255, 255, 255, 0.80)',
      batteryBorder: 'rgba(197, 106, 18, 0.34)',
      accent: '#C56A12',
      valueText: '#9A4A0C',
    },
    critical: {
      badgeBackground: 'rgba(217, 45, 32, 0.09)',
      badgeBorder: 'rgba(217, 45, 32, 0.20)',
      batteryBackground: 'rgba(255, 255, 255, 0.80)',
      batteryBorder: 'rgba(217, 45, 32, 0.30)',
      accent: '#D92D20',
      valueText: '#B42318',
    },
  } as const;
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      justifyContent: 'flex-start',
      gap: theme.spacing.xs + 2,
      flexWrap: 'wrap',
    },
    badge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: theme.radius.full,
      paddingLeft: 6,
      paddingRight: 7,
      paddingVertical: 4,
    },
    meterRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
    },
    toneDot: {
      width: 6,
      height: 6,
      borderRadius: theme.radius.full,
      flexShrink: 0,
    },
    batteryWrap: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    batteryBody: {
      width: BATTERY_BODY_WIDTH,
      height: 8,
      borderRadius: 2,
      borderWidth: 1,
      padding: 1,
      overflow: 'hidden',
    },
    batteryFill: {
      height: '100%',
      borderRadius: 1,
    },
    batteryCap: {
      width: 2,
      height: 4,
      borderRadius: 1,
      marginLeft: 1,
    },
    labelText: {
      ...theme.typography.caption,
      fontWeight: '600',
      fontVariant: ['tabular-nums'],
      fontSize: 8,
      lineHeight: 9,
      textTransform: 'lowercase',
      color: theme.colors.textSecondary,
    },
    valueText: {
      ...theme.typography.caption,
      fontWeight: '700',
      fontVariant: ['tabular-nums'],
      fontSize: 8,
      lineHeight: 9,
    },
  });
