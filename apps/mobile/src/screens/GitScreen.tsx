import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { MacBridgeApiClient } from '../api/client';
import type { GitStatusResponse } from '../api/types';
import { ActionButton, Panel, ScreenSurface } from '../ui/primitives';
import { fonts, palette, radii, spacing } from '../ui/theme';

interface GitScreenProps {
  api: MacBridgeApiClient;
}

export function GitScreen({ api }: GitScreenProps) {
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [diff, setDiff] = useState('');
  const [commitMessage, setCommitMessage] = useState('chore: checkpoint');
  const [loading, setLoading] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const [nextStatus, nextDiff] = await Promise.all([api.gitStatus(), api.gitDiff()]);

      setStatus(nextStatus);
      setDiff(nextDiff.diff);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const commit = useCallback(async () => {
    try {
      setCommitting(true);
      const result = await api.gitCommit({ message: commitMessage });
      if (!result.committed) {
        setError(result.stderr || 'Commit command failed.');
      } else {
        setError(null);
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCommitting(false);
    }
  }, [api, commitMessage, refresh]);

  if (loading) {
    return (
      <ScreenSurface>
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={palette.accent} />
        </View>
      </ScreenSurface>
    );
  }

  return (
    <ScreenSurface>
      <View style={styles.container}>
        <View style={styles.hero}>
          <Text style={styles.heroLabel}>SOURCE CONTROL</Text>
          <Text style={styles.heroTitle}>Repository Pulse</Text>
          <Text style={styles.heroMeta}>Review diffs and commit without leaving mobile.</Text>
        </View>

        <Panel>
          <View style={styles.repoHeader}>
            <View>
              <Text style={styles.repoTitle}>{status?.branch ?? 'unknown branch'}</Text>
              <Text style={styles.repoSubtitle}>Current branch</Text>
            </View>
            <View style={[styles.cleanBadge, status?.clean ? styles.cleanBadgeOk : styles.cleanBadgeDirty]}>
              <Text style={styles.cleanBadgeText}>{status?.clean ? 'clean' : 'dirty'}</Text>
            </View>
          </View>
          <View style={styles.repoActionRow}>
            <ActionButton label="Refresh" variant="ghost" compact onPress={() => void refresh()} />
          </View>
        </Panel>

        <Panel>
          <Text style={styles.blockTitle}>Commit Message</Text>
          <TextInput
            value={commitMessage}
            onChangeText={setCommitMessage}
            style={styles.input}
            placeholder="feat: update mobile UI"
            placeholderTextColor={palette.inkMuted}
          />
          <View style={styles.repoActionRow}>
            <ActionButton
              label={committing ? 'Committing...' : 'Create Commit'}
              onPress={() => void commit()}
              disabled={committing || !commitMessage.trim()}
            />
          </View>
        </Panel>

        <Panel style={styles.diffPanel}>
          <Text style={styles.blockTitle}>Diff</Text>
          <ScrollView style={styles.diffBox} contentContainerStyle={styles.diffContent}>
            <Text selectable style={styles.diffText}>
              {diff || 'No diff.'}
            </Text>
          </ScrollView>
        </Panel>

        {error ? <Text style={styles.error}>Error: {error}</Text> : null}
      </View>
    </ScreenSurface>
  );
}

const styles = StyleSheet.create({
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
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
  repoHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm
  },
  repoTitle: {
    fontFamily: fonts.heading,
    color: palette.ink,
    fontSize: 18
  },
  repoSubtitle: {
    fontFamily: fonts.body,
    color: palette.inkMuted,
    marginTop: 2
  },
  cleanBadge: {
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5
  },
  cleanBadgeOk: {
    backgroundColor: '#DCEFE5'
  },
  cleanBadgeDirty: {
    backgroundColor: '#F9DEDA'
  },
  cleanBadgeText: {
    fontFamily: fonts.heading,
    fontSize: 12,
    textTransform: 'uppercase',
    color: palette.ink
  },
  repoActionRow: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    justifyContent: 'flex-end'
  },
  blockTitle: {
    fontFamily: fonts.heading,
    color: palette.ink,
    fontSize: 16,
    marginBottom: spacing.sm
  },
  input: {
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    backgroundColor: palette.canvas,
    fontFamily: fonts.body,
    color: palette.ink
  },
  diffPanel: {
    flex: 1,
    padding: spacing.sm
  },
  diffBox: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#1B3047',
    borderRadius: radii.md,
    backgroundColor: palette.nightSoft
  },
  diffContent: {
    padding: spacing.sm
  },
  diffText: {
    color: '#EAF2FA',
    fontFamily: fonts.mono,
    fontSize: 13,
    lineHeight: 19
  },
  error: {
    color: palette.danger,
    fontFamily: fonts.body,
    paddingHorizontal: 2
  }
});
