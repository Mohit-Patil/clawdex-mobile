import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { MacBridgeApiClient } from '../api/client';
import type { ModelOption, ReasoningEffort } from '../api/types';
import type { MacBridgeWsClient } from '../api/ws';
import { colors, radius, spacing, typography } from '../theme';

interface SettingsScreenProps {
  api: MacBridgeApiClient;
  ws: MacBridgeWsClient;
  bridgeUrl: string;
  defaultModelId?: string | null;
  defaultReasoningEffort?: ReasoningEffort | null;
  onDefaultModelSettingsChange?: (
    modelId: string | null,
    effort: ReasoningEffort | null
  ) => void;
  onOpenDrawer: () => void;
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
}

export function SettingsScreen({
  api,
  ws,
  bridgeUrl,
  defaultModelId,
  defaultReasoningEffort,
  onDefaultModelSettingsChange,
  onOpenDrawer,
  onOpenPrivacy,
  onOpenTerms,
}: SettingsScreenProps) {
  const [healthyAt, setHealthyAt] = useState<string | null>(null);
  const [uptimeSec, setUptimeSec] = useState<number | null>(null);
  const [wsConnected, setWsConnected] = useState(ws.isConnected);
  const [error, setError] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelModalVisible, setModelModalVisible] = useState(false);
  const [effortModalVisible, setEffortModalVisible] = useState(false);

  const normalizedDefaultModelId = normalizeModelId(defaultModelId);
  const normalizedDefaultEffort = normalizeReasoningEffort(defaultReasoningEffort);
  const selectedDefaultModel = useMemo(
    () =>
      normalizedDefaultModelId
        ? modelOptions.find((model) => model.id === normalizedDefaultModelId) ?? null
        : null,
    [modelOptions, normalizedDefaultModelId]
  );
  const selectedDefaultModelEfforts = selectedDefaultModel?.reasoningEffort ?? [];
  const canSelectDefaultEffort = Boolean(normalizedDefaultModelId);
  const defaultModelLabel = normalizedDefaultModelId
    ? selectedDefaultModel
      ? `${selectedDefaultModel.displayName} (${selectedDefaultModel.id})`
      : normalizedDefaultModelId
    : 'Server default';
  const defaultEffortLabel = normalizedDefaultModelId
    ? normalizedDefaultEffort
      ? formatReasoningEffort(normalizedDefaultEffort)
      : selectedDefaultModel?.defaultReasoningEffort
        ? `Default (${formatReasoningEffort(selectedDefaultModel.defaultReasoningEffort)})`
        : 'Model default'
    : 'Server default';

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

  const refreshModelOptions = useCallback(async () => {
    setLoadingModels(true);
    try {
      const models = await api.listModels(false);
      setModelOptions(models);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingModels(false);
    }
  }, [api]);

  useEffect(() => {
    const t = setTimeout(() => {
      void checkHealth();
      void refreshModelOptions();
    }, 0);
    return () => clearTimeout(t);
  }, [checkHealth, refreshModelOptions]);

  useEffect(() => ws.onStatus(setWsConnected), [ws]);

  const openModelModal = useCallback(() => {
    setModelModalVisible(true);
    if (modelOptions.length === 0 && !loadingModels) {
      void refreshModelOptions();
    }
  }, [loadingModels, modelOptions.length, refreshModelOptions]);

  const closeModelModal = useCallback(() => {
    if (loadingModels) {
      return;
    }
    setModelModalVisible(false);
  }, [loadingModels]);

  const openEffortModal = useCallback(() => {
    if (!normalizedDefaultModelId) {
      setError('Select a default model first');
      return;
    }

    const selectedModel =
      modelOptions.find((model) => model.id === normalizedDefaultModelId) ?? null;
    if (!selectedModel) {
      setError('Loading model info. Try again.');
      if (!loadingModels) {
        void refreshModelOptions();
      }
      return;
    }

    if ((selectedModel.reasoningEffort?.length ?? 0) === 0) {
      setError('Selected model does not expose reasoning levels');
      return;
    }

    setEffortModalVisible(true);
    setError(null);
  }, [
    loadingModels,
    modelOptions,
    normalizedDefaultModelId,
    refreshModelOptions,
  ]);

  const selectDefaultModel = useCallback(
    (modelId: string | null) => {
      const normalizedModel = normalizeModelId(modelId);
      const nextModel = normalizedModel
        ? modelOptions.find((model) => model.id === normalizedModel) ?? null
        : null;
      const currentEffort = normalizeReasoningEffort(defaultReasoningEffort);

      let nextEffort: ReasoningEffort | null = null;
      if (normalizedModel && nextModel) {
        const supportedEfforts = nextModel.reasoningEffort ?? [];
        nextEffort =
          currentEffort &&
          supportedEfforts.some((entry) => entry.effort === currentEffort)
            ? currentEffort
            : null;
      }

      onDefaultModelSettingsChange?.(normalizedModel, nextEffort);
      setModelModalVisible(false);
      setError(null);

      if (normalizedModel && nextModel && (nextModel.reasoningEffort?.length ?? 0) > 0) {
        setEffortModalVisible(true);
      } else {
        setEffortModalVisible(false);
      }
    },
    [defaultReasoningEffort, modelOptions, onDefaultModelSettingsChange]
  );

  const selectDefaultEffort = useCallback(
    (effort: ReasoningEffort | null) => {
      if (!normalizedDefaultModelId) {
        setError('Select a default model first');
        return;
      }

      onDefaultModelSettingsChange?.(normalizedDefaultModelId, effort);
      setEffortModalVisible(false);
      setError(null);
    },
    [normalizedDefaultModelId, onDefaultModelSettingsChange]
  );

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
          <Text style={styles.sectionLabel}>Chat Defaults</Text>
          <BlurView intensity={50} tint="dark" style={styles.card}>
            <Pressable
              onPress={openModelModal}
              style={({ pressed }) => [
                styles.settingRow,
                pressed && styles.linkRowPressed,
              ]}
            >
              <View style={styles.settingRowLeft}>
                <Text style={styles.rowLabel}>Default model</Text>
                <Text style={styles.settingValue} numberOfLines={1}>
                  {defaultModelLabel}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </Pressable>
            <Pressable
              onPress={openEffortModal}
              disabled={!canSelectDefaultEffort}
              style={({ pressed }) => [
                styles.settingRow,
                styles.settingRowLast,
                pressed && canSelectDefaultEffort && styles.linkRowPressed,
                !canSelectDefaultEffort && styles.settingRowDisabled,
              ]}
            >
              <View style={styles.settingRowLeft}>
                <Text style={styles.rowLabel}>Default reasoning</Text>
                <Text style={styles.settingValue} numberOfLines={1}>
                  {defaultEffortLabel}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </Pressable>
          </BlurView>

          <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Bridge</Text>
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
            onPress={() => {
              void checkHealth();
              void refreshModelOptions();
            }}
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

      <Modal
        visible={modelModalVisible}
        transparent
        animationType="fade"
        onRequestClose={closeModelModal}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Default model</Text>
            {loadingModels ? (
              <ActivityIndicator color={colors.textPrimary} style={styles.modalLoader} />
            ) : (
              <ScrollView style={styles.modalList} contentContainerStyle={styles.modalListContent}>
                <OptionRow
                  label="Server default"
                  selected={normalizedDefaultModelId === null}
                  onPress={() => selectDefaultModel(null)}
                />
                {modelOptions.map((model) => (
                  <OptionRow
                    key={model.id}
                    label={`${model.displayName} (${model.id})`}
                    selected={model.id === normalizedDefaultModelId}
                    onPress={() => selectDefaultModel(model.id)}
                  />
                ))}
              </ScrollView>
            )}
            <View style={styles.modalActions}>
              <Pressable
                onPress={closeModelModal}
                style={({ pressed }) => [
                  styles.modalCloseBtn,
                  pressed && styles.workspaceModalCloseBtnPressed,
                ]}
              >
                <Text style={styles.modalCloseText}>Close</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={effortModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setEffortModalVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Default reasoning</Text>
            <ScrollView style={styles.modalList} contentContainerStyle={styles.modalListContent}>
              <OptionRow
                label="Model default"
                selected={normalizedDefaultEffort === null}
                onPress={() => selectDefaultEffort(null)}
              />
              {selectedDefaultModelEfforts.map((option) => (
                <OptionRow
                  key={option.effort}
                  label={
                    option.description
                      ? `${formatReasoningEffort(option.effort)} — ${option.description}`
                      : formatReasoningEffort(option.effort)
                  }
                  selected={option.effort === normalizedDefaultEffort}
                  onPress={() => selectDefaultEffort(option.effort)}
                />
              ))}
            </ScrollView>
            <View style={styles.modalActions}>
              <Pressable
                onPress={() => setEffortModalVisible(false)}
                style={({ pressed }) => [
                  styles.modalCloseBtn,
                  pressed && styles.workspaceModalCloseBtnPressed,
                ]}
              >
                <Text style={styles.modalCloseText}>Close</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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

function OptionRow({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.optionRow,
        selected && styles.optionRowSelected,
        pressed && styles.optionRowPressed,
      ]}
    >
      <Text style={[styles.optionRowText, selected && styles.optionRowTextSelected]}>{label}</Text>
      {selected ? <Ionicons name="checkmark" size={16} color={colors.textPrimary} /> : null}
    </Pressable>
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
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderLight,
  },
  settingRowLast: {
    borderBottomWidth: 0,
  },
  settingRowLeft: {
    flex: 1,
    gap: 3,
  },
  settingValue: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  settingRowDisabled: {
    opacity: 0.45,
  },
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
    paddingVertical: spacing.md,
  },
  linkRowPressed: {
    opacity: 0.75,
  },
  linkRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  linkRowLabel: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  modalCard: {
    backgroundColor: colors.bgItem,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
    maxHeight: '74%',
  },
  modalTitle: {
    ...typography.headline,
    color: colors.textPrimary,
  },
  modalLoader: {
    marginVertical: spacing.lg,
  },
  modalList: {
    maxHeight: 320,
  },
  modalListContent: {
    gap: spacing.xs,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: colors.bgMain,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  optionRowSelected: {
    borderColor: colors.borderHighlight,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  optionRowPressed: {
    opacity: 0.86,
  },
  optionRowText: {
    ...typography.caption,
    color: colors.textSecondary,
    flex: 1,
  },
  optionRowTextSelected: {
    color: colors.textPrimary,
    fontWeight: '600',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  modalCloseBtn: {
    borderRadius: 10,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgMain,
  },
  workspaceModalCloseBtnPressed: {
    opacity: 0.85,
  },
  modalCloseText: {
    ...typography.body,
    color: colors.textPrimary,
  },
  errorText: {
    ...typography.caption,
    color: colors.error,
    marginTop: spacing.md,
    textAlign: 'center',
  },
});

function normalizeModelId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeReasoningEffort(
  effort: string | null | undefined
): ReasoningEffort | null {
  if (typeof effort !== 'string') {
    return null;
  }

  const normalized = effort.trim().toLowerCase();
  if (
    normalized === 'none' ||
    normalized === 'minimal' ||
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh'
  ) {
    return normalized;
  }

  return null;
}

function formatReasoningEffort(effort: ReasoningEffort): string {
  if (effort === 'xhigh') {
    return 'X-High';
  }
  if (effort === 'none') {
    return 'None';
  }
  if (effort === 'minimal') {
    return 'Minimal';
  }

  return effort.charAt(0).toUpperCase() + effort.slice(1);
}
