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
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';

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
    <View style={styles.container}>
      <LinearGradient
        colors={['#0F0C29', '#302B63', '#05050A']}
        style={StyleSheet.absoluteFill}
      />
      <SafeAreaView style={styles.safeArea}>
        <BlurView intensity={80} tint="dark" style={styles.header}>
          <Pressable onPress={onOpenDrawer} hitSlop={8} style={styles.menuBtn}>
            <Ionicons name="menu" size={22} color={colors.textPrimary} />
          </Pressable>
          <Ionicons name="git-branch" size={16} color={colors.textPrimary} />
          <Text style={styles.headerTitle}>Git</Text>
          <Pressable onPress={() => void refresh()} hitSlop={8} style={styles.refreshBtn}>
            <Ionicons name="refresh" size={16} color={colors.textPrimary} />
          </Pressable>
        </BlurView>

        {
          loading ? (
            <ActivityIndicator color={colors.textPrimary} style={styles.loader} />
          ) : (
            <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
              <BlurView intensity={50} tint="dark" style={styles.card}>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Branch</Text>
                  <Text style={styles.infoValue}>{status?.branch ?? '—'}</Text>
                </View>
                <View style={styles.separator} />
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Status</Text>
                  <Text style={[styles.infoValue, status?.clean ? styles.clean : styles.dirty]}>
                    {status?.clean ? 'clean' : 'changes'}
                  </Text>
                </View>
              </BlurView>

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
          )
        }
      </SafeAreaView >
    </View >
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgMain },
  safeArea: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderHighlight,
  },
  menuBtn: { padding: spacing.xs },
  headerTitle: { ...typography.headline, flex: 1, color: colors.textPrimary },
  refreshBtn: { marginLeft: 'auto' },
  loader: { marginTop: spacing.xxl },
  body: { flex: 1 },
  bodyContent: { padding: spacing.lg, gap: spacing.md },
  card: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHighlight,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.xs,
    overflow: 'hidden',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: spacing.xs,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
  },
  infoLabel: { ...typography.body, color: colors.textMuted },
  infoValue: { ...typography.body, fontWeight: '600', color: colors.textPrimary },
  clean: { color: colors.statusComplete },
  dirty: { color: colors.statusError },
  sectionLabel: {
    ...typography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  input: {
    backgroundColor: colors.bgInput,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    color: colors.textPrimary,
    fontSize: 15,
  },
  commitBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.md,
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  commitBtnPressed: { backgroundColor: colors.accentPressed },
  commitBtnDisabled: { backgroundColor: colors.bgSidebar, shadowOpacity: 0 },
  commitBtnText: { ...typography.headline, color: colors.white, fontSize: 15 },
  errorText: { ...typography.caption, color: colors.error },
  diffBox: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHighlight,
    padding: spacing.md,
    maxHeight: 350,
  },
  diffText: { ...typography.mono, color: '#A1A1AA', fontSize: 13, lineHeight: 20 },
});
