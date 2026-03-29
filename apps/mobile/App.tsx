import 'react-native-gesture-handler';

import * as FileSystem from 'expo-file-system/legacy';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StatusBar,
  StyleSheet,
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
import { env } from './src/config';
import { DrawerContent } from './src/navigation/DrawerContent';
import { GitScreen } from './src/screens/GitScreen';
import { MainScreen, type MainScreenHandle } from './src/screens/MainScreen';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { PrivacyScreen } from './src/screens/PrivacyScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { TermsScreen } from './src/screens/TermsScreen';
import {
  AppThemeProvider,
  createAppTheme,
  resolveThemeMode,
  type AppearancePreference,
} from './src/theme';

type AppScreen = 'Main' | 'ChatGit' | 'Settings' | 'Privacy' | 'Terms';
type Screen = AppScreen | 'Onboarding';
type OnboardingMode = 'initial' | 'edit';

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

export default function App() {
  const systemColorScheme = useColorScheme();
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [bridgeUrl, setBridgeUrl] = useState<string | null>(null);
  const [bridgeToken, setBridgeToken] = useState<string | null>(env.hostBridgeToken);
  const [onboardingMode, setOnboardingMode] = useState<OnboardingMode>('initial');
  const [onboardingReturnScreen, setOnboardingReturnScreen] =
    useState<AppScreen>('Settings');
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
  const mainRef = useRef<MainScreenHandle>(null);
  const [currentScreen, setCurrentScreen] = useState<Screen>('Main');
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [gitChat, setGitChat] = useState<Chat | null>(null);
  const [pendingMainChatId, setPendingMainChatId] = useState<string | null>(null);
  const [pendingMainChatSnapshot, setPendingMainChatSnapshot] = useState<Chat | null>(null);
  const [defaultStartCwd, setDefaultStartCwd] = useState<string | null>(null);
  const [defaultChatEngine, setDefaultChatEngine] = useState<ChatEngine>('codex');
  const [defaultEngineSettings, setDefaultEngineSettings] = useState<EngineDefaultSettingsMap>(
    createEmptyEngineDefaultSettingsMap
  );
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('yolo');
  const [showToolCalls, setShowToolCalls] = useState(false);
  const [appearancePreference, setAppearancePreference] =
    useState<AppearancePreference>('system');
  const [drawerVisible, setDrawerVisible] = useState(false);
  const drawerOpenRef = useRef(false);
  const drawerVisibleRef = useRef(false);
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

  const saveAppSettings = useCallback(
    async (
      nextBridgeUrl: string | null,
      nextBridgeToken: string | null,
      nextDefaultStartCwd: string | null,
      nextDefaultChatEngine: ChatEngine,
      nextDefaultEngineSettings: EngineDefaultSettingsMap,
      nextApprovalMode: ApprovalMode,
      nextShowToolCalls: boolean,
      nextAppearancePreference: AppearancePreference
    ) => {
      const settingsPath = getAppSettingsPath();
      if (!settingsPath) {
        return;
      }

      const payload = JSON.stringify({
        version: APP_SETTINGS_VERSION,
        bridgeUrl: nextBridgeUrl,
        bridgeToken: nextBridgeToken,
        defaultStartCwd: nextDefaultStartCwd,
        defaultChatEngine: nextDefaultChatEngine,
        defaultEngineSettings: nextDefaultEngineSettings,
        approvalMode: nextApprovalMode,
        showToolCalls: nextShowToolCalls,
        appearancePreference: nextAppearancePreference,
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
      setShowToolCalls(false);
      setAppearancePreference('system');
    };

    const loadSettings = async () => {
      const settingsPath = getAppSettingsPath();
      if (!settingsPath) {
        if (!cancelled) {
          resetToDefaults();
          setBridgeUrl(null);
          setBridgeToken(env.hostBridgeToken);
          setSettingsLoaded(true);
        }
        return;
      }

      try {
        const raw = await FileSystem.readAsStringAsync(settingsPath);
        if (cancelled) {
          return;
        }
        const parsed = parseAppSettings(raw);
        const resolvedBridgeUrl = parsed.bridgeUrl ?? null;
        setBridgeUrl(resolvedBridgeUrl);
        setBridgeToken(parsed.bridgeToken ?? env.hostBridgeToken);
        setDefaultStartCwd(parsed.defaultStartCwd);
        setDefaultChatEngine(parsed.defaultChatEngine);
        setDefaultEngineSettings(parsed.defaultEngineSettings);
        setApprovalMode(parsed.approvalMode);
        setShowToolCalls(parsed.showToolCalls);
        setAppearancePreference(parsed.appearancePreference);
      } catch {
        if (!cancelled) {
          resetToDefaults();
          setBridgeUrl(null);
          setBridgeToken(env.hostBridgeToken);
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

  const handleChatGitBack = useCallback(() => {
    const chatId = gitChat?.id ?? activeChat?.id ?? selectedChatId;
    const resumeChat =
      gitChat && gitChat.id === chatId
        ? gitChat
        : activeChat && activeChat.id === chatId
          ? activeChat
          : null;
    setCurrentScreen('Main');
    setGitChat(null);
    if (chatId) {
      setSelectedChatId(chatId);
      setPendingMainChatId(chatId);
      setPendingMainChatSnapshot(resumeChat);
    }
  }, [activeChat, gitChat, selectedChatId]);

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

      setSelectedChatId(id);
      setGitChat(null);
      setCurrentScreen('Main');
      setPendingMainChatId(id);
      setPendingMainChatSnapshot(null);
      closeDrawer();
    },
    [activeChat?.id, closeDrawer, currentScreen, selectedChatId]
  );

  const handleNewChat = useCallback(() => {
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
        bridgeUrl,
        bridgeToken,
        defaultStartCwd,
        normalizedEngine,
        defaultEngineSettings,
        approvalMode,
        showToolCalls,
        appearancePreference
      );
    },
    [
      approvalMode,
      bridgeToken,
      bridgeUrl,
      defaultEngineSettings,
      defaultStartCwd,
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
        bridgeUrl,
        bridgeToken,
        defaultStartCwd,
        defaultChatEngine,
        nextDefaultEngineSettings,
        approvalMode,
        showToolCalls,
        appearancePreference
      );
    },
    [
      approvalMode,
      bridgeToken,
      bridgeUrl,
      defaultChatEngine,
      defaultEngineSettings,
      defaultStartCwd,
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
        bridgeUrl,
        bridgeToken,
        defaultStartCwd,
        defaultChatEngine,
        defaultEngineSettings,
        normalizedMode,
        showToolCalls,
        appearancePreference
      );
    },
    [
      bridgeToken,
      bridgeUrl,
      defaultChatEngine,
      defaultEngineSettings,
      defaultStartCwd,
      saveAppSettings,
      showToolCalls,
      appearancePreference,
    ]
  );

  const handleShowToolCallsChange = useCallback(
    (nextValue: boolean) => {
      setShowToolCalls(nextValue);
      void saveAppSettings(
        bridgeUrl,
        bridgeToken,
        defaultStartCwd,
        defaultChatEngine,
        defaultEngineSettings,
        approvalMode,
        nextValue,
        appearancePreference
      );
    },
    [
      approvalMode,
      bridgeToken,
      bridgeUrl,
      defaultChatEngine,
      defaultEngineSettings,
      defaultStartCwd,
      saveAppSettings,
      appearancePreference,
    ]
  );

  const handleDefaultStartCwdChange = useCallback(
    (nextCwd: string | null) => {
      const normalizedDefaultStartCwd = normalizeDefaultStartCwd(nextCwd);
      setDefaultStartCwd(normalizedDefaultStartCwd);
      void saveAppSettings(
        bridgeUrl,
        bridgeToken,
        normalizedDefaultStartCwd,
        defaultChatEngine,
        defaultEngineSettings,
        approvalMode,
        showToolCalls,
        appearancePreference
      );
    },
    [
      approvalMode,
      bridgeToken,
      bridgeUrl,
      defaultChatEngine,
      defaultEngineSettings,
      saveAppSettings,
      showToolCalls,
      appearancePreference,
    ]
  );

  const handleAppearancePreferenceChange = useCallback(
    (nextPreference: AppearancePreference) => {
      setAppearancePreference(nextPreference);
      void saveAppSettings(
        bridgeUrl,
        bridgeToken,
        defaultStartCwd,
        defaultChatEngine,
        defaultEngineSettings,
        approvalMode,
        showToolCalls,
        nextPreference
      );
    },
    [
      approvalMode,
      bridgeToken,
      bridgeUrl,
      defaultChatEngine,
      defaultEngineSettings,
      defaultStartCwd,
      saveAppSettings,
      showToolCalls,
    ]
  );

  const handleBridgeUrlSaved = useCallback(
    (nextBridgeUrl: string, nextBridgeToken: string | null) => {
      const normalized = normalizeBridgeUrlInput(nextBridgeUrl);
      if (!normalized) {
        return;
      }

      setBridgeUrl(normalized);
      setBridgeToken(normalizeBridgeToken(nextBridgeToken));
      setSelectedChatId(null);
      setActiveChat(null);
      setGitChat(null);
      setPendingMainChatId(null);
      setPendingMainChatSnapshot(null);
      void saveAppSettings(
        normalized,
        normalizeBridgeToken(nextBridgeToken),
        defaultStartCwd,
        defaultChatEngine,
        defaultEngineSettings,
        approvalMode,
        showToolCalls,
        appearancePreference
      );
      setCurrentScreen(onboardingMode === 'edit' ? onboardingReturnScreen : 'Main');
      setOnboardingMode('edit');
      closeDrawer();
    },
    [
      approvalMode,
      closeDrawer,
      defaultChatEngine,
      defaultEngineSettings,
      defaultStartCwd,
      onboardingMode,
      onboardingReturnScreen,
      saveAppSettings,
      showToolCalls,
      appearancePreference,
    ]
  );

  const handleOpenBridgeUrlSettings = useCallback(() => {
    setOnboardingMode(bridgeUrl ? 'edit' : 'initial');
    setOnboardingReturnScreen(currentScreen === 'Onboarding' ? 'Settings' : currentScreen);
    setCurrentScreen('Onboarding');
    closeDrawer();
  }, [bridgeUrl, closeDrawer, currentScreen]);

  const handleResetOnboarding = useCallback(() => {
    setBridgeUrl(null);
    setBridgeToken(null);
    setSelectedChatId(null);
    setActiveChat(null);
    setGitChat(null);
    setPendingMainChatId(null);
    setPendingMainChatSnapshot(null);
    setOnboardingMode('initial');
    setOnboardingReturnScreen('Main');
    setCurrentScreen('Onboarding');
    void saveAppSettings(
      null,
      null,
      defaultStartCwd,
      defaultChatEngine,
      defaultEngineSettings,
      approvalMode,
      showToolCalls,
      appearancePreference
    );
    closeDrawer();
  }, [
    approvalMode,
    closeDrawer,
    defaultChatEngine,
    defaultEngineSettings,
    defaultStartCwd,
    saveAppSettings,
    showToolCalls,
    appearancePreference,
  ]);

  const handleCancelOnboarding = useCallback(() => {
    setCurrentScreen(onboardingReturnScreen);
  }, [onboardingReturnScreen]);

  const handleOpenChatGit = useCallback((chat: Chat) => {
    setGitChat(chat);
    setSelectedChatId(chat.id);
    setCurrentScreen('ChatGit');
  }, []);

  const handleChatContextChange = useCallback((chat: Chat | null) => {
    setActiveChat(chat);
    setSelectedChatId(chat?.id ?? null);
  }, []);

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
    setCurrentScreen('Main');
    setGitChat(null);
    if (chatId) {
      setSelectedChatId(chatId);
      setPendingMainChatId(chatId);
      setPendingMainChatSnapshot(resumeChat);
    }
  }, [activeChat, gitChat, selectedChatId]);

  const openPrivacy = useCallback(() => {
    setCurrentScreen('Privacy');
  }, []);

  const openTerms = useCallback(() => {
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
    const initialUrl = bridgeUrl ?? env.legacyHostBridgeUrl ?? '';
    const initialToken = bridgeToken ?? env.hostBridgeToken ?? '';
    const mode: OnboardingMode = bridgeUrl ? onboardingMode : 'initial';
    const canCancel = mode === 'edit' && Boolean(bridgeUrl);
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
              onSave={handleBridgeUrlSaved}
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
            defaultStartCwd={defaultStartCwd}
            defaultChatEngine={defaultChatEngine}
            defaultEngineSettings={defaultEngineSettings}
            approvalMode={approvalMode}
            showToolCalls={showToolCalls}
            onDefaultStartCwdChange={handleDefaultStartCwdChange}
            onChatContextChange={handleChatContextChange}
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
            onEditBridgeUrl={handleOpenBridgeUrlSettings}
            onResetOnboarding={handleResetOnboarding}
            onOpenDrawer={openDrawer}
            onOpenPrivacy={openPrivacy}
            onOpenTerms={openTerms}
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
            defaultStartCwd={defaultStartCwd}
            defaultChatEngine={defaultChatEngine}
            defaultEngineSettings={defaultEngineSettings}
            approvalMode={approvalMode}
            showToolCalls={showToolCalls}
            onDefaultStartCwdChange={handleDefaultStartCwdChange}
            onChatContextChange={handleChatContextChange}
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
