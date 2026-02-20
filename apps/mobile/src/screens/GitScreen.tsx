import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { MacBridgeApiClient } from '../api/client';
import type { GitStatusResponse } from '../api/types';
import { colors, radius, spacing, typography } from '../theme';

interface GitScreenProps {
  api: MacBridgeApiClient;
  onOpenDrawer: () => void;
}

export function GitScreen({ api, onOpenDrawer }: GitScreenProps) {
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [diff, setDiff] = useState('');
  const [commitMessage, setCommitMessage] = useState('chore: checkpoint');
  const [loading, setLoading] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const [s, d] = await Promise.all([api.gitStatus(), api.gitDiff()]);
      setStatus(s);
      setDiff(d.diff);
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
      if (!result.committed) setError(result.stderr || 'Commit failed.');
      else setError(null);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCommitting(false);
    }
  }, [api, commitMessage, refresh]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onOpenDrawer} hitSlop={8} style={styles.menuBtn}>
          <Ionicons name="menu" size={22} color={colors.textMuted} />
        </Pressable>
        <Ionicons name="git-branch" size={16} color={colors.textMuted} />
        <Text style={styles.headerTitle}>Git</Text>
        <Pressable onPress={() => void refresh()} hitSlop={8} style={styles.refreshBtn}>
          <Ionicons name="refresh" size={16} color={colors.textMuted} />
        </Pressable>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.textMuted} style={styles.loader} />
      ) : (
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Branch</Text>
            <Text style={styles.infoValue}>{status?.branch ?? '—'}</Text>
          </View>
          <View style={[styles.infoRow, styles.infoRowBorder]}>
            <Text style={styles.infoLabel}>Status</Text>
            <Text style={[styles.infoValue, status?.clean ? styles.clean : styles.dirty]}>
              {status?.clean ? 'clean' : 'changes'}
            </Text>
          </View>

          <Text style={styles.sectionLabel}>Commit message</Text>
          <TextInput
            style={styles.input}
            value={commitMessage}
            onChangeText={setCommitMessage}
            placeholder="Commit message..."
            placeholderTextColor={colors.textMuted}
          />
          <Pressable
            onPress={() => void commit()}
            disabled={committing || !commitMessage.trim()}
            style={({ pressed }) => [
              styles.commitBtn,
              pressed && styles.commitBtnPressed,
              (committing || !commitMessage.trim()) && styles.commitBtnDisabled,
            ]}
          >
            <Text style={styles.commitBtnText}>
              {committing ? 'Committing…' : 'Commit'}
            </Text>
          </Pressable>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <Text style={styles.sectionLabel}>Diff</Text>
          <ScrollView
            style={styles.diffBox}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            <Text selectable style={styles.diffText}>
              {diff || 'No changes.'}
            </Text>
          </ScrollView>
        </ScrollView>
      )}
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
  headerTitle: { ...typography.headline, flex: 1 },
  refreshBtn: { marginLeft: 'auto' },
  loader: { marginTop: spacing.xxl },
  body: { flex: 1 },
  bodyContent: { padding: spacing.lg, gap: spacing.md },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  infoRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  infoLabel: { ...typography.body, color: colors.textMuted },
  infoValue: { ...typography.body },
  clean: { color: colors.statusComplete },
  dirty: { color: colors.statusError },
  sectionLabel: {
    ...typography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: spacing.md,
  },
  input: {
    backgroundColor: colors.bgSidebar,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    color: colors.textPrimary,
    fontSize: 14,
  },
  commitBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
  },
  commitBtnPressed: { backgroundColor: colors.accentPressed },
  commitBtnDisabled: { backgroundColor: colors.bgItem },
  commitBtnText: { ...typography.headline, color: colors.white, fontSize: 14 },
  errorText: { ...typography.caption, color: colors.error },
  diffBox: {
    backgroundColor: colors.bgSidebar,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    maxHeight: 300,
  },
  diffText: { ...typography.mono },
});
