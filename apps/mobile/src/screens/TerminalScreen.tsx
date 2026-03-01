import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { HostBridgeApiClient } from '../api/client';
import type { HostBridgeWsClient } from '../api/ws';
import { colors, radius, spacing, typography } from '../theme';

interface TerminalScreenProps {
  api: HostBridgeApiClient;
  ws: HostBridgeWsClient;
  onOpenDrawer: () => void;
}

export function TerminalScreen({ api, ws, onOpenDrawer }: TerminalScreenProps) {
  const [command, setCommand] = useState('pwd');
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const executeCommand = useCallback(async () => {
    try {
      setRunning(true);
      const result = await api.execTerminal({ command });
      const lines = [
        `$ ${result.command}`,
        result.stdout || '(no stdout)',
        result.stderr ? `stderr:\n${result.stderr}` : null,
        `exit ${String(result.code)} · ${result.durationMs}ms`,
      ]
        .filter(Boolean)
        .join('\n\n');
      setOutput(lines);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }, [api, command]);

  const runCommand = useCallback(() => {
    const trimmed = command.trim();
    if (!trimmed || running) {
      return;
    }

    Alert.alert('Run command?', trimmed, [
      {
        text: 'Cancel',
        style: 'cancel'
      },
      {
        text: 'Run',
        onPress: () => {
          void executeCommand();
        }
      }
    ]);
  }, [command, executeCommand, running]);

  useEffect(() => {
    return ws.onEvent((event) => {
      if (event.method === 'bridge/terminal/completed') {
        const payload = event.params;
        const command = typeof payload?.command === 'string' ? payload.command : 'unknown';
        const code =
          typeof payload?.code === 'number' || payload?.code === null
            ? payload.code
            : null;
        setOutput((prev) =>
          `${prev}\n\n[ws] ${command} → ${String(code)}`.trim()
        );
      }
    });
  }, [ws]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onOpenDrawer} hitSlop={8} style={styles.menuBtn}>
          <Ionicons name="menu" size={22} color={colors.textMuted} />
        </Pressable>
        <Ionicons name="terminal" size={16} color={colors.textMuted} />
        <Text style={styles.headerTitle}>Terminal</Text>
      </View>

      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.terminalWindow}>
          {/* macOS-style window header */}
          <View style={styles.windowHeader}>
            <View style={styles.trafficLights}>
              <View style={[styles.trafficLight, { backgroundColor: '#FF5F56' }]} />
              <View style={[styles.trafficLight, { backgroundColor: '#FFBD2E' }]} />
              <View style={[styles.trafficLight, { backgroundColor: '#8A93A5' }]} />
            </View>
            <Text style={styles.windowTitle}>bash — 80x24</Text>
            <View style={styles.trafficLightsPlaceholder} />
          </View>

          <ScrollView style={styles.output} contentContainerStyle={styles.outputContent}>
            <Text selectable style={styles.outputText}>
              {output || 'Run a command to see output.'}
            </Text>
          </ScrollView>
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.inputRow}>
          <Text style={styles.prompt}>$</Text>
          <TextInput
            style={styles.input}
            value={command}
            onChangeText={setCommand}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="send"
            onSubmitEditing={runCommand}
            placeholder="command"
            placeholderTextColor={colors.textMuted}
          />
          <Pressable
            onPress={runCommand}
            disabled={running || !command.trim()}
            style={({ pressed }) => [
              styles.runBtn,
              pressed && styles.runBtnPressed,
              running && styles.runBtnDisabled,
            ]}
          >
            <Ionicons name={running ? 'pause' : 'play'} size={14} color={colors.white} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000000' }, // Pure black context for terminal
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.bgMain,
  },
  menuBtn: { padding: spacing.xs },
  headerTitle: { ...typography.headline, color: colors.textPrimary },
  body: { flex: 1, padding: spacing.md },
  terminalWindow: {
    flex: 1,
    backgroundColor: '#1E1E1E', // standard dark term bg
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.1)',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 8,
  },
  windowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: '#323233',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#111',
  },
  trafficLights: {
    flexDirection: 'row',
    gap: 6,
    width: 50,
  },
  trafficLightsPlaceholder: {
    width: 50,
  },
  trafficLight: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  windowTitle: {
    ...typography.caption,
    color: '#9E9E9E',
    fontWeight: '600',
  },
  output: { flex: 1 },
  outputContent: { padding: spacing.md },
  outputText: {
    ...typography.mono,
    color: '#D4D7DF',
    fontSize: 13,
    lineHeight: 20,
  },
  errorText: {
    ...typography.caption,
    color: colors.error,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingTop: spacing.md,
    paddingBottom: Platform.OS === 'ios' ? spacing.xl : spacing.md,
  },
  prompt: { ...typography.mono, color: colors.textSecondary, fontWeight: '700' },
  input: {
    flex: 1,
    ...typography.mono,
    color: colors.textPrimary,
    backgroundColor: '#1E1E1E',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  runBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  runBtnPressed: { backgroundColor: colors.accentPressed },
  runBtnDisabled: { backgroundColor: colors.bgItem },
});
