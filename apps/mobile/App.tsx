import 'react-native-gesture-handler';

import * as FileSystem from 'expo-file-system/legacy';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  ActivityIndicator,
  Keyboard,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  type AppStateStatus,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';

import { HostBridgeApiClient } from './src/api/client';
import { APP_SETTINGS_VERSION, parseAppSettings } from './src/appSettings';
import type {
  ApprovalMode,
  Chat,
  ChatEngine,
  EngineDefaultSettingsMap,
  ReasoningEffort,
} from './src/api/types';
import { HostBridgeWsClient } from './src/api/ws';
import { normalizeBridgeUrlInput } from './src/bridgeUrl';
import {
  clearBridgeProfileStore,
  getActiveBridgeProfile,
  loadBridgeProfileStore,
  saveBridgeProfileStore,
  setActiveBridgeProfile,
  type BridgeProfile,
  type BridgeProfileDraft,
  upsertBridgeProfile,
} from './src/bridgeProfiles';
import { env } from './src/config';
import { DrawerContent } from './src/navigation/DrawerContent';
import { BrowserScreen } from './src/screens/BrowserScreen';
import { GitScreen } from './src/screens/GitScreen';
import { MainScreen, type MainScreenHandle } from './src/screens/MainScreen';
import {
  OnboardingScreen,
  type OnboardingBridgeProfileDraft,
  type OnboardingMode,
} from './src/screens/OnboardingScreen';
import { PrivacyScreen } from './src/screens/PrivacyScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import {
  AUTO_STORE_REVIEW_THRESHOLD_MS,
  createDefaultAutoStoreReviewState,
  isAutoStoreReviewEligible,
  loadAutoStoreReviewState,
  requestNativeStoreReview,
  saveAutoStoreReviewState,
  type AutoStoreReviewState,
} from './src/storeReview';
import { TermsScreen } from './src/screens/TermsScreen';
import { configureRevenueCatIfNeeded } from './src/tips';
import {
  AppThemeProvider,
  createAppTheme,
  resolveThemeMode,
  type AppearancePreference,
} from './src/theme';

type AppScreen = 'Main' | 'ChatGit' | 'Browser' | 'Settings' | 'Privacy' | 'Terms';
type Screen = AppScreen | 'Onboarding';

const DRAWER_WIDTH = 280;
const EDGE_SWIPE_WIDTH = 24;
const CHAT_GIT_BACK_DISTANCE = 56;
const CHAT_GIT_BACK_VELOCITY = 900;
const DRAWER_SNAP_OPEN_PROGRESS = 0.38;
const DRAWER_SNAP_VELOCITY = 920;
const DRAWER_VELOCITY_PROJECTION = 0.08;
const DRAWER_RUBBER_BAND_STRENGTH = 0.2;
const DRAWER_CONTENT_SCALE = 0.94;
const DRAWER_CONTENT_PARALLAX = 18;
const DRAWER_MAX_RADIUS = 28;
const DRAWER_MAX_SHADOW_OPACITY = 0.24;
const DRAWER_MAX_SHADOW_RADIUS = 26;
const DRAWER_MAX_ELEVATION = 18;
const APP_SETTINGS_FILE = 'clawdex-app-settings.json';
const AUTO_STORE_REVIEW_RETRY_MS = 24 * 60 * 60 * 1000;

