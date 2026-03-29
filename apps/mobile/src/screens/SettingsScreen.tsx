import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { HostBridgeApiClient } from '../api/client';
import type {
  AccountSnapshot,
  AccountRateLimitSnapshot,
  ApprovalMode,
  BridgeCapabilities,
  ChatEngine,
  EngineDefaultSettingsMap,
  ModelOption,
  PlanType,
  ReasoningEffort,
} from '../api/types';
import type { HostBridgeWsClient } from '../api/ws';
import { SelectionSheet, type SelectionSheetOption } from '../components/SelectionSheet';
import {
  buildComposerUsageLimitBadges,
  formatComposerUsageLimitResetAt,
} from '../components/usageLimitBadges';
import { getChatEngineLabel } from '../chatEngines';
import {
  formatModelOptionDescription,
  formatModelOptionLabel,
} from '../modelOptions';
import {
  useAppTheme,
  type AppearancePreference,
  type AppTheme,
} from '../theme';

interface SettingsScreenProps {
  api: HostBridgeApiClient;
  ws: HostBridgeWsClient;
  bridgeUrl: string;
  defaultChatEngine?: ChatEngine | null;
  defaultEngineSettings?: EngineDefaultSettingsMap | null;
  approvalMode?: ApprovalMode;
  showToolCalls?: boolean;
  appearancePreference?: AppearancePreference;
  onDefaultChatEngineChange?: (engine: ChatEngine) => void;
  onDefaultModelSettingsChange?: (
    engine: ChatEngine,
    modelId: string | null,
    effort: ReasoningEffort | null
  ) => void;
  onApprovalModeChange?: (mode: ApprovalMode) => void;
  onShowToolCallsChange?: (value: boolean) => void;
  onAppearancePreferenceChange?: (preference: AppearancePreference) => void;
  onEditBridgeUrl?: () => void;
  onResetOnboarding?: () => void;
  onOpenDrawer: () => void;
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
}

