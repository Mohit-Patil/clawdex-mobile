import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { useAppTheme, type AppTheme } from '../theme';

interface TerminalScreenProps {
  api: HostBridgeApiClient;
  ws: HostBridgeWsClient;
  onOpenDrawer: () => void;
}

export function TerminalScreen({ api, ws, onOpenDrawer }: TerminalScreenProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
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
          <Ionicons name="menu" size={22} color={theme.colors.textMuted} />
        </Pressable>
        <Ionicons name="terminal" size={16} color={theme.colors.textMuted} />
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
            keyboardAppearance={theme.keyboardAppearance}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="send"
            onSubmitEditing={runCommand}
            placeholder="command"
            placeholderTextColor={theme.colors.textMuted}
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
            <Ionicons name={running ? 'pause' : 'play'} size={14} color={theme.colors.accentText} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.isDark ? '#000000' : theme.colors.bgMain },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    backgroundColor: theme.colors.bgMain,
  },
  menuBtn: { padding: theme.spacing.xs },
  headerTitle: { ...theme.typography.headline, color: theme.colors.textPrimary },
  body: { flex: 1, padding: theme.spacing.md },
  terminalWindow: {
    flex: 1,
    backgroundColor: theme.isDark ? '#1E1E1E' : theme.colors.bgElevated,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.isDark ? 'rgba(255,255,255,0.1)' : theme.colors.border,
    overflow: 'hidden',
    boxShadow: theme.isDark
      ? '0px 10px 20px rgba(0, 0, 0, 0.5)'
      : '0px 10px 20px rgba(15, 23, 42, 0.08)',
  },
  windowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.isDark ? '#323233' : theme.colors.bgCanvasAccent,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.isDark ? '#111' : theme.colors.border,
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
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontWeight: '600',
  },
  output: { flex: 1 },
  outputContent: { padding: theme.spacing.md },
  outputText: {
    ...theme.typography.mono,
    color: theme.colors.textPrimary,
    fontSize: 13,
    lineHeight: 20,
  },
  errorText: {
    ...theme.typography.caption,
    color: theme.colors.error,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.xs,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingTop: theme.spacing.md,
    paddingBottom: Platform.OS === 'ios' ? theme.spacing.xl : theme.spacing.md,
  },
  prompt: { ...theme.typography.mono, color: theme.colors.textSecondary, fontWeight: '700' },
  input: {
    flex: 1,
    ...theme.typography.mono,
    color: theme.colors.textPrimary,
    backgroundColor: theme.isDark ? '#1E1E1E' : theme.colors.bgInput,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.isDark ? 'rgba(255,255,255,0.1)' : theme.colors.border,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 10,
  },
  runBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: theme.colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  runBtnPressed: { backgroundColor: theme.colors.accentPressed },
  runBtnDisabled: { backgroundColor: theme.colors.bgItem },
});