export default function App() {
  const systemColorScheme = useColorScheme();
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [bridgeProfiles, setBridgeProfiles] = useState<BridgeProfile[]>([]);
  const [activeBridgeProfileId, setActiveBridgeProfileId] = useState<string | null>(null);
  const [onboardingMode, setOnboardingMode] = useState<OnboardingMode>('initial');
  const [onboardingReturnScreen, setOnboardingReturnScreen] =
    useState<AppScreen>('Settings');
  const activeBridgeProfile = useMemo(
    () =>
      getActiveBridgeProfile({
        activeProfileId: activeBridgeProfileId,
        profiles: bridgeProfiles,
      }),
    [activeBridgeProfileId, bridgeProfiles]
  );
  const bridgeUrl = activeBridgeProfile?.bridgeUrl ?? null;
  const bridgeToken = activeBridgeProfile?.bridgeToken ?? null;
  const ws = useMemo(
    () =>
      bridgeUrl
        ? new HostBridgeWsClient(bridgeUrl, {
            authToken: bridgeToken ?? env.hostBridgeToken,
            allowQueryTokenAuth: env.allowWsQueryTokenAuth
          })
        : null,
    [bridgeToken, bridgeUrl]
  );
  const api = useMemo(
    () =>
      ws
        ? new HostBridgeApiClient({
            ws,
          })
        : null,
    [ws]
  );
  const currentBridgeProfileStore = useMemo(
    () => ({
      activeProfileId: activeBridgeProfileId,
      profiles: bridgeProfiles,
    }),
    [activeBridgeProfileId, bridgeProfiles]
  );
  const mainRef = useRef<MainScreenHandle>(null);
  const [currentScreen, setCurrentScreen] = useState<Screen>('Main');
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [gitChat, setGitChat] = useState<Chat | null>(null);
  const [chatTransitionChatId, setChatTransitionChatId] = useState<string | null>(null);
  const [mainOpeningChatId, setMainOpeningChatId] = useState<string | null>(null);
  const [pendingMainChatId, setPendingMainChatId] = useState<string | null>(null);
  const [pendingMainChatSnapshot, setPendingMainChatSnapshot] = useState<Chat | null>(null);
  const [defaultStartCwd, setDefaultStartCwd] = useState<string | null>(null);
  const [defaultChatEngine, setDefaultChatEngine] = useState<ChatEngine>('codex');
  const [defaultEngineSettings, setDefaultEngineSettings] = useState<EngineDefaultSettingsMap>(
    createEmptyEngineDefaultSettingsMap
  );
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('yolo');
  const [showToolCalls, setShowToolCalls] = useState(true);
  const [appearancePreference, setAppearancePreference] =
    useState<AppearancePreference>('system');
  const [recentBrowserTargetUrls, setRecentBrowserTargetUrls] = useState<string[]>([]);
  const [pendingBrowserTargetUrl, setPendingBrowserTargetUrl] = useState<string | null>(null);
  const [appLifecycleState, setAppLifecycleState] = useState<AppStateStatus>(
    AppState.currentState
  );
  const [storeReviewStateLoaded, setStoreReviewStateLoaded] = useState(false);
  const [storeReviewState, setStoreReviewState] = useState<AutoStoreReviewState>(
    createDefaultAutoStoreReviewState
  );
  const [automaticStoreReviewRetryAt, setAutomaticStoreReviewRetryAt] = useState<number | null>(
    null
  );
  const [drawerVisible, setDrawerVisible] = useState(false);
  const drawerOpenRef = useRef(false);
  const drawerVisibleRef = useRef(false);
  const chatTransitionRequestIdRef = useRef(0);
  const appLifecycleStateRef = useRef(AppState.currentState);
  const activeUsageStartedAtRef = useRef<number | null>(
    AppState.currentState === 'active' ? Date.now() : null
  );
  const storeReviewStateRef = useRef<AutoStoreReviewState>(createDefaultAutoStoreReviewState());
  const automaticStoreReviewInFlightRef = useRef(false);
  const { width: screenWidth } = useWindowDimensions();
  const resolvedThemeMode = resolveThemeMode(appearancePreference, systemColorScheme);
  const theme = useMemo(() => createAppTheme(resolvedThemeMode), [resolvedThemeMode]);
  const styles = useMemo(() => createStyles(theme), [theme]);
  const contentShiftOpen = Math.min(DRAWER_WIDTH - 12, screenWidth * 0.74);
  const drawerOffset = useSharedValue(-DRAWER_WIDTH);
  const drawerDragStartOffset = useSharedValue(-DRAWER_WIDTH);

  const screenFrameAnimatedStyle = useAnimatedStyle(() => {
    const progress = getDrawerOpenProgress(drawerOffset.value);
    return {
      transform: [
        { translateX: progress * contentShiftOpen },
        { scale: 1 - (1 - DRAWER_CONTENT_SCALE) * progress },
      ],
      borderRadius: DRAWER_MAX_RADIUS * progress,
      shadowOpacity: DRAWER_MAX_SHADOW_OPACITY * progress,
      shadowRadius: DRAWER_MAX_SHADOW_RADIUS * progress,
      elevation: DRAWER_MAX_ELEVATION * progress,
    };
  }, [contentShiftOpen]);

  const overlayAnimatedStyle = useAnimatedStyle(() => ({
    opacity: getDrawerOpenProgress(drawerOffset.value),
  }));

  const drawerAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: drawerOffset.value }],
  }));

  const drawerContentAnimatedStyle = useAnimatedStyle(() => {
    const progress = getDrawerOpenProgress(drawerOffset.value);
    return {
      opacity: 0.88 + progress * 0.12,
      transform: [
        { translateX: (1 - progress) * -DRAWER_CONTENT_PARALLAX },
        { scale: 0.985 + progress * 0.015 },
      ],
    };
  });

  useEffect(() => {
    if (!ws) {
      return;
    }

    ws.connect();
    return () => ws.disconnect();
  }, [ws]);

  useEffect(() => {
    void configureRevenueCatIfNeeded().catch((error) => {
      console.warn(
        `RevenueCat setup skipped: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }, []);

  const persistStoreReviewState = useCallback(async (nextState: AutoStoreReviewState) => {
    try {
      await saveAutoStoreReviewState(nextState);
    } catch {
      // Best effort persistence only.
    }
  }, []);

  const updateStoreReviewState = useCallback(
    (recipe: (previous: AutoStoreReviewState) => AutoStoreReviewState) => {
      setStoreReviewState((previous) => {
        const nextState = recipe(previous);
        if (
          previous.accumulatedForegroundMs === nextState.accumulatedForegroundMs &&
          previous.automaticRequestAt === nextState.automaticRequestAt
        ) {
          return previous;
        }

        storeReviewStateRef.current = nextState;
        void persistStoreReviewState(nextState);
        return nextState;
      });
    },
    [persistStoreReviewState]
  );

  const flushActiveUsageTime = useCallback(
    (now = Date.now(), keepActive = false) => {
      const activeUsageStartedAt = activeUsageStartedAtRef.current;
      if (appLifecycleStateRef.current !== 'active' || activeUsageStartedAt === null) {
        if (keepActive && appLifecycleStateRef.current === 'active') {
          activeUsageStartedAtRef.current = now;
        }
        return;
      }

      const elapsedMs = Math.max(0, now - activeUsageStartedAt);
      activeUsageStartedAtRef.current = keepActive ? now : null;
      if (elapsedMs <= 0) {
        return;
      }

      updateStoreReviewState((previous) => ({
        ...previous,
        accumulatedForegroundMs: previous.accumulatedForegroundMs + elapsedMs,
      }));
    },
    [updateStoreReviewState]
  );

  const getEffectiveForegroundUsageMs = useCallback(() => {
    const currentState = storeReviewStateRef.current;
    if (
      appLifecycleStateRef.current !== 'active' ||
      activeUsageStartedAtRef.current === null
    ) {
      return currentState.accumulatedForegroundMs;
    }

    return (
      currentState.accumulatedForegroundMs +
      Math.max(0, Date.now() - activeUsageStartedAtRef.current)
    );
  }, []);

  const requestAutomaticStoreReview = useCallback(async () => {
    if (
      automaticStoreReviewInFlightRef.current ||
      !settingsLoaded ||
      !storeReviewStateLoaded ||
      currentScreen === 'Onboarding' ||
      (automaticStoreReviewRetryAt !== null && automaticStoreReviewRetryAt > Date.now())
    ) {
      return;
    }

    const effectiveState: AutoStoreReviewState = {
      ...storeReviewStateRef.current,
      accumulatedForegroundMs: getEffectiveForegroundUsageMs(),
    };
    if (!isAutoStoreReviewEligible(effectiveState)) {
      return;
    }

    automaticStoreReviewInFlightRef.current = true;
    try {
      const now = Date.now();
      flushActiveUsageTime(now, true);
      const didRequest = await requestNativeStoreReview();
      if (!didRequest) {
        setAutomaticStoreReviewRetryAt(now + AUTO_STORE_REVIEW_RETRY_MS);
        return;
      }

      setAutomaticStoreReviewRetryAt(null);
      updateStoreReviewState((previous) => ({
        ...previous,
        automaticRequestAt: new Date(now).toISOString(),
      }));
    } catch (error) {
      setAutomaticStoreReviewRetryAt(Date.now() + AUTO_STORE_REVIEW_RETRY_MS);
      console.warn(
        `Automatic store review request failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      automaticStoreReviewInFlightRef.current = false;
    }
  }, [
    currentScreen,
    flushActiveUsageTime,
    getEffectiveForegroundUsageMs,
    automaticStoreReviewRetryAt,
    settingsLoaded,
    storeReviewStateLoaded,
    updateStoreReviewState,
  ]);

  useEffect(() => {
    let cancelled = false;

    const loadStoreReviewPromptState = async () => {
      const nextState = await loadAutoStoreReviewState();
      if (cancelled) {
        return;
      }

      storeReviewStateRef.current = nextState;
      setStoreReviewState(nextState);
      setStoreReviewStateLoaded(true);
    };

    void loadStoreReviewPromptState();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      const previousState = appLifecycleStateRef.current;
      if (previousState === 'active' && nextState !== 'active') {
        flushActiveUsageTime(Date.now(), false);
      }

      if (previousState !== 'active' && nextState === 'active') {
        activeUsageStartedAtRef.current = Date.now();
      }

      appLifecycleStateRef.current = nextState;
      setAppLifecycleState(nextState);
    });

    return () => {
      subscription.remove();
      flushActiveUsageTime(Date.now(), false);
    };
  }, [flushActiveUsageTime]);

  useEffect(() => {
    if (
      appLifecycleState !== 'active' ||
      !settingsLoaded ||
      !storeReviewStateLoaded ||
      currentScreen === 'Onboarding' ||
      storeReviewState.automaticRequestAt
    ) {
      return;
    }

    const thresholdRemainingMs = AUTO_STORE_REVIEW_THRESHOLD_MS - getEffectiveForegroundUsageMs();
    const retryRemainingMs =
      automaticStoreReviewRetryAt === null ? 0 : automaticStoreReviewRetryAt - Date.now();
    const remainingMs = Math.max(thresholdRemainingMs, retryRemainingMs);
    if (remainingMs <= 0) {
      void requestAutomaticStoreReview();
      return;
    }

    const timer = setTimeout(() => {
      void requestAutomaticStoreReview();
    }, remainingMs);

    return () => {
      clearTimeout(timer);
    };
  }, [
    appLifecycleState,
    automaticStoreReviewRetryAt,
    currentScreen,
    getEffectiveForegroundUsageMs,
    requestAutomaticStoreReview,
    settingsLoaded,
    storeReviewState.accumulatedForegroundMs,
    storeReviewState.automaticRequestAt,
    storeReviewStateLoaded,
  ]);

  const saveAppSettings = useCallback(
    async (
      nextDefaultStartCwd: string | null,
      nextDefaultChatEngine: ChatEngine,
      nextDefaultEngineSettings: EngineDefaultSettingsMap,
      nextApprovalMode: ApprovalMode,
      nextShowToolCalls: boolean,
      nextAppearancePreference: AppearancePreference,
      nextRecentBrowserTargetUrls: string[]
    ) => {
      const settingsPath = getAppSettingsPath();
      if (!settingsPath) {
        return;
      }

      const payload = JSON.stringify({
        version: APP_SETTINGS_VERSION,
        defaultStartCwd: nextDefaultStartCwd,
        defaultChatEngine: nextDefaultChatEngine,
        defaultEngineSettings: nextDefaultEngineSettings,
        approvalMode: nextApprovalMode,
        showToolCalls: nextShowToolCalls,
        appearancePreference: nextAppearancePreference,
        recentBrowserTargetUrls: nextRecentBrowserTargetUrls,
      });

      try {
        await FileSystem.writeAsStringAsync(settingsPath, payload);
      } catch {
        // Best effort persistence only.
      }
    },
    []
  );

  useEffect(() => {
    let cancelled = false;

    const resetToDefaults = () => {
      setDefaultStartCwd(null);
      setDefaultChatEngine('codex');
      setDefaultEngineSettings(createEmptyEngineDefaultSettingsMap());
      setApprovalMode('yolo');
      setShowToolCalls(true);
      setAppearancePreference('system');
      setRecentBrowserTargetUrls([]);
    };

    const loadSettings = async () => {
      const settingsPath = getAppSettingsPath();
      let raw = '';
      try {
        if (settingsPath) {
          raw = await FileSystem.readAsStringAsync(settingsPath);
        }
      } catch {
        raw = '';
      }

      const parsed = parseAppSettings(raw);

      try {
        let profileStore = await loadBridgeProfileStore();
        if (
          profileStore.profiles.length === 0 &&
          parsed.bridgeUrl &&
          parsed.bridgeToken
        ) {
          profileStore = upsertBridgeProfile(profileStore, {
            name: null,
            bridgeUrl: parsed.bridgeUrl,
            bridgeToken: parsed.bridgeToken,
            activate: true,
          }).store;
          await saveBridgeProfileStore(profileStore);
        }

        if (cancelled) {
          return;
        }

        setBridgeProfiles(profileStore.profiles);
        setActiveBridgeProfileId(profileStore.activeProfileId);
        setDefaultStartCwd(parsed.defaultStartCwd);
        setDefaultChatEngine(parsed.defaultChatEngine);
        setDefaultEngineSettings(parsed.defaultEngineSettings);
        setApprovalMode(parsed.approvalMode);
        setShowToolCalls(parsed.showToolCalls);
        setAppearancePreference(parsed.appearancePreference);
        setRecentBrowserTargetUrls(parsed.recentBrowserTargetUrls);

        if (parsed.bridgeUrl || parsed.bridgeToken) {
          void saveAppSettings(
            parsed.defaultStartCwd,
            parsed.defaultChatEngine,
            parsed.defaultEngineSettings,
            parsed.approvalMode,
            parsed.showToolCalls,
            parsed.appearancePreference,
            parsed.recentBrowserTargetUrls
          );
        }
      } catch {
        if (!cancelled) {
          resetToDefaults();
          setBridgeProfiles([]);
          setActiveBridgeProfileId(null);
        }
      } finally {
        if (!cancelled) {
          setSettingsLoaded(true);
        }
      }
    };

    void loadSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  const dismissKeyboard = useCallback(() => {
    Keyboard.dismiss();
  }, []);

  const ensureDrawerVisible = useCallback(() => {
    if (drawerVisibleRef.current) {
      return;
    }

    drawerVisibleRef.current = true;
    setDrawerVisible(true);
  }, []);

  const handleDrawerSettled = useCallback(
    (isOpen: boolean) => {
      drawerOpenRef.current = isOpen;
      drawerVisibleRef.current = isOpen;
      setDrawerVisible(isOpen);
    },
    []
  );

  const animateDrawerTo = useCallback(
    (shouldOpen: boolean, velocityX = 0) => {
      if (!shouldOpen && !drawerVisibleRef.current) {
        return;
      }

      if (shouldOpen) {
        dismissKeyboard();
      }

      ensureDrawerVisible();
      drawerOffset.value = withSpring(
        shouldOpen ? 0 : -DRAWER_WIDTH,
        buildDrawerSpringConfig(velocityX),
        (finished) => {
          if (finished) {
            runOnJS(handleDrawerSettled)(shouldOpen);
          }
        }
      );
    },
    [dismissKeyboard, drawerOffset, ensureDrawerVisible, handleDrawerSettled]
  );

  const openDrawer = useCallback(() => {
    animateDrawerTo(true);
  }, [animateDrawerTo]);

  const closeDrawer = useCallback(() => {
    animateDrawerTo(false);
  }, [animateDrawerTo]);

  const openChatWithTransition = useCallback(
    async (id: string, snapshot?: Chat | null) => {
      const requestId = chatTransitionRequestIdRef.current + 1;
      chatTransitionRequestIdRef.current = requestId;
      const startedAt = Date.now();
      setChatTransitionChatId(id);
      setMainOpeningChatId(id);
      closeDrawer();

      let nextSnapshot = snapshot && snapshot.id === id ? snapshot : null;
      if (!nextSnapshot && currentScreen !== 'Main' && api) {
        try {
          nextSnapshot = await api.getChat(id);
        } catch {
          nextSnapshot = null;
        }
      }

      const remainingMs = 220 - (Date.now() - startedAt);
      if (remainingMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingMs));
      }

      if (chatTransitionRequestIdRef.current !== requestId) {
        return;
      }

      setSelectedChatId(id);
      setActiveChat(nextSnapshot);
      setGitChat(null);
      setCurrentScreen('Main');
      setPendingMainChatId(id);
      setPendingMainChatSnapshot(nextSnapshot);
      setChatTransitionChatId(null);
      if (nextSnapshot) {
        setMainOpeningChatId(null);
      }
    },
    [api, closeDrawer, currentScreen]
  );

  const handleChatGitBack = useCallback(() => {
    const chatId = gitChat?.id ?? activeChat?.id ?? selectedChatId;
    const resumeChat =
      gitChat && gitChat.id === chatId
        ? gitChat
        : activeChat && activeChat.id === chatId
          ? activeChat
          : null;
    if (chatId) {
      void openChatWithTransition(chatId, resumeChat);
      return;
    }
    setCurrentScreen('Main');
    setGitChat(null);
  }, [activeChat, gitChat, openChatWithTransition, selectedChatId]);

  const chatGitBackGesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ right: 12 })
        .activeOffsetX(12)
        .failOffsetY([-18, 18])
        .onEnd((event) => {
          if (
            event.translationX > CHAT_GIT_BACK_DISTANCE ||
            event.velocityX > CHAT_GIT_BACK_VELOCITY
          ) {
            runOnJS(handleChatGitBack)();
          }
        }),
    [handleChatGitBack]
  );

  const openDrawerGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(currentScreen !== 'ChatGit')
        .activeOffsetX(12)
        .failOffsetY([-18, 18])
        .onStart(() => {
          cancelAnimation(drawerOffset);
          drawerDragStartOffset.value = drawerOffset.value;
          runOnJS(dismissKeyboard)();
          runOnJS(ensureDrawerVisible)();
        })
        .onUpdate((event) => {
          drawerOffset.value = applyDrawerRubberBand(
            drawerDragStartOffset.value + event.translationX
          );
        })
        .onEnd((event) => {
          const nextOffset = clampDrawerOffset(drawerDragStartOffset.value + event.translationX);
          const shouldOpen = shouldSettleDrawerOpen(nextOffset, event.velocityX);
          drawerOffset.value = withSpring(
            shouldOpen ? 0 : -DRAWER_WIDTH,
            buildDrawerSpringConfig(event.velocityX),
            (finished) => {
              if (finished) {
                runOnJS(handleDrawerSettled)(shouldOpen);
              }
            }
          );
        }),
    [
      currentScreen,
      dismissKeyboard,
      drawerDragStartOffset,
      drawerOffset,
      ensureDrawerVisible,
      handleDrawerSettled,
    ]
  );

  const visibleDrawerGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(drawerVisible)
        .activeOffsetX([-8, 8])
        .failOffsetY([-18, 18])
        .onBegin(() => {
          cancelAnimation(drawerOffset);
          drawerDragStartOffset.value = drawerOffset.value;
        })
        .onUpdate((event) => {
          drawerOffset.value = applyDrawerRubberBand(
            drawerDragStartOffset.value + event.translationX
          );
        })
        .onEnd((event) => {
          const nextOffset = clampDrawerOffset(drawerDragStartOffset.value + event.translationX);
          const shouldOpen = shouldSettleDrawerOpen(nextOffset, event.velocityX);
          drawerOffset.value = withSpring(
            shouldOpen ? 0 : -DRAWER_WIDTH,
            buildDrawerSpringConfig(event.velocityX),
            (finished) => {
              if (finished) {
                runOnJS(handleDrawerSettled)(shouldOpen);
              }
            }
          );
        }),
    [drawerDragStartOffset, drawerOffset, drawerVisible, handleDrawerSettled]
  );

  const navigate = useCallback(
    (screen: Screen) => {
      if (screen !== 'Main') {
        chatTransitionRequestIdRef.current += 1;
        setChatTransitionChatId(null);
        setMainOpeningChatId(null);
      }
      setCurrentScreen(screen);
      closeDrawer();
    },
    [closeDrawer]
  );

  const handleSelectChat = useCallback(
    (id: string) => {
      const currentChatId = activeChat?.id ?? selectedChatId;
      if (currentScreen === 'Main' && currentChatId === id) {
        closeDrawer();
        return;
      }

      void openChatWithTransition(id, null);
    },
    [activeChat?.id, closeDrawer, currentScreen, openChatWithTransition, selectedChatId]
  );

  const handleNewChat = useCallback(() => {
    chatTransitionRequestIdRef.current += 1;
    setChatTransitionChatId(null);
    setMainOpeningChatId(null);
    setPendingMainChatId(null);
    setPendingMainChatSnapshot(null);
    setSelectedChatId(null);
    setActiveChat(null);
    setGitChat(null);
    setCurrentScreen('Main');
    mainRef.current?.startNewChat();
    closeDrawer();
  }, [closeDrawer]);

  const handleDefaultChatEngineChange = useCallback(
    (engine: ChatEngine) => {
      const normalizedEngine = normalizeChatEngine(engine) ?? 'codex';
      setDefaultChatEngine(normalizedEngine);
      void saveAppSettings(
        defaultStartCwd,
        normalizedEngine,
        defaultEngineSettings,
        approvalMode,
        showToolCalls,
        appearancePreference,
        recentBrowserTargetUrls
      );
    },
    [
      approvalMode,
      defaultEngineSettings,
      defaultStartCwd,
      recentBrowserTargetUrls,
      saveAppSettings,
      showToolCalls,
      appearancePreference,
    ]
  );

  const handleDefaultModelSettingsChange = useCallback(
    (engine: ChatEngine, modelId: string | null, effort: ReasoningEffort | null) => {
      const normalizedEngine = normalizeChatEngine(engine) ?? 'codex';
      const normalizedModelId = normalizeModelId(modelId);
      const normalizedEffort = normalizeReasoningEffort(effort);
      const nextDefaultEngineSettings = {
        ...defaultEngineSettings,
        [normalizedEngine]: {
          modelId: normalizedModelId,
          effort: normalizedEffort,
        },
      };
      setDefaultEngineSettings(nextDefaultEngineSettings);
      void saveAppSettings(
        defaultStartCwd,
        defaultChatEngine,
        nextDefaultEngineSettings,
        approvalMode,
        showToolCalls,
        appearancePreference,
        recentBrowserTargetUrls
      );
    },
    [
      approvalMode,
      defaultChatEngine,
      defaultEngineSettings,
      defaultStartCwd,
      recentBrowserTargetUrls,
      saveAppSettings,
      showToolCalls,
      appearancePreference,
    ]
  );

  const handleApprovalModeChange = useCallback(
    (nextMode: ApprovalMode) => {
      const normalizedMode = normalizeApprovalMode(nextMode);
      setApprovalMode(normalizedMode);
      void saveAppSettings(
        defaultStartCwd,
        defaultChatEngine,
        defaultEngineSettings,
        normalizedMode,
        showToolCalls,
        appearancePreference,
        recentBrowserTargetUrls
      );
    },
    [
      defaultChatEngine,
      defaultEngineSettings,
      defaultStartCwd,
      recentBrowserTargetUrls,
      saveAppSettings,
      showToolCalls,
      appearancePreference,
    ]
  );

  const handleShowToolCallsChange = useCallback(
    (nextValue: boolean) => {
      setShowToolCalls(nextValue);
      void saveAppSettings(
        defaultStartCwd,
        defaultChatEngine,
        defaultEngineSettings,
        approvalMode,
        nextValue,
        appearancePreference,
        recentBrowserTargetUrls
      );
    },
    [
      approvalMode,
      defaultChatEngine,
      defaultEngineSettings,
      defaultStartCwd,
      recentBrowserTargetUrls,
      saveAppSettings,
      appearancePreference,
    ]
  );

  const handleDefaultStartCwdChange = useCallback(
    (nextCwd: string | null) => {
      const normalizedDefaultStartCwd = normalizeDefaultStartCwd(nextCwd);
      setDefaultStartCwd(normalizedDefaultStartCwd);
      void saveAppSettings(
        normalizedDefaultStartCwd,
        defaultChatEngine,
        defaultEngineSettings,
        approvalMode,
        showToolCalls,
        appearancePreference,
        recentBrowserTargetUrls
      );
    },
    [
      approvalMode,
      defaultChatEngine,
      defaultEngineSettings,
      recentBrowserTargetUrls,
      saveAppSettings,
      showToolCalls,
      appearancePreference,
    ]
  );

  const handleAppearancePreferenceChange = useCallback(
    (nextPreference: AppearancePreference) => {
      setAppearancePreference(nextPreference);
      void saveAppSettings(
        defaultStartCwd,
        defaultChatEngine,
        defaultEngineSettings,
        approvalMode,
        showToolCalls,
        nextPreference,
        recentBrowserTargetUrls
      );
    },
    [
      approvalMode,
      defaultChatEngine,
      defaultEngineSettings,
      defaultStartCwd,
      recentBrowserTargetUrls,
      saveAppSettings,
      showToolCalls,
    ]
  );

  const handleRecentBrowserTargetUrlsChange = useCallback(
    (nextTargets: string[]) => {
      setRecentBrowserTargetUrls(nextTargets);
      void saveAppSettings(
        defaultStartCwd,
        defaultChatEngine,
        defaultEngineSettings,
        approvalMode,
        showToolCalls,
        appearancePreference,
        nextTargets
      );
    },
    [
      approvalMode,
      appearancePreference,
      defaultChatEngine,
      defaultEngineSettings,
      defaultStartCwd,
      saveAppSettings,
      showToolCalls,
    ]
  );

  const openBrowser = useCallback(
    (targetUrl?: string | null) => {
      if (typeof targetUrl === 'string' && targetUrl.trim().length > 0) {
        setPendingBrowserTargetUrl(targetUrl.trim());
      }
      chatTransitionRequestIdRef.current += 1;
      setChatTransitionChatId(null);
      setMainOpeningChatId(null);
      setCurrentScreen('Browser');
      closeDrawer();
    },
    [closeDrawer]
  );

  const resetBridgeSessionState = useCallback(() => {
      setSelectedChatId(null);
      setActiveChat(null);
      setGitChat(null);
      setChatTransitionChatId(null);
      setMainOpeningChatId(null);
      setPendingMainChatId(null);
      setPendingMainChatSnapshot(null);
  }, []);

  const handleBridgeProfileSaved = useCallback(
    async (draft: OnboardingBridgeProfileDraft) => {
      const normalized = normalizeBridgeUrlInput(draft.bridgeUrl);
      const normalizedToken = normalizeBridgeToken(draft.bridgeToken);
      if (!normalized || !normalizedToken) {
        throw new Error('Bridge URL and token are required.');
      }

      const nextDraft: BridgeProfileDraft = {
        id:
          onboardingMode === 'edit'
            ? activeBridgeProfile?.id ?? null
            : null,
        bridgeUrl: normalized,
        bridgeToken: normalizedToken,
        activate: true,
      };
      const { store: nextStore } = upsertBridgeProfile(currentBridgeProfileStore, nextDraft);
      await saveBridgeProfileStore(nextStore);
      setBridgeProfiles(nextStore.profiles);
      setActiveBridgeProfileId(nextStore.activeProfileId);
      resetBridgeSessionState();
      void saveAppSettings(
        defaultStartCwd,
        defaultChatEngine,
        defaultEngineSettings,
        approvalMode,
        showToolCalls,
        appearancePreference,
        recentBrowserTargetUrls
      );
      setCurrentScreen(onboardingMode === 'initial' ? 'Main' : onboardingReturnScreen);
      setOnboardingMode('edit');
      closeDrawer();
    },
    [
      activeBridgeProfile?.id,
      approvalMode,
      closeDrawer,
      currentBridgeProfileStore,
      defaultChatEngine,
      defaultEngineSettings,
      defaultStartCwd,
      onboardingMode,
      onboardingReturnScreen,
      recentBrowserTargetUrls,
      resetBridgeSessionState,
      saveAppSettings,
      showToolCalls,
      appearancePreference,
    ]
  );

  const handleEditBridgeProfile = useCallback(() => {
    setOnboardingMode(bridgeUrl ? 'edit' : 'initial');
    setOnboardingReturnScreen(currentScreen === 'Onboarding' ? 'Settings' : currentScreen);
    setCurrentScreen('Onboarding');
    closeDrawer();
  }, [bridgeUrl, closeDrawer, currentScreen]);

  const handleAddBridgeProfile = useCallback(() => {
    setOnboardingMode('add');
    setOnboardingReturnScreen(currentScreen === 'Onboarding' ? 'Settings' : currentScreen);
    setCurrentScreen('Onboarding');
    closeDrawer();
  }, [closeDrawer, currentScreen]);

  const handleSwitchBridgeProfile = useCallback(
    async (profileId: string) => {
      const nextStore = setActiveBridgeProfile(currentBridgeProfileStore, profileId);
      await saveBridgeProfileStore(nextStore);
      setBridgeProfiles(nextStore.profiles);
      setActiveBridgeProfileId(nextStore.activeProfileId);
      resetBridgeSessionState();
    },
    [currentBridgeProfileStore, resetBridgeSessionState]
  );

  const handleClearSavedBridges = useCallback(async () => {
    await clearBridgeProfileStore();
    setBridgeProfiles([]);
    setActiveBridgeProfileId(null);
    resetBridgeSessionState();
    setOnboardingMode('initial');
    setOnboardingReturnScreen('Main');
    setCurrentScreen('Onboarding');
    closeDrawer();
  }, [closeDrawer, resetBridgeSessionState]);

  const handleCancelOnboarding = useCallback(() => {
    setCurrentScreen(onboardingReturnScreen);
  }, [onboardingReturnScreen]);

  const handleOpenChatGit = useCallback((chat: Chat) => {
    chatTransitionRequestIdRef.current += 1;
    setChatTransitionChatId(null);
    setMainOpeningChatId(null);
    setGitChat(chat);
    setSelectedChatId(chat.id);
    setCurrentScreen('ChatGit');
  }, []);

  const handleChatContextChange = useCallback((chat: Chat | null) => {
    setActiveChat(chat);
    setSelectedChatId((previous) => {
      if (chat?.id) {
        return chat.id;
      }
      return mainOpeningChatId ? previous : null;
    });
  }, [mainOpeningChatId]);

  const handleGitChatUpdated = useCallback((chat: Chat) => {
    setGitChat(chat);
    setActiveChat((prev) => (prev?.id === chat.id ? chat : prev));
  }, []);

  const handleCloseGit = useCallback(() => {
    const chatId = gitChat?.id ?? activeChat?.id ?? selectedChatId;
    const resumeChat =
      gitChat && gitChat.id === chatId
        ? gitChat
        : activeChat && activeChat.id === chatId
          ? activeChat
          : null;
    if (chatId) {
      void openChatWithTransition(chatId, resumeChat);
      return;
    }
    setCurrentScreen('Main');
    setGitChat(null);
  }, [activeChat, gitChat, openChatWithTransition, selectedChatId]);

  const openPrivacy = useCallback(() => {
    chatTransitionRequestIdRef.current += 1;
    setChatTransitionChatId(null);
    setMainOpeningChatId(null);
    setCurrentScreen('Privacy');
  }, []);

  const openTerms = useCallback(() => {
    chatTransitionRequestIdRef.current += 1;
    setChatTransitionChatId(null);
    setMainOpeningChatId(null);
    setCurrentScreen('Terms');
  }, []);

  if (!settingsLoaded) {
    return (
      <AppThemeProvider theme={theme}>
        <GestureHandlerRootView style={styles.root}>
          <SafeAreaProvider initialMetrics={initialWindowMetrics}>
            <StatusBar
              barStyle={theme.statusBarStyle}
              backgroundColor={theme.colors.bgMain}
            />
            <View style={styles.loadingRoot}>
              <ActivityIndicator size="large" color={theme.colors.textMuted} />
            </View>
          </SafeAreaProvider>
        </GestureHandlerRootView>
      </AppThemeProvider>
    );
  }

  if (!bridgeUrl || !api || !ws || currentScreen === 'Onboarding') {
    const mode: OnboardingMode = bridgeUrl ? onboardingMode : 'initial';
    const initialUrl =
      mode === 'edit'
        ? activeBridgeProfile?.bridgeUrl ?? ''
        : mode === 'add'
          ? ''
          : env.legacyHostBridgeUrl ?? '';
    const initialToken =
      mode === 'edit'
        ? activeBridgeProfile?.bridgeToken ?? ''
        : mode === 'add'
          ? ''
          : env.hostBridgeToken ?? '';
    const canCancel = (mode === 'edit' || mode === 'add') && Boolean(activeBridgeProfile);
    return (
      <AppThemeProvider theme={theme}>
        <GestureHandlerRootView style={styles.root}>
          <SafeAreaProvider initialMetrics={initialWindowMetrics}>
            <StatusBar
              barStyle={theme.statusBarStyle}
              backgroundColor={theme.colors.bgMain}
            />
            <OnboardingScreen
              mode={mode}
              initialBridgeUrl={initialUrl}
              initialBridgeToken={initialToken}
              allowInsecureRemoteBridge={env.allowInsecureRemoteBridge}
              allowQueryTokenAuth={env.allowWsQueryTokenAuth}
              onSave={handleBridgeProfileSaved}
              onCancel={canCancel ? handleCancelOnboarding : undefined}
            />
          </SafeAreaProvider>
        </GestureHandlerRootView>
      </AppThemeProvider>
    );
  }

  const activeApi = api;
  const activeWs = ws;

  const renderScreen = () => {
    switch (currentScreen) {
      case 'ChatGit':
        return gitChat ? (
          <GitScreen
            api={activeApi}
            chat={gitChat}
            onBack={handleCloseGit}
            onChatUpdated={handleGitChatUpdated}
          />
        ) : (
          <MainScreen
            ref={mainRef}
            api={activeApi}
            ws={activeWs}
            bridgeUrl={bridgeUrl}
            bridgeToken={bridgeToken}
            onOpenDrawer={openDrawer}
            onOpenGit={handleOpenChatGit}
            onOpenLocalPreview={openBrowser}
            defaultStartCwd={defaultStartCwd}
            defaultChatEngine={defaultChatEngine}
            defaultEngineSettings={defaultEngineSettings}
            approvalMode={approvalMode}
            showToolCalls={showToolCalls}
            onDefaultStartCwdChange={handleDefaultStartCwdChange}
            onChatContextChange={handleChatContextChange}
            onChatOpeningStateChange={setMainOpeningChatId}
            pendingOpenChatId={pendingMainChatId}
            pendingOpenChatSnapshot={pendingMainChatSnapshot}
            onPendingOpenChatHandled={() => {
              setPendingMainChatId(null);
              setPendingMainChatSnapshot(null);
            }}
          />
        );
      case 'Settings':
        return (
          <SettingsScreen
            api={activeApi}
            ws={activeWs}
            bridgeUrl={bridgeUrl}
            activeBridgeProfileId={activeBridgeProfile?.id ?? null}
            bridgeProfileName={activeBridgeProfile?.name ?? 'Current bridge'}
            bridgeProfiles={bridgeProfiles}
            defaultChatEngine={defaultChatEngine}
            defaultEngineSettings={defaultEngineSettings}
            onDefaultChatEngineChange={handleDefaultChatEngineChange}
            onDefaultModelSettingsChange={handleDefaultModelSettingsChange}
            approvalMode={approvalMode}
            onApprovalModeChange={handleApprovalModeChange}
            showToolCalls={showToolCalls}
            onShowToolCallsChange={handleShowToolCallsChange}
            appearancePreference={appearancePreference}
            onAppearancePreferenceChange={handleAppearancePreferenceChange}
            onEditBridgeProfile={handleEditBridgeProfile}
            onAddBridgeProfile={handleAddBridgeProfile}
            onSwitchBridgeProfile={handleSwitchBridgeProfile}
            onClearSavedBridges={handleClearSavedBridges}
            onOpenDrawer={openDrawer}
            onOpenBrowser={openBrowser}
            onOpenPrivacy={openPrivacy}
            onOpenTerms={openTerms}
          />
        );
      case 'Browser':
        return (
          <BrowserScreen
            api={activeApi}
            bridgeUrl={bridgeUrl}
            onOpenDrawer={openDrawer}
            recentTargetUrls={recentBrowserTargetUrls}
            onRecentTargetUrlsChange={handleRecentBrowserTargetUrlsChange}
            pendingTargetUrl={pendingBrowserTargetUrl}
            onPendingTargetHandled={() => setPendingBrowserTargetUrl(null)}
          />
        );
      case 'Privacy':
        return (
          <PrivacyScreen
            policyUrl={env.privacyPolicyUrl}
            onOpenDrawer={openDrawer}
          />
        );
      case 'Terms':
        return (
          <TermsScreen
            termsUrl={env.termsOfServiceUrl}
            onOpenDrawer={openDrawer}
          />
        );
      default:
        return (
          <MainScreen
            ref={mainRef}
            api={activeApi}
            ws={activeWs}
            bridgeUrl={bridgeUrl}
            bridgeToken={bridgeToken}
            onOpenDrawer={openDrawer}
            onOpenGit={handleOpenChatGit}
            onOpenLocalPreview={openBrowser}
            defaultStartCwd={defaultStartCwd}
            defaultChatEngine={defaultChatEngine}
            defaultEngineSettings={defaultEngineSettings}
            approvalMode={approvalMode}
            showToolCalls={showToolCalls}
            onDefaultStartCwdChange={handleDefaultStartCwdChange}
            onChatContextChange={handleChatContextChange}
            onChatOpeningStateChange={setMainOpeningChatId}
            pendingOpenChatId={pendingMainChatId}
            pendingOpenChatSnapshot={pendingMainChatSnapshot}
            onPendingOpenChatHandled={() => {
              setPendingMainChatId(null);
              setPendingMainChatSnapshot(null);
            }}
          />
        );
    }
  };

  return (
    <AppThemeProvider theme={theme}>
      <GestureHandlerRootView style={styles.root}>
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
          <StatusBar
            barStyle={theme.statusBarStyle}
            backgroundColor={theme.colors.bgMain}
          />
          <View style={styles.root}>
            <GestureDetector gesture={openDrawerGesture}>
              <Animated.View
                style={[
                  styles.screenFrame,
                  screenFrameAnimatedStyle,
                  { width: screenWidth },
                ]}
              >
                {renderScreen()}
                {chatTransitionChatId || (currentScreen === 'Main' && mainOpeningChatId) ? (
                  <View style={styles.chatTransitionOverlay}>
                    <View style={styles.chatTransitionCard}>
                      <ActivityIndicator size="small" color={theme.colors.textPrimary} />
                      <Text style={styles.chatTransitionTitle}>Opening chat...</Text>
                    </View>
                  </View>
                ) : null}
              </Animated.View>
            </GestureDetector>

            <View pointerEvents={drawerVisible ? 'auto' : 'none'} style={styles.drawerLayer}>
              <GestureDetector gesture={visibleDrawerGesture}>
                <Animated.View style={[styles.overlay, overlayAnimatedStyle]}>
                  <Pressable style={StyleSheet.absoluteFill} onPress={closeDrawer} />
                </Animated.View>
              </GestureDetector>

              <Animated.View style={[styles.drawer, drawerAnimatedStyle]}>
                <Animated.View
                  style={[styles.drawerContentShell, drawerContentAnimatedStyle]}
                >
                  <DrawerContent
                    api={activeApi}
                    ws={activeWs}
                    selectedChatId={selectedChatId}
                    onSelectChat={handleSelectChat}
                    onNewChat={handleNewChat}
                    onNavigate={navigate}
                  />
                </Animated.View>

                <GestureDetector gesture={visibleDrawerGesture}>
                  <View style={styles.drawerDragZone} />
                </GestureDetector>
              </Animated.View>
            </View>

            {currentScreen === 'ChatGit' ? (
              <GestureDetector gesture={chatGitBackGesture}>
                <View
                  pointerEvents={drawerVisible ? 'none' : 'auto'}
                  style={styles.edgeSwipeZone}
                />
              </GestureDetector>
            ) : null}
          </View>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </AppThemeProvider>
  );
}