export function SettingsScreen({
  api,
  ws,
  bridgeUrl,
  defaultChatEngine,
  defaultEngineSettings,
  approvalMode,
  showToolCalls = false,
  appearancePreference = 'system',
  onDefaultChatEngineChange,
  onDefaultModelSettingsChange,
  onApprovalModeChange,
  onShowToolCallsChange,
  onAppearancePreferenceChange,
  onEditBridgeUrl,
  onResetOnboarding,
  onOpenDrawer,
  onOpenPrivacy,
  onOpenTerms,
}: SettingsScreenProps) {
  const theme = useAppTheme();
  const { colors } = theme;
  const styles = useMemo(() => createStyles(theme), [theme]);
  const transcriptSwitchTrackColor = theme.isDark ? colors.borderLight : 'rgba(95, 105, 118, 0.32)';
  const transcriptSwitchActiveColor = theme.isDark ? colors.accent : '#4F5D6D';
  const transcriptSwitchThumbColor = showToolCalls ? colors.white : '#FFFFFF';
  const [healthyAt, setHealthyAt] = useState<string | null>(null);
  const [uptimeSec, setUptimeSec] = useState<number | null>(null);
  const [wsConnected, setWsConnected] = useState(ws.isConnected);
  const [error, setError] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [engineModalVisible, setEngineModalVisible] = useState(false);
  const [modelModalVisible, setModelModalVisible] = useState(false);
  const [effortModalVisible, setEffortModalVisible] = useState(false);
  const [approvalModeModalVisible, setApprovalModeModalVisible] = useState(false);
  const [appearanceModalVisible, setAppearanceModalVisible] = useState(false);
  const [account, setAccount] = useState<AccountSnapshot | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountRateLimits, setAccountRateLimits] = useState<AccountRateLimitSnapshot | null>(null);
  const [rateLimitsLoading, setRateLimitsLoading] = useState(false);
  const [rateLimitsError, setRateLimitsError] = useState<string | null>(null);
  const [bridgeCapabilities, setBridgeCapabilities] = useState<BridgeCapabilities | null>(null);

  const availableEngines: ChatEngine[] = bridgeCapabilities?.availableEngines?.length
    ? bridgeCapabilities.availableEngines
    : ['codex'];
  const normalizedDefaultChatEngine = availableEngines.includes(defaultChatEngine ?? 'codex')
    ? (defaultChatEngine ?? 'codex')
    : availableEngines[0] ?? 'codex';
  const selectedEngineDefaults = defaultEngineSettings?.[normalizedDefaultChatEngine] ?? null;
  const normalizedDefaultModelId = normalizeModelId(selectedEngineDefaults?.modelId);
  const normalizedDefaultEffort = normalizeReasoningEffort(selectedEngineDefaults?.effort);
  const selectedDefaultModel = useMemo(
    () =>
      normalizedDefaultModelId
        ? modelOptions.find((model) => model.id === normalizedDefaultModelId) ?? null
        : null,
    [modelOptions, normalizedDefaultModelId]
  );
  const selectedDefaultModelEfforts = selectedDefaultModel?.reasoningEffort ?? [];
  const canSelectDefaultEffort = Boolean(normalizedDefaultModelId);
  const defaultEngineLabel = getChatEngineLabel(normalizedDefaultChatEngine);
  const defaultModelLabel = normalizedDefaultModelId
    ? selectedDefaultModel
      ? formatModelOptionLabel(selectedDefaultModel)
      : normalizedDefaultModelId
    : 'Server default';
  const defaultEffortLabel = normalizedDefaultModelId
    ? normalizedDefaultEffort
      ? formatReasoningEffort(normalizedDefaultEffort)
      : selectedDefaultModel?.defaultReasoningEffort
        ? `Default (${formatReasoningEffort(selectedDefaultModel.defaultReasoningEffort)})`
        : 'Model default'
    : 'Server default';
  const normalizedApprovalMode = approvalMode === 'yolo' ? 'yolo' : 'normal';
  const normalizedAppearancePreference =
    appearancePreference === 'light' || appearancePreference === 'dark'
      ? appearancePreference
      : 'system';
  const approvalModeLabel =
    normalizedApprovalMode === 'yolo'
      ? 'YOLO (no approval prompts)'
      : 'Normal (ask for approvals)';
  const appearancePreferenceLabel =
    normalizedAppearancePreference === 'light'
      ? 'Light'
      : normalizedAppearancePreference === 'dark'
        ? 'Dark'
        : 'System';
  const activeEngine = bridgeCapabilities?.activeEngine ?? null;
  const usageLimitBadges = useMemo(
    () => buildComposerUsageLimitBadges(accountRateLimits),
    [accountRateLimits]
  );
  const showCodexUsageLimits = availableEngines.includes('codex');

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

  const loadBridgeCapabilities = useCallback(async () => {
    try {
      const capabilities = await api.readBridgeCapabilities();
      setBridgeCapabilities(capabilities);
      setError(null);
    } catch (err) {
      setBridgeCapabilities(null);
      setError((err as Error).message);
    }
  }, [api]);

  const refreshModelOptions = useCallback(async () => {
    setLoadingModels(true);
    try {
      const models = await api.listModels(false, {
        engine: normalizedDefaultChatEngine,
      });
      setModelOptions(models);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingModels(false);
    }
  }, [api, normalizedDefaultChatEngine]);

  const loadAccount = useCallback(async () => {
    setAccountLoading(true);
    try {
      const snapshot = await api.readAccount();
      setAccount(snapshot);
      setAccountError(null);
    } catch (err) {
      setAccountError((err as Error).message);
    } finally {
      setAccountLoading(false);
    }
  }, [api]);

  const loadRateLimits = useCallback(async () => {
    setRateLimitsLoading(true);
    try {
      const snapshot = await api.readAccountRateLimits();
      setAccountRateLimits(snapshot);
      setRateLimitsError(null);
    } catch (err) {
      setRateLimitsError((err as Error).message);
    } finally {
      setRateLimitsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    const t = setTimeout(() => {
      void checkHealth();
      void loadBridgeCapabilities();
      void refreshModelOptions();
      void loadAccount();
      void loadRateLimits();
    }, 0);
    return () => clearTimeout(t);
  }, [checkHealth, loadAccount, loadBridgeCapabilities, loadRateLimits, refreshModelOptions]);

  useEffect(
    () =>
      ws.onStatus((connected) => {
        setWsConnected(connected);
        if (connected) {
          void loadBridgeCapabilities();
          void loadAccount();
          void loadRateLimits();
        }
      }),
    [loadAccount, loadBridgeCapabilities, loadRateLimits, ws]
  );

  useEffect(
    () =>
      ws.onEvent((event) => {
        if (event.method === 'account/rateLimits/updated') {
          void loadRateLimits();
        }

        if (event.method === 'account/updated') {
          void loadAccount();
        }
      }),
    [loadAccount, loadRateLimits, ws]
  );

  const openEngineModal = useCallback(() => {
    if (availableEngines.length <= 1) {
      return;
    }
    setEngineModalVisible(true);
    setError(null);
  }, [availableEngines.length]);

  const closeEngineModal = useCallback(() => {
    setEngineModalVisible(false);
  }, []);

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

  const selectDefaultEngine = useCallback(
    (engine: ChatEngine) => {
      onDefaultChatEngineChange?.(engine);
      setEngineModalVisible(false);
      setModelModalVisible(false);
      setEffortModalVisible(false);
      setError(null);
    },
    [onDefaultChatEngineChange]
  );

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
      const currentEffort = normalizeReasoningEffort(selectedEngineDefaults?.effort);

      let nextEffort: ReasoningEffort | null = null;
      if (normalizedModel && nextModel) {
        const supportedEfforts = nextModel.reasoningEffort ?? [];
        nextEffort =
          currentEffort &&
          supportedEfforts.some((entry) => entry.effort === currentEffort)
            ? currentEffort
            : null;
      }

      onDefaultModelSettingsChange?.(normalizedDefaultChatEngine, normalizedModel, nextEffort);
      setModelModalVisible(false);
      setError(null);

      if (normalizedModel && nextModel && (nextModel.reasoningEffort?.length ?? 0) > 0) {
        setEffortModalVisible(true);
      } else {
        setEffortModalVisible(false);
      }
    },
    [
      modelOptions,
      normalizedDefaultChatEngine,
      onDefaultModelSettingsChange,
      selectedEngineDefaults?.effort,
    ]
  );

  const selectDefaultEffort = useCallback(
    (effort: ReasoningEffort | null) => {
      if (!normalizedDefaultModelId) {
        setError('Select a default model first');
        return;
      }

      onDefaultModelSettingsChange?.(
        normalizedDefaultChatEngine,
        normalizedDefaultModelId,
        effort
      );
      setEffortModalVisible(false);
      setError(null);
    },
    [normalizedDefaultChatEngine, normalizedDefaultModelId, onDefaultModelSettingsChange]
  );

  const selectApprovalMode = useCallback(
    (mode: ApprovalMode) => {
      onApprovalModeChange?.(mode);
      setApprovalModeModalVisible(false);
      setError(null);
    },
    [onApprovalModeChange]
  );

  const approvalModeOptions = useMemo<SelectionSheetOption[]>(
    () => [
      {
        key: 'normal',
        title: 'Normal approvals',
        description: 'Ask before commands and file-changing actions run.',
        icon: 'shield-checkmark-outline',
        selected: normalizedApprovalMode === 'normal',
        onPress: () => selectApprovalMode('normal'),
      },
      {
        key: 'yolo',
        title: 'YOLO approvals',
        description: 'Run commands without prompting for approval.',
        icon: 'flash-outline',
        meta: 'Unsafe',
        selected: normalizedApprovalMode === 'yolo',
        onPress: () => selectApprovalMode('yolo'),
      },
    ],
    [normalizedApprovalMode, selectApprovalMode]
  );

  const appearanceOptions = useMemo<SelectionSheetOption[]>(
    () => [
      {
        key: 'system',
        title: 'System',
        description: 'Follow the current device appearance setting.',
        icon: 'phone-portrait-outline',
        selected: normalizedAppearancePreference === 'system',
        onPress: () => {
          onAppearancePreferenceChange?.('system');
          setAppearanceModalVisible(false);
        },
      },
      {
        key: 'light',
        title: 'Light',
        description: 'Use the bright palette throughout the app.',
        icon: 'sunny-outline',
        selected: normalizedAppearancePreference === 'light',
        onPress: () => {
          onAppearancePreferenceChange?.('light');
          setAppearanceModalVisible(false);
        },
      },
      {
        key: 'dark',
        title: 'Dark',
        description: 'Keep the current dark interface regardless of device theme.',
        icon: 'moon-outline',
        selected: normalizedAppearancePreference === 'dark',
        onPress: () => {
          onAppearancePreferenceChange?.('dark');
          setAppearanceModalVisible(false);
        },
      },
    ],
    [normalizedAppearancePreference, onAppearancePreferenceChange]
  );

  const enginePickerOptions = useMemo<SelectionSheetOption[]>(
    () =>
      availableEngines.map((engine) => ({
        key: engine,
        title: getChatEngineLabel(engine),
        description:
          engine === 'opencode'
            ? 'Use OpenCode defaults for new chats.'
            : 'Use Codex defaults for new chats.',
        icon: engine === 'opencode' ? ('layers-outline' as const) : ('sparkles-outline' as const),
        selected: engine === normalizedDefaultChatEngine,
        onPress: () => selectDefaultEngine(engine),
      })),
    [availableEngines, normalizedDefaultChatEngine, selectDefaultEngine]
  );

  const modelPickerOptions = useMemo<SelectionSheetOption[]>(
    () => [
      {
        key: 'server-default',
        title: 'Use server default',
        description: 'Follow the bridge default model for new chats.',
        icon: 'sparkles-outline',
        badge: 'Auto',
        selected: normalizedDefaultModelId === null,
        onPress: () => selectDefaultModel(null),
      },
      ...modelOptions.map((model) => ({
        key: model.id,
        title: formatModelOptionLabel(model),
        description: formatModelOptionDescription(model),
        icon: 'hardware-chip-outline' as const,
        badge: model.isDefault ? 'Default' : undefined,
        meta: model.defaultReasoningEffort
          ? formatReasoningEffort(model.defaultReasoningEffort)
          : undefined,
        selected: model.id === normalizedDefaultModelId,
        onPress: () => selectDefaultModel(model.id),
      })),
    ],
    [modelOptions, normalizedDefaultModelId, selectDefaultModel]
  );

  const effortPickerOptions = useMemo<SelectionSheetOption[]>(
    () => [
      {
        key: 'model-default',
        title: 'Use model default',
        description: selectedDefaultModel
          ? `Follow ${formatModelOptionLabel(selectedDefaultModel)}'s default reasoning.`
          : 'Follow the model default reasoning level.',
        icon: 'sparkles-outline',
        badge: 'Auto',
        selected: normalizedDefaultEffort === null,
        onPress: () => selectDefaultEffort(null),
      },
      ...selectedDefaultModelEfforts.map((option) => ({
        key: option.effort,
        title: formatReasoningEffort(option.effort),
        description:
          option.description?.trim() ||
          'Override the default reasoning depth for new chats.',
        icon: 'pulse-outline' as const,
        selected: option.effort === normalizedDefaultEffort,
        onPress: () => selectDefaultEffort(option.effort),
      })),
    ],
    [
      normalizedDefaultEffort,
      selectDefaultEffort,
      selectedDefaultModel,
      selectedDefaultModelEfforts,
    ]
  );

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={[colors.bgMain, colors.bgMain, colors.bgMain]}
        style={StyleSheet.absoluteFill}
      />
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <Pressable onPress={onOpenDrawer} hitSlop={8} style={styles.menuBtn}>
            <Ionicons name="menu" size={22} color={colors.textPrimary} />
          </Pressable>
          <Ionicons name="settings" size={16} color={colors.textPrimary} />
          <Text style={styles.headerTitle}>Settings</Text>
        </View>

        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          <Text style={styles.sectionLabel}>Chat Defaults</Text>
          <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
            <Pressable
              onPress={openEngineModal}
              disabled={availableEngines.length <= 1}
              style={({ pressed }) => [
                styles.settingRow,
                pressed && availableEngines.length > 1 && styles.linkRowPressed,
                availableEngines.length <= 1 && styles.settingRowDisabled,
              ]}
            >
              <View style={styles.settingRowLeft}>
                <Text style={styles.rowLabel}>Default engine</Text>
                <Text style={styles.settingValue} numberOfLines={1}>
                  {defaultEngineLabel}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </Pressable>
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

          <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Appearance</Text>
          <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
            <Pressable
              onPress={() => setAppearanceModalVisible(true)}
              style={({ pressed }) => [
                styles.settingRow,
                styles.settingRowLast,
                pressed && styles.linkRowPressed,
              ]}
            >
              <View style={styles.settingRowLeft}>
                <Text style={styles.rowLabel}>Theme</Text>
                <Text style={styles.settingValue} numberOfLines={2}>
                  {appearancePreferenceLabel}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </Pressable>
          </BlurView>
          <Text style={styles.subtleHintText}>
            System follows your phone appearance. Existing installs stay dark until changed.
          </Text>

          <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Approvals & Permissions</Text>
          <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
            <Pressable
              onPress={() => setApprovalModeModalVisible(true)}
              style={({ pressed }) => [
                styles.settingRow,
                styles.settingRowLast,
                pressed && styles.linkRowPressed,
              ]}
            >
              <View style={styles.settingRowLeft}>
                <Text style={styles.rowLabel}>Execution approval mode</Text>
                <Text style={styles.settingValue} numberOfLines={2}>
                  {approvalModeLabel}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </Pressable>
          </BlurView>
          <Text style={styles.subtleHintText}>
            This controls command/file-change approvals only. It does not affect
            request_user_input questions. Mobile chats request full Codex sandbox
            access by default.
          </Text>

          <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Transcript</Text>
          <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
            <View style={[styles.settingRow, styles.settingRowLast]}>
              <View style={styles.settingRowLeft}>
                <Text style={styles.rowLabel}>Show tool calls</Text>
                <Text style={styles.settingValue} numberOfLines={2}>
                  Show web searches, MCP/OpenAI docs calls, commands, and file changes.
                </Text>
              </View>
              <Switch
                value={showToolCalls}
                onValueChange={(value) => onShowToolCallsChange?.(value)}
                trackColor={{ false: transcriptSwitchTrackColor, true: transcriptSwitchActiveColor }}
                thumbColor={transcriptSwitchThumbColor}
                ios_backgroundColor={transcriptSwitchTrackColor}
              />
            </View>
          </BlurView>
          <Text style={styles.subtleHintText}>
            Live tool activity stays in a capped panel so the chat list does not
            start jumping while a turn is running.
          </Text>

          <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Account & Auth</Text>
          <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
            {accountLoading ? (
              <View style={styles.accountLoadingState}>
                <ActivityIndicator color={colors.textPrimary} />
                <Text style={styles.settingValue}>Loading account details…</Text>
              </View>
            ) : (
              <>
                <Row
                  label="Status"
                  value={formatAccountType(account)}
                  valueColor={account?.type ? colors.statusComplete : colors.textMuted}
                />
                {account?.email ? (
                  <Row label="Email" value={account.email} />
                ) : null}
                {account?.planType ? (
                  <Row label="Plan" value={formatPlanType(account.planType)} />
                ) : null}
                <Row
                  label="Bridge auth"
                  value={account?.requiresOpenaiAuth ? 'Required' : 'Optional'}
                  isLast
                />
              </>
            )}
          </BlurView>
          {account?.type === null && account?.requiresOpenaiAuth ? (
            <Text style={styles.subtleHintText}>
              The bridge expects OpenAI auth, but mobile does not expose a login flow yet.
            </Text>
          ) : null}
          {accountError ? <Text style={styles.errorText}>{accountError}</Text> : null}

          {showCodexUsageLimits ? (
            <>
              <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Codex Usage Limits</Text>
              <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
                {rateLimitsLoading ? (
                  <View style={styles.accountLoadingState}>
                    <ActivityIndicator color={colors.textPrimary} />
                    <Text style={styles.settingValue}>Loading usage limits…</Text>
                  </View>
                ) : usageLimitBadges.length > 0 ? (
                  usageLimitBadges.map((limit, index) => {
                    const toneColor =
                      limit.tone === 'critical'
                        ? colors.statusError
                        : limit.tone === 'warning'
                          ? colors.warning
                          : colors.statusComplete;
                    const label = limit.label === 'weekly' ? 'Weekly' : limit.label;
                    const isLastLimit = index === usageLimitBadges.length - 1;

                    return (
                      <Fragment key={limit.id}>
                        <Row
                          label={`${label} remaining`}
                          value={`${String(limit.remainingPercent)}%`}
                          valueColor={toneColor}
                        />
                        <Row
                          label={`${label} resets`}
                          value={formatComposerUsageLimitResetAt(limit.resetsAt)}
                          isLast={isLastLimit}
                        />
                      </Fragment>
                    );
                  })
                ) : (
                  <View style={styles.accountLoadingState}>
                    <Text style={styles.settingValue}>No usage limit data yet</Text>
                  </View>
                )}
              </BlurView>
              <Text style={styles.subtleHintText}>
                Reset times are shown in your local device timezone.
              </Text>
              {rateLimitsError ? <Text style={styles.errorText}>{rateLimitsError}</Text> : null}
            </>
          ) : null}

          <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Bridge</Text>
          <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
            <Text selectable style={styles.valueText}>
              {bridgeUrl}
            </Text>
            <Pressable
              onPress={onEditBridgeUrl}
              style={({ pressed }) => [
                styles.bridgeEditBtn,
                pressed && styles.bridgeEditBtnPressed,
              ]}
            >
              <Ionicons name="swap-horizontal-outline" size={15} color={colors.textPrimary} />
              <Text style={styles.bridgeEditBtnText}>Change bridge URL</Text>
            </Pressable>
            <Pressable
              onPress={onResetOnboarding}
              style={({ pressed }) => [
                styles.bridgeResetBtn,
                pressed && styles.bridgeResetBtnPressed,
              ]}
            >
              <Ionicons name="refresh-circle-outline" size={15} color={colors.error} />
              <Text style={styles.bridgeResetBtnText}>Reset onboarding</Text>
            </Pressable>
          </BlurView>

          <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Engines</Text>
          <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
            <EngineAvailabilityRow
              engine="codex"
              available={availableEngines.includes('codex')}
              active={activeEngine === 'codex'}
            />
            <EngineAvailabilityRow
              engine="opencode"
              available={availableEngines.includes('opencode')}
              active={activeEngine === 'opencode'}
              isLast
            />
          </BlurView>
          <Text style={styles.subtleHintText}>
            The new chat engine picker only appears when multiple engines are available on
            this bridge.
          </Text>

          <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Health</Text>
          <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
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
              void loadBridgeCapabilities();
              void refreshModelOptions();
              void loadAccount();
              void loadRateLimits();
            }}
            style={({ pressed }) => [styles.refreshBtn, pressed && styles.refreshBtnPressed]}
          >
            <Ionicons name="refresh" size={16} color={colors.white} />
            <Text style={styles.refreshBtnText}>Refresh settings</Text>
          </Pressable>

          <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Legal</Text>
          <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
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

      <SelectionSheet
        visible={engineModalVisible}
        eyebrow="Defaults"
        title="Default engine"
        subtitle="Pick which backend new chats should start with."
        options={enginePickerOptions}
        onClose={closeEngineModal}
      />

      <SelectionSheet
        visible={appearanceModalVisible}
        eyebrow="Appearance"
        title="Theme"
        subtitle="Choose whether the mobile app follows the system appearance or uses an explicit mode."
        options={appearanceOptions}
        onClose={() => setAppearanceModalVisible(false)}
      />

      <SelectionSheet
        visible={approvalModeModalVisible}
        eyebrow="Approvals"
        title="Execution approval mode"
        subtitle="This only affects command and file-change approvals."
        options={approvalModeOptions}
        onClose={() => setApprovalModeModalVisible(false)}
      />

      <SelectionSheet
        visible={modelModalVisible}
        eyebrow="Defaults"
        title="Default model"
        subtitle={`Pick the ${defaultEngineLabel} model new chats should start with.`}
        options={modelPickerOptions}
        loading={loadingModels}
        loadingLabel="Refreshing available models…"
        presentation="expanded"
        onClose={closeModelModal}
      />

      <SelectionSheet
        visible={effortModalVisible}
        eyebrow="Defaults"
        title="Default reasoning"
        subtitle={
          selectedDefaultModel
            ? `Current model: ${formatModelOptionLabel(selectedDefaultModel)}`
            : `Choose the default reasoning depth for ${defaultEngineLabel} chats.`
        }
        options={effortPickerOptions}
        presentation="expanded"
        onClose={() => setEffortModalVisible(false)}
      />
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
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={[styles.row, isLast && styles.rowLast]}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, valueColor ? { color: valueColor } : undefined]}>
        {value}
      </Text>
    </View>
  );
}

