import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { HostBridgeApiClient } from '../api/client';
import type {
  Chat,
  GitDiffResponse,
  GitStatusFile,
  GitStatusResponse,
} from '../api/types';
import { useAppTheme, type AppTheme } from '../theme';
import {
  parseUnifiedGitDiff,
  type UnifiedDiffFile,
} from './gitDiff';

interface GitScreenProps {
  api: HostBridgeApiClient;
  chat: Chat;
  onBack: () => void;
  onChatUpdated?: (chat: Chat) => void;
}

export function GitScreen({ api, chat, onBack, onChatUpdated }: GitScreenProps) {
  const theme = useAppTheme();
  const [activeChat, setActiveChat] = useState(chat);
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [diff, setDiff] = useState<GitDiffResponse | null>(null);
  const [commitMessage, setCommitMessage] = useState('chore: checkpoint');
  const [workspaceDraft, setWorkspaceDraft] = useState(chat.cwd ?? '');
  const [loading, setLoading] = useState(true);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [stagingPath, setStagingPath] = useState<string | null>(null);
  const [unstagingPath, setUnstagingPath] = useState<string | null>(null);
  const [stagingAll, setStagingAll] = useState(false);
  const [unstagingAll, setUnstagingAll] = useState(false);
  const [bodyScrollEnabled, setBodyScrollEnabled] = useState(true);
  const [selectedDiffFileId, setSelectedDiffFileId] = useState<string | null>(null);
  const [pendingDiffFileId, setPendingDiffFileId] = useState<string | null>(null);
  const [switchingDiffFile, setSwitchingDiffFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const diffSelectionRequestRef = useRef(0);
  const diffSelectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { height: windowHeight } = useWindowDimensions();
  const styles = useMemo(() => createStyles(theme), [theme]);

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
      const [nextStatus, nextDiff] = await Promise.all([
        api.gitStatus(requestedCwd),
        api.gitDiff(requestedCwd),
      ]);
      setStatus(nextStatus);
      setDiff(nextDiff);
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

  const stageFile = useCallback(
    async (path: string) => {
      if (!path.trim()) {
        return;
      }

      try {
        setStagingPath(path);
        const result = await api.gitStage({
          path,
          cwd: requestedCwd,
        });
        if (!result.staged) {
          setError(result.stderr || `Failed to stage ${path}.`);
        } else {
          setError(null);
        }
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setStagingPath((current) => (current === path ? null : current));
      }
    },
    [api, refresh, requestedCwd]
  );

  const unstageFile = useCallback(
    async (path: string) => {
      if (!path.trim()) {
        return;
      }

      try {
        setUnstagingPath(path);
        const result = await api.gitUnstage({
          path,
          cwd: requestedCwd,
        });
        if (!result.unstaged) {
          setError(result.stderr || `Failed to unstage ${path}.`);
        } else {
          setError(null);
        }
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setUnstagingPath((current) => (current === path ? null : current));
      }
    },
    [api, refresh, requestedCwd]
  );

  const stageAll = useCallback(async () => {
    try {
      setStagingAll(true);
      const result = await api.gitStageAll(requestedCwd);
      if (!result.staged) {
        setError(result.stderr || 'Failed to stage all files.');
      } else {
        setError(null);
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStagingAll(false);
    }
  }, [api, refresh, requestedCwd]);

  const unstageAll = useCallback(async () => {
    try {
      setUnstagingAll(true);
      const result = await api.gitUnstageAll(requestedCwd);
      if (!result.unstaged) {
        setError(result.stderr || 'Failed to unstage all files.');
      } else {
        setError(null);
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUnstagingAll(false);
    }
  }, [api, refresh, requestedCwd]);

  const workspaceChanged = workspaceDraft.trim() !== workspaceCwd;
  const commitWorkspaceIfChanged = useCallback(() => {
    if (!workspaceChanged || !workspaceDraft.trim() || savingWorkspace) {
      return;
    }

    void saveWorkspace();
  }, [saveWorkspace, savingWorkspace, workspaceChanged, workspaceDraft]);

  const changedFiles = useMemo(() => {
    if (status?.files?.length) {
      return status.files.map(mapStatusFileToChangedEntry);
    }
    return parseChangedFiles(status?.raw ?? '');
  }, [status?.files, status?.raw]);
  const parsedDiff = useMemo(
    () => parseUnifiedGitDiff(diff?.diff ?? ''),
    [diff?.diff]
  );
  const diffStatsByPath = useMemo(() => {
    const map = new Map<string, { additions: number; deletions: number }>();
    for (const file of parsedDiff.files) {
      const stats = {
        additions: file.additions,
        deletions: file.deletions,
      };
      const keys = getDiffFileLookupKeys(file);
      for (const key of keys) {
        map.set(key, stats);
      }
    }
    return map;
  }, [parsedDiff.files]);
  const changedFilesWithStats = useMemo(
    () =>
      changedFiles.map((entry) => ({
        ...entry,
        stats: diffStatsByPath.get(entry.path) ?? null,
        diffFileId: findDiffFileIdForEntry(entry, parsedDiff.files),
      })),
    [changedFiles, diffStatsByPath, parsedDiff.files]
  );
  const hasChanges = changedFiles.length > 0;
  const hasStagedFiles = useMemo(
    () => changedFiles.some((entry) => entry.staged),
    [changedFiles]
  );
  const hasUnstagedFiles = useMemo(
    () => changedFiles.some((entry) => entry.unstaged),
    [changedFiles]
  );
  const aheadCount = useMemo(
    () => parseAheadCount(status?.raw ?? ''),
    [status?.raw]
  );
  const hasUpstream = useMemo(
    () => parseHasUpstream(status?.raw ?? ''),
    [status?.raw]
  );
  const canPush = aheadCount > 0;
  const canPublishBranch = !hasUpstream && isPublishableBranch(status?.branch);
  const showPushAction = canPush || canPublishBranch;
  const pushButtonLabel = pushing
    ? canPublishBranch
      ? 'Publishing...'
      : 'Pushing...'
    : canPublishBranch
      ? 'Publish branch'
      : `Push (${aheadCount})`;
  const selectedDiffFile = useMemo(() => {
    if (parsedDiff.files.length === 0) {
      return null;
    }

    return (
      parsedDiff.files.find((file) => file.id === selectedDiffFileId) ??
      parsedDiff.files[0]
    );
  }, [parsedDiff.files, selectedDiffFileId]);
  const diffFileForView = useMemo(() => {
    if (parsedDiff.files.length === 0) {
      return null;
    }

    const targetId = pendingDiffFileId ?? selectedDiffFile?.id ?? parsedDiff.files[0].id;
    return parsedDiff.files.find((file) => file.id === targetId) ?? parsedDiff.files[0];
  }, [parsedDiff.files, pendingDiffFileId, selectedDiffFile]);
  const activeDiffTabId = pendingDiffFileId ?? diffFileForView?.id ?? null;
  const showDiffFileSwitching = switchingDiffFile && Boolean(pendingDiffFileId);
  const filesListMaxHeight = useMemo(() => {
    const proposed = Math.floor(windowHeight * 0.4);
    return Math.max(200, Math.min(360, proposed));
  }, [windowHeight]);
  const diffViewerMaxHeight = useMemo(() => {
    const proposed = Math.floor(windowHeight * 0.5);
    return Math.max(220, Math.min(480, proposed));
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

  useEffect(() => {
    if (stagingPath && !changedFiles.some((entry) => entry.stagePath === stagingPath)) {
      setStagingPath(null);
    }
    if (unstagingPath && !changedFiles.some((entry) => entry.stagePath === unstagingPath)) {
      setUnstagingPath(null);
    }
  }, [changedFiles, stagingPath, unstagingPath]);

  useEffect(() => {
    if (parsedDiff.files.length === 0) {
      if (selectedDiffFileId) {
        setSelectedDiffFileId(null);
      }
      if (pendingDiffFileId) {
        setPendingDiffFileId(null);
      }
      if (switchingDiffFile) {
        setSwitchingDiffFile(false);
      }
      return;
    }

    if (!selectedDiffFileId) {
      setSelectedDiffFileId(parsedDiff.files[0].id);
      return;
    }

    const stillExists = parsedDiff.files.some((file) => file.id === selectedDiffFileId);
    if (!stillExists) {
      setSelectedDiffFileId(parsedDiff.files[0].id);
    }

    if (pendingDiffFileId) {
      const pendingStillExists = parsedDiff.files.some((file) => file.id === pendingDiffFileId);
      if (!pendingStillExists) {
        setPendingDiffFileId(null);
        setSwitchingDiffFile(false);
      }
    }
  }, [parsedDiff.files, pendingDiffFileId, selectedDiffFileId, switchingDiffFile]);

  const selectDiffFile = useCallback(
    (fileId: string) => {
      if (!fileId || fileId === activeDiffTabId) {
        return;
      }

      diffSelectionRequestRef.current += 1;
      const requestId = diffSelectionRequestRef.current;
      setPendingDiffFileId(fileId);
      setSwitchingDiffFile(true);
      if (diffSelectionTimerRef.current) {
        clearTimeout(diffSelectionTimerRef.current);
      }
      diffSelectionTimerRef.current = setTimeout(() => {
        if (diffSelectionRequestRef.current !== requestId) {
          return;
        }

        setSelectedDiffFileId(fileId);
        setSwitchingDiffFile(false);
        setPendingDiffFileId(null);
        diffSelectionTimerRef.current = null;
      }, 120);
    },
    [activeDiffTabId]
  );

  useEffect(() => {
    return () => {
      if (diffSelectionTimerRef.current) {
        clearTimeout(diffSelectionTimerRef.current);
      }
    };
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={8} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={theme.colors.textPrimary} />
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
          <Ionicons name="refresh" size={16} color={theme.colors.textMuted} />
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
            keyboardAppearance={theme.keyboardAppearance}
            onSubmitEditing={commitWorkspaceIfChanged}
            onBlur={commitWorkspaceIfChanged}
            placeholder="/path/to/project"
            placeholderTextColor={theme.colors.textMuted}
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
          <ActivityIndicator color={theme.colors.textPrimary} style={styles.loader} />
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
              {isPublishableBranch(status?.branch) ? (
                <>
                  <View style={styles.separator} />
                  <View style={styles.infoRow}>
                    <Text style={styles.infoLabel}>Published</Text>
                    <Text style={styles.infoValue}>{hasUpstream ? 'Yes' : 'No'}</Text>
                  </View>
                </>
              ) : null}
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
              keyboardAppearance={theme.keyboardAppearance}
              placeholder="Commit message..."
              placeholderTextColor={theme.colors.textMuted}
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

            {showPushAction ? (
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
                  {pushButtonLabel}
                </Text>
              </Pressable>
            ) : null}

            <View style={styles.filesHeaderRow}>
              <Text style={[styles.sectionLabel, styles.sectionLabelResetMargin]}>
                {hasChanges ? `Changed files (${changedFiles.length})` : 'Changed files'}
              </Text>
              {hasChanges ? (
                <View style={styles.filesHeaderActions}>
                  {hasUnstagedFiles ? (
                    <Pressable
                      onPress={() => void stageAll()}
                      disabled={
                        loading ||
                        committing ||
                        pushing ||
                        stagingAll ||
                        unstagingAll ||
                        Boolean(stagingPath) ||
                        Boolean(unstagingPath)
                      }
                      style={({ pressed }) => [
                        styles.bulkActionBtn,
                        styles.bulkActionBtnStage,
                        pressed && styles.fileActionBtnPressed,
                        (loading ||
                          committing ||
                          pushing ||
                          stagingAll ||
                          unstagingAll ||
                          Boolean(stagingPath) ||
                          Boolean(unstagingPath)) &&
                          styles.fileActionBtnDisabled,
                      ]}
                    >
                      <Text style={styles.bulkActionText}>
                        {stagingAll ? 'Staging all...' : 'Stage all'}
                      </Text>
                    </Pressable>
                  ) : null}
                  {hasStagedFiles ? (
                    <Pressable
                      onPress={() => void unstageAll()}
                      disabled={
                        loading ||
                        committing ||
                        pushing ||
                        unstagingAll ||
                        stagingAll ||
                        Boolean(stagingPath) ||
                        Boolean(unstagingPath)
                      }
                      style={({ pressed }) => [
                        styles.bulkActionBtn,
                        styles.bulkActionBtnUnstage,
                        pressed && styles.fileActionBtnPressed,
                        (loading ||
                          committing ||
                          pushing ||
                          unstagingAll ||
                          stagingAll ||
                          Boolean(stagingPath) ||
                          Boolean(unstagingPath)) &&
                          styles.fileActionBtnDisabled,
                      ]}
                    >
                      <Text style={styles.bulkActionText}>
                        {unstagingAll ? 'Unstaging all...' : 'Unstage all'}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
            </View>
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
                  {changedFilesWithStats.map((entry) => (
                    <View key={`${entry.code}:${entry.path}`} style={styles.fileRow}>
                      <Text style={styles.fileCode}>{formatStatusCode(entry.code)}</Text>
                      {entry.diffFileId ? (
                        <Pressable
                          style={styles.filePathPressable}
                          onPress={() => {
                            if (entry.diffFileId) {
                              selectDiffFile(entry.diffFileId);
                            }
                          }}
                          disabled={switchingDiffFile}
                        >
                          <Text
                            style={[
                              styles.filePath,
                              styles.filePathInteractive,
                              switchingDiffFile && styles.filePathDisabled,
                            ]}
                          >
                            {entry.path}
                          </Text>
                        </Pressable>
                      ) : (
                        <Text style={styles.filePath}>
                          {entry.path}
                        </Text>
                      )}
                      {entry.stats ? (
                        <View style={styles.fileStats}>
                          <Text style={styles.fileAdded}>+{entry.stats.additions}</Text>
                          <Text style={styles.fileRemoved}>-{entry.stats.deletions}</Text>
                        </View>
                      ) : null}
                      <View style={styles.fileActions}>
                        {entry.unstaged ? (
                          <Pressable
                            onPress={() => void stageFile(entry.stagePath)}
                            disabled={
                              loading ||
                              committing ||
                              pushing ||
                              stagingAll ||
                              unstagingAll ||
                              stagingPath === entry.stagePath ||
                              unstagingPath === entry.stagePath
                            }
                            style={({ pressed }) => [
                              styles.fileActionBtn,
                              styles.fileActionBtnStage,
                              pressed && styles.fileActionBtnPressed,
                              (loading ||
                                committing ||
                                pushing ||
                                stagingAll ||
                                unstagingAll ||
                                stagingPath === entry.stagePath ||
                                unstagingPath === entry.stagePath) &&
                                styles.fileActionBtnDisabled,
                            ]}
                          >
                            <Text style={styles.fileActionText}>
                              {stagingPath === entry.stagePath ? 'Staging...' : 'Stage'}
                            </Text>
                          </Pressable>
                        ) : null}
                        {entry.staged ? (
                          <Pressable
                            onPress={() => void unstageFile(entry.stagePath)}
                            disabled={
                              loading ||
                              committing ||
                              pushing ||
                              stagingAll ||
                              unstagingAll ||
                              unstagingPath === entry.stagePath ||
                              stagingPath === entry.stagePath
                            }
                            style={({ pressed }) => [
                              styles.fileActionBtn,
                              styles.fileActionBtnUnstage,
                              pressed && styles.fileActionBtnPressed,
                              (loading ||
                                committing ||
                                pushing ||
                                stagingAll ||
                                unstagingAll ||
                                unstagingPath === entry.stagePath ||
                                stagingPath === entry.stagePath) &&
                                styles.fileActionBtnDisabled,
                            ]}
                          >
                            <Text style={styles.fileActionText}>
                              {unstagingPath === entry.stagePath
                                ? 'Unstaging...'
                                : 'Unstage'}
                            </Text>
                          </Pressable>
                        ) : null}
                      </View>
                    </View>
                  ))}
                </ScrollView>
              )}
            </View>

            <Text style={styles.sectionLabel}>Diff summary</Text>
            <View style={styles.diffSummaryRow}>
              <View style={styles.diffSummaryPill}>
                <Text style={styles.diffSummaryLabel}>Files</Text>
                <Text style={styles.diffSummaryValue}>{parsedDiff.files.length}</Text>
              </View>
              <View style={styles.diffSummaryPill}>
                <Text style={styles.diffSummaryLabel}>Added</Text>
                <Text style={[styles.diffSummaryValue, styles.fileAdded]}>
                  +{parsedDiff.totalAdditions}
                </Text>
              </View>
              <View style={styles.diffSummaryPill}>
                <Text style={styles.diffSummaryLabel}>Removed</Text>
                <Text style={[styles.diffSummaryValue, styles.fileRemoved]}>
                  -{parsedDiff.totalDeletions}
                </Text>
              </View>
            </View>

            <Text style={styles.sectionLabel}>Unified diff</Text>
            <View style={styles.diffCard}>
              {parsedDiff.files.length === 0 ? (
                <Text style={styles.emptyFilesText}>
                  {hasChanges
                    ? 'No patch output for current changes yet (likely untracked files only).'
                    : 'No diff to show.'}
                </Text>
              ) : (
                <>
                  <ScrollView
                    horizontal
                    style={styles.diffTabsScroll}
                    contentContainerStyle={styles.diffTabsContent}
                    showsHorizontalScrollIndicator={false}
                    nestedScrollEnabled
                    keyboardShouldPersistTaps="handled"
                    onTouchStart={disableBodyScroll}
                    onTouchCancel={enableBodyScroll}
                    onTouchEnd={enableBodyScroll}
                  >
                    {parsedDiff.files.map((file) => {
                      const selected = file.id === activeDiffTabId;
                      return (
                        <Pressable
                          key={file.id}
                          onPress={() => selectDiffFile(file.id)}
                          style={({ pressed }) => [
                            styles.diffTab,
                            selected && styles.diffTabActive,
                            pressed && styles.diffTabPressed,
                          ]}
                        >
                          <Text style={styles.diffTabTitle}>
                            {file.displayPath}
                          </Text>
                          <View style={styles.diffTabStats}>
                            <Text style={styles.fileAdded}>+{file.additions}</Text>
                            <Text style={styles.fileRemoved}>-{file.deletions}</Text>
                          </View>
                        </Pressable>
                      );
                    })}
                  </ScrollView>

                  {diffFileForView ? (
                    <>
                      <View style={styles.diffFileHeader}>
                        <Text style={styles.diffFilePath}>
                          {diffFileForView.displayPath}
                        </Text>
                        <Text style={styles.diffFileStatus}>{diffFileForView.status}</Text>
                      </View>

                      {showDiffFileSwitching ? (
                        <View style={styles.diffLoadingContainer}>
                          <ActivityIndicator color={theme.colors.textPrimary} size="small" />
                          <Text style={styles.diffLoadingText}>Loading diff…</Text>
                        </View>
                      ) : diffFileForView.hunks.length === 0 ? (
                        <Text style={styles.emptyFilesText}>
                          No textual hunks available for this file.
                        </Text>
                      ) : (
                        <ScrollView
                          style={[styles.diffVerticalScroll, { maxHeight: diffViewerMaxHeight }]}
                          contentContainerStyle={styles.diffVerticalContent}
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
                          <ScrollView
                            horizontal
                            showsHorizontalScrollIndicator
                            nestedScrollEnabled
                            keyboardShouldPersistTaps="handled"
                            onTouchStart={disableBodyScroll}
                            onTouchCancel={enableBodyScroll}
                            onTouchEnd={enableBodyScroll}
                          >
                            <View style={styles.diffLines}>
                              {diffFileForView.hunks.map((hunk) => (
                                <View
                                  key={`${hunk.header}:${hunk.oldStart}:${hunk.newStart}`}
                                  style={styles.hunkBlock}
                                >
                                  <Text style={styles.hunkHeader}>{hunk.header}</Text>
                                  {hunk.lines.map((line, lineIndex) => (
                                    <View
                                      key={`${hunk.header}:${lineIndex}`}
                                      style={[
                                        styles.diffLineRow,
                                        line.kind === 'add' && styles.diffLineRowAdd,
                                        line.kind === 'remove' && styles.diffLineRowRemove,
                                        line.kind === 'meta' && styles.diffLineRowMeta,
                                      ]}
                                    >
                                      <Text style={styles.diffLineNumber}>
                                        {formatDiffLineNumber(line.oldLineNumber)}
                                      </Text>
                                      <Text style={styles.diffLineNumber}>
                                        {formatDiffLineNumber(line.newLineNumber)}
                                      </Text>
                                      <Text
                                        style={[
                                          styles.diffLinePrefix,
                                          line.kind === 'add' && styles.diffLinePrefixAdd,
                                          line.kind === 'remove' && styles.diffLinePrefixRemove,
                                          line.kind === 'meta' && styles.diffLinePrefixMeta,
                                        ]}
                                      >
                                        {line.prefix}
                                      </Text>
                                      <Text selectable style={styles.diffLineText}>
                                        {line.content || ' '}
                                      </Text>
                                    </View>
                                  ))}
                                </View>
                              ))}
                            </View>
                          </ScrollView>
                        </ScrollView>
                      )}
                    </>
                  ) : null}
                </>
              )}
            </View>
          </>
        )}

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bgMain,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderLight,
  },
  backBtn: {
    padding: theme.spacing.xs,
  },
  headerTitles: {
    flex: 1,
  },
  headerTitle: {
    ...theme.typography.headline,
    color: theme.colors.textPrimary,
  },
  headerSubtitle: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
  },
  refreshBtn: {
    padding: theme.spacing.xs,
    borderRadius: theme.radius.full,
  },
  refreshBtnPressed: {
    backgroundColor: theme.colors.bgItem,
  },
  refreshBtnDisabled: {
    opacity: 0.4,
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    padding: theme.spacing.lg,
    gap: theme.spacing.md,
  },
  loader: {
    marginTop: theme.spacing.lg,
  },
  card: {
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    padding: theme.spacing.md,
    backgroundColor: theme.colors.bgItem,
    gap: theme.spacing.sm,
  },
  sectionLabel: {
    ...theme.typography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
    marginTop: theme.spacing.sm,
    marginBottom: theme.spacing.xs,
  },
  sectionLabelResetMargin: {
    marginTop: 0,
    marginBottom: 0,
  },
  input: {
    backgroundColor: theme.colors.bgInput,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    color: theme.colors.textPrimary,
    fontSize: 15,
  },
  actionBtn: {
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.md,
    paddingVertical: theme.spacing.md,
    alignItems: 'center',
    marginTop: theme.spacing.sm,
  },
  actionBtnPressed: {
    backgroundColor: theme.colors.accentPressed,
  },
  actionBtnDisabled: {
    backgroundColor: theme.colors.bgInput,
    opacity: 0.6,
  },
  pushBtn: {
    marginTop: theme.spacing.xs,
  },
  actionBtnText: {
    ...theme.typography.headline,
    color: theme.colors.accentText,
    fontSize: 15,
  },
  metaText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
  },
  warningText: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: theme.spacing.sm,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.borderLight,
  },
  infoLabel: {
    ...theme.typography.body,
    color: theme.colors.textMuted,
  },
  infoValue: {
    ...theme.typography.body,
    fontWeight: '600',
    color: theme.colors.textPrimary,
  },
  clean: {
    color: theme.colors.statusComplete,
  },
  dirty: {
    color: theme.colors.statusError,
  },
  filesCard: {
    backgroundColor: theme.colors.bgItem,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    overflow: 'hidden',
  },
  filesHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.sm,
  },
  filesHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  filesScroll: {
    minHeight: 56,
  },
  filesScrollContent: {
    paddingVertical: theme.spacing.xs,
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderLight,
  },
  fileCode: {
    ...theme.typography.mono,
    color: theme.colors.textMuted,
    width: 24,
    fontSize: 12,
    lineHeight: 18,
  },
  filePath: {
    ...theme.typography.body,
    color: theme.colors.textSecondary,
    flex: 1,
    flexShrink: 1,
    lineHeight: 18,
  },
  filePathPressable: {
    flex: 1,
  },
  filePathInteractive: {
    color: theme.colors.textPrimary,
  },
  filePathDisabled: {
    opacity: 0.6,
  },
  fileStats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    marginLeft: theme.spacing.sm,
  },
  fileActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    marginLeft: theme.spacing.sm,
  },
  fileActionBtn: {
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 6,
  },
  fileActionBtnStage: {
    borderColor: 'rgba(136, 218, 149, 0.45)',
    backgroundColor: 'rgba(86, 182, 92, 0.16)',
  },
  fileActionBtnUnstage: {
    borderColor: 'rgba(242, 155, 155, 0.45)',
    backgroundColor: 'rgba(239, 68, 68, 0.16)',
  },
  fileActionBtnPressed: {
    opacity: 0.8,
  },
  fileActionBtnDisabled: {
    opacity: 0.55,
  },
  fileActionText: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '600',
  },
  bulkActionBtn: {
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 7,
  },
  bulkActionBtnStage: {
    borderColor: 'rgba(136, 218, 149, 0.5)',
    backgroundColor: 'rgba(86, 182, 92, 0.2)',
  },
  bulkActionBtnUnstage: {
    borderColor: 'rgba(242, 155, 155, 0.5)',
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
  },
  bulkActionText: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '600',
  },
  fileAdded: {
    ...theme.typography.mono,
    color: '#88DA95',
    fontSize: 12,
  },
  fileRemoved: {
    ...theme.typography.mono,
    color: '#F29B9B',
    fontSize: 12,
  },
  diffSummaryRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  diffSummaryPill: {
    flex: 1,
    backgroundColor: theme.colors.bgItem,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    gap: 2,
  },
  diffSummaryLabel: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
  },
  diffSummaryValue: {
    ...theme.typography.body,
    fontWeight: '700',
    color: theme.colors.textPrimary,
  },
  diffCard: {
    backgroundColor: theme.colors.bgItem,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    overflow: 'hidden',
  },
  diffTabsScroll: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderLight,
  },
  diffTabsContent: {
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  diffTab: {
    minWidth: 140,
    maxWidth: 220,
    backgroundColor: theme.colors.bgInput,
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    gap: theme.spacing.xs,
  },
  diffTabActive: {
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.bgItem,
  },
  diffTabPressed: {
    opacity: 0.85,
  },
  diffTabTitle: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    flexShrink: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  diffTabStats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  diffFileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderLight,
  },
  diffFilePath: {
    ...theme.typography.body,
    color: theme.colors.textSecondary,
    flex: 1,
    flexShrink: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  diffFileStatus: {
    ...theme.typography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: theme.colors.textMuted,
  },
  diffLoadingContainer: {
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  diffLoadingText: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
  },
  diffVerticalScroll: {
    minHeight: 120,
  },
  diffVerticalContent: {
    paddingVertical: theme.spacing.sm,
  },
  diffLines: {
    minWidth: '100%',
  },
  hunkBlock: {
    marginBottom: theme.spacing.sm,
  },
  hunkHeader: {
    ...theme.typography.mono,
    color: '#AFC6F7',
    backgroundColor: 'rgba(175, 198, 247, 0.14)',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderLight,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderLight,
  },
  diffLineRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    minWidth: '100%',
  },
  diffLineRowAdd: {
    backgroundColor: 'rgba(86, 182, 92, 0.14)',
  },
  diffLineRowRemove: {
    backgroundColor: 'rgba(239, 68, 68, 0.14)',
  },
  diffLineRowMeta: {
    backgroundColor: theme.colors.bgCanvasAccent,
  },
  diffLineNumber: {
    ...theme.typography.mono,
    width: 44,
    textAlign: 'right',
    color: theme.colors.textMuted,
    paddingHorizontal: theme.spacing.xs,
    paddingVertical: 3,
    fontSize: 11,
    lineHeight: 17,
  },
  diffLinePrefix: {
    ...theme.typography.mono,
    width: 16,
    color: theme.colors.textMuted,
    paddingVertical: 3,
    fontSize: 11,
    lineHeight: 17,
  },
  diffLinePrefixAdd: {
    color: '#88DA95',
  },
  diffLinePrefixRemove: {
    color: '#F29B9B',
  },
  diffLinePrefixMeta: {
    color: '#B8C4D8',
  },
  diffLineText: {
    ...theme.typography.mono,
    color: theme.colors.textPrimary,
    paddingRight: theme.spacing.md,
    paddingVertical: 3,
    fontSize: 12,
    lineHeight: 17,
  },
  emptyFilesText: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  errorText: {
    ...theme.typography.caption,
    color: theme.colors.error,
    marginTop: theme.spacing.xs,
  },
});

