import 'react-native-gesture-handler';

import { Ionicons } from '@expo/vector-icons';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { useEffect, useMemo } from 'react';

import { MacBridgeApiClient } from './src/api/client';
import { env } from './src/config';
import { GitScreen } from './src/screens/GitScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { TerminalScreen } from './src/screens/TerminalScreen';
import { ThreadsScreen } from './src/screens/ThreadsScreen';
import { palette, fonts } from './src/ui/theme';
import { MacBridgeWsClient } from './src/api/ws';

type RootTabParamList = {
  Threads: undefined;
  Terminal: undefined;
  Git: undefined;
  Settings: undefined;
};

const Tab = createBottomTabNavigator<RootTabParamList>();

const navigationTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: palette.accent,
    background: palette.canvas,
    card: palette.panel,
    text: palette.ink,
    border: palette.border
  }
};

export default function App() {
  const api = useMemo(() => new MacBridgeApiClient({ baseUrl: env.macBridgeUrl }), []);
  const ws = useMemo(() => new MacBridgeWsClient(api.wsUrl()), [api]);

  useEffect(() => {
    ws.connect();

    return () => {
      ws.disconnect();
    };
  }, [ws]);

  return (
    <NavigationContainer theme={navigationTheme}>
      <Tab.Navigator
        initialRouteName="Threads"
        screenOptions={({ route }) => ({
          headerTitleAlign: 'left',
          headerShadowVisible: false,
          headerStyle: {
            backgroundColor: palette.canvas
          },
          headerTintColor: palette.ink,
          headerTitleStyle: {
            fontFamily: fonts.heading,
            fontSize: 20
          },
          tabBarStyle: {
            backgroundColor: palette.panel,
            borderTopColor: palette.border,
            height: 68,
            paddingTop: 8,
            paddingBottom: 10
          },
          tabBarLabelStyle: {
            fontFamily: fonts.heading,
            fontSize: 12
          },
          tabBarActiveTintColor: palette.accent,
          tabBarInactiveTintColor: palette.inkMuted,
          tabBarIcon: ({ color, focused, size }) => (
            <Ionicons
              name={tabIcon(route.name, focused)}
              size={focused ? size + 1 : size}
              color={color}
            />
          )
        })}
      >
        <Tab.Screen name="Threads">{() => <ThreadsScreen api={api} ws={ws} />}</Tab.Screen>
        <Tab.Screen name="Terminal">{() => <TerminalScreen api={api} ws={ws} />}</Tab.Screen>
        <Tab.Screen name="Git">{() => <GitScreen api={api} />}</Tab.Screen>
        <Tab.Screen name="Settings">
          {() => <SettingsScreen api={api} ws={ws} bridgeUrl={env.macBridgeUrl} />}
        </Tab.Screen>
      </Tab.Navigator>
    </NavigationContainer>
  );
}

function tabIcon(
  route: keyof RootTabParamList,
  focused: boolean
): keyof typeof Ionicons.glyphMap {
  if (route === 'Threads') {
    return focused ? 'chatbubbles' : 'chatbubbles-outline';
  }

  if (route === 'Terminal') {
    return focused ? 'terminal' : 'terminal-outline';
  }

  if (route === 'Git') {
    return focused ? 'git-branch' : 'git-branch-outline';
  }

  return focused ? 'settings' : 'settings-outline';
}
