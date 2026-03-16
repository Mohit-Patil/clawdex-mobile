import { StyleSheet, Text, View } from 'react-native';

import type { ComposerUsageLimitBadgeModel } from './usageLimitBadges';
import { spacing, typography } from '../theme';

const BATTERY_BODY_WIDTH = 16;

const toneColors = {
  neutral: {
    border: '#34C759',
    background: 'rgba(52, 199, 89, 0.16)',
    text: '#A7F3C1',
    label: '#7EE2A8',
  },
  warning: {
    border: '#F59E0B',
    background: 'rgba(245, 158, 11, 0.16)',
    text: '#FFE2A8',
    label: '#F8C76B',
  },
  critical: {
    border: '#EF4444',
    background: 'rgba(239, 68, 68, 0.16)',
    text: '#FFC1C1',
    label: '#FF9C9C',
  },
} as const;

interface ComposerUsageLimitsProps {
  limits: ComposerUsageLimitBadgeModel[];
}

export function ComposerUsageLimits({ limits }: ComposerUsageLimitsProps) {
  if (limits.length === 0) {
    return null;
  }

  return (
    <View style={styles.row}>
      {limits.map((limit) => (
        <View key={limit.id} style={styles.badge}>
          <Text
            style={[
              styles.labelText,
              {
                color: toneColors[limit.tone].label,
              },
            ]}
          >
            {limit.label}
          </Text>
          <View style={styles.meterRow}>
            <View style={styles.batteryWrap}>
              <View
                style={[
                  styles.batteryBody,
                  {
                    borderColor: toneColors[limit.tone].border,
                    backgroundColor: toneColors[limit.tone].background,
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
                      backgroundColor: toneColors[limit.tone].border,
                    },
                  ]}
                />
              </View>
              <View
                style={[
                  styles.batteryCap,
                  {
                    backgroundColor: toneColors[limit.tone].border,
                  },
                ]}
              />
            </View>
            <Text
              style={[
                styles.valueText,
                {
                  color: toneColors[limit.tone].text,
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

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    gap: spacing.xs + 2,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  meterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
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
    ...typography.caption,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    fontSize: 8,
    lineHeight: 9,
    textTransform: 'lowercase',
  },
  valueText: {
    ...typography.caption,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    fontSize: 8,
    lineHeight: 9,
  },
});
