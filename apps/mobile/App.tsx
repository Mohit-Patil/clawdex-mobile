import 'react-native-gesture-handler';

import * as FileSystem from 'expo-file-system/legacy';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Keyboard,
  PanResponder,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { HostBridgeApiClient } from './src/api/client';
import type { ApprovalMode, Chat, ReasoningEffort } from './src/api/types';
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
import { colors } from './src/theme';

type AppScreen = 'Main' | 'ChatGit' | 'Settings' | 'Privacy' | 'Terms';
type Screen = AppScreen | 'Onboarding';
type OnboardingMode = 'initial' | 'edit';

const DRAWER_WIDTH = 280;
const EDGE_SWIPE_WIDTH = 24;
const SWIPE_OPEN_DISTANCE = 56;
const SWIPE_CLOSE_DISTANCE = 56;
const SWIPE_OPEN_VELOCITY = 0.4;
const SWIPE_CLOSE_VELOCITY = -0.4;
const APP_SETTINGS_FILE = 'clawdex-app-settings.json';
const APP_SETTINGS_VERSION = 3;

export default function App() {
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
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  const [defaultReasoningEffort, setDefaultReasoningEffort] =
    useState<ReasoningEffort | null>(null);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('normal');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerAnim = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  const overlayAnim = useRef(new Animated.Value(0)).current;
  const { width: screenWidth } = useWindowDimensions();

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
      nextModelId: string | null,
      nextEffort: ReasoningEffort | null,
      nextApprovalMode: ApprovalMode
    ) => {
      const settingsPath = getAppSettingsPath();
      if (!settingsPath) {
        return;
      }

      const payload = JSON.stringify({
        version: APP_SETTINGS_VERSION,
        bridgeUrl: nextBridgeUrl,
        bridgeToken: nextBridgeToken,
        defaultModelId: nextModelId,
        defaultReasoningEffort: nextEffort,
        approvalMode: nextApprovalMode,
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
      setDefaultModelId(null);
      setDefaultReasoningEffort(null);
      setApprovalMode('normal');
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
        setDefaultModelId(parsed.defaultModelId);
        setDefaultReasoningEffort(parsed.defaultReasoningEffort);
        setApprovalMode(parsed.approvalMode);
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

  const openDrawer = useCallback(() => {
    Keyboard.dismiss();
    setDrawerOpen(true);
    Animated.parallel([
      Animated.spring(drawerAnim, {
        toValue: 0,
        useNativeDriver: true,
        bounciness: 0,
        speed: 20,
      }),
      Animated.timing(overlayAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start();
  }, [drawerAnim, overlayAnim]);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    Animated.parallel([
      Animated.spring(drawerAnim, {
        toValue: -DRAWER_WIDTH,
        useNativeDriver: true,
        bounciness: 0,
        speed: 20,
      }),
      Animated.timing(overlayAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start();
  }, [drawerAnim, overlayAnim]);

  const openSwipeResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) => {
          if (drawerOpen) {
            return false;
          }

          if (gesture.dx <= 0) {
            return false;
          }

          const isMostlyHorizontal = Math.abs(gesture.dx) > Math.abs(gesture.dy);
          const isFromEdge = gesture.moveX <= EDGE_SWIPE_WIDTH + 12;

          return isMostlyHorizontal && isFromEdge && gesture.dx > 8;
        },
        onPanResponderRelease: (_, gesture) => {
          if (
            gesture.dx > SWIPE_OPEN_DISTANCE ||
            gesture.vx > SWIPE_OPEN_VELOCITY
          ) {
            if (currentScreen === 'ChatGit') {
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
              return;
            }

            openDrawer();
          }
        },
      }),
    [activeChat, currentScreen, drawerOpen, gitChat, openDrawer, selectedChatId]
  );

  const closeSwipeResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) => {
          if (!drawerOpen) {
            return false;
          }

          if (gesture.dx >= 0) {
            return false;
          }

          const isMostlyHorizontal = Math.abs(gesture.dx) > Math.abs(gesture.dy);
          return isMostlyHorizontal && gesture.dx < -8;
        },
        onPanResponderRelease: (_, gesture) => {
          if (
            gesture.dx < -SWIPE_CLOSE_DISTANCE ||
            gesture.vx < SWIPE_CLOSE_VELOCITY
          ) {
            closeDrawer();
          }
        },
      }),
    [closeDrawer, drawerOpen]
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
      setSelectedChatId(id);
      setGitChat(null);
      setCurrentScreen('Main');
      setPendingMainChatId(id);
      setPendingMainChatSnapshot(null);
      closeDrawer();
    },
    [closeDrawer]
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

  const handleDefaultModelSettingsChange = useCallback(
    (modelId: string | null, effort: ReasoningEffort | null) => {
      const normalizedModelId = normalizeModelId(modelId);
      const normalizedEffort = normalizeReasoningEffort(effort);
      setDefaultModelId(normalizedModelId);
      setDefaultReasoningEffort(normalizedEffort);
      void saveAppSettings(
        bridgeUrl,
        bridgeToken,
        normalizedModelId,
        normalizedEffort,
        approvalMode
      );
    },
    [approvalMode, bridgeToken, bridgeUrl, saveAppSettings]
  );

  const handleApprovalModeChange = useCallback(
    (nextMode: ApprovalMode) => {
      const normalizedMode = normalizeApprovalMode(nextMode);
      setApprovalMode(normalizedMode);
      void saveAppSettings(
        bridgeUrl,
        bridgeToken,
        defaultModelId,
        defaultReasoningEffort,
        normalizedMode
      );
    },
    [bridgeToken, bridgeUrl, defaultModelId, defaultReasoningEffort, saveAppSettings]
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
        defaultModelId,
        defaultReasoningEffort,
        approvalMode
      );
      setCurrentScreen(onboardingMode === 'edit' ? onboardingReturnScreen : 'Main');
      setOnboardingMode('edit');
      closeDrawer();
    },
    [
      approvalMode,
      closeDrawer,
      defaultModelId,
      defaultReasoningEffort,
      onboardingMode,
      onboardingReturnScreen,
      saveAppSettings,
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
    void saveAppSettings(null, null, defaultModelId, defaultReasoningEffort, approvalMode);
    closeDrawer();
  }, [
    approvalMode,
    closeDrawer,
    defaultModelId,
    defaultReasoningEffort,
    saveAppSettings,
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
      <SafeAreaProvider>
        <View style={styles.loadingRoot}>
          <ActivityIndicator size="large" color={colors.textMuted} />
        </View>
      </SafeAreaProvider>
    );
  }

  if (!bridgeUrl || !api || !ws || currentScreen === 'Onboarding') {
    const initialUrl = bridgeUrl ?? env.legacyHostBridgeUrl ?? '';
    const initialToken = bridgeToken ?? env.hostBridgeToken ?? '';
    const mode: OnboardingMode = bridgeUrl ? onboardingMode : 'initial';
    const canCancel = mode === 'edit' && Boolean(bridgeUrl);
    return (
      <SafeAreaProvider>
        <OnboardingScreen
          mode={mode}
          initialBridgeUrl={initialUrl}
          initialBridgeToken={initialToken}
          allowInsecureRemoteBridge={env.allowInsecureRemoteBridge}
          onSave={handleBridgeUrlSaved}
          onCancel={canCancel ? handleCancelOnboarding : undefined}
        />
      </SafeAreaProvider>
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
            onOpenDrawer={openDrawer}
            onOpenGit={handleOpenChatGit}
            defaultStartCwd={defaultStartCwd}
            defaultModelId={defaultModelId}
            defaultReasoningEffort={defaultReasoningEffort}
            approvalMode={approvalMode}
            onDefaultStartCwdChange={setDefaultStartCwd}
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
            defaultModelId={defaultModelId}
            defaultReasoningEffort={defaultReasoningEffort}
            onDefaultModelSettingsChange={handleDefaultModelSettingsChange}
            approvalMode={approvalMode}
            onApprovalModeChange={handleApprovalModeChange}
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
            onOpenDrawer={openDrawer}
            onOpenGit={handleOpenChatGit}
            defaultStartCwd={defaultStartCwd}
            defaultModelId={defaultModelId}
            defaultReasoningEffort={defaultReasoningEffort}
            approvalMode={approvalMode}
            onDefaultStartCwdChange={setDefaultStartCwd}
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
    <SafeAreaProvider>
      <View style={styles.root}>
        {/* Main content */}
        <View style={[styles.screen, { width: screenWidth }]}>
          {renderScreen()}
        </View>

        {/* Overlay */}
        <Animated.View
          pointerEvents={drawerOpen ? 'auto' : 'none'}
          {...closeSwipeResponder.panHandlers}
          style={[styles.overlay, { opacity: overlayAnim }]}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={closeDrawer} />
        </Animated.View>

        {/* Drawer */}
        <Animated.View
          {...closeSwipeResponder.panHandlers}
          style={[
            styles.drawer,
            { transform: [{ translateX: drawerAnim }] },
          ]}
        >
          <DrawerContent
            api={activeApi}
            ws={activeWs}
            selectedChatId={selectedChatId}
            selectedDefaultCwd={defaultStartCwd}
            onSelectDefaultCwd={setDefaultStartCwd}
            onSelectChat={handleSelectChat}
            onNewChat={handleNewChat}
            onNavigate={navigate}
          />
        </Animated.View>

        <View
          pointerEvents={drawerOpen ? 'none' : 'auto'}
          style={styles.edgeSwipeZone}
          {...openSwipeResponder.panHandlers}
        />
      </View>
    </SafeAreaProvider>
  );
}

