import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { MacBridgeApiClient } from '../api/client';
import type { MacBridgeWsClient } from '../api/ws';
import { colors, radius, spacing, typography } from '../theme';

interface TerminalScreenProps {
  api: MacBridgeApiClient;
  ws: MacBridgeWsClient;
  onOpenDrawer: () => void;
}

export function TerminalScreen({ api, ws, onOpenDrawer }: TerminalScreenProps) {
  const [command, setCommand] = useState('pwd');
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runCommand = useCallback(async () => {
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

  useEffect(() => {
    return ws.onEvent((event) => {
      if (event.type === 'terminal.executed') {
        setOutput((prev) =>
          `${prev}\n\n[ws] ${event.payload.command} → ${String(event.payload.code)}`.trim()
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
        <ScrollView style={styles.output} contentContainerStyle={styles.outputContent}>
          <Text selectable style={styles.outputText}>
            {output || 'Run a command to see output.'}
          </Text>
        </ScrollView>

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
            onSubmitEditing={() => void runCommand()}
            placeholder="command"
            placeholderTextColor={colors.textMuted}
          />
          <Pressable
            onPress={() => void runCommand()}
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
  container: { flex: 1, backgroundColor: colors.bgMain },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  menuBtn: { padding: spacing.xs },
  headerTitle: { ...typography.headline },
  body: { flex: 1 },
  output: { flex: 1 },
  outputContent: { padding: spacing.lg },
  outputText: { ...typography.mono },
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
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  prompt: { ...typography.mono, color: colors.accent },
  input: {
    flex: 1,
    ...typography.mono,
    color: colors.textPrimary,
    backgroundColor: colors.bgSidebar,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
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
