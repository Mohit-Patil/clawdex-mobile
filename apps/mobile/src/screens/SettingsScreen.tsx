import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import type { PurchasesOffering, PurchasesPackage } from 'react-native-purchases';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { HostBridgeApiClient } from '../api/client';
import type {
  AccountSnapshot,
  AccountRateLimitSnapshot,
  ApprovalMode,
  BridgeCapabilities,
  BridgeRuntimeInfo,
  ChatEngine,
  EngineDefaultSettingsMap,
  ModelOption,
  PlanType,
  ReasoningEffort,
} from '../api/types';
import type { HostBridgeWsClient } from '../api/ws';
import type { BridgeProfile } from '../bridgeProfiles';
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
import {
  getTipJarUnavailableReason,
  isTipPaywallTemplateAvailable,
  getTipTierDescription,
  getTipTierMeta,
  getTipTierTitle,
  isRevenueCatPurchaseCancelled,
  isTipJarAvailable,
  loadTipOffering,
  presentTipPaywall,
  purchaseTipPackage,
} from '../tips';
import {
  canOpenAppStoreWriteReviewPage,
  openAppStoreWriteReviewPage,
} from '../storeReview';

interface SettingsScreenProps {
  api: HostBridgeApiClient;
  ws: HostBridgeWsClient;
  bridgeUrl: string;
  activeBridgeProfileId?: string | null;
  bridgeProfileName: string;
  bridgeProfiles: BridgeProfile[];
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
  onEditBridgeProfile?: () => void;
  onAddBridgeProfile?: () => void;
  onSwitchBridgeProfile?: (profileId: string) => void | Promise<void>;
  onClearSavedBridges?: () => void | Promise<void>;
  onOpenDrawer: () => void;
  onDrawerGestureEnabledChange?: (enabled: boolean) => void;
  onOpenBrowser?: () => void;
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
}

type SettingsRoute =
  | 'home'
  | 'chat'
  | 'account'
  | 'limits'
  | 'bridge'
  | 'appearance'
  | 'tips'
  | 'legal';

const SETTINGS_BACK_GESTURE_DISTANCE = 56;
const SETTINGS_BACK_GESTURE_VELOCITY = 900;
const SETTINGS_BACK_EDGE_WIDTH = 28;
const SETTINGS_ROUTE_TRANSITION_OFFSET = 18;
const SETTINGS_ROUTE_TRANSITION_MS = 220;

type SettingsRouteTransitionDirection = 'forward' | 'backward';

