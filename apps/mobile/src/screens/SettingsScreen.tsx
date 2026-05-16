import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import Constants from 'expo-constants';
import { LinearGradient } from 'expo-linear-gradient';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
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
import { toRecord } from '../api/chatMapping';
import { readAccountRateLimitSnapshot } from '../api/rateLimits';
import type {
  AccountSnapshot,
  AccountRateLimitSnapshot,
  ApprovalMode,
  BridgeCapabilities,
  BridgeRuntimeInfo,
  ChatEngine,
  CursorCredentialStatus,
  EngineDefaultSettingsMap,
  ModelOption,
  PlanType,
  ReasoningEffort,
} from '../api/types';
import type { HostBridgeWsClient } from '../api/ws';
import clawdexMark from '../../assets/brand/mark.png';
import type { BridgeProfile } from '../bridgeProfiles';
import { BridgeProfileManagerSheet } from '../components/bridge-profile-manager-sheet';
import { SelectionSheet, type SelectionSheetOption } from '../components/SelectionSheet';
import {
  DEFAULT_WORKSPACE_CHAT_LIMIT,
  formatWorkspaceChatLimit,
  WORKSPACE_CHAT_LIMIT_OPTIONS,
  type WorkspaceChatLimit,
} from '../appSettings';
import {
  buildComposerUsageLimitBadges,
  formatComposerUsageLimitResetAt,
} from '../components/usageLimitBadges';
import { getChatEngineLabel } from '../chatEngines';
import {
  DEFAULT_FONT_PREFERENCE,
  FONT_PREFERENCE_OPTIONS,
  getFontFamilies,
  getFontPreferenceLabel,
  normalizeFontPreference,
  type FontPreference,
} from '../fonts';
import {
  formatModelOptionDescription,
  formatModelOptionLabel,
} from '../modelOptions';
import {
  useAppTheme,
  type AppearancePreference,
  type AppTheme,
  type DarkUiPalette,
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
  activeBridgeProfileId?: string | null;
  bridgeProfileName: string;
  bridgeProfiles: BridgeProfile[];
  defaultChatEngine?: ChatEngine | null;
  defaultEngineSettings?: EngineDefaultSettingsMap | null;
  approvalMode?: ApprovalMode;
  showToolCalls?: boolean;
  workspaceChatLimit?: WorkspaceChatLimit;
  appearancePreference?: AppearancePreference;
  darkUiPalette?: DarkUiPalette;
  fontPreference?: FontPreference;
  onDefaultChatEngineChange?: (engine: ChatEngine) => void;
  onDefaultModelSettingsChange?: (
    engine: ChatEngine,
    modelId: string | null,
    effort: ReasoningEffort | null
  ) => void;
  onApprovalModeChange?: (mode: ApprovalMode) => void;
  onShowToolCallsChange?: (value: boolean) => void;
  onWorkspaceChatLimitChange?: (limit: WorkspaceChatLimit) => void;
  onAppearancePreferenceChange?: (preference: AppearancePreference) => void;
  onDarkUiPaletteChange?: (palette: DarkUiPalette) => void;
  onFontPreferenceChange?: (preference: FontPreference) => void;
  onEditBridgeProfile?: () => void;
  onAddBridgeProfile?: () => void;
  onSwitchBridgeProfile?: (profileId: string) => void | Promise<void>;
  onRenameBridgeProfile?: (profileId: string, nextName: string) => void | Promise<void>;
  onDeleteBridgeProfile?: (profileId: string) => void | Promise<void>;
  onClearSavedBridges?: () => void | Promise<void>;
  onOpenDrawer: () => void;
  onDrawerGestureEnabledChange?: (enabled: boolean) => void;
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
}

