import { useCallback, useEffect, useState } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';

import type { MacBridgeApiClient } from '../api/client';
import type { MacBridgeWsClient } from '../api/ws';

interface SettingsScreenProps {
  api: MacBridgeApiClient;
  ws: MacBridgeWsClient;
  bridgeUrl: string;
}

export function SettingsScreen({ api, ws, bridgeUrl }: SettingsScreenProps) {
  const [healthyAt, setHealthyAt] = useState<string | null>(null);
  const [uptimeSec, setUptimeSec] = useState<number | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const health = await api.health();
      setHealthyAt(health.at);
      setUptimeSec(health.uptimeSec);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      void checkHealth();
    }, 0);

    return () => {
      clearTimeout(timeout);
    };
  }, [checkHealth]);

  useEffect(() => {
    const unsubscribe = ws.onStatus((connected) => {
      setWsConnected(connected);
    });

    return unsubscribe;
  }, [ws]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Bridge Config</Text>
      <Text selectable style={styles.value}>
        {bridgeUrl}
      </Text>

      <Text style={styles.title}>Health</Text>
      <Text>Status: {healthyAt ? 'ok' : 'unknown'}</Text>
      <Text>Last seen: {healthyAt ?? '-'}</Text>
      <Text>Bridge uptime: {uptimeSec !== null ? `${uptimeSec}s` : '-'}</Text>
      <Text>WebSocket: {wsConnected ? 'connected' : 'disconnected'}</Text>

      <Button title="Refresh health" onPress={() => void checkHealth()} />

      {error ? <Text style={styles.error}>Error: {error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    gap: 8
  },
  title: {
    fontWeight: '600',
    fontSize: 16,
    marginTop: 8
  },
  value: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 10
  },
  error: {
    color: '#b91c1c'
  }
});