interface ChangedFileEntry {
  code: string;
  path: string;
  stagePath: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
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

    const indexStatus = line[0] ?? ' ';
    const worktreeStatus = line[1] ?? ' ';
    const code = `${indexStatus}${worktreeStatus}`;
    const path = line.slice(3).trim();
    if (!path) {
      continue;
    }

    const stagePath = extractStagePath(path);
    const untracked = code === '??';
    const staged = !untracked && indexStatus !== ' ';
    const unstaged = untracked || worktreeStatus !== ' ';

    files.push({
      code,
      path,
      stagePath,
      staged,
      unstaged,
      untracked,
    });
  }

  return files;
}

function mapStatusFileToChangedEntry(file: GitStatusFile): ChangedFileEntry {
  const displayPath = file.originalPath ? `${file.originalPath} -> ${file.path}` : file.path;
  return {
    code: `${file.indexStatus}${file.worktreeStatus}`,
    path: displayPath,
    stagePath: file.path,
    staged: file.staged,
    unstaged: file.unstaged,
    untracked: file.untracked,
  };
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

function parseHasUpstream(rawStatus: string): boolean {
  const header = rawStatus
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('## '));
  return header?.includes('...') ?? false;
}

function isPublishableBranch(branch: string | null | undefined): boolean {
  const normalized = branch?.trim();
  return Boolean(normalized && normalized !== 'unknown' && !normalized.startsWith('HEAD'));
}

