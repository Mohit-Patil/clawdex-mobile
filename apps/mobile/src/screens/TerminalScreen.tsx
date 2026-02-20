import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { MacBridgeApiClient } from '../api/client';
import type { MacBridgeWsClient } from '../api/ws';
import { ActionButton, Panel, ScreenSurface } from '../ui/primitives';
import { fonts, palette, radii, spacing } from '../ui/theme';

interface TerminalScreenProps {
  api: MacBridgeApiClient;
  ws: MacBridgeWsClient;
}

export function TerminalScreen({ api, ws }: TerminalScreenProps) {
  const [command, setCommand] = useState('pwd');
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
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
        `duration: ${result.durationMs}ms${result.timedOut ? ' • timed out' : ''}`
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
        const line = `${new Date().toLocaleTimeString()} • ${event.payload.command} => ${String(event.payload.code)}`;
        setEvents((previous) => [line, ...previous].slice(0, 4));
      }
    });

    return unsubscribe;
  }, [ws]);

  return (
    <ScreenSurface>
      <View style={styles.container}>
        <View style={styles.hero}>
          <Text style={styles.heroLabel}>TERMINAL BRIDGE</Text>
          <Text style={styles.heroTitle}>Run Commands</Text>
          <Text style={styles.heroMeta}>Execute shell commands on your Mac bridge quickly.</Text>
        </View>

        <Panel>
          <Text style={styles.blockTitle}>Command</Text>
          <TextInput
            value={command}
            onChangeText={setCommand}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            placeholder="npm run typecheck"
            placeholderTextColor={palette.inkMuted}
            multiline
          />
          <View style={styles.buttonRow}>
            <ActionButton
              label={running ? 'Running...' : 'Execute'}
              onPress={() => void runCommand()}
              disabled={running || !command.trim()}
            />
          </View>
        </Panel>

        {events.length > 0 ? (
          <Panel style={styles.eventsPanel}>
            <Text style={styles.eventsTitle}>Live Events</Text>
            {events.map((event) => (
              <Text key={event} numberOfLines={1} style={styles.eventLine}>
                {event}
              </Text>
            ))}
          </Panel>
        ) : null}

        <Panel style={styles.outputPanel}>
          <View style={styles.outputHeader}>
            <Text style={styles.outputTitle}>Output</Text>
            <Text style={styles.outputHint}>stream snapshot</Text>
          </View>
          <ScrollView style={styles.outputBox} contentContainerStyle={styles.outputContent}>
            <Text selectable style={styles.outputText}>
              {output || 'Run a command to see terminal output.'}
            </Text>
          </ScrollView>
        </Panel>

        {error ? <Text style={styles.error}>Error: {error}</Text> : null}
      </View>
    </ScreenSurface>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    gap: spacing.sm,
    paddingTop: spacing.sm
  },
  hero: {
    marginBottom: spacing.xs
  },
  heroLabel: {
    fontFamily: fonts.heading,
    fontSize: 12,
    letterSpacing: 1.3,
    color: palette.accent
  },
  heroTitle: {
    marginTop: 2,
    fontFamily: fonts.heading,
    fontSize: 28,
    color: palette.ink
  },
  heroMeta: {
    marginTop: 2,
    fontFamily: fonts.body,
    color: palette.inkMuted
  },
  blockTitle: {
    fontFamily: fonts.heading,
    fontSize: 16,
    color: palette.ink,
    marginBottom: spacing.sm
  },
  input: {
    minHeight: 60,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    backgroundColor: palette.canvas,
    fontFamily: fonts.mono,
    color: palette.ink,
    textAlignVertical: 'top'
  },
  buttonRow: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    justifyContent: 'flex-end'
  },
  eventsPanel: {
    padding: spacing.sm,
    gap: 4
  },
  eventsTitle: {
    fontFamily: fonts.heading,
    fontSize: 13,
    color: palette.ink
  },
  eventLine: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: palette.inkMuted
  },
  outputPanel: {
    flex: 1,
    padding: spacing.sm,
    gap: spacing.xs
  },
  outputHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  outputTitle: {
    fontFamily: fonts.heading,
    fontSize: 16,
    color: palette.ink
  },
  outputHint: {
    fontFamily: fonts.body,
    color: palette.inkMuted,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.8
  },
  outputBox: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#1B3047',
    borderRadius: radii.md,
    backgroundColor: palette.night
  },
  outputContent: {
    padding: spacing.sm
  },
  outputText: {
    color: '#EAF2FA',
    fontFamily: fonts.mono,
    lineHeight: 19,
    fontSize: 13
  },
  error: {
    color: palette.danger,
    fontFamily: fonts.body,
    paddingHorizontal: 2
  }
});
