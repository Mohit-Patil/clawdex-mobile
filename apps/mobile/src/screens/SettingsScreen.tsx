import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';

import type { MacBridgeApiClient } from '../api/client';
import type { MacBridgeWsClient } from '../api/ws';
import { colors, radius, spacing, typography } from '../theme';

interface SettingsScreenProps {
  api: MacBridgeApiClient;
  ws: MacBridgeWsClient;
  bridgeUrl: string;
  onOpenDrawer: () => void;
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
}

export function SettingsScreen({
  api,
  ws,
  bridgeUrl,
  onOpenDrawer,
  onOpenPrivacy,
  onOpenTerms
}: SettingsScreenProps) {
  const [healthyAt, setHealthyAt] = useState<string | null>(null);
  const [uptimeSec, setUptimeSec] = useState<number | null>(null);
  const [wsConnected, setWsConnected] = useState(ws.isConnected);
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
    <View style={styles.container}>
      <LinearGradient
        colors={[colors.bgMain, colors.bgMain, colors.bgMain]}
        style={StyleSheet.absoluteFill}
      />
      <SafeAreaView style={styles.safeArea}>
        <BlurView intensity={80} tint="dark" style={styles.header}>
          <Pressable onPress={onOpenDrawer} hitSlop={8} style={styles.menuBtn}>
            <Ionicons name="menu" size={22} color={colors.textPrimary} />
          </Pressable>
          <Ionicons name="settings" size={16} color={colors.textPrimary} />
          <Text style={styles.headerTitle}>Settings</Text>
        </BlurView>

        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          <Text style={styles.sectionLabel}>Bridge</Text>
          <BlurView intensity={50} tint="dark" style={styles.card}>
            <Text selectable style={styles.valueText}>
              {bridgeUrl}
            </Text>
          </BlurView>

          <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Health</Text>
          <BlurView intensity={50} tint="dark" style={styles.card}>
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
              isLast
            />
          </BlurView>

          <Pressable
            onPress={() => void checkHealth()}
            style={({ pressed }) => [styles.refreshBtn, pressed && styles.refreshBtnPressed]}
          >
            <Ionicons name="refresh" size={16} color={colors.white} />
            <Text style={styles.refreshBtnText}>Refresh health</Text>
          </Pressable>

          <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Legal</Text>
          <BlurView intensity={50} tint="dark" style={styles.card}>
            <Pressable
              onPress={onOpenPrivacy}
              style={({ pressed }) => [styles.linkRow, pressed && styles.linkRowPressed]}
            >
              <View style={styles.linkRowLeft}>
                <Ionicons name="shield-checkmark-outline" size={16} color={colors.textPrimary} />
                <Text style={styles.linkRowLabel}>Privacy details</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </Pressable>
            <Pressable
              onPress={onOpenTerms}
              style={({ pressed }) => [styles.linkRow, pressed && styles.linkRowPressed]}
            >
              <View style={styles.linkRowLeft}>
                <Ionicons name="document-text-outline" size={16} color={colors.textPrimary} />
                <Text style={styles.linkRowLabel}>Terms of service</Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </Pressable>
          </BlurView>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

function Row({
  label,
  value,
  valueColor,
  isLast,
}: {
  label: string;
  value: string;
  valueColor?: string;
  isLast?: boolean;
}) {
  return (
    <View style={[styles.row, isLast && styles.rowLast]}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, valueColor ? { color: valueColor } : undefined]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgMain },
  safeArea: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderHighlight,
  },
  menuBtn: { padding: spacing.xs },
  headerTitle: { ...typography.headline, color: colors.textPrimary },
  body: { flex: 1 },
  bodyContent: { padding: spacing.lg },
  card: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHighlight,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.xs,
    overflow: 'hidden',
  },
  sectionLabel: {
    ...typography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    color: colors.textMuted,
    marginLeft: spacing.xs,
  },
  sectionLabelGap: { marginTop: spacing.xl },
  valueText: {
    ...typography.mono,
    color: colors.textPrimary,
    paddingVertical: spacing.md,
    fontSize: 14,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderLight,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowLabel: { ...typography.body, color: colors.textMuted },
  rowValue: { ...typography.body, fontWeight: '600', color: colors.textPrimary },
  refreshBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.xl,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  refreshBtnPressed: { backgroundColor: colors.accentPressed },
  refreshBtnText: { ...typography.headline, color: colors.white, fontSize: 15 },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md
  },
  linkRowPressed: {
    opacity: 0.75
  },
  linkRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  linkRowLabel: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '600'
  },
  errorText: { ...typography.caption, color: colors.error, marginTop: spacing.md, textAlign: 'center' },
});
