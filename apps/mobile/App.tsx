import 'react-native-gesture-handler';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';

import { MacBridgeApiClient } from './src/api/client';
import type { Chat } from './src/api/types';
import { MacBridgeWsClient } from './src/api/ws';
import { env } from './src/config';
import { DrawerContent } from './src/navigation/DrawerContent';
import { GitScreen } from './src/screens/GitScreen';
import { MainScreen, type MainScreenHandle } from './src/screens/MainScreen';
import { PrivacyScreen } from './src/screens/PrivacyScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { TerminalScreen } from './src/screens/TerminalScreen';
import { TermsScreen } from './src/screens/TermsScreen';
import { colors } from './src/theme';

type Screen = 'Main' | 'ChatGit' | 'Terminal' | 'Settings' | 'Privacy' | 'Terms';

const DRAWER_WIDTH = 280;
const EDGE_SWIPE_WIDTH = 24;
const SWIPE_OPEN_DISTANCE = 56;
const SWIPE_CLOSE_DISTANCE = 56;
const SWIPE_OPEN_VELOCITY = 0.4;
const SWIPE_CLOSE_VELOCITY = -0.4;

export default function App() {
  const ws = useMemo(
    () =>
      new MacBridgeWsClient(env.macBridgeUrl, {
        authToken: env.macBridgeToken,
        allowQueryTokenAuth: env.allowWsQueryTokenAuth
      }),
    []
  );
  const api = useMemo(
    () =>
      new MacBridgeApiClient({
        ws,
      }),
    [ws]
  );
  const mainRef = useRef<MainScreenHandle>(null);
  const [currentScreen, setCurrentScreen] = useState<Screen>('Main');
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [gitChat, setGitChat] = useState<Chat | null>(null);
  const [defaultStartCwd, setDefaultStartCwd] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerAnim = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  const overlayAnim = useRef(new Animated.Value(0)).current;
  const { width: screenWidth } = useWindowDimensions();

  useEffect(() => {
    ws.connect();
    return () => ws.disconnect();
  }, [ws]);

  const openDrawer = useCallback(() => {
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
            openDrawer();
          }
        },
      }),
    [drawerOpen, openDrawer]
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
      mainRef.current?.openChat(id);
      closeDrawer();
    },
    [closeDrawer]
  );

  const handleNewChat = useCallback(() => {
    setSelectedChatId(null);
    setActiveChat(null);
    setGitChat(null);
    setCurrentScreen('Main');
    mainRef.current?.startNewChat();
    closeDrawer();
  }, [closeDrawer]);

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
    setCurrentScreen('Main');
    if (chatId) {
      setSelectedChatId(chatId);
      mainRef.current?.openChat(chatId);
    }
  }, [activeChat?.id, gitChat?.id, selectedChatId]);

  const openPrivacy = useCallback(() => {
    setCurrentScreen('Privacy');
  }, []);

  const openTerms = useCallback(() => {
    setCurrentScreen('Terms');
  }, []);

  const renderScreen = () => {
    switch (currentScreen) {
      case 'Terminal':
        return <TerminalScreen api={api} ws={ws} onOpenDrawer={openDrawer} />;
      case 'ChatGit':
        return gitChat ? (
          <GitScreen
            api={api}
            chat={gitChat}
            onBack={handleCloseGit}
            onChatUpdated={handleGitChatUpdated}
          />
        ) : (
          <MainScreen
            ref={mainRef}
            api={api}
            ws={ws}
            onOpenDrawer={openDrawer}
            onOpenGit={handleOpenChatGit}
            defaultStartCwd={defaultStartCwd}
            onDefaultStartCwdChange={setDefaultStartCwd}
            onChatContextChange={handleChatContextChange}
          />
        );
      case 'Settings':
        return (
          <SettingsScreen
            api={api}
            ws={ws}
            bridgeUrl={env.macBridgeUrl}
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
            api={api}
            ws={ws}
            onOpenDrawer={openDrawer}
            onOpenGit={handleOpenChatGit}
            defaultStartCwd={defaultStartCwd}
            onDefaultStartCwdChange={setDefaultStartCwd}
            onChatContextChange={handleChatContextChange}
          />
        );
    }
  };

  return (
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
          api={api}
          ws={ws}
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
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
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
