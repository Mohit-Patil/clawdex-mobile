import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { MacBridgeApiClient } from '../api/client';
import type { MacBridgeWsClient } from '../api/ws';
import { ActionButton, Panel, ScreenSurface } from '../ui/primitives';
import { fonts, palette, spacing } from '../ui/theme';

interface SettingsScreenProps {
  api: MacBridgeApiClient;
  ws: MacBridgeWsClient;
  bridgeUrl: string;
}

export function SettingsScreen({ api, ws, bridgeUrl }: SettingsScreenProps) {
  const [healthyAt, setHealthyAt] = useState<string | null>(null);
  const [uptimeSec, setUptimeSec] = useState<number | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const health = await api.health();
      setHealthyAt(health.at);
      setUptimeSec(health.uptimeSec);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      void checkHealth();
    }, 0);

    return () => {
      clearTimeout(timeout);
    };
  }, [checkHealth]);

  useEffect(() => {
    const unsubscribe = ws.onStatus((connected) => {
      setWsConnected(connected);
    });

    return unsubscribe;
  }, [ws]);

  const lastSeen = useMemo(() => {
    if (!healthyAt) {
      return '-';
    }

    const parsed = new Date(healthyAt);
    if (Number.isNaN(parsed.getTime())) {
      return healthyAt;
    }

    return parsed.toLocaleString();
  }, [healthyAt]);

  return (
    <ScreenSurface>
      <View style={styles.container}>
        <View style={styles.hero}>
          <Text style={styles.heroLabel}>SETTINGS</Text>
          <Text style={styles.heroTitle}>Bridge Link</Text>
          <Text style={styles.heroMeta}>Monitor health and connection status for your Mac bridge.</Text>
        </View>

        <Panel>
          <Text style={styles.blockTitle}>Bridge URL</Text>
          <Text selectable style={styles.urlText}>
            {bridgeUrl}
          </Text>
        </Panel>

        <Panel>
          <View style={styles.statusHeader}>
            <Text style={styles.blockTitle}>Connection Status</Text>
            <View style={[styles.wsBadge, wsConnected ? styles.wsBadgeOn : styles.wsBadgeOff]}>
              <Text style={styles.wsBadgeText}>{wsConnected ? 'WS online' : 'WS offline'}</Text>
            </View>
          </View>

          <View style={styles.healthGrid}>
            <HealthItem label="HTTP status" value={healthyAt ? 'ok' : 'unknown'} />
            <HealthItem label="Last seen" value={lastSeen} />
            <HealthItem
              label="Bridge uptime"
              value={uptimeSec !== null ? `${String(uptimeSec)}s` : '-'}
            />
          </View>

          <View style={styles.refreshRow}>
            <ActionButton label="Refresh Health" onPress={() => void checkHealth()} />
          </View>
        </Panel>

        {error ? <Text style={styles.error}>Error: {error}</Text> : null}
      </View>
    </ScreenSurface>
  );
}

interface HealthItemProps {
  label: string;
  value: string;
}

function HealthItem({ label, value }: HealthItemProps) {
  return (
    <View style={styles.healthItem}>
      <Text style={styles.healthLabel}>{label}</Text>
      <Text style={styles.healthValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    gap: spacing.sm,
    paddingTop: spacing.sm
  },
  hero: {
    marginBottom: spacing.xs
  },
  heroLabel: {
    fontFamily: fonts.heading,
    fontSize: 12,
    letterSpacing: 1.3,
    color: palette.accent
  },
  heroTitle: {
    marginTop: 2,
    fontFamily: fonts.heading,
    fontSize: 28,
    color: palette.ink
  },
  heroMeta: {
    marginTop: 2,
    fontFamily: fonts.body,
    color: palette.inkMuted
  },
  blockTitle: {
    fontFamily: fonts.heading,
    fontSize: 16,
    color: palette.ink
  },
  urlText: {
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 12,
    backgroundColor: palette.canvas,
    padding: spacing.sm,
    color: palette.ink,
    fontFamily: fonts.mono,
    fontSize: 13
  },
  statusHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  wsBadge: {
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5
  },
  wsBadgeOn: {
    backgroundColor: '#DCEFE5'
  },
  wsBadgeOff: {
    backgroundColor: '#F9DEDA'
  },
  wsBadgeText: {
    fontFamily: fonts.heading,
    fontSize: 12,
    color: palette.ink,
    textTransform: 'uppercase'
  },
  healthGrid: {
    marginTop: spacing.sm,
    gap: spacing.sm
  },
  healthItem: {
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: 12,
    backgroundColor: palette.canvas,
    padding: spacing.sm
  },
  healthLabel: {
    fontFamily: fonts.body,
    color: palette.inkMuted,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.8
  },
  healthValue: {
    marginTop: 3,
    fontFamily: fonts.heading,
    color: palette.ink,
    fontSize: 15
  },
  refreshRow: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    justifyContent: 'flex-end'
  },
  error: {
    color: palette.danger,
    fontFamily: fonts.body,
    paddingHorizontal: 2
  }
});
