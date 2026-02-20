import 'react-native-gesture-handler';

import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useEffect, useMemo } from 'react';

import { MacBridgeApiClient } from './src/api/client';
import { MacBridgeWsClient } from './src/api/ws';
import { env } from './src/config';
import { GitScreen } from './src/screens/GitScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { TerminalScreen } from './src/screens/TerminalScreen';
import { ThreadsScreen } from './src/screens/ThreadsScreen';

type RootTabParamList = {
  Threads: undefined;
  Terminal: undefined;
  Git: undefined;
  Settings: undefined;
};

const Tab = createBottomTabNavigator<RootTabParamList>();

export default function App() {
  const api = useMemo(
    () => new MacBridgeApiClient({ baseUrl: env.macBridgeUrl }),
    []
  );
  const ws = useMemo(() => new MacBridgeWsClient(api.wsUrl()), [api]);

  useEffect(() => {
    ws.connect();

    return () => {
      ws.disconnect();
    };
  }, [ws]);

  return (
    <NavigationContainer>
      <Tab.Navigator
        initialRouteName="Threads"
        screenOptions={{
          headerTitleAlign: 'center'
        }}
      >
        <Tab.Screen name="Threads">
          {() => <ThreadsScreen api={api} ws={ws} />}
        </Tab.Screen>
        <Tab.Screen name="Terminal">
          {() => <TerminalScreen api={api} ws={ws} />}
        </Tab.Screen>
        <Tab.Screen name="Git">{() => <GitScreen api={api} />}</Tab.Screen>
        <Tab.Screen name="Settings">
          {() => <SettingsScreen api={api} ws={ws} bridgeUrl={env.macBridgeUrl} />}
        </Tab.Screen>
      </Tab.Navigator>
    </NavigationContainer>
  );
}
