import 'react-native-gesture-handler';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';

import { MacBridgeApiClient } from './src/api/client';
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

type Screen = 'Main' | 'Terminal' | 'Git' | 'Settings' | 'Privacy' | 'Terms';

const DRAWER_WIDTH = 280;

export default function App() {
  const api = useMemo(
    () =>
      new MacBridgeApiClient({
        baseUrl: env.macBridgeUrl,
        authToken: env.macBridgeToken
      }),
    []
  );
  const ws = useMemo(
    () =>
      new MacBridgeWsClient(api.wsUrl(), {
        authToken: env.macBridgeToken,
        allowQueryTokenAuth: env.allowWsQueryTokenAuth
      }),
    [api]
  );
  const mainRef = useRef<MainScreenHandle>(null);
  const [currentScreen, setCurrentScreen] = useState<Screen>('Main');
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const drawerAnim = useRef(new Animated.Value(-DRAWER_WIDTH)).current;
  const overlayAnim = useRef(new Animated.Value(0)).current;
  const isOpen = useRef(false);
  const { width: screenWidth } = useWindowDimensions();

  useEffect(() => {
    ws.connect();
    return () => ws.disconnect();
  }, [ws]);

  const openDrawer = useCallback(() => {
    isOpen.current = true;
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
    isOpen.current = false;
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

  const navigate = useCallback(
    (screen: Screen) => {
      setCurrentScreen(screen);
      closeDrawer();
    },
    [closeDrawer]
  );

  const handleSelectThread = useCallback(
    (id: string) => {
      setSelectedThreadId(id);
      setCurrentScreen('Main');
      mainRef.current?.openThread(id);
      closeDrawer();
    },
    [closeDrawer]
  );

  const handleNewThread = useCallback(() => {
    setSelectedThreadId(null);
    setCurrentScreen('Main');
    mainRef.current?.startNewThread();
    closeDrawer();
  }, [closeDrawer]);

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
      case 'Git':
        return <GitScreen api={api} onOpenDrawer={openDrawer} />;
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
        pointerEvents={isOpen.current ? 'auto' : 'none'}
        style={[styles.overlay, { opacity: overlayAnim }]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={closeDrawer} />
      </Animated.View>

      {/* Drawer */}
      <Animated.View
        style={[
          styles.drawer,
          { transform: [{ translateX: drawerAnim }] },
        ]}
      >
        <DrawerContent
          api={api}
          ws={ws}
          selectedThreadId={selectedThreadId}
          onSelectThread={handleSelectThread}
          onNewThread={handleNewThread}
          onNavigate={navigate}
        />
      </Animated.View>
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
});
