import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import type { MacBridgeApiClient } from '../api/client';
import type { Chat, GitStatusResponse } from '../api/types';
import { colors, radius, spacing, typography } from '../theme';

interface GitScreenProps {
  api: MacBridgeApiClient;
  chat: Chat;
  onBack: () => void;
  onChatUpdated?: (chat: Chat) => void;
}

export function GitScreen({ api, chat, onBack, onChatUpdated }: GitScreenProps) {
  const [activeChat, setActiveChat] = useState(chat);
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [commitMessage, setCommitMessage] = useState('chore: checkpoint');
  const [workspaceDraft, setWorkspaceDraft] = useState(chat.cwd ?? '');
  const [loading, setLoading] = useState(true);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [bodyScrollEnabled, setBodyScrollEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { height: windowHeight } = useWindowDimensions();

  useEffect(() => {
    setActiveChat(chat);
    setWorkspaceDraft(chat.cwd ?? '');
    setError(null);
  }, [chat]);

  const workspaceCwd = useMemo(
    () => activeChat.cwd?.trim() ?? '',
    [activeChat.cwd]
  );
  const requestedCwd = useMemo(() => {
    const draft = workspaceDraft.trim();
    if (draft.length > 0) {
      return draft;
    }
    return workspaceCwd.length > 0 ? workspaceCwd : undefined;
  }, [workspaceCwd, workspaceDraft]);
  const hasWorkspace = Boolean(requestedCwd);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const nextStatus = await api.gitStatus(requestedCwd);
      setStatus(nextStatus);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [api, requestedCwd]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const saveWorkspace = useCallback(async () => {
    const nextWorkspace = workspaceDraft.trim();
    if (!nextWorkspace || savingWorkspace) {
      return;
    }

    try {
      setSavingWorkspace(true);
      const updated = await api.setChatWorkspace(activeChat.id, nextWorkspace);
      setActiveChat(updated);
      setWorkspaceDraft(updated.cwd ?? nextWorkspace);
      setError(null);
      onChatUpdated?.(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingWorkspace(false);
    }
  }, [activeChat.id, api, onChatUpdated, savingWorkspace, workspaceDraft]);

  const commit = useCallback(async () => {
    const trimmedMessage = commitMessage.trim();
    if (!trimmedMessage) {
      return;
    }

    try {
      setCommitting(true);
      const result = await api.gitCommit({
        message: trimmedMessage,
        cwd: requestedCwd,
      });
      if (!result.committed) {
        setError(result.stderr || 'Commit failed.');
      } else {
        setError(null);
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCommitting(false);
    }
  }, [api, commitMessage, refresh, requestedCwd]);

  const push = useCallback(async () => {
    try {
      setPushing(true);
      const result = await api.gitPush(requestedCwd);
      if (!result.pushed) {
        setError(result.stderr || 'Push failed.');
      } else {
        setError(null);
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPushing(false);
    }
  }, [api, refresh, requestedCwd]);

  const workspaceChanged = workspaceDraft.trim() !== workspaceCwd;
  const commitWorkspaceIfChanged = useCallback(() => {
    if (!workspaceChanged || !workspaceDraft.trim() || savingWorkspace) {
      return;
    }

    void saveWorkspace();
  }, [saveWorkspace, savingWorkspace, workspaceChanged, workspaceDraft]);

  const changedFiles = useMemo(
    () => parseChangedFiles(status?.raw ?? ''),
    [status?.raw]
  );
  const hasChanges = changedFiles.length > 0;
  const aheadCount = useMemo(
    () => parseAheadCount(status?.raw ?? ''),
    [status?.raw]
  );
  const canPush = aheadCount > 0;
  const filesListMaxHeight = useMemo(() => {
    const proposed = Math.floor(windowHeight * 0.4);
    return Math.max(200, Math.min(360, proposed));
  }, [windowHeight]);

  const disableBodyScroll = useCallback(() => {
    setBodyScrollEnabled((previous) => (previous ? false : previous));
  }, []);

  const enableBodyScroll = useCallback(() => {
    setBodyScrollEnabled((previous) => (previous ? previous : true));
  }, []);

  useEffect(() => {
    if ((loading || !hasChanges) && !bodyScrollEnabled) {
      setBodyScrollEnabled(true);
    }
  }, [bodyScrollEnabled, hasChanges, loading]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.textPrimary} />
        </Pressable>
        <View style={styles.headerTitles}>
          <Text style={styles.headerTitle}>Git</Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {activeChat.title || 'Untitled chat'}
          </Text>
        </View>
        <Pressable
          onPress={() => void refresh()}
          hitSlop={8}
          style={({ pressed }) => [
            styles.refreshBtn,
            pressed && styles.refreshBtnPressed,
            loading && styles.refreshBtnDisabled,
          ]}
          disabled={loading}
        >
          <Ionicons name="refresh" size={16} color={colors.textMuted} />
        </Pressable>
      </View>

      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        scrollEnabled={bodyScrollEnabled}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>Workspace</Text>
          <TextInput
            style={styles.input}
            value={workspaceDraft}
            onChangeText={setWorkspaceDraft}
            onSubmitEditing={commitWorkspaceIfChanged}
            onBlur={commitWorkspaceIfChanged}
            placeholder="/path/to/project"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            editable={!savingWorkspace}
          />

          {hasWorkspace ? (
            <Text style={styles.metaText}>{requestedCwd}</Text>
          ) : (
            <Text style={styles.warningText}>Using bridge root workspace.</Text>
          )}
          {savingWorkspace ? (
            <Text style={styles.metaText}>Saving workspace...</Text>
          ) : null}
        </View>

        {loading ? (
          <ActivityIndicator color={colors.textPrimary} style={styles.loader} />
        ) : (
          <>
            <View style={styles.card}>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Branch</Text>
                <Text style={styles.infoValue}>{status?.branch ?? '—'}</Text>
              </View>
              <View style={styles.separator} />
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Status</Text>
                <Text
                  style={[styles.infoValue, status?.clean ? styles.clean : styles.dirty]}
                >
                  {status?.clean ? 'clean' : 'changes'}
                </Text>
              </View>
              {canPush ? (
                <>
                  <View style={styles.separator} />
                  <View style={styles.infoRow}>
                    <Text style={styles.infoLabel}>Ahead</Text>
                    <Text style={styles.infoValue}>{aheadCount}</Text>
                  </View>
                </>
              ) : null}
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
              disabled={committing || !commitMessage.trim() || !hasChanges}
              style={({ pressed }) => [
                styles.actionBtn,
                pressed && styles.actionBtnPressed,
                (committing || !commitMessage.trim() || !hasChanges) &&
                  styles.actionBtnDisabled,
              ]}
            >
              <Text style={styles.actionBtnText}>
                {committing ? 'Committing...' : 'Commit'}
              </Text>
            </Pressable>

            {canPush ? (
              <Pressable
                onPress={() => void push()}
                disabled={pushing || committing || loading}
                style={({ pressed }) => [
                  styles.actionBtn,
                  styles.pushBtn,
                  pressed && styles.actionBtnPressed,
                  (pushing || committing || loading) && styles.actionBtnDisabled,
                ]}
              >
                <Text style={styles.actionBtnText}>
                  {pushing ? 'Pushing...' : `Push (${aheadCount})`}
                </Text>
              </Pressable>
            ) : null}

            <Text style={styles.sectionLabel}>
              {hasChanges ? `Changed files (${changedFiles.length})` : 'Changed files'}
            </Text>
            <View style={styles.filesCard}>
              {changedFiles.length === 0 ? (
                <Text style={styles.emptyFilesText}>No changes.</Text>
              ) : (
                <ScrollView
                  style={[styles.filesScroll, { maxHeight: filesListMaxHeight }]}
                  contentContainerStyle={styles.filesScrollContent}
                  showsVerticalScrollIndicator
                  nestedScrollEnabled
                  keyboardShouldPersistTaps="handled"
                  onTouchStart={disableBodyScroll}
                  onTouchCancel={enableBodyScroll}
                  onTouchEnd={enableBodyScroll}
                  onScrollBeginDrag={disableBodyScroll}
                  onScrollEndDrag={enableBodyScroll}
                  onMomentumScrollEnd={enableBodyScroll}
                >
                  {changedFiles.map((entry) => (
                    <View key={`${entry.code}:${entry.path}`} style={styles.fileRow}>
                      <Text style={styles.fileCode}>{entry.code}</Text>
                      <Text style={styles.filePath} numberOfLines={2}>
                        {entry.path}
                      </Text>
                    </View>
                  ))}
                </ScrollView>
              )}
            </View>
          </>
        )}

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgMain,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderLight,
  },
  backBtn: {
    padding: spacing.xs,
  },
  headerTitles: {
    flex: 1,
  },
  headerTitle: {
    ...typography.headline,
    color: colors.textPrimary,
  },
  headerSubtitle: {
    ...typography.caption,
    color: colors.textMuted,
  },
  refreshBtn: {
    padding: spacing.xs,
    borderRadius: radius.full,
  },
  refreshBtnPressed: {
    backgroundColor: colors.bgItem,
  },
  refreshBtnDisabled: {
    opacity: 0.4,
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  loader: {
    marginTop: spacing.lg,
  },
  card: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    padding: spacing.md,
    backgroundColor: colors.bgItem,
    gap: spacing.sm,
  },
  sectionLabel: {
    ...typography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
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
  actionBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  actionBtnPressed: {
    backgroundColor: colors.accentPressed,
  },
  actionBtnDisabled: {
    backgroundColor: colors.bgInput,
    opacity: 0.6,
  },
  pushBtn: {
    marginTop: spacing.xs,
  },
  actionBtnText: {
    ...typography.headline,
    color: colors.black,
    fontSize: 15,
  },
  metaText: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  warningText: {
    ...typography.caption,
    color: colors.textMuted,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderLight,
  },
  infoLabel: {
    ...typography.body,
    color: colors.textMuted,
  },
  infoValue: {
    ...typography.body,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  clean: {
    color: colors.statusComplete,
  },
  dirty: {
    color: colors.statusError,
  },
  filesCard: {
    backgroundColor: colors.bgItem,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    overflow: 'hidden',
  },
  filesScroll: {
    minHeight: 56,
  },
  filesScrollContent: {
    paddingVertical: spacing.xs,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
  },
  fileCode: {
    ...typography.mono,
    color: colors.textMuted,
    width: 24,
    fontSize: 12,
    lineHeight: 18,
  },
  filePath: {
    ...typography.body,
    color: colors.textSecondary,
    flex: 1,
    lineHeight: 18,
  },
  emptyFilesText: {
    ...typography.caption,
    color: colors.textMuted,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  errorText: {
    ...typography.caption,
    color: colors.error,
    marginTop: spacing.xs,
  },
});

interface ChangedFileEntry {
  code: string;
  path: string;
}

function parseChangedFiles(rawStatus: string): ChangedFileEntry[] {
  const lines = rawStatus
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);

  const files: ChangedFileEntry[] = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      continue;
    }

    if (line.length < 3) {
      continue;
    }

    const code = line.slice(0, 2).trim() || line.slice(0, 2);
    const path = line.slice(3).trim();
    if (!path) {
      continue;
    }

    files.push({
      code,
      path,
    });
  }

  return files;
}

function parseAheadCount(rawStatus: string): number {
  const header = rawStatus
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('## '));
  if (!header) {
    return 0;
  }

  const match = header.match(/\bahead\s+(\d+)\b/i);
  if (!match) {
    return 0;
  }

  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
