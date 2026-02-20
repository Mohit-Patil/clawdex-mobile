import 'react-native-gesture-handler';

import { createDrawerNavigator } from '@react-navigation/drawer';
import { NavigationContainer } from '@react-navigation/native';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { View } from 'react-native';

import { MacBridgeApiClient } from './src/api/client';
import { MacBridgeWsClient } from './src/api/ws';
import { env } from './src/config';
import { DrawerContent } from './src/navigation/DrawerContent';
import { GitScreen } from './src/screens/GitScreen';
import { MainScreen, type MainScreenHandle } from './src/screens/MainScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { TerminalScreen } from './src/screens/TerminalScreen';
import { colors } from './src/theme';

type DrawerParamList = {
  Main: undefined;
  Terminal: undefined;
  Git: undefined;
  Settings: undefined;
};

const Drawer = createDrawerNavigator<DrawerParamList>();

export default function App() {
  const api = useMemo(() => new MacBridgeApiClient({ baseUrl: env.macBridgeUrl }), []);
  const ws = useMemo(() => new MacBridgeWsClient(api.wsUrl()), [api]);
  const mainRef = useRef<MainScreenHandle>(null);

  useEffect(() => {
    ws.connect();
    return () => ws.disconnect();
  }, [ws]);

  const handleSelectThread = useCallback((id: string) => {
    mainRef.current?.openThread(id);
  }, []);

  const handleNewThread = useCallback(() => {
    mainRef.current?.startNewThread();
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bgMain }}>
      <NavigationContainer>
        <Drawer.Navigator
          drawerContent={(props) => (
            <DrawerContent
              {...props}
              api={api}
              ws={ws}
              selectedThreadId={null}
              onSelectThread={handleSelectThread}
              onNewThread={handleNewThread}
            />
          )}
          screenOptions={{
            headerShown: false,
            drawerStyle: { width: 280, backgroundColor: colors.bgSidebar },
            drawerType: 'front',
            overlayColor: 'rgba(0,0,0,0.5)',
            swipeEdgeWidth: 40,
          }}
        >
          <Drawer.Screen name="Main">
            {({ navigation }) => (
              <MainScreen ref={mainRef} api={api} ws={ws} navigation={navigation} />
            )}
          </Drawer.Screen>
          <Drawer.Screen name="Terminal">
            {() => <TerminalScreen api={api} ws={ws} />}
          </Drawer.Screen>
          <Drawer.Screen name="Git">
            {() => <GitScreen api={api} />}
          </Drawer.Screen>
          <Drawer.Screen name="Settings">
            {() => <SettingsScreen api={api} ws={ws} bridgeUrl={env.macBridgeUrl} />}
          </Drawer.Screen>
        </Drawer.Navigator>
      </NavigationContainer>
    </View>
  );
}