export function SettingsScreen({
  api,
  ws,
  bridgeUrl,
  activeBridgeProfileId = null,
  bridgeProfileName,
  bridgeProfiles,
  defaultChatEngine,
  defaultEngineSettings,
  approvalMode,
  showToolCalls = true,
  appearancePreference = 'system',
  onDefaultChatEngineChange,
  onDefaultModelSettingsChange,
  onApprovalModeChange,
  onShowToolCallsChange,
  onAppearancePreferenceChange,
  onEditBridgeProfile,
  onAddBridgeProfile,
  onSwitchBridgeProfile,
  onClearSavedBridges,
  onOpenDrawer,
  onDrawerGestureEnabledChange,
  onOpenBrowser,
  onOpenPrivacy,
  onOpenTerms,
}: SettingsScreenProps) {
  const theme = useAppTheme();
  const { colors } = theme;
  const insets = useSafeAreaInsets();
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
  const [bridgeProfileModalVisible, setBridgeProfileModalVisible] = useState(false);
  const [account, setAccount] = useState<AccountSnapshot | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountRateLimits, setAccountRateLimits] = useState<AccountRateLimitSnapshot | null>(null);
  const [rateLimitsLoading, setRateLimitsLoading] = useState(false);
  const [rateLimitsError, setRateLimitsError] = useState<string | null>(null);
  const [bridgeCapabilities, setBridgeCapabilities] = useState<BridgeCapabilities | null>(null);
  const [bridgeRuntime, setBridgeRuntime] = useState<BridgeRuntimeInfo | null>(null);
  const [bridgeRuntimeLoading, setBridgeRuntimeLoading] = useState(false);
  const [bridgeRuntimeError, setBridgeRuntimeError] = useState<string | null>(null);
  const [bridgeRestartModalVisible, setBridgeRestartModalVisible] = useState(false);
  const [bridgeRestartActionError, setBridgeRestartActionError] = useState<string | null>(null);
  const [bridgeRestartStarting, setBridgeRestartStarting] = useState(false);
  const [bridgeUpdateModalVisible, setBridgeUpdateModalVisible] = useState(false);
  const [bridgeUpdateActionError, setBridgeUpdateActionError] = useState<string | null>(null);
  const [bridgeUpdateStarting, setBridgeUpdateStarting] = useState(false);
  const [tipOffering, setTipOffering] = useState<PurchasesOffering | null>(null);
  const [tipPackages, setTipPackages] = useState<PurchasesPackage[]>([]);
  const [tipsLoading, setTipsLoading] = useState(false);
  const [tipsError, setTipsError] = useState<string | null>(null);
  const [tipActionError, setTipActionError] = useState<string | null>(null);
  const [tipActionMessage, setTipActionMessage] = useState<string | null>(null);
  const [tipPurchasingPackageId, setTipPurchasingPackageId] = useState<string | null>(null);
  const [tipPaywallOpening, setTipPaywallOpening] = useState(false);
  const [route, setRoute] = useState<SettingsRoute>('home');
  const [routeTransitionDirection, setRouteTransitionDirection] =
    useState<SettingsRouteTransitionDirection>('forward');
  const routeContentTranslateX = useSharedValue(0);
  const routeContentOpacity = useSharedValue(1);
  const handleReturnToSettingsHome = useCallback(() => {
    setRouteTransitionDirection('backward');
    setRoute('home');
  }, []);
  const navigateToRoute = useCallback((nextRoute: Exclude<SettingsRoute, 'home'>) => {
    setRouteTransitionDirection('forward');
    setRoute(nextRoute);
  }, []);

  const availableEngines: ChatEngine[] = bridgeCapabilities?.availableEngines?.length
    ? bridgeCapabilities.availableEngines
    : defaultChatEngine
      ? [defaultChatEngine]
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
  const canSelfUpdateBridge =
    bridgeCapabilities?.supports.selfUpdate === true &&
    bridgeRuntime?.selfUpdateSupported === true;
  const canSafeRestartBridge = bridgeRuntime?.safeRestartSupported === true;
  const bridgeUpdateStatus = bridgeRuntime?.updaterStatus ?? null;
  const bridgeMaintenanceBusy = bridgeUpdateStarting || bridgeRestartStarting;
  const bridgeMaintenanceActive = bridgeUpdateStatus
    ? isBridgeMaintenanceInProgress(bridgeUpdateStatus.state)
    : false;
  const bridgeLatestVersion = bridgeRuntime?.latestVersion?.trim() || null;
  const headerTitle =
    route === 'chat'
      ? 'Chat Preferences'
      : route === 'account'
        ? 'Account & Auth'
        : route === 'limits'
          ? 'Codex Usage Limits'
          : route === 'bridge'
          ? 'Bridge & Servers'
          : route === 'appearance'
            ? 'Appearance'
            : route === 'tips'
              ? 'Support Clawdex'
              : route === 'legal'
                ? 'Legal'
                : 'Settings';
  const headerIcon =
    route === 'chat'
      ? ('sparkles-outline' as const)
      : route === 'account'
        ? ('person-circle-outline' as const)
        : route === 'limits'
          ? ('speedometer-outline' as const)
          : route === 'bridge'
          ? ('server-outline' as const)
          : route === 'appearance'
            ? ('color-palette-outline' as const)
            : route === 'tips'
              ? ('heart-outline' as const)
              : route === 'legal'
                ? ('document-text-outline' as const)
                : ('settings' as const);
  const chatDefaultsSummary = normalizedDefaultModelId
    ? `${defaultEngineLabel} · ${defaultModelLabel} · ${defaultEffortLabel}`
    : `${defaultEngineLabel} · Server default`;
  const appearanceSummary = `Current theme: ${appearancePreferenceLabel}`;
  const accountSummary = 'View account type, email, and bridge auth details';
  const usageLimitsSummary = 'View weekly usage and reset times';
  const bridgeSummary = 'Manage profiles, maintenance, engines, and health';
  const tipJarSummary = isTipJarAvailable()
    ? 'Support development with a one-time tip'
    : 'Configure RevenueCat to enable tips';
  const nativeTipPaywallAvailable = isTipPaywallTemplateAvailable();
  const shouldShowManualTipTierList = !nativeTipPaywallAvailable || tipActionError !== null;
  const tipPreviewPackages = tipPackages.slice(0, 4);
  const legalSummary = 'Privacy details and terms of service';
  const canRateOnAppStore =
    Platform.OS === 'ios' && canOpenAppStoreWriteReviewPage();
  const shouldLoadChatSettings = route === 'chat';
  const shouldLoadAccountSettings = route === 'account';
  const shouldLoadLimitsSettings = route === 'limits';
  const shouldLoadBridgeSettings = route === 'bridge';

  useEffect(() => {
    onDrawerGestureEnabledChange?.(route === 'home');
  }, [onDrawerGestureEnabledChange, route]);

  useEffect(
    () => () => {
      onDrawerGestureEnabledChange?.(true);
    },
    [onDrawerGestureEnabledChange]
  );

  useEffect(() => {
    const directionMultiplier = routeTransitionDirection === 'forward' ? 1 : -1;
    routeContentTranslateX.value =
      directionMultiplier * SETTINGS_ROUTE_TRANSITION_OFFSET;
    routeContentOpacity.value = 0;
    routeContentTranslateX.value = withTiming(0, {
      duration: SETTINGS_ROUTE_TRANSITION_MS,
      easing: Easing.out(Easing.cubic),
    });
    routeContentOpacity.value = withTiming(1, {
      duration: SETTINGS_ROUTE_TRANSITION_MS,
      easing: Easing.out(Easing.quad),
    });
  }, [
    route,
    routeContentOpacity,
    routeContentTranslateX,
    routeTransitionDirection,
  ]);

  const routeContentAnimatedStyle = useAnimatedStyle(() => ({
    opacity: routeContentOpacity.value,
    transform: [{ translateX: routeContentTranslateX.value }],
  }));

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

  const loadBridgeRuntime = useCallback(async () => {
    setBridgeRuntimeLoading(true);
    try {
      const runtime = await api.readBridgeRuntime();
      setBridgeRuntime(runtime);
      setBridgeRuntimeError(null);
    } catch (err) {
      setBridgeRuntimeError((err as Error).message);
    } finally {
      setBridgeRuntimeLoading(false);
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

  const loadTips = useCallback(async () => {
    if (!isTipJarAvailable()) {
      setTipOffering(null);
      setTipPackages([]);
      setTipsError(getTipJarUnavailableReason());
      return;
    }

    setTipsError(null);
    setTipsLoading(true);
    try {
      const snapshot = await loadTipOffering();
      setTipOffering(snapshot.offering);
      setTipPackages(snapshot.packages);
      setTipsError(null);
    } catch (err) {
      setTipOffering(null);
      setTipPackages([]);
      setTipsError((err as Error).message);
    } finally {
      setTipsLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      if (shouldLoadBridgeSettings) {
        void checkHealth();
        void loadBridgeCapabilities();
        void loadBridgeRuntime();
      }
      if (shouldLoadChatSettings) {
        void loadBridgeCapabilities();
        void refreshModelOptions();
      }
      if (shouldLoadAccountSettings) {
        void loadAccount();
      }
      if (shouldLoadLimitsSettings) {
        void loadRateLimits();
      }
    }, 0);
    return () => clearTimeout(t);
  }, [
    checkHealth,
    loadAccount,
    loadBridgeCapabilities,
    loadBridgeRuntime,
    loadRateLimits,
    refreshModelOptions,
    shouldLoadAccountSettings,
    shouldLoadBridgeSettings,
    shouldLoadChatSettings,
    shouldLoadLimitsSettings,
  ]);

  useEffect(
    () =>
      ws.onStatus((connected) => {
        setWsConnected(connected);
        if (connected) {
          if (shouldLoadBridgeSettings) {
            void checkHealth();
            void loadBridgeCapabilities();
            void loadBridgeRuntime();
          }
          if (shouldLoadChatSettings) {
            void loadBridgeCapabilities();
            void refreshModelOptions();
          }
          if (shouldLoadAccountSettings) {
            void loadAccount();
          }
          if (shouldLoadLimitsSettings) {
            void loadRateLimits();
          }
        }
      }),
    [
      checkHealth,
      loadAccount,
      loadBridgeCapabilities,
      loadBridgeRuntime,
      loadRateLimits,
      refreshModelOptions,
      shouldLoadAccountSettings,
      shouldLoadBridgeSettings,
      shouldLoadChatSettings,
      shouldLoadLimitsSettings,
      ws,
    ]
  );

  useEffect(
    () =>
      ws.onEvent((event) => {
        if (event.method === 'account/rateLimits/updated' && shouldLoadLimitsSettings) {
          void loadRateLimits();
        }

        if (event.method === 'account/updated' && shouldLoadAccountSettings) {
          void loadAccount();
        }
      }),
    [loadAccount, loadRateLimits, shouldLoadAccountSettings, shouldLoadLimitsSettings, ws]
  );

  useEffect(() => {
    if (
      route !== 'tips' ||
      tipsLoading ||
      tipOffering ||
      tipPackages.length > 0 ||
      tipsError !== null
    ) {
      return;
    }

    void loadTips();
  }, [loadTips, route, tipOffering, tipPackages.length, tipsError, tipsLoading]);

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

  const handlePurchaseTip = useCallback(async (aPackage: PurchasesPackage) => {
    setTipActionError(null);
    setTipActionMessage(null);
    setTipPurchasingPackageId(aPackage.identifier);

    try {
      await purchaseTipPackage(aPackage);
      setTipActionMessage('Thanks for supporting Clawdex.');
    } catch (err) {
      if (!isRevenueCatPurchaseCancelled(err)) {
        setTipActionError((err as Error).message);
      }
    } finally {
      setTipPurchasingPackageId(null);
    }
  }, []);

  const handleOpenTipPaywall = useCallback(async () => {
    setTipActionError(null);
    setTipActionMessage(null);
    setTipPaywallOpening(true);

    try {
      let nextOffering = tipOffering;

      if (!nextOffering || tipPackages.length === 0) {
        const snapshot = await loadTipOffering();
        nextOffering = snapshot.offering;
        setTipOffering(snapshot.offering);
        setTipPackages(snapshot.packages);
      }

      const result = await presentTipPaywall(nextOffering);
      if (result === 'purchased') {
        setTipActionMessage('Thanks for supporting Clawdex.');
      } else if (result === 'restored') {
        setTipActionMessage('Previous tip purchase restored.');
      } else if (result === 'notPresented') {
        setTipActionError('The RevenueCat paywall was not available for this offering.');
      }
    } catch (err) {
      setTipActionError((err as Error).message);
    } finally {
      setTipPaywallOpening(false);
    }
  }, [tipOffering, tipPackages]);

  const handleOpenSupportClawdex = useCallback(() => {
    if (nativeTipPaywallAvailable) {
      void handleOpenTipPaywall();
      return;
    }

    navigateToRoute('tips');
  }, [handleOpenTipPaywall, nativeTipPaywallAvailable, navigateToRoute]);

  const handleOpenAppStoreReview = useCallback(() => {
    void (async () => {
      try {
        const opened = await openAppStoreWriteReviewPage();
        if (!opened) {
          setError('App Store reviews are only available on iOS.');
          return;
        }

        setError(null);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Unable to open the App Store review page.'
        );
      }
    })();
  }, []);

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

  const bridgeProfileOptions = useMemo<SelectionSheetOption[]>(
    () =>
      bridgeProfiles.map((profile) => ({
        key: profile.id,
        title: profile.name,
        description: profile.bridgeUrl,
        icon: 'server-outline' as const,
        badge: profile.id === activeBridgeProfileId ? 'Active' : undefined,
        selected: profile.id === activeBridgeProfileId,
        onPress: () => {
          setBridgeProfileModalVisible(false);
          void onSwitchBridgeProfile?.(profile.id);
        },
      })),
    [activeBridgeProfileId, bridgeProfiles, onSwitchBridgeProfile]
  );

  const startBridgeRestart = useCallback(async () => {
    setBridgeRestartStarting(true);
    setBridgeRestartActionError(null);
    try {
      const response = await api.startBridgeRestart();
      setBridgeRestartModalVisible(false);
      setBridgeRuntime((previous) => ({
        version: previous?.version ?? 'unknown',
        installKind: previous?.installKind ?? 'unknown',
        selfUpdateSupported: previous?.selfUpdateSupported ?? false,
        safeRestartSupported: previous?.safeRestartSupported ?? true,
        latestVersion: previous?.latestVersion ?? bridgeLatestVersion,
        updaterStatus: {
          state: 'scheduled',
          jobId: response.jobId,
          targetVersion: previous?.version ?? 'current',
          message: response.message,
          updatedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          logPath: response.logPath ?? null,
        },
      }));
    } catch (err) {
      setBridgeRestartActionError((err as Error).message);
    } finally {
      setBridgeRestartStarting(false);
    }
  }, [api, bridgeLatestVersion]);

  const startBridgeUpdate = useCallback(async () => {
    setBridgeUpdateStarting(true);
    setBridgeUpdateActionError(null);
    try {
      const response = await api.startBridgeUpdate(bridgeLatestVersion ?? 'latest');
      setBridgeUpdateModalVisible(false);
      setBridgeRuntime((previous) => ({
        version: previous?.version ?? 'unknown',
        installKind: previous?.installKind ?? 'unknown',
        selfUpdateSupported: previous?.selfUpdateSupported ?? true,
        safeRestartSupported: previous?.safeRestartSupported ?? true,
        latestVersion: previous?.latestVersion ?? bridgeLatestVersion,
        updaterStatus: {
          state: 'scheduled',
          jobId: response.jobId,
          targetVersion: response.targetVersion,
          message: response.message,
          updatedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          logPath: response.logPath ?? null,
        },
      }));
    } catch (err) {
      setBridgeUpdateActionError((err as Error).message);
    } finally {
      setBridgeUpdateStarting(false);
    }
  }, [api, bridgeLatestVersion]);

  const bridgeRestartOptions = useMemo<SelectionSheetOption[]>(
    () => [
      {
        key: 'restart-safe',
        title: bridgeRestartStarting ? 'Scheduling restart…' : 'Restart bridge safely',
        description:
          'This launches a detached restart job. The bridge will stop, relaunch in the background, and reconnect once health recovers.',
        icon: 'refresh-outline',
        disabled: bridgeMaintenanceBusy || bridgeMaintenanceActive,
        onPress: () => {
          void startBridgeRestart();
        },
      },
    ],
    [bridgeMaintenanceActive, bridgeMaintenanceBusy, bridgeRestartStarting, startBridgeRestart]
  );

  const bridgeUpdateOptions = useMemo<SelectionSheetOption[]>(
    () => [
      {
        key: 'update-latest',
        title: bridgeUpdateStarting
          ? 'Starting update…'
          : `Update bridge to ${bridgeLatestVersion ?? 'latest'}`,
        description:
          'This launches a detached update job. The bridge will disconnect briefly, update in the background, and restart automatically.',
        icon: 'cloud-download-outline',
        disabled: bridgeMaintenanceBusy || bridgeMaintenanceActive,
        onPress: () => {
          void startBridgeUpdate();
        },
      },
    ],
    [bridgeLatestVersion, bridgeMaintenanceActive, bridgeMaintenanceBusy, bridgeUpdateStarting, startBridgeUpdate]
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

  const renderHomeContent = () => (
    <>
      <Text style={styles.sectionLabel}>Preferences</Text>
      <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
          <MenuEntry
            icon="sparkles-outline"
            title="Chat Preferences"
            description={chatDefaultsSummary}
            onPress={() => navigateToRoute('chat')}
          />
          <MenuEntry
            icon="color-palette-outline"
            title="Appearance"
            description={appearanceSummary}
            onPress={() => navigateToRoute('appearance')}
            isLast={!showCodexUsageLimits}
          />
        {showCodexUsageLimits ? (
          <MenuEntry
            icon="speedometer-outline"
            title="Codex Usage Limits"
            description={usageLimitsSummary}
            onPress={() => navigateToRoute('limits')}
            isLast
          />
        ) : null}
      </BlurView>

      <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Connection</Text>
      <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
        <MenuEntry
          icon="person-circle-outline"
          title="Account & Auth"
          description={accountSummary}
          onPress={() => navigateToRoute('account')}
        />
        <MenuEntry
          icon="server-outline"
          title="Bridge & Servers"
          description={bridgeSummary}
          onPress={() => navigateToRoute('bridge')}
        />
        <MenuEntry
          icon="globe-outline"
          title="Local Preview Browser"
          description="Open localhost web apps from the bridge machine inside Clawdex"
          onPress={() => {
            onOpenBrowser?.();
          }}
          isLast
        />
      </BlurView>

      <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Support</Text>
      <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
        {canRateOnAppStore ? (
          <MenuEntry
            icon="star-outline"
            title="Rate Clawdex"
            description="Leave a rating or written review on the App Store"
            onPress={handleOpenAppStoreReview}
          />
        ) : null}
        <MenuEntry
          icon="heart-outline"
          title="Support Clawdex"
          description={tipJarSummary}
          onPress={handleOpenSupportClawdex}
        />
        <MenuEntry
          icon="document-text-outline"
          title="Legal"
          description={legalSummary}
          onPress={() => navigateToRoute('legal')}
          isLast
        />
      </BlurView>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </>
  );

  const renderChatContent = () => (
    <>
      <Text style={styles.sectionLabel}>Defaults</Text>
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
          style={({ pressed }) => [styles.settingRow, pressed && styles.linkRowPressed]}
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

      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </>
  );

  const renderAppearanceContent = () => (
    <>
      <Text style={styles.sectionLabel}>Theme</Text>
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
    </>
  );

  const renderAccountContent = () => (
    <>
      <Text style={styles.sectionLabel}>Account & Auth</Text>
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
            {account?.email ? <Row label="Email" value={account.email} /> : null}
            {account?.planType ? <Row label="Plan" value={formatPlanType(account.planType)} /> : null}
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
    </>
  );

  const renderLimitsContent = () => (
    <>
      <Text style={styles.sectionLabel}>Codex Usage Limits</Text>
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
  );

  const renderBridgeContent = () => (
    <>
      <Text style={styles.sectionLabel}>Bridge Profiles</Text>
      <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
        <Row label="Active profile" value={bridgeProfileName} />
        <Row label="Saved profiles" value={String(bridgeProfiles.length)} />
        <Row label="Storage" value="Secure device keychain" isLast />
        <Text selectable style={styles.valueText}>
          {bridgeUrl}
        </Text>
        <Pressable
          onPress={() => setBridgeProfileModalVisible(true)}
          style={({ pressed }) => [styles.bridgeEditBtn, pressed && styles.bridgeEditBtnPressed]}
        >
          <Ionicons name="swap-horizontal-outline" size={15} color={colors.textPrimary} />
          <Text style={styles.bridgeEditBtnText}>Switch profile</Text>
        </Pressable>
        <Pressable
          onPress={onAddBridgeProfile}
          style={({ pressed }) => [styles.bridgeEditBtn, pressed && styles.bridgeEditBtnPressed]}
        >
          <Ionicons name="add-circle-outline" size={15} color={colors.textPrimary} />
          <Text style={styles.bridgeEditBtnText}>Add profile</Text>
        </Pressable>
        <Pressable
          onPress={onEditBridgeProfile}
          style={({ pressed }) => [styles.bridgeEditBtn, pressed && styles.bridgeEditBtnPressed]}
        >
          <Ionicons name="create-outline" size={15} color={colors.textPrimary} />
          <Text style={styles.bridgeEditBtnText}>Edit active profile</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            void onClearSavedBridges?.();
          }}
          style={({ pressed }) => [styles.bridgeResetBtn, pressed && styles.bridgeResetBtnPressed]}
        >
          <Ionicons name="refresh-circle-outline" size={15} color={colors.error} />
          <Text style={styles.bridgeResetBtnText}>Clear saved bridges</Text>
        </Pressable>
      </BlurView>
      <Text style={styles.subtleHintText}>
        Bridge URLs and tokens are stored in the secure device keychain so you can switch
        servers without retyping secrets.
      </Text>

      <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Bridge Maintenance</Text>
      <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
        {bridgeRuntimeLoading ? (
          <View style={styles.accountLoadingState}>
            <ActivityIndicator color={colors.textPrimary} />
            <Text style={styles.settingValue}>Loading bridge runtime…</Text>
          </View>
        ) : (
          <>
            <Row label="Bridge version" value={bridgeRuntime?.version ?? 'Unknown'} />
            <Row label="Latest available" value={bridgeLatestVersion ?? 'Unknown'} />
            <Row
              label="Install type"
              value={formatInstallKind(bridgeRuntime?.installKind ?? 'unknown')}
            />
            {bridgeUpdateStatus ? (
              <Row
                label="Last maintenance state"
                value={formatBridgeUpdaterState(bridgeUpdateStatus.state)}
              />
            ) : null}
            {bridgeUpdateStatus ? (
              <Row
                label="Maintenance message"
                value={bridgeUpdateStatus.message}
                isLast
              />
            ) : null}
            {!bridgeUpdateStatus ? (
              <Row
                label="Maintenance status"
                value={canSelfUpdateBridge || canSafeRestartBridge ? 'Ready' : 'Unavailable'}
                isLast
              />
            ) : null}
          </>
        )}
        <Pressable
          disabled={!canSafeRestartBridge || bridgeMaintenanceBusy || bridgeMaintenanceActive}
          onPress={() => setBridgeRestartModalVisible(true)}
          style={({ pressed }) => [
            styles.bridgeEditBtn,
            (!canSafeRestartBridge || bridgeMaintenanceBusy || bridgeMaintenanceActive) &&
              styles.settingRowDisabled,
            pressed &&
              canSafeRestartBridge &&
              !bridgeMaintenanceBusy &&
              !bridgeMaintenanceActive &&
              styles.bridgeEditBtnPressed,
          ]}
        >
          <Ionicons name="refresh-outline" size={15} color={colors.textPrimary} />
          <Text style={styles.bridgeEditBtnText}>
            {bridgeRestartStarting ? 'Scheduling bridge restart…' : 'Restart bridge safely'}
          </Text>
        </Pressable>
        <Pressable
          disabled={!canSelfUpdateBridge || bridgeMaintenanceBusy || bridgeMaintenanceActive}
          onPress={() => setBridgeUpdateModalVisible(true)}
          style={({ pressed }) => [
            styles.bridgeEditBtn,
            (!canSelfUpdateBridge || bridgeMaintenanceBusy || bridgeMaintenanceActive) &&
              styles.settingRowDisabled,
            pressed &&
              canSelfUpdateBridge &&
              !bridgeMaintenanceBusy &&
              !bridgeMaintenanceActive &&
              styles.bridgeEditBtnPressed,
          ]}
        >
          <Ionicons name="cloud-download-outline" size={15} color={colors.textPrimary} />
          <Text style={styles.bridgeEditBtnText}>
            {bridgeUpdateStarting ? 'Starting bridge update…' : 'Update bridge'}
          </Text>
        </Pressable>
      </BlurView>
      {bridgeRestartActionError ? <Text style={styles.errorText}>{bridgeRestartActionError}</Text> : null}
      {bridgeUpdateActionError ? <Text style={styles.errorText}>{bridgeUpdateActionError}</Text> : null}
      {bridgeRuntimeError ? <Text style={styles.errorText}>{bridgeRuntimeError}</Text> : null}

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
          void loadBridgeRuntime();
          void refreshModelOptions();
          void loadAccount();
          void loadRateLimits();
        }}
        style={({ pressed }) => [styles.refreshBtn, pressed && styles.refreshBtnPressed]}
      >
        <Ionicons name="refresh" size={16} color={colors.white} />
        <Text style={styles.refreshBtnText}>Refresh settings</Text>
      </Pressable>
    </>
  );

  const renderLegalContent = () => (
    <>
      <Text style={styles.sectionLabel}>Legal</Text>
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
    </>
  );

  const renderTipsContent = () => (
    <>
      <Text style={styles.sectionLabel}>Support Clawdex</Text>
      <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
        <LinearGradient
          colors={
            theme.isDark
              ? ['rgba(26, 33, 44, 0.96)', 'rgba(17, 22, 31, 0.94)']
              : ['#FFFFFF', '#EEF4FB']
          }
          style={styles.tipHeroPanel}
        >
          <View style={styles.tipHero}>
            <View style={styles.tipHeroIcon}>
              <Ionicons name="heart-outline" size={18} color={colors.textPrimary} />
            </View>
            <View style={styles.tipHeroCopy}>
              <Text style={styles.tipHeroEyebrow}>Support the build</Text>
              <Text style={styles.tipHeroTitle}>Leave a one-time tip</Text>
              <Text style={styles.tipHeroDescription}>
                Help fund bridge updates, native polish, and ongoing mobile improvements.
              </Text>
            </View>
          </View>

          {tipPreviewPackages.length > 0 ? (
            <View style={styles.tipPreviewGrid}>
              {tipPreviewPackages.map((aPackage) => (
                <View key={aPackage.identifier} style={styles.tipPreviewCard}>
                  <Text style={styles.tipPreviewPrice}>{aPackage.product.priceString}</Text>
                  <Text style={styles.tipPreviewLabel} numberOfLines={1}>
                    {getTipTierTitle(aPackage)}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          <Pressable
            onPress={() => {
              if (nativeTipPaywallAvailable) {
                void handleOpenTipPaywall();
              } else {
                void loadTips();
              }
            }}
            disabled={tipsLoading || tipPaywallOpening || tipPurchasingPackageId !== null}
            style={({ pressed }) => [
              styles.tipPrimaryBtn,
              (tipsLoading || tipPaywallOpening || tipPurchasingPackageId !== null) &&
                styles.settingRowDisabled,
              pressed &&
                !tipsLoading &&
                !tipPaywallOpening &&
                tipPurchasingPackageId === null &&
                styles.tipPrimaryBtnPressed,
            ]}
          >
            {tipsLoading || tipPaywallOpening ? (
              <ActivityIndicator color={theme.colors.accentText} />
            ) : (
              <Ionicons name="heart" size={16} color={theme.colors.accentText} />
            )}
            <Text style={styles.tipPrimaryBtnText}>
              {nativeTipPaywallAvailable ? 'Open tip jar' : 'Refresh tip tiers'}
            </Text>
          </Pressable>

          <Text style={styles.tipHeroFootnote}>
            {nativeTipPaywallAvailable
              ? 'Uses RevenueCat paywall templates on native builds.'
              : 'Expo Go uses the manual tier list below.'}
          </Text>
        </LinearGradient>

        <Row label="Billing" value="Apple in-app purchase" />
        <Row
          label="Presentation"
          value={nativeTipPaywallAvailable ? 'RevenueCat template' : 'Manual tier list'}
          isLast={!tipOffering}
        />
        {tipOffering ? (
          <Row
            label="Offering"
            value={tipOffering.serverDescription.trim() || tipOffering.identifier}
            isLast
          />
        ) : null}
      </BlurView>

      {shouldShowManualTipTierList ? (
        <>
          <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Tip tiers</Text>
          <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
            {tipsLoading ? (
              <View style={styles.accountLoadingState}>
                <ActivityIndicator color={colors.textPrimary} />
                <Text style={styles.settingValue}>Loading tip tiers…</Text>
              </View>
            ) : tipPackages.length > 0 ? (
              tipPackages.map((aPackage, index) => (
                <TipTierEntry
                  key={aPackage.identifier}
                  aPackage={aPackage}
                  busy={tipPurchasingPackageId === aPackage.identifier}
                  disabled={
                    tipPaywallOpening ||
                    (tipPurchasingPackageId !== null &&
                      tipPurchasingPackageId !== aPackage.identifier)
                  }
                  isLast={index === tipPackages.length - 1}
                  onPress={() => {
                    void handlePurchaseTip(aPackage);
                  }}
                />
              ))
            ) : (
              <View style={styles.accountLoadingState}>
                <Text style={styles.settingValue}>
                  {isTipJarAvailable()
                    ? 'No tip tiers are configured yet.'
                    : 'RevenueCat tip support is not configured in this build.'}
                </Text>
              </View>
            )}

            <Pressable
              onPress={() => {
                void loadTips();
              }}
              disabled={tipsLoading || tipPurchasingPackageId !== null || tipPaywallOpening}
              style={({ pressed }) => [
                styles.bridgeEditBtn,
                (tipsLoading || tipPurchasingPackageId !== null || tipPaywallOpening) &&
                  styles.settingRowDisabled,
                pressed &&
                  !tipsLoading &&
                  tipPurchasingPackageId === null &&
                  !tipPaywallOpening &&
                  styles.bridgeEditBtnPressed,
              ]}
            >
              <Ionicons name="refresh-outline" size={15} color={colors.textPrimary} />
              <Text style={styles.bridgeEditBtnText}>Refresh tip tiers</Text>
            </Pressable>
          </BlurView>
          <Text style={styles.subtleHintText}>
            Configure 4–5 consumable, non-subscription products in your RevenueCat offering to
            control the tier order, labels, and prices from the dashboard.
          </Text>
        </>
      ) : (
        <Text style={[styles.subtleHintText, styles.tipTemplateHint]}>
          The native build opens your configured RevenueCat paywall template and keeps the raw
          tier list out of the way.
        </Text>
      )}

      {tipActionMessage ? <Text style={styles.successText}>{tipActionMessage}</Text> : null}
      {tipActionError ? <Text style={styles.errorText}>{tipActionError}</Text> : null}
      {tipsError ? <Text style={styles.errorText}>{tipsError}</Text> : null}
    </>
  );

  const renderBodyContent = () => {
    switch (route) {
      case 'chat':
        return renderChatContent();
      case 'appearance':
        return renderAppearanceContent();
      case 'account':
        return renderAccountContent();
      case 'limits':
        return renderLimitsContent();
      case 'bridge':
        return renderBridgeContent();
      case 'tips':
        return renderTipsContent();
      case 'legal':
        return renderLegalContent();
      default:
        return renderHomeContent();
    }
  };

  const settingsBackGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(route !== 'home')
        .activeOffsetX(12)
        .failOffsetY([-18, 18])
        .onEnd((event) => {
          if (
            event.translationX > SETTINGS_BACK_GESTURE_DISTANCE ||
            event.velocityX > SETTINGS_BACK_GESTURE_VELOCITY
          ) {
            runOnJS(handleReturnToSettingsHome)();
          }
        }),
    [handleReturnToSettingsHome, route]
  );

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={[colors.bgMain, colors.bgMain, colors.bgMain]}
        style={StyleSheet.absoluteFill}
      />
      <SafeAreaView edges={['top']} style={styles.safeArea}>
        <View style={styles.header}>
          {route === 'home' ? (
            <Pressable onPress={onOpenDrawer} hitSlop={8} style={styles.menuBtn}>
              <Ionicons name="menu" size={22} color={colors.textPrimary} />
            </Pressable>
          ) : (
            <Pressable onPress={handleReturnToSettingsHome} hitSlop={8} style={styles.menuBtn}>
              <Ionicons name="chevron-back" size={22} color={colors.textPrimary} />
            </Pressable>
          )}
          <Ionicons name={headerIcon} size={16} color={colors.textPrimary} />
          <Text style={styles.headerTitle}>{headerTitle}</Text>
        </View>

        <ScrollView
          style={styles.body}
          contentContainerStyle={[
            styles.bodyContent,
            { paddingBottom: theme.spacing.xl + insets.bottom },
          ]}
          alwaysBounceVertical
          contentInsetAdjustmentBehavior="never"
          keyboardDismissMode="on-drag"
          scrollIndicatorInsets={{ bottom: theme.spacing.xl + insets.bottom }}
        >
          <Animated.View style={[styles.routeContent, routeContentAnimatedStyle]}>
            {renderBodyContent()}
          </Animated.View>
        </ScrollView>
      </SafeAreaView>
      {route !== 'home' ? (
        <GestureDetector gesture={settingsBackGesture}>
          <View style={styles.backSwipeZone} />
        </GestureDetector>
      ) : null}

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
        visible={bridgeProfileModalVisible}
        eyebrow="Bridge Profiles"
        title="Switch active bridge"
        subtitle="Pick which saved server this phone should connect to right now."
        options={bridgeProfileOptions}
        onClose={() => setBridgeProfileModalVisible(false)}
      />

      <SelectionSheet
        visible={bridgeRestartModalVisible}
        eyebrow="Bridge Maintenance"
        title="Restart bridge safely"
        subtitle="This will briefly disconnect the app while the bridge stops and relaunches in the background."
        options={bridgeRestartOptions}
        loading={bridgeRestartStarting}
        loadingLabel="Scheduling bridge restart…"
        onClose={() => setBridgeRestartModalVisible(false)}
      />

      <SelectionSheet
        visible={bridgeUpdateModalVisible}
        eyebrow="Bridge Maintenance"
        title="Update bridge"
        subtitle="This will briefly disconnect the app while the bridge updates and restarts in the background."
        options={bridgeUpdateOptions}
        loading={bridgeUpdateStarting}
        loadingLabel="Starting bridge update…"
        onClose={() => setBridgeUpdateModalVisible(false)}
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

function MenuEntry({
  icon,
  title,
  description,
  onPress,
  isLast,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  description: string;
  onPress: () => void;
  isLast?: boolean;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { colors } = theme;

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.menuRow,
        isLast && styles.menuRowLast,
        pressed && styles.linkRowPressed,
      ]}
    >
      <View style={styles.menuRowLeft}>
        <View style={styles.menuIconWrap}>
          <Ionicons name={icon} size={16} color={colors.textPrimary} />
        </View>
        <View style={styles.menuTextWrap}>
          <Text style={styles.menuTitle}>{title}</Text>
          <Text style={styles.menuDescription} numberOfLines={2}>
            {description}
          </Text>
        </View>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
    </Pressable>
  );
}

function TipTierEntry({
  aPackage,
  busy,
  disabled,
  isLast,
  onPress,
}: {
  aPackage: PurchasesPackage;
  busy: boolean;
  disabled: boolean;
  isLast?: boolean;
  onPress: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <Pressable
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tipTierRow,
        isLast && styles.tipTierRowLast,
        (disabled || busy) && styles.settingRowDisabled,
        pressed && !disabled && !busy && styles.linkRowPressed,
      ]}
    >
      <View style={styles.tipTierTextWrap}>
        <Text style={styles.tipTierTitle}>{getTipTierTitle(aPackage)}</Text>
        <Text style={styles.tipTierDescription} numberOfLines={2}>
          {getTipTierDescription(aPackage)}
        </Text>
      </View>
      <View style={styles.tipTierMetaWrap}>
        {busy ? (
          <ActivityIndicator color={theme.colors.textPrimary} />
        ) : (
          <Text style={styles.tipTierPrice}>{aPackage.product.priceString}</Text>
        )}
        <Text style={styles.tipTierMeta}>{getTipTierMeta(aPackage)}</Text>
      </View>
    </Pressable>
  );
}

