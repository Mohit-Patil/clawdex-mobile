import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';

import type { MacBridgeApiClient } from '../api/client';
import type { MacBridgeWsClient } from '../api/ws';

interface TerminalScreenProps {
  api: MacBridgeApiClient;
  ws: MacBridgeWsClient;
}

export function TerminalScreen({ api, ws }: TerminalScreenProps) {
  const [command, setCommand] = useState('pwd');
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runCommand = useCallback(async () => {
    try {
      setRunning(true);
      const result = await api.execTerminal({ command });
      const formatted = [
        `$ ${result.command}`,
        result.stdout || '(no stdout)',
        result.stderr ? `stderr:\n${result.stderr}` : null,
        `exit code: ${String(result.code)}`,
        `duration: ${result.durationMs}ms`
      ]
        .filter(Boolean)
        .join('\n\n');

      setOutput(formatted);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }, [api, command]);

  useEffect(() => {
    const unsubscribe = ws.onEvent((event) => {
      if (event.type === 'terminal.executed') {
        setOutput((previous) => {
          const next = `${previous}\n\n[WS] ${event.payload.command} => ${String(event.payload.code)}`.trim();
          return next;
        });
      }
    });

    return unsubscribe;
  }, [ws]);

  return (
    <View style={styles.container}>
      <TextInput
        value={command}
        onChangeText={setCommand}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        placeholder="Enter command"
      />
      <Button
        title={running ? 'Running...' : 'Execute'}
        onPress={() => void runCommand()}
        disabled={running || !command.trim()}
      />

      <Text style={styles.title}>Output</Text>
      <ScrollView style={styles.outputBox} contentContainerStyle={styles.outputContent}>
        <Text selectable style={styles.outputText}>
          {output || 'Run a command to see output.'}
        </Text>
      </ScrollView>

      {error ? <Text style={styles.error}>Error: {error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    gap: 10
  },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  title: {
    fontSize: 16,
    fontWeight: '600'
  },
  outputBox: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#0f172a'
  },
  outputContent: {
    padding: 12
  },
  outputText: {
    color: '#e2e8f0',
    fontFamily: 'Courier'
  },
  error: {
    color: '#b91c1c'
  }
});
