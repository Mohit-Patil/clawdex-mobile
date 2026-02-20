import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';

import type { MacBridgeApiClient } from '../api/client';
import type { MacBridgeWsClient } from '../api/ws';
import { colors, spacing, typography } from '../theme';

interface SettingsScreenProps {
  api: MacBridgeApiClient;
  ws: MacBridgeWsClient;
  bridgeUrl: string;
  onOpenDrawer: () => void;
}

export function SettingsScreen({ api, ws, bridgeUrl, onOpenDrawer }: SettingsScreenProps) {
  const [healthyAt, setHealthyAt] = useState<string | null>(null);
  const [uptimeSec, setUptimeSec] = useState<number | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const h = await api.health();
      setHealthyAt(h.at);
      setUptimeSec(h.uptimeSec);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api]);

  useEffect(() => {
    const t = setTimeout(() => void checkHealth(), 0);
    return () => clearTimeout(t);
  }, [checkHealth]);

  useEffect(() => ws.onStatus(setWsConnected), [ws]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onOpenDrawer} hitSlop={8} style={styles.menuBtn}>
          <Ionicons name="menu" size={22} color={colors.textMuted} />
        </Pressable>
        <Ionicons name="settings" size={16} color={colors.textMuted} />
        <Text style={styles.headerTitle}>Settings</Text>
      </View>

      <View style={styles.body}>
        <Text style={styles.sectionLabel}>Bridge</Text>
        <Text selectable style={styles.valueText}>
          {bridgeUrl}
        </Text>

        <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Health</Text>
        <Row
          label="Status"
          value={healthyAt ? 'OK' : 'Unknown'}
          valueColor={healthyAt ? colors.statusComplete : colors.textMuted}
        />
        <Row label="Last seen" value={healthyAt ?? '—'} />
        <Row label="Uptime" value={uptimeSec !== null ? `${uptimeSec}s` : '—'} />
        <Row
          label="WebSocket"
          value={wsConnected ? 'Connected' : 'Disconnected'}
          valueColor={wsConnected ? colors.statusComplete : colors.statusError}
        />

        <Pressable
          onPress={() => void checkHealth()}
          style={({ pressed }) => [styles.refreshBtn, pressed && styles.refreshBtnPressed]}
        >
          <Ionicons name="refresh" size={14} color={colors.textMuted} />
          <Text style={styles.refreshBtnText}>Refresh health</Text>
        </Pressable>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>
    </SafeAreaView>
  );
}

function Row({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, valueColor ? { color: valueColor } : undefined]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgMain },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  menuBtn: { padding: spacing.xs },
  headerTitle: { ...typography.headline },
  body: { padding: spacing.lg, gap: spacing.sm },
  sectionLabel: {
    ...typography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  sectionLabelGap: { marginTop: spacing.xl },
  valueText: {
    ...typography.mono,
    color: colors.textMuted,
    backgroundColor: colors.bgSidebar,
    borderRadius: 6,
    padding: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowLabel: { ...typography.body, color: colors.textMuted },
  rowValue: { ...typography.body },
  refreshBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  refreshBtnPressed: { backgroundColor: colors.bgItem },
  refreshBtnText: { ...typography.body, color: colors.textMuted, fontSize: 13 },
  errorText: { ...typography.caption, color: colors.error, marginTop: spacing.md },
});
