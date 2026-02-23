import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

import type { HostBridgeApiClient } from '../api/client';
import type {
  Chat,
  GitDiffResponse,
  GitStatusFile,
  GitStatusResponse,
} from '../api/types';
import { colors, radius, spacing, typography } from '../theme';
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
  const canPush = aheadCount > 0;
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
                          <ActivityIndicator color={colors.textPrimary} size="small" />
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
  sectionLabelResetMargin: {
    marginTop: 0,
    marginBottom: 0,
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
  filesHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  filesHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
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
    flexShrink: 1,
    lineHeight: 18,
  },
  filePathPressable: {
    flex: 1,
  },
  filePathInteractive: {
    color: colors.textPrimary,
  },
  filePathDisabled: {
    opacity: 0.6,
  },
  fileStats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginLeft: spacing.sm,
  },
  fileActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginLeft: spacing.sm,
  },
  fileActionBtn: {
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
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
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  bulkActionBtn: {
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
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
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  fileAdded: {
    ...typography.mono,
    color: '#88DA95',
    fontSize: 12,
  },
  fileRemoved: {
    ...typography.mono,
    color: '#F29B9B',
    fontSize: 12,
  },
  diffSummaryRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  diffSummaryPill: {
    flex: 1,
    backgroundColor: colors.bgItem,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: 2,
  },
  diffSummaryLabel: {
    ...typography.caption,
    color: colors.textMuted,
  },
  diffSummaryValue: {
    ...typography.body,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  diffCard: {
    backgroundColor: colors.bgItem,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    overflow: 'hidden',
  },
  diffTabsScroll: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderLight,
  },
  diffTabsContent: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  diffTab: {
    minWidth: 140,
    maxWidth: 220,
    backgroundColor: colors.bgInput,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  diffTabActive: {
    borderColor: colors.borderHighlight,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
  },
  diffTabPressed: {
    opacity: 0.85,
  },
  diffTabTitle: {
    ...typography.body,
    color: colors.textPrimary,
    flexShrink: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  diffTabStats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  diffFileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderLight,
  },
  diffFilePath: {
    ...typography.body,
    color: colors.textSecondary,
    flex: 1,
    flexShrink: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  diffFileStatus: {
    ...typography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: colors.textMuted,
  },
  diffLoadingContainer: {
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.lg,
    gap: spacing.sm,
  },
  diffLoadingText: {
    ...typography.caption,
    color: colors.textMuted,
  },
  diffVerticalScroll: {
    minHeight: 120,
  },
  diffVerticalContent: {
    paddingVertical: spacing.sm,
  },
  diffLines: {
    minWidth: '100%',
  },
  hunkBlock: {
    marginBottom: spacing.sm,
  },
  hunkHeader: {
    ...typography.mono,
    color: '#AFC6F7',
    backgroundColor: 'rgba(175, 198, 247, 0.14)',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderLight,
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
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  diffLineNumber: {
    ...typography.mono,
    width: 44,
    textAlign: 'right',
    color: colors.textMuted,
    paddingHorizontal: spacing.xs,
    paddingVertical: 3,
    fontSize: 11,
    lineHeight: 17,
  },
  diffLinePrefix: {
    ...typography.mono,
    width: 16,
    color: colors.textMuted,
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
    ...typography.mono,
    color: colors.textPrimary,
    paddingRight: spacing.md,
    paddingVertical: 3,
    fontSize: 12,
    lineHeight: 17,
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