function getAppSettingsPath(): string | null {
  const base = FileSystem.documentDirectory;
  if (typeof base !== 'string' || base.trim().length === 0) {
    return null;
  }

  return `${base}${APP_SETTINGS_FILE}`;
}

function parseAppSettings(raw: string): {
  bridgeUrl: string | null;
  bridgeToken: string | null;
  defaultModelId: string | null;
  defaultReasoningEffort: ReasoningEffort | null;
  approvalMode: ApprovalMode;
} {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {
      bridgeUrl: null,
      bridgeToken: null,
      defaultModelId: null,
      defaultReasoningEffort: null,
      approvalMode: 'normal',
    };
  }

  try {
    const parsed = JSON.parse(raw);
    const parsedVersion = (parsed as { version?: unknown }).version;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsedVersion !== 1 &&
        parsedVersion !== 2 &&
        parsedVersion !== APP_SETTINGS_VERSION)
    ) {
      return {
        bridgeUrl: null,
        bridgeToken: null,
        defaultModelId: null,
        defaultReasoningEffort: null,
        approvalMode: 'normal',
      };
    }

    return {
      bridgeUrl: normalizeBridgeUrl((parsed as { bridgeUrl?: unknown }).bridgeUrl),
      bridgeToken: normalizeBridgeToken((parsed as { bridgeToken?: unknown }).bridgeToken),
      defaultModelId: normalizeModelId(
        (parsed as { defaultModelId?: unknown }).defaultModelId
      ),
      defaultReasoningEffort: normalizeReasoningEffort(
        (parsed as { defaultReasoningEffort?: unknown }).defaultReasoningEffort
      ),
      approvalMode: normalizeApprovalMode(
        (parsed as { approvalMode?: unknown }).approvalMode
      ),
    };
  } catch {
    return {
      bridgeUrl: null,
      bridgeToken: null,
      defaultModelId: null,
      defaultReasoningEffort: null,
      approvalMode: 'normal',
    };
  }
}

function normalizeBridgeUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  return normalizeBridgeUrlInput(value);
}

function normalizeBridgeToken(value: unknown): string | null {
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

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bgMain,
  },
  loadingRoot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgMain,
  },
  screen: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
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
  edgeSwipeZone: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: EDGE_SWIPE_WIDTH,
    zIndex: 30,
  },
});