function formatInstallKind(kind: BridgeRuntimeInfo['installKind']): string {
  switch (kind) {
    case 'publishedCli':
      return 'Published CLI';
    case 'sourceCheckout':
      return 'Source checkout';
    default:
      return 'Unknown';
  }
}

function formatBridgeUpdaterState(state: string): string {
  switch (state) {
    case 'scheduled':
      return 'Scheduled';
    case 'stopping':
      return 'Stopping bridge';
    case 'upgrading':
      return 'Installing update';
    case 'starting':
      return 'Starting bridge';
    case 'waitingForHealth':
      return 'Waiting for health';
    case 'completed':
      return 'Completed';
    case 'recovered':
      return 'Recovered previous bridge';
    case 'failed':
      return 'Failed';
    default:
      return state;
  }
}

function isBridgeMaintenanceInProgress(state: string): boolean {
  return (
    state === 'scheduled' ||
    state === 'stopping' ||
    state === 'upgrading' ||
    state === 'starting' ||
    state === 'waitingForHealth'
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
    bodyContent: {
      flexGrow: 1,
      padding: theme.spacing.lg,
    },
    routeContent: {
      flexGrow: 1,
    },
    backSwipeZone: {
      position: 'absolute',
      top: 0,
      left: 0,
      bottom: 0,
      width: SETTINGS_BACK_EDGE_WIDTH,
      zIndex: 20,
    },
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
    menuRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: settingsDivider,
    },
    menuRowLast: {
      borderBottomWidth: 0,
    },
    menuRowLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.md,
      flex: 1,
    },
    menuIconWrap: {
      width: 32,
      height: 32,
      borderRadius: theme.radius.sm,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: neutralControlBackground,
    },
    menuTextWrap: {
      flex: 1,
      gap: 3,
    },
    menuTitle: {
      ...theme.typography.body,
      color: settingsPrimaryText,
      fontWeight: '600',
    },
    menuDescription: {
      ...theme.typography.caption,
      color: settingsValueColor,
    },
    tipHero: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.md,
      paddingVertical: theme.spacing.md,
    },
    tipHeroPanel: {
      marginHorizontal: -theme.spacing.lg,
      marginTop: -theme.spacing.xs,
      marginBottom: theme.spacing.md,
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.sm,
      paddingBottom: theme.spacing.md,
      gap: theme.spacing.md,
    },
    tipHeroIcon: {
      width: 36,
      height: 36,
      borderRadius: theme.radius.sm,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: neutralControlBackground,
    },
    tipHeroCopy: {
      flex: 1,
      gap: 4,
    },
    tipHeroEyebrow: {
      ...theme.typography.caption,
      color: settingsLabelColor,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },
    tipHeroTitle: {
      ...theme.typography.headline,
      color: settingsPrimaryText,
      fontWeight: '700',
    },
    tipHeroDescription: {
      ...theme.typography.caption,
      color: settingsValueColor,
    },
    tipPreviewGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
    },
    tipPreviewCard: {
      minWidth: 112,
      flexGrow: 1,
      borderRadius: theme.radius.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      backgroundColor: theme.isDark ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.78)',
      borderWidth: 1,
      borderColor: settingsCardBorder,
      gap: 4,
    },
    tipPreviewPrice: {
      ...theme.typography.headline,
      color: settingsPrimaryText,
      fontSize: 17,
    },
    tipPreviewLabel: {
      ...theme.typography.caption,
      color: settingsValueColor,
      fontWeight: '600',
    },
    tipPrimaryBtn: {
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.accent,
      paddingVertical: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.sm,
      boxShadow: `0px 8px 20px ${theme.colors.accent}33`,
    },
    tipPrimaryBtnPressed: {
      backgroundColor: theme.colors.accentPressed,
    },
    tipPrimaryBtnText: {
      ...theme.typography.body,
      color: theme.colors.accentText,
      fontWeight: '700',
    },
    tipHeroFootnote: {
      ...theme.typography.caption,
      color: settingsLabelColor,
      textAlign: 'center',
    },
    tipTierRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: settingsDivider,
    },
    tipTierRowLast: {
      borderBottomWidth: 0,
    },
    tipTierTextWrap: {
      flex: 1,
      gap: 4,
    },
    tipTierTitle: {
      ...theme.typography.body,
      color: settingsPrimaryText,
      fontWeight: '700',
    },
    tipTierDescription: {
      ...theme.typography.caption,
      color: settingsValueColor,
    },
    tipTierMetaWrap: {
      minWidth: 92,
      alignItems: 'flex-end',
      gap: 3,
    },
    tipTierPrice: {
      ...theme.typography.body,
      color: settingsPrimaryText,
      fontWeight: '700',
    },
    tipTierMeta: {
      ...theme.typography.caption,
      color: settingsLabelColor,
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
    successText: {
      ...theme.typography.caption,
      color: theme.colors.statusComplete,
      marginTop: theme.spacing.md,
      textAlign: 'center',
    },
    tipTemplateHint: {
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