function EngineAvailabilityRow({
  engine,
  available,
  active,
  isLast,
}: {
  engine: ChatEngine;
  available: boolean;
  active: boolean;
  isLast?: boolean;
}) {
  const theme = useAppTheme();
  const value = available
    ? active
      ? 'Available · active'
      : 'Available'
    : 'Not installed on bridge';
  const valueColor = available ? theme.colors.statusComplete : theme.colors.textMuted;

  return (
    <Row
      label={getChatEngineLabel(engine)}
      value={value}
      valueColor={valueColor}
      isLast={isLast}
    />
  );
}

const createStyles = (theme: AppTheme) => {
  const settingsCardBackground = theme.isDark ? theme.colors.bgCanvasAccent : '#F3F7FB';
  const settingsCardBorder = theme.isDark
    ? theme.colors.borderHighlight
    : 'rgba(71, 85, 105, 0.22)';
  const settingsDivider = theme.isDark
    ? theme.colors.borderLight
    : 'rgba(71, 85, 105, 0.16)';
  const settingsCardShadow = theme.isDark
    ? undefined
    : '0px 14px 30px rgba(15, 31, 54, 0.10)';
  const neutralControlBackground = theme.isDark ? theme.colors.bgMain : '#D9E2EB';
  const neutralControlPressed = theme.isDark ? theme.colors.bgItem : '#CCD6E0';
  const settingsLabelColor = theme.isDark ? theme.colors.textMuted : '#536172';
  const settingsValueColor = theme.isDark ? theme.colors.textSecondary : '#3F4C5A';
  const settingsPrimaryText = theme.isDark ? theme.colors.textPrimary : '#263341';
  const hintTextColor = theme.isDark ? theme.colors.textMuted : '#556270';

  return StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.colors.bgMain },
    safeArea: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      backgroundColor: theme.colors.bgMain,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.borderHighlight,
    },
    menuBtn: { padding: theme.spacing.xs },
    headerTitle: { ...theme.typography.headline, color: theme.colors.textPrimary },
    body: { flex: 1 },
    bodyContent: { padding: theme.spacing.lg },
    card: {
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: settingsCardBorder,
      paddingHorizontal: theme.spacing.lg,
      marginBottom: theme.spacing.xs,
      overflow: 'hidden',
      backgroundColor: settingsCardBackground,
      boxShadow: settingsCardShadow,
    },
    sectionLabel: {
      ...theme.typography.caption,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
      marginTop: theme.spacing.sm,
      marginBottom: theme.spacing.sm,
      color: settingsLabelColor,
      marginLeft: theme.spacing.xs,
    },
    sectionLabelGap: { marginTop: theme.spacing.xl },
    valueText: {
      ...theme.typography.mono,
      color: settingsPrimaryText,
      paddingVertical: theme.spacing.md,
      fontSize: 14,
    },
    bridgeEditBtn: {
      marginBottom: theme.spacing.md,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: settingsCardBorder,
      backgroundColor: neutralControlBackground,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
      paddingVertical: theme.spacing.sm,
    },
    bridgeEditBtnPressed: {
      backgroundColor: neutralControlPressed,
    },
    bridgeEditBtnText: {
      ...theme.typography.caption,
      color: settingsPrimaryText,
      fontWeight: '600',
    },
    bridgeResetBtn: {
      marginBottom: theme.spacing.md,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: theme.colors.error,
      backgroundColor: theme.colors.errorBg,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
      paddingVertical: theme.spacing.sm,
    },
    bridgeResetBtnPressed: {
      opacity: 0.82,
    },
    bridgeResetBtnText: {
      ...theme.typography.caption,
      color: theme.colors.error,
      fontWeight: '700',
    },
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: theme.spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: settingsDivider,
    },
    rowLast: {
      borderBottomWidth: 0,
    },
    rowLabel: { ...theme.typography.body, color: settingsLabelColor },
    rowValue: {
      ...theme.typography.body,
      fontWeight: '600',
      color: settingsPrimaryText,
      paddingLeft: theme.spacing.sm,
      flexShrink: 1,
      textAlign: 'right',
    },
    settingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: settingsDivider,
    },
    settingRowLast: {
      borderBottomWidth: 0,
    },
    settingRowLeft: {
      flex: 1,
      gap: 3,
    },
    settingValue: {
      ...theme.typography.caption,
      color: settingsValueColor,
    },
    settingRowDisabled: {
      opacity: 0.45,
    },
    subtleHintText: {
      ...theme.typography.caption,
      color: hintTextColor,
      marginTop: theme.spacing.xs,
      marginHorizontal: theme.spacing.xs,
    },
    accountLoadingState: {
      minHeight: 88,
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.sm,
    },
    refreshBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.sm,
      marginTop: theme.spacing.xl,
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.md,
      backgroundColor: theme.colors.accent,
      borderRadius: theme.radius.md,
      boxShadow: `0px 4px 8px ${theme.colors.accent}4D`,
    },
    refreshBtnPressed: { backgroundColor: theme.colors.accentPressed },
    refreshBtnText: {
      ...theme.typography.headline,
      color: theme.colors.accentText,
      fontSize: 15,
    },
    linkRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: theme.spacing.md,
    },
    linkRowPressed: {
      backgroundColor: neutralControlPressed,
    },
    linkRowLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    linkRowLabel: {
      ...theme.typography.body,
      color: settingsPrimaryText,
      fontWeight: '600',
    },
    errorText: {
      ...theme.typography.caption,
      color: theme.colors.error,
      marginTop: theme.spacing.md,
      textAlign: 'center',
    },
  });
};

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

function formatAccountType(account: AccountSnapshot | null): string {
  if (!account?.type) {
    return 'Signed out';
  }

  return account.type === 'chatgpt' ? 'ChatGPT' : 'API key';
}

function formatPlanType(planType: PlanType): string {
  if (planType === 'pro') {
    return 'Pro';
  }
  if (planType === 'plus') {
    return 'Plus';
  }
  if (planType === 'go') {
    return 'Go';
  }
  if (planType === 'edu') {
    return 'Edu';
  }

  return planType.charAt(0).toUpperCase() + planType.slice(1);
}