function getAppSettingsPath(): string | null {
  const base = FileSystem.documentDirectory;
  if (typeof base !== 'string' || base.trim().length === 0) {
    return null;
  }

  return `${base}${APP_SETTINGS_FILE}`;
}

function normalizeBridgeToken(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeDefaultStartCwd(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeModelId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeChatEngine(value: unknown): ChatEngine | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'opencode') {
    return normalized;
  }

  return null;
}

function createEmptyEngineDefaultSettingsMap(): EngineDefaultSettingsMap {
  return {
    codex: {
      modelId: null,
      effort: null,
    },
    opencode: {
      modelId: null,
      effort: null,
    },
  };
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
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

function normalizeApprovalMode(value: unknown): ApprovalMode {
  return value === 'yolo' ? 'yolo' : 'normal';
}

function clampDrawerOffset(value: number): number {
  'worklet';
  return Math.max(-DRAWER_WIDTH, Math.min(0, value));
}

function getDrawerOpenProgress(value: number): number {
  'worklet';
  return (clampDrawerOffset(value) + DRAWER_WIDTH) / DRAWER_WIDTH;
}

function applyDrawerRubberBand(value: number): number {
  'worklet';
  if (value > 0) {
    return value * DRAWER_RUBBER_BAND_STRENGTH;
  }

  if (value < -DRAWER_WIDTH) {
    return -DRAWER_WIDTH + (value + DRAWER_WIDTH) * DRAWER_RUBBER_BAND_STRENGTH;
  }

  return value;
}

function projectDrawerOffset(value: number, velocityX: number): number {
  'worklet';
  return clampDrawerOffset(value + velocityX * DRAWER_VELOCITY_PROJECTION);
}

function shouldSettleDrawerOpen(value: number, velocityX: number): boolean {
  'worklet';
  if (velocityX >= DRAWER_SNAP_VELOCITY) {
    return true;
  }

  if (velocityX <= -DRAWER_SNAP_VELOCITY) {
    return false;
  }

  return getDrawerOpenProgress(projectDrawerOffset(value, velocityX)) >= DRAWER_SNAP_OPEN_PROGRESS;
}

function buildDrawerSpringConfig(velocityX: number) {
  'worklet';
  return {
    damping: 22,
    stiffness: 260,
    mass: 0.9,
    velocity: Math.max(-1800, Math.min(1800, velocityX)),
  };
}

const createStyles = (theme: ReturnType<typeof createAppTheme>) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: theme.colors.bgMain,
    },
    loadingRoot: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.bgMain,
    },
    screen: {
      flex: 1,
    },
    screenFrame: {
      flex: 1,
      backgroundColor: theme.colors.bgMain,
      overflow: 'hidden',
      borderCurve: 'continuous',
      shadowColor: theme.colors.shadow,
      shadowOffset: { width: 0, height: 16 },
    },
    chatTransitionOverlay: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 5,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 28,
      backgroundColor: theme.colors.bgMain,
    },
    chatTransitionCard: {
      width: '100%',
      maxWidth: 320,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgElevated,
      paddingHorizontal: 22,
      paddingVertical: 24,
      alignItems: 'center',
      gap: 10,
    },
    chatTransitionTitle: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
      fontWeight: '700',
      textAlign: 'center',
    },
    overlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: theme.colors.overlayBackdrop,
      zIndex: 10,
    },
    drawerLayer: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 10,
    },
    drawer: {
      position: 'absolute',
      top: 0,
      left: 0,
      bottom: 0,
      width: DRAWER_WIDTH,
      zIndex: 20,
    },
    drawerContentShell: {
      flex: 1,
    },
    drawerDragZone: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      width: 20,
      zIndex: 25,
    },
    edgeSwipeZone: {
      position: 'absolute',
      top: 0,
      left: 0,
      bottom: 0,
      width: EDGE_SWIPE_WIDTH,
      zIndex: 30,
    },
  });