function formatDiffLineNumber(value: number | null): string {
  if (value === null || value <= 0) {
    return '';
  }
  return String(value);
}

function formatStatusCode(code: string): string {
  if (!code) {
    return '??';
  }
  if (code === '??') {
    return code;
  }

  const normalized = code.replace(/ /g, '·');
  return normalized.trim() ? normalized : '··';
}

function getDiffFileLookupKeys(file: UnifiedDiffFile): string[] {
  const keys = [file.displayPath, file.oldPath, file.newPath].filter(
    (value): value is string => Boolean(value)
  );
  return Array.from(new Set(keys));
}

function findDiffFileIdForEntry(
  entry: Pick<ChangedFileEntry, 'path' | 'stagePath'>,
  files: UnifiedDiffFile[]
): string | null {
  if (files.length === 0) {
    return null;
  }

  const lookupCandidates = new Set<string>([entry.path, entry.stagePath]);
  for (const file of files) {
    const keys = getDiffFileLookupKeys(file);
    if (keys.some((key) => lookupCandidates.has(key))) {
      return file.id;
    }
  }

  return null;
}

function extractStagePath(path: string): string {
  const parts = path.split(' -> ');
  const candidate = parts[parts.length - 1]?.trim() ?? path.trim();
  return candidate || path.trim();
}