type SettingsRoute =
  | 'home'
  | 'chat'
  | 'account'
  | 'limits'
  | 'bridge'
  | 'engines'
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
  activeBridgeProfileId = null,
  bridgeProfileName,
  bridgeProfiles,
  defaultChatEngine,
  defaultEngineSettings,
  approvalMode,
  showToolCalls = true,
  appearancePreference = 'system',
  darkUiPalette = 'classic',
  fontPreference = DEFAULT_FONT_PREFERENCE,
  onDefaultChatEngineChange,
  onDefaultModelSettingsChange,
  onApprovalModeChange,
  onShowToolCallsChange,
  workspaceChatLimit = DEFAULT_WORKSPACE_CHAT_LIMIT,
  onWorkspaceChatLimitChange,
  onAppearancePreferenceChange,
  onDarkUiPaletteChange,
  onFontPreferenceChange,
  onEditBridgeProfile,
  onAddBridgeProfile,
  onSwitchBridgeProfile,
  onRenameBridgeProfile,
  onDeleteBridgeProfile,
  onClearSavedBridges,
  onOpenDrawer,
  onDrawerGestureEnabledChange,
  onOpenPrivacy,
  onOpenTerms,
}: SettingsScreenProps) {
  const theme = useAppTheme();
  const { colors } = theme;
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const appVersion = readOptionalDisplayString(Constants.expoConfig?.version) ?? 'Unknown';
  const nativeBuildVersion =
    Platform.OS === 'ios'
      ? readOptionalDisplayString(Constants.platform?.ios?.buildNumber)
      : Platform.OS === 'android'
        ? readOptionalDisplayString(Constants.platform?.android?.versionCode)
        : null;
  const configuredBuildVersion =
    Platform.OS === 'ios'
      ? readOptionalDisplayString(Constants.expoConfig?.ios?.buildNumber)
      : Platform.OS === 'android'
        ? readOptionalDisplayString(Constants.expoConfig?.android?.versionCode)
        : null;
  const appBuildVersion =
    nativeBuildVersion ??
    configuredBuildVersion ??
    (Platform.OS === 'web' ? 'Web runtime' : 'Unavailable');
  const transcriptSwitchTrackColor = colors.borderLight;
  const transcriptSwitchActiveColor = colors.accent;
  const transcriptSwitchThumbColor = colors.white;
  const [healthyAt, setHealthyAt] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(ws.isConnected);
  const [error, setError] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [engineModalVisible, setEngineModalVisible] = useState(false);
  const [modelModalVisible, setModelModalVisible] = useState(false);
  const [effortModalVisible, setEffortModalVisible] = useState(false);
  const [approvalModeModalVisible, setApprovalModeModalVisible] = useState(false);
  const [workspaceChatLimitModalVisible, setWorkspaceChatLimitModalVisible] = useState(false);
  const [appearanceModalVisible, setAppearanceModalVisible] = useState(false);
  const [darkPaletteModalVisible, setDarkPaletteModalVisible] = useState(false);
  const [fontModalVisible, setFontModalVisible] = useState(false);
  const [bridgeProfileModalVisible, setBridgeProfileModalVisible] = useState(false);
  const [showConnectionTroubleshooting, setShowConnectionTroubleshooting] = useState(false);
  const [account, setAccount] = useState<AccountSnapshot | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [accountRateLimits, setAccountRateLimits] = useState<AccountRateLimitSnapshot | null>(
    () => api.peekAccountRateLimits()
  );
  const [rateLimitsLoading, setRateLimitsLoading] = useState(false);
  const [rateLimitsError, setRateLimitsError] = useState<string | null>(null);
  const [bridgeCapabilities, setBridgeCapabilities] = useState<BridgeCapabilities | null>(null);
  const [bridgeRuntime, setBridgeRuntime] = useState<BridgeRuntimeInfo | null>(null);
  const [bridgeRuntimeLoading, setBridgeRuntimeLoading] = useState(false);
  const [bridgeRuntimeError, setBridgeRuntimeError] = useState<string | null>(null);
  const [cursorCredentials, setCursorCredentials] =
    useState<CursorCredentialStatus | null>(null);
  const [cursorCredentialsLoading, setCursorCredentialsLoading] = useState(false);
  const [cursorCredentialsError, setCursorCredentialsError] = useState<string | null>(null);
  const [engineActionMessage, setEngineActionMessage] = useState<string | null>(null);
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

  const runtimeAvailableEngines = bridgeCapabilities?.availableEngines ?? [];
  const availableEngines = useMemo(
    () =>
      mergeChatEngines(
        runtimeAvailableEngines,
        bridgeCapabilities?.activeEngine
      ),
    [bridgeCapabilities?.activeEngine, runtimeAvailableEngines]
  );
  const normalizedDefaultChatEngine =
    defaultChatEngine && availableEngines.includes(defaultChatEngine)
      ? defaultChatEngine
      : bridgeCapabilities?.activeEngine && availableEngines.includes(bridgeCapabilities.activeEngine)
        ? bridgeCapabilities.activeEngine
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
  const normalizedFontPreference = normalizeFontPreference(fontPreference);
  const normalizedDarkUiPalette = darkUiPalette === 'grey' ? 'grey' : 'classic';
  const darkUiPaletteLabel =
    normalizedDarkUiPalette === 'grey' ? 'Grey (IDE-style)' : 'Classic (pure black)';
  const approvalModeLabel =
    normalizedApprovalMode === 'yolo'
      ? 'YOLO (no approval prompts)'
      : 'Normal (ask for approvals)';
  const workspaceChatLimitLabel = formatWorkspaceChatLimit(workspaceChatLimit);
  const appearancePreferenceLabel =
    normalizedAppearancePreference === 'light'
      ? 'Light'
      : normalizedAppearancePreference === 'dark'
        ? 'Dark'
        : 'System';
  const fontPreferenceLabel = getFontPreferenceLabel(normalizedFontPreference);
  const activeEngine = bridgeCapabilities?.activeEngine ?? null;
  const usageLimitBadges = useMemo(
    () => buildComposerUsageLimitBadges(accountRateLimits),
    [accountRateLimits]
  );
  const showCodexUsageLimits =
    runtimeAvailableEngines.length > 0
      ? runtimeAvailableEngines.includes('codex')
      : availableEngines.includes('codex');
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
  const activeBridgeProfile = useMemo(
    () =>
      bridgeProfiles.find((profile) => profile.id === activeBridgeProfileId) ??
      bridgeProfiles[0] ??
      null,
    [activeBridgeProfileId, bridgeProfiles]
  );
  const activeConnectionType = activeBridgeProfile ? 'Private bridge' : 'Connection';
  const shouldOpenPrivateBridgeEditor = Boolean(
    activeBridgeProfile && onEditBridgeProfile
  );
  const connectionStatusSummary = wsConnected
    ? 'Connected'
    : healthyAt
      ? 'Reachable'
      : 'Unknown';
  const serverToolsStatus = bridgeUpdateStatus
    ? formatBridgeUpdaterState(bridgeUpdateStatus.state)
    : bridgeMaintenanceBusy || bridgeMaintenanceActive
      ? 'Busy'
      : canSelfUpdateBridge || canSafeRestartBridge
        ? 'Ready'
        : 'Limited';
  const engineSummary =
    activeEngine && runtimeAvailableEngines.includes(activeEngine)
      ? runtimeAvailableEngines.length > 1
        ? `${getChatEngineLabel(activeEngine)} active · ${runtimeAvailableEngines.length} available`
        : getChatEngineLabel(activeEngine)
      : runtimeAvailableEngines.length > 1
        ? `${runtimeAvailableEngines.length} available`
        : runtimeAvailableEngines.length === 1
          ? getChatEngineLabel(runtimeAvailableEngines[0]!)
          : 'Server managed';
  const headerTitle =
    route === 'chat'
      ? 'Chat Preferences'
      : route === 'account'
        ? 'Account'
        : route === 'limits'
          ? 'Codex Usage Limits'
          : route === 'bridge'
            ? 'Connections'
            : route === 'engines'
              ? 'Engines'
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
            ? ('link-outline' as const)
            : route === 'engines'
              ? ('hardware-chip-outline' as const)
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
  const appearanceSummary = `${appearancePreferenceLabel} · ${darkUiPaletteLabel} · ${fontPreferenceLabel}`;
  const accountSummary = 'See sign-in status and plan';
  const usageLimitsSummary = 'View weekly usage and reset times';
  const bridgeSummary = 'Add or manage private connections';
  const enginesSummary = formatEnginesSummary(
    runtimeAvailableEngines,
    cursorCredentials,
    cursorCredentialsLoading
  );
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
  const shouldLoadEngineSettings = route === 'engines';

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

  const loadCursorCredentials = useCallback(async () => {
    setCursorCredentialsLoading(true);
    try {
      const status = await api.readCursorCredentials();
      setCursorCredentials(status);
      setCursorCredentialsError(null);
    } catch (err) {
      setCursorCredentialsError((err as Error).message);
    } finally {
      setCursorCredentialsLoading(false);
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

  const loadRateLimits = useCallback(async (options?: { showLoading?: boolean }) => {
    const cachedSnapshot = api.peekAccountRateLimits();
    if (cachedSnapshot) {
      setAccountRateLimits(cachedSnapshot);
    }

    const showLoading = options?.showLoading !== false && !cachedSnapshot;
    setRateLimitsLoading(showLoading);
    try {
      const snapshot = await api.readAccountRateLimits({ forceRefresh: true });
      setAccountRateLimits(snapshot);
      setRateLimitsError(null);
    } catch (err) {
      setRateLimitsError(formatRateLimitsError(err));
    } finally {
      setRateLimitsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    const cachedSnapshot = api.peekAccountRateLimits();
    if (cachedSnapshot) {
      setAccountRateLimits(cachedSnapshot);
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
      if (shouldLoadEngineSettings) {
        void loadBridgeCapabilities();
        void loadCursorCredentials();
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
    loadCursorCredentials,
    loadRateLimits,
    refreshModelOptions,
    shouldLoadAccountSettings,
    shouldLoadBridgeSettings,
    shouldLoadChatSettings,
    shouldLoadEngineSettings,
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
          if (shouldLoadEngineSettings) {
            void loadBridgeCapabilities();
            void loadCursorCredentials();
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
      loadCursorCredentials,
      loadRateLimits,
      refreshModelOptions,
      shouldLoadAccountSettings,
      shouldLoadBridgeSettings,
      shouldLoadChatSettings,
      shouldLoadEngineSettings,
      shouldLoadLimitsSettings,
      ws,
    ]
  );

  useEffect(
    () =>
      ws.onEvent((event) => {
        if (event.method === 'account/rateLimits/updated' && shouldLoadLimitsSettings) {
          const params = toRecord(event.params);
          const snapshot = readAccountRateLimitSnapshot(
            params?.rateLimits ?? params?.rate_limits ?? event.params
          );
          api.rememberAccountRateLimits(snapshot);
          setAccountRateLimits(snapshot);
          setRateLimitsError(null);
          setRateLimitsLoading(false);
          if (!snapshot) {
            void loadRateLimits({ showLoading: false });
          }
        }

        if (event.method === 'account/updated' && shouldLoadAccountSettings) {
          void loadAccount();
        }

        if (event.method === 'bridge/capabilities/changed') {
          void loadBridgeCapabilities();
          if (shouldLoadEngineSettings) {
            void loadCursorCredentials();
          }
        }
      }),
    [
      api,
      loadAccount,
      loadBridgeCapabilities,
      loadCursorCredentials,
      loadRateLimits,
      shouldLoadAccountSettings,
      shouldLoadEngineSettings,
      shouldLoadLimitsSettings,
      ws,
    ]
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

  const workspaceChatLimitOptions = useMemo<SelectionSheetOption[]>(
    () =>
      WORKSPACE_CHAT_LIMIT_OPTIONS.map((option) => ({
        key: option === null ? 'all' : String(option),
        title: formatWorkspaceChatLimit(option),
        description:
          option === null
            ? 'Show every chat in each workspace section.'
            : `Show ${option} chats first, with a Show all button for the rest.`,
        icon: option === null ? ('albums-outline' as const) : ('list-outline' as const),
        selected: workspaceChatLimit === option,
        onPress: () => {
          onWorkspaceChatLimitChange?.(option);
          setWorkspaceChatLimitModalVisible(false);
        },
      })),
    [onWorkspaceChatLimitChange, workspaceChatLimit]
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

  const darkPaletteOptions = useMemo<SelectionSheetOption[]>(
    () => [
      {
        key: 'classic',
        title: 'Classic',
        description: 'Deep black and blue-gray tones. Often nicest on OLED battery-wise.',
        icon: 'contrast-outline',
        selected: normalizedDarkUiPalette === 'classic',
        onPress: () => {
          onDarkUiPaletteChange?.('classic');
          setDarkPaletteModalVisible(false);
        },
      },
      {
        key: 'grey',
        title: 'Grey',
        description: 'Lifted charcoal neutrals inspired by IDE dark themes.',
        icon: 'layers-outline',
        selected: normalizedDarkUiPalette === 'grey',
        onPress: () => {
          onDarkUiPaletteChange?.('grey');
          setDarkPaletteModalVisible(false);
        },
      },
    ],
    [normalizedDarkUiPalette, onDarkUiPaletteChange]
  );

  const fontOptions = useMemo<SelectionSheetOption[]>(
    () =>
      FONT_PREFERENCE_OPTIONS.map((option) => {
        const families = getFontFamilies(option.key);
        const titleFamily = families.semibold ?? families.medium ?? families.regular;
        const descriptionFamily = families.regular;

        return {
          key: option.key,
          title: option.title,
          description:
            option.key === 'system'
              ? option.description
              : `${option.description}\nSphinx of black quartz, judge my vow.`,
          descriptionNumberOfLines: option.key === 'system' ? 2 : 3,
          icon:
            option.key === 'jetbrainsMono'
              ? ('code-slash-outline' as const)
              : ('text-outline' as const),
          titleStyle: titleFamily ? { fontFamily: titleFamily } : undefined,
          descriptionStyle: descriptionFamily ? { fontFamily: descriptionFamily } : undefined,
          selected: normalizedFontPreference === option.key,
          onPress: () => {
            onFontPreferenceChange?.(option.key);
            setFontModalVisible(false);
          },
        };
      }),
    [normalizedFontPreference, onFontPreferenceChange]
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

  const handleConnectEngine = useCallback(
    (engine: Exclude<ChatEngine, 'codex'>) => {
      const command =
        engine === 'cursor'
          ? 'clawdex init --engines codex,cursor'
          : 'clawdex init --engines codex,opencode';
      setEngineActionMessage(`Run ${command} on the bridge host, then restart the connection.`);
    },
    []
  );

  const enginePickerOptions = useMemo<SelectionSheetOption[]>(
    () =>
      availableEngines.map((engine) => ({
        key: engine,
        title: getChatEngineLabel(engine),
        description:
          engine === 'opencode'
            ? 'Use OpenCode defaults for new chats.'
            : engine === 'cursor'
              ? 'Use Cursor SDK defaults for new chats.'
              : 'Use Codex defaults for new chats.',
        icon:
          engine === 'opencode'
            ? ('layers-outline' as const)
            : engine === 'cursor'
              ? ('code-slash-outline' as const)
              : ('sparkles-outline' as const),
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
          title="Account"
          description={accountSummary}
          onPress={() => navigateToRoute('account')}
        />
        <MenuEntry
          icon="hardware-chip-outline"
          title="Engines"
          description={enginesSummary}
          onPress={() => navigateToRoute('engines')}
        />
        <MenuEntry
          icon="server-outline"
          title="Connections"
          description={bridgeSummary}
          onPress={() => navigateToRoute('bridge')}
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

      <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>App</Text>
      <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
        <Row label="Version" value={appVersion} />
        <Row label="Build" value={appBuildVersion} isLast />
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

      <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Sidebar</Text>
      <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
        <Pressable
          onPress={() => setWorkspaceChatLimitModalVisible(true)}
          style={({ pressed }) => [
            styles.settingRow,
            styles.settingRowLast,
            pressed && styles.linkRowPressed,
          ]}
        >
          <View style={styles.settingRowLeft}>
            <Text style={styles.rowLabel}>Chats per workspace</Text>
            <Text style={styles.settingValue} numberOfLines={2}>
              {workspaceChatLimitLabel}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
        </Pressable>
      </BlurView>

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
            pressed && styles.linkRowPressed,
          ]}
        >
          <View style={styles.settingRowLeft}>
            <Text style={styles.rowLabel}>Light / Dark</Text>
            <Text style={styles.settingValue} numberOfLines={2}>
              {appearancePreferenceLabel}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
        </Pressable>
        <Pressable
          onPress={() => setDarkPaletteModalVisible(true)}
          style={({ pressed }) => [
            styles.settingRow,
            pressed && styles.linkRowPressed,
          ]}
        >
          <View style={styles.settingRowLeft}>
            <Text style={styles.rowLabel}>Dark palette</Text>
            <Text style={styles.settingValue} numberOfLines={2}>
              {darkUiPaletteLabel}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
        </Pressable>
        <Pressable
          onPress={() => setFontModalVisible(true)}
          style={({ pressed }) => [
            styles.settingRow,
            styles.settingRowLast,
            pressed && styles.linkRowPressed,
          ]}
        >
          <View style={styles.settingRowLeft}>
            <Text style={styles.rowLabel}>Typography</Text>
            <Text style={styles.settingValue} numberOfLines={2}>
              {fontPreferenceLabel}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
        </Pressable>
      </BlurView>
      <Text style={styles.subtleHintText}>
        Light / Dark follows System when chosen. Dark palette applies whenever the interface is in
        dark mode (including System when your phone is set to dark).
      </Text>
    </>
  );

  const renderAccountContent = () => (
    <>
      <Text style={styles.sectionLabel}>Account</Text>
      <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
        {accountLoading ? (
          <View style={styles.accountLoadingState}>
            <ActivityIndicator color={colors.textPrimary} />
            <Text style={styles.settingValue}>Loading account details…</Text>
          </View>
        ) : (
          <>
            <Row
              label="Sign-in"
              value={formatAccountSignInStatus(account)}
              valueColor={account?.type ? colors.statusComplete : colors.textMuted}
              isLast={!account?.email && !account?.planType}
            />
            {account?.email ? <Row label="Email" value={account.email} /> : null}
            {account?.planType ? <Row label="Plan" value={formatPlanType(account.planType)} isLast /> : null}
          </>
        )}
      </BlurView>
      <Text style={styles.subtleHintText}>{formatAccountHelpText(account)}</Text>
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
      <Text style={styles.sectionLabel}>Connections</Text>
      <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
        <Row label="Current connection" value={bridgeProfileName} />
        <Row label="Type" value={activeConnectionType} />
        <Row label="Saved connections" value={String(bridgeProfiles.length)} isLast />
        {(onAddBridgeProfile || shouldOpenPrivateBridgeEditor) ? (
          <MenuEntry
            icon="hardware-chip-outline"
            logo="clawdex"
            title="Private bridge"
            description={
              shouldOpenPrivateBridgeEditor
                ? 'Update the private connection on this device.'
                : 'Connect to your own machine.'
            }
            onPress={
              shouldOpenPrivateBridgeEditor
                ? onEditBridgeProfile!
                : onAddBridgeProfile!
            }
          />
        ) : null}
        <MenuEntry
          icon="albums-outline"
          title="Manage saved connections"
          description="Switch, rename, or remove saved connections."
          onPress={() => setBridgeProfileModalVisible(true)}
          isLast
        />
      </BlurView>
      <Text style={styles.subtleHintText}>
        Saved connections stay in secure device storage so you can switch later without
        re-entering everything.
      </Text>

      <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Troubleshooting</Text>
      <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
        <Pressable
          onPress={() => setShowConnectionTroubleshooting((current) => !current)}
          style={({ pressed }) => [styles.linkRow, pressed && styles.linkRowPressed]}
        >
          <View style={styles.linkRowLeft}>
            <Ionicons name="construct-outline" size={16} color={colors.textPrimary} />
            <Text style={styles.linkRowLabel}>Connection tools</Text>
          </View>
          <Ionicons
            name={showConnectionTroubleshooting ? 'chevron-up' : 'chevron-down'}
            size={16}
            color={colors.textMuted}
          />
        </Pressable>

        {showConnectionTroubleshooting ? (
          <>
            {onClearSavedBridges ? (
              <Pressable
                onPress={() => {
                  void onClearSavedBridges();
                }}
                style={({ pressed }) => [styles.linkRow, pressed && styles.linkRowPressed]}
              >
                <View style={styles.linkRowLeft}>
                  <Ionicons name="refresh-circle-outline" size={15} color={colors.error} />
                  <Text style={[styles.linkRowLabel, { color: colors.error }]}>
                    Clear all saved connections
                  </Text>
                </View>
              </Pressable>
            ) : null}

            {bridgeRuntimeLoading ? (
              <View style={styles.accountLoadingState}>
                <ActivityIndicator color={colors.textPrimary} />
                <Text style={styles.settingValue}>Loading connection tools…</Text>
              </View>
            ) : (
              <>
                <Row label="Service version" value={bridgeRuntime?.version ?? 'Unknown'} />
                <Row label="Status" value={serverToolsStatus} />
              </>
            )}
            <Row label="Connection status" value={connectionStatusSummary} />
            <Row label="Chat engines" value={engineSummary} />
            <Row
              label="Install type"
              value={formatInstallKind(bridgeRuntime?.installKind ?? 'unknown')}
              isLast
            />

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
                {bridgeRestartStarting ? 'Scheduling restart…' : 'Restart service'}
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
                {bridgeUpdateStarting ? 'Starting update…' : 'Update service'}
              </Text>
            </Pressable>

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
              <Text style={styles.refreshBtnText}>Refresh connection details</Text>
            </Pressable>
          </>
        ) : null}
      </BlurView>
      <Text style={styles.subtleHintText}>
        Use these only when you are fixing a connection problem.
      </Text>
      {bridgeRestartActionError ? <Text style={styles.errorText}>{bridgeRestartActionError}</Text> : null}
      {bridgeUpdateActionError ? <Text style={styles.errorText}>{bridgeUpdateActionError}</Text> : null}
      {bridgeRuntimeError ? <Text style={styles.errorText}>{bridgeRuntimeError}</Text> : null}
    </>
  );

  const renderEnginesContent = () => {
    const statusColor =
      cursorCredentials?.valid === true
        ? colors.statusComplete
        : cursorCredentials?.configured
          ? colors.error
          : colors.textMuted;
    const codexConnected =
      runtimeAvailableEngines.length === 0 || runtimeAvailableEngines.includes('codex');
    const cursorConnected =
      cursorCredentials?.valid === true &&
      (cursorCredentials.runtimeAvailable || runtimeAvailableEngines.includes('cursor'));
    const cursorActionLabel = cursorConnected ? undefined : 'Connect';
    const opencodeConnected = runtimeAvailableEngines.includes('opencode');
    const opencodeActionLabel = opencodeConnected ? undefined : 'Connect';
    return (
      <>
        <Text style={styles.sectionLabel}>Engines</Text>
        <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
          <EngineConnectionEntry
            icon="sparkles-outline"
            title="Codex"
            description="Already available on this connection."
            status={codexConnected ? 'Connected' : 'Unavailable'}
            statusTone={codexConnected ? 'connected' : 'muted'}
          />
          <EngineConnectionEntry
            icon="code-slash-outline"
            title="Cursor"
            description={formatCursorEngineDescription(cursorCredentials, cursorCredentialsLoading)}
            status={formatCursorEngineStatus(cursorCredentials, cursorCredentialsLoading)}
            statusTone={
              cursorConnected ? 'connected' : cursorCredentials?.configured ? 'warning' : 'muted'
            }
            actionLabel={cursorActionLabel}
            busy={cursorCredentialsLoading && !cursorCredentials}
            onAction={cursorActionLabel ? () => handleConnectEngine('cursor') : undefined}
          />
          <EngineConnectionEntry
            icon="layers-outline"
            title="OpenCode"
            description={
              opencodeConnected
                ? 'OpenCode is available for new chats.'
                : 'Enable OpenCode on the bridge or hosted workspace.'
            }
            status={opencodeConnected ? 'Connected' : 'Not connected'}
            statusTone={opencodeConnected ? 'connected' : 'muted'}
            actionLabel={opencodeActionLabel}
            onAction={opencodeActionLabel ? () => handleConnectEngine('opencode') : undefined}
            isLast
          />
        </BlurView>

        <Text style={styles.subtleHintText}>
          Codex is connected by default. Cursor uses a Cursor API key on the bridge; OpenCode uses
          the provider credentials configured for OpenCode.
        </Text>
        {engineActionMessage ? (
          <Text style={styles.successText}>{engineActionMessage}</Text>
        ) : null}

        <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Cursor Details</Text>
        <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
          {cursorCredentialsLoading && !cursorCredentials ? (
            <View style={styles.accountLoadingState}>
              <ActivityIndicator color={colors.textPrimary} />
              <Text style={styles.settingValue}>Checking Cursor credentials…</Text>
            </View>
          ) : (
            <>
              <Row
                label="Status"
                value={formatCursorCredentialStatus(cursorCredentials)}
                valueColor={statusColor}
              />
              <Row
                label="Source"
                value={formatCursorCredentialSource(cursorCredentials)}
              />
              <Row
                label="Runtime"
                value={formatCursorRuntimeStatus(cursorCredentials)}
              />
              {cursorCredentials?.apiKeyName ? (
                <Row label="Key" value={cursorCredentials.apiKeyName} />
              ) : null}
              {cursorCredentials?.userEmail ? (
                <Row label="Email" value={cursorCredentials.userEmail} />
              ) : null}
              {cursorCredentials?.createdAt ? (
                <Row
                  label="Created"
                  value={formatCursorCredentialDate(cursorCredentials.createdAt)}
                />
              ) : null}
              <Row label="Usage" value="Not exposed by Cursor API" isLast />
            </>
          )}
        </BlurView>

        {cursorCredentialsError ? (
          <Text style={styles.errorText}>{cursorCredentialsError}</Text>
        ) : null}
        {cursorCredentials?.error ? (
          <Text style={styles.errorText}>{cursorCredentials.error}</Text>
        ) : null}
      </>
    );
  };

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
          colors={[theme.colors.bgElevated, theme.colors.bgItem]}
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
      case 'engines':
        return renderEnginesContent();
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
        title="Light / Dark"
        subtitle="Choose whether the app follows system appearance or stays light or dark."
        options={appearanceOptions}
        onClose={() => setAppearanceModalVisible(false)}
      />

      <SelectionSheet
        visible={darkPaletteModalVisible}
        eyebrow="Appearance"
        title="Dark palette"
        subtitle="Used whenever the app is in dark mode."
        options={darkPaletteOptions}
        onClose={() => setDarkPaletteModalVisible(false)}
      />

      <SelectionSheet
        visible={fontModalVisible}
        eyebrow="Appearance"
        title="Typography"
        subtitle="Pick the app-wide font pack used throughout the mobile interface."
        options={fontOptions}
        onClose={() => setFontModalVisible(false)}
      />

      <BridgeProfileManagerSheet
        visible={bridgeProfileModalVisible}
        profiles={bridgeProfiles}
        activeProfileId={activeBridgeProfileId}
        onActivate={onSwitchBridgeProfile}
        onRename={onRenameBridgeProfile}
        onDelete={onDeleteBridgeProfile}
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
        visible={workspaceChatLimitModalVisible}
        eyebrow="Sidebar"
        title="Chats per workspace"
        subtitle="Choose how many chats each workspace shows before the Show all row."
        options={workspaceChatLimitOptions}
        onClose={() => setWorkspaceChatLimitModalVisible(false)}
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

function MenuEntry({
  icon,
  logo,
  title,
  description,
  onPress,
  isLast,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  logo?: 'github' | 'clawdex';
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
          {logo === 'github' ? (
            <Ionicons name="logo-github" size={17} color={colors.textPrimary} />
          ) : logo === 'clawdex' ? (
            <Image
              source={clawdexMark}
              resizeMode="contain"
              style={[styles.menuLogoImage, { tintColor: colors.textPrimary }]}
            />
          ) : (
            <Ionicons name={icon} size={16} color={colors.textPrimary} />
          )}
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

type EngineStatusTone = 'connected' | 'warning' | 'muted';

function EngineConnectionEntry({
  icon,
  title,
  description,
  status,
  statusTone,
  actionLabel,
  busy,
  onAction,
  isLast,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  description: string;
  status: string;
  statusTone: EngineStatusTone;
  actionLabel?: string;
  busy?: boolean;
  onAction?: () => void;
  isLast?: boolean;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { colors } = theme;
  const statusColor =
    statusTone === 'connected'
      ? colors.statusComplete
      : statusTone === 'warning'
        ? colors.warning
        : colors.textMuted;

  return (
    <View style={[styles.engineRow, isLast && styles.engineRowLast]}>
      <View style={styles.menuIconWrap}>
        <Ionicons name={icon} size={16} color={colors.textPrimary} />
      </View>
      <View style={styles.engineTextWrap}>
        <View style={styles.engineTitleLine}>
          <Text style={styles.menuTitle}>{title}</Text>
          <View style={[styles.engineStatusPill, { borderColor: statusColor }]}>
            <Text style={[styles.engineStatusText, { color: statusColor }]} numberOfLines={1}>
              {status}
            </Text>
          </View>
        </View>
        <Text style={styles.menuDescription} numberOfLines={2}>
          {description}
        </Text>
      </View>
      {actionLabel && onAction ? (
        <Pressable
          onPress={onAction}
          disabled={busy}
          style={({ pressed }) => [
            styles.engineConnectBtn,
            busy && styles.settingRowDisabled,
            pressed && !busy && styles.engineConnectBtnPressed,
          ]}
        >
          {busy ? (
            <ActivityIndicator color={theme.colors.accentText} size="small" />
          ) : (
            <Text style={styles.engineConnectBtnText}>{actionLabel}</Text>
          )}
        </Pressable>
      ) : null}
    </View>
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

function readOptionalDisplayString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
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
  const settingsCardBackground = theme.colors.bgCanvasAccent;
  const settingsCardBorder = theme.colors.borderHighlight;
  const settingsDivider = theme.colors.borderLight;
  const neutralControlBackground = theme.colors.bgInput;
  const neutralControlPressed = theme.colors.bgItem;
  const settingsLabelColor = theme.colors.textMuted;
  const settingsValueColor = theme.colors.textSecondary;
  const settingsPrimaryText = theme.colors.textPrimary;
  const hintTextColor = theme.colors.textMuted;
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
    },
    sectionLabel: {
      ...theme.typography.caption,
      textTransform: 'uppercase',
      letterSpacing: 0,
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
    credentialInput: {
      ...theme.typography.body,
      minHeight: 48,
      marginTop: theme.spacing.md,
      marginBottom: theme.spacing.md,
      borderRadius: theme.radius.md,
      borderWidth: 1,
      borderColor: settingsCardBorder,
      backgroundColor: neutralControlBackground,
      color: settingsPrimaryText,
      paddingHorizontal: theme.spacing.md,
    },
    credentialPrimaryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.sm,
      marginBottom: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.md,
      backgroundColor: theme.colors.accent,
      borderRadius: theme.radius.md,
      boxShadow: `0px 4px 8px ${theme.colors.accent}4D`,
    },
    credentialPrimaryBtnText: {
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
    menuLogoImage: {
      width: 18,
      height: 18,
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
    engineRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: settingsDivider,
    },
    engineRowLast: {
      borderBottomWidth: 0,
    },
    engineTextWrap: {
      flex: 1,
      gap: 4,
      minWidth: 0,
    },
    engineTitleLine: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      flexWrap: 'wrap',
    },
    engineStatusPill: {
      borderRadius: theme.radius.sm,
      borderWidth: 1,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 2,
    },
    engineStatusText: {
      ...theme.typography.caption,
      fontWeight: '700',
    },
    engineConnectBtn: {
      minWidth: 78,
      minHeight: 36,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: theme.radius.md,
      backgroundColor: theme.colors.accent,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
    },
    engineConnectBtnPressed: {
      backgroundColor: theme.colors.accentPressed,
    },
    engineConnectBtnText: {
      ...theme.typography.caption,
      color: theme.colors.accentText,
      fontWeight: '700',
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
      letterSpacing: 0,
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
      backgroundColor: theme.colors.bgItem,
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

function formatRateLimitsError(error: unknown): string {
  const message = String((error as Error)?.message ?? error).trim();
  const normalized = message.toLowerCase();
  const authRequired =
    normalized.includes('codex account authentication required') ||
    normalized.includes('account authentication required') ||
    normalized.includes('authentication required to read rate limits') ||
    normalized.includes('requires openai auth') ||
    normalized.includes('chatgptauthtokens/refresh');

  if (authRequired) {
    return 'Codex is not signed in on this connection. Finish Codex login on the bridge host, then reconnect.';
  }

  return message || 'Unable to read Codex usage limits.';
}

function formatAccountSignInStatus(account: AccountSnapshot | null): string {
  if (!account?.type) {
    return 'Not signed in';
  }

  return account.type === 'chatgpt' ? 'ChatGPT' : 'API key';
}

function formatAccountHelpText(account: AccountSnapshot | null): string {
  if (!account) {
    return 'Check whether this connection is signed in before starting chats.';
  }

  if (account.type) {
    return 'This connection is signed in and ready to use.';
  }

  if (account.requiresOpenaiAuth) {
    return 'This connection still needs a ChatGPT or API sign-in before chats will work.';
  }

  return 'This connection can be used without a separate account sign-in.';
}

function mergeChatEngines(
  engines: readonly ChatEngine[],
  ...extraEngines: Array<ChatEngine | null | undefined>
): ChatEngine[] {
  const merged: ChatEngine[] = [];
  for (const engine of [...engines, ...extraEngines]) {
    if (
      (engine === 'codex' || engine === 'opencode' || engine === 'cursor') &&
      !merged.includes(engine)
    ) {
      merged.push(engine);
    }
  }

  return merged.length > 0 ? merged : ['codex'];
}

function formatEnginesSummary(
  availableEngines: readonly ChatEngine[],
  status: CursorCredentialStatus | null,
  loading: boolean
): string {
  const connected = new Set<ChatEngine>(availableEngines);
  connected.add('codex');
  if (status?.valid === true && status.runtimeAvailable) {
    connected.add('cursor');
  }

  const parts = [...connected].map((engine) => getChatEngineLabel(engine));
  if (parts.length >= 3) {
    return 'Codex, Cursor, OpenCode connected';
  }
  if (parts.length > 1) {
    return `${parts.join(', ')} connected`;
  }
  if (loading && !status) {
    return 'Codex connected · Checking Cursor';
  }
  if (!status) {
    return 'Codex connected';
  }
  if (!status.configured) {
    return 'Codex connected · Cursor API key required';
  }
  if (status.valid === true) {
    return status.runtimeAvailable ? 'Codex and Cursor connected' : 'Codex connected · Cursor key saved';
  }
  if (status.valid === false) {
    return 'Codex connected · Cursor key invalid';
  }
  return 'Codex connected · Cursor status unknown';
}

function formatCursorEngineDescription(
  status: CursorCredentialStatus | null,
  loading: boolean
): string {
  if (loading && !status) {
    return 'Checking the Cursor API key on this connection.';
  }
  if (!status?.configured) {
    return 'Connect with a Cursor API key on the bridge.';
  }
  if (status.valid === false) {
    return 'The saved Cursor API key needs attention.';
  }
  if (status.valid === true && status.runtimeAvailable) {
    return 'Cursor is available for new chats.';
  }
  if (status.valid === true) {
    return 'Cursor key is saved; restart the bridge if it is not available.';
  }
  return 'Cursor key status is not available yet.';
}

function formatCursorEngineStatus(
  status: CursorCredentialStatus | null,
  loading: boolean
): string {
  if (loading && !status) {
    return 'Checking';
  }
  if (!status?.configured) {
    return 'Not connected';
  }
  if (status.valid === false) {
    return 'Key invalid';
  }
  if (status.valid === true && status.runtimeAvailable) {
    return 'Connected';
  }
  if (status.valid === true) {
    return 'Key saved';
  }
  return 'Unknown';
}

function formatCursorCredentialStatus(status: CursorCredentialStatus | null): string {
  if (!status) {
    return 'Not checked';
  }
  if (!status.configured) {
    return 'Not configured';
  }
  if (status.valid === true) {
    return 'Connected';
  }
  if (status.valid === false) {
    return 'Invalid';
  }
  return 'Unknown';
}

function formatCursorCredentialSource(status: CursorCredentialStatus | null): string {
  if (!status?.source) {
    return 'None';
  }
  if (status.source === 'env') {
    return 'clawdex init';
  }
  return 'None';
}

function formatCursorRuntimeStatus(status: CursorCredentialStatus | null): string {
  if (!status) {
    return 'Unknown';
  }
  if (!status.enabled) {
    return 'Not enabled';
  }
  if (status.runtimeAvailable) {
    return status.active ? 'Active' : 'Ready';
  }
  return 'Waiting for key';
}

function formatCursorCredentialDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
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
