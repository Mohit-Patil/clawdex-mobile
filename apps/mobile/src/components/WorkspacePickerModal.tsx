import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { FileSystemEntry, WorkspaceSummary } from '../api/types';
import { useAppTheme, type AppTheme } from '../theme';

interface WorkspacePickerModalProps {
  visible: boolean;
  selectedPath?: string | null;
  bridgeRoot?: string | null;
  recentWorkspaces: WorkspaceSummary[];
  favoriteWorkspacePaths?: string[];
  currentPath?: string | null;
  parentPath?: string | null;
  entries: FileSystemEntry[];
  loadingEntries?: boolean;
  error?: string | null;
  onBrowsePath: (path: string | null) => void;
  onSelectPath: (path: string | null) => void;
  onToggleFavorite?: (path: string | null) => void;
  actionLabel?: string | null;
  actionDescription?: string | null;
  actionDisabled?: boolean;
  onActionPress?: (path: string | null) => void;
  onClose: () => void;
}

const ENTRY_ROW_HEIGHT = 48;
type IoniconName = keyof typeof Ionicons.glyphMap;

export function WorkspacePickerModal({
  visible,
  selectedPath = null,
  bridgeRoot = null,
  recentWorkspaces,
  favoriteWorkspacePaths = [],
  currentPath = null,
  parentPath = null,
  entries,
  loadingEntries = false,
  error = null,
  onBrowsePath,
  onSelectPath,
  onToggleFavorite,
  actionLabel = null,
  actionDescription = null,
  actionDisabled = false,
  onActionPress,
  onClose,
}: WorkspacePickerModalProps) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [searchQuery, setSearchQuery] = useState('');
  const [pendingSelectionPath, setPendingSelectionPath] = useState<string | null>(
    selectedPath ?? currentPath ?? bridgeRoot
  );
  const wasVisibleRef = useRef(false);
  const previousSelectedPathRef = useRef<string | null>(selectedPath);
  const styles = useMemo(() => createStyles(theme), [theme]);
  const topInset = Math.max(insets.top + theme.spacing.lg, 72);
  const bottomInset = Math.max(insets.bottom + theme.spacing.lg, 72);
  const cardHeight = Math.min(
    Math.max(560, Math.round(windowHeight * 0.82)),
    windowHeight - topInset - bottomInset
  );

  useEffect(() => {
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = visible;

    if (!visible) {
      setSearchQuery('');
      return;
    }

    if (!wasVisible) {
      setPendingSelectionPath(selectedPath ?? currentPath ?? bridgeRoot);
    }
  }, [bridgeRoot, currentPath, selectedPath, visible]);

  useEffect(() => {
    if (!visible || pendingSelectionPath !== null) {
      return;
    }
    const fallbackPath = selectedPath ?? currentPath ?? bridgeRoot;
    if (fallbackPath) {
      setPendingSelectionPath(fallbackPath);
    }
  }, [bridgeRoot, currentPath, pendingSelectionPath, selectedPath, visible]);

  useEffect(() => {
    const previousSelectedPath = previousSelectedPathRef.current;
    previousSelectedPathRef.current = selectedPath;

    if (!visible || previousSelectedPath === selectedPath) {
      return;
    }

    setPendingSelectionPath((current) => {
      if (current !== previousSelectedPath) {
        return current;
      }
      return selectedPath ?? currentPath ?? bridgeRoot ?? null;
    });
  }, [bridgeRoot, currentPath, selectedPath, visible]);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const favoritePathSet = useMemo(
    () => new Set(favoriteWorkspacePaths),
    [favoriteWorkspacePaths]
  );
  const recentWorkspaceByPath = useMemo(() => {
    const map = new Map<string, WorkspaceSummary>();
    for (const workspace of recentWorkspaces) {
      map.set(workspace.path, workspace);
    }
    return map;
  }, [recentWorkspaces]);
  const favoriteWorkspaces = favoriteWorkspacePaths
    .map((path) => recentWorkspaceByPath.get(path) ?? { path, chatCount: 0 })
    .filter((workspace) =>
      matchesSearch([workspace.path, toPathBasename(workspace.path)], normalizedSearch)
    );

  const filteredEntries = entries.filter((entry) =>
    matchesSearch([entry.name, entry.path], normalizedSearch)
  );
  const footerPath = pendingSelectionPath ?? currentPath ?? bridgeRoot ?? null;
  const footerTitle = footerPath ? toPathBasename(footerPath) : 'Default workspace';
  const footerSubtitle = footerPath ?? 'Bridge default workspace';
  const footerIsFavorite = footerPath ? favoritePathSet.has(footerPath) : false;
  const currentFolderPath = currentPath ?? bridgeRoot ?? null;
  const currentFolderTitle = currentFolderPath ? toPathBasename(currentFolderPath) : 'Loading';
  const hasFavoriteWorkspaces = favoriteWorkspaces.length > 0;
  const compactFavoriteWorkspaces = favoriteWorkspaces.slice(0, 4);
  const hasVisibleEntries = filteredEntries.length > 0;

  const handleBrowsePath = (path: string | null) => {
    setPendingSelectionPath(path);
    onBrowsePath(path);
  };

  const handleActionPress = () => {
    onActionPress?.(pendingSelectionPath ?? currentPath ?? bridgeRoot);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      presentationStyle="overFullScreen"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.outer, { paddingTop: topInset, paddingBottom: bottomInset }]}>
          <View style={[styles.card, { height: cardHeight }]}>
            <View style={styles.header}>
              <View style={styles.headerSpacer} />
              <Text style={styles.title}>Choose Workspace</Text>
              <Pressable
                onPress={onClose}
                style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
              >
                <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
              </Pressable>
            </View>

            <View style={styles.body}>
              <ScrollView
                style={styles.topContentScroll}
                contentContainerStyle={styles.topContentContainer}
                showsVerticalScrollIndicator={false}
              >
                <View style={styles.connectionRow}>
                  <Text style={styles.connectionText} numberOfLines={1}>
                    {bridgeRoot ? `Start folder: ${toPathBasename(bridgeRoot)}` : 'Computer folders'}
                  </Text>
                  <Pressable
                    onPress={() => onSelectPath(null)}
                    style={({ pressed }) => [
                      styles.defaultButton,
                      selectedPath === null && styles.defaultButtonSelected,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text
                      style={[
                        styles.defaultButtonText,
                        selectedPath === null && styles.defaultButtonTextSelected,
                      ]}
                    >
                      {selectedPath === null ? 'Default' : 'Use Default'}
                    </Text>
                  </Pressable>
                </View>

                <View style={styles.searchField}>
                  <Ionicons name="search" size={16} color={theme.colors.textMuted} />
                  <TextInput
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    keyboardAppearance={theme.keyboardAppearance}
                    placeholder="Search folders"
                    placeholderTextColor={theme.colors.textMuted}
                    style={styles.searchInput}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="search"
                  />
                </View>

                {actionLabel && onActionPress ? (
                  <Pressable
                    onPress={handleActionPress}
                    disabled={actionDisabled}
                    style={({ pressed }) => [
                      styles.actionCard,
                      actionDisabled && styles.buttonDisabled,
                      pressed && !actionDisabled && styles.pressed,
                    ]}
                  >
                    <View style={styles.actionIconWrap}>
                      <Ionicons
                        name="git-branch-outline"
                        size={16}
                        color={theme.colors.textSecondary}
                      />
                    </View>
                    <View style={styles.actionCopy}>
                      <Text style={styles.actionTitle}>{actionLabel}</Text>
                      <Text style={styles.actionSubtitle} numberOfLines={2}>
                        {actionDescription ??
                          'Clone into the selected or currently open folder and start the chat there.'}
                      </Text>
                    </View>
                    <Ionicons
                      name="chevron-forward"
                      size={14}
                      color={theme.colors.textMuted}
                    />
                  </Pressable>
                ) : null}

                {hasFavoriteWorkspaces ? (
                  <>
                    <View style={styles.sectionHeader}>
                      <Text style={styles.sectionTitle}>Pinned</Text>
                    </View>

                    <View style={styles.favoriteGrid}>
                      {compactFavoriteWorkspaces.map((workspace) => (
                        <WorkspaceTile
                          key={workspace.path}
                          workspace={workspace}
                          iconName="star"
                          selected={workspace.path === pendingSelectionPath}
                          onPress={() => handleBrowsePath(workspace.path)}
                          isPinned={favoritePathSet.has(workspace.path)}
                          onPinAction={() => onToggleFavorite?.(workspace.path)}
                        />
                      ))}
                    </View>
                  </>
                ) : null}


                <View style={styles.breadcrumbRow}>
                  <Pressable
                    onPress={() => parentPath && handleBrowsePath(parentPath)}
                    disabled={!parentPath || (loadingEntries && !hasVisibleEntries)}
                    style={({ pressed }) => [
                      styles.upButton,
                      (!parentPath || (loadingEntries && !hasVisibleEntries)) &&
                        styles.buttonDisabled,
                      pressed &&
                        parentPath &&
                        (!loadingEntries || hasVisibleEntries) &&
                        styles.pressed,
                    ]}
                  >
                    <Ionicons name="return-up-back" size={14} color={theme.colors.textSecondary} />
                    <Text style={styles.upButtonText}>Up</Text>
                  </Pressable>

                  <View style={styles.currentFolderChip}>
                    <Text style={styles.currentFolderTitle} numberOfLines={1}>
                      {currentFolderTitle}
                    </Text>
                    <Text
                      style={styles.currentFolderPath}
                      numberOfLines={2}
                      ellipsizeMode="middle"
                    >
                      {currentFolderPath ?? 'Loading path'}
                    </Text>
                  </View>
                </View>

                {error ? <Text style={styles.errorText}>{error}</Text> : null}
              </ScrollView>

              <View style={styles.browserCard}>
                {loadingEntries && !hasVisibleEntries ? (
                  <LoadingRow label="Loading folders..." />
                ) : hasVisibleEntries ? (
                  <FlatList
                    style={styles.entryListScroll}
                    contentContainerStyle={styles.entryListContent}
                    data={filteredEntries}
                    keyExtractor={(entry) => entry.path}
                    initialNumToRender={18}
                    maxToRenderPerBatch={24}
                    removeClippedSubviews
                    windowSize={7}
                    getItemLayout={(_, index) => ({
                      length: ENTRY_ROW_HEIGHT,
                      offset: ENTRY_ROW_HEIGHT * index,
                      index,
                    })}
                    showsVerticalScrollIndicator={false}
                    keyboardShouldPersistTaps="handled"
                    renderItem={({ item: entry, index }) => (
                      <View
                        style={[
                          styles.entryRow,
                          index === filteredEntries.length - 1 && styles.entryRowLast,
                        ]}
                      >
                        <Pressable
                          onPress={() => handleBrowsePath(entry.path)}
                          onLongPress={() =>
                            onToggleFavorite &&
                            showWorkspacePinAction({
                              isPinned: favoritePathSet.has(entry.path),
                              onAction: () => onToggleFavorite(entry.path),
                            })
                          }
                          style={({ pressed }) => [
                            styles.rowMainAction,
                            pressed && styles.pressed,
                          ]}
                        >
                          <View style={styles.entryIconWrap}>
                            <Ionicons
                              name={entry.isGitRepo ? 'git-branch-outline' : 'folder-outline'}
                              size={18}
                              color={theme.colors.textSecondary}
                            />
                          </View>
                          <View style={styles.entryCopy}>
                            <Text style={styles.entryName} numberOfLines={1}>
                              {entry.name}
                            </Text>
                          </View>
                          <Ionicons
                            name="chevron-forward"
                            size={15}
                            color={theme.colors.textMuted}
                          />
                        </Pressable>
                      </View>
                    )}
                  />
                ) : (
                  <EmptyRow
                    label={
                      normalizedSearch
                        ? 'No folders match this search.'
                        : 'No folders found here.'
                    }
                  />
                )}
              </View>

              <View style={styles.footer}>
                <View style={styles.selectionSummary}>
                  <Text style={styles.selectionLabel}>Workspace</Text>
                  <Text style={styles.selectionTitle} numberOfLines={1} ellipsizeMode="tail">
                    {footerTitle}
                  </Text>
                  <Text
                    style={styles.selectionPath}
                    numberOfLines={2}
                    ellipsizeMode="middle"
                  >
                    {footerSubtitle}
                  </Text>
                </View>
                <Pressable
                  onPress={() => footerPath && onToggleFavorite?.(footerPath)}
                  disabled={!footerPath || !onToggleFavorite}
                  style={({ pressed }) => [
                    styles.footerFavoriteButton,
                    footerIsFavorite && styles.footerFavoriteButtonActive,
                    (!footerPath || !onToggleFavorite) && styles.buttonDisabled,
                    pressed && footerPath && onToggleFavorite && styles.footerFavoriteButtonPressed,
                  ]}
                >
                  <Ionicons
                    name={footerIsFavorite ? 'star' : 'star-outline'}
                    size={17}
                    color={
                      footerIsFavorite ? theme.colors.textPrimary : theme.colors.textSecondary
                    }
                  />
                </Pressable>
                <Pressable
                  onPress={() => footerPath && onSelectPath(footerPath)}
                  disabled={!footerPath}
                  style={({ pressed }) => [
                    styles.footerUseButton,
                    !footerPath && styles.buttonDisabled,
                    pressed &&
                      Boolean(footerPath) &&
                      styles.footerUseButtonPressed,
                  ]}
                >
                  <Text style={styles.footerUseButtonText}>Use</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function WorkspaceTile({
  workspace,
  iconName,
  selected,
  onPress,
  isPinned,
  onPinAction,
}: {
  workspace: WorkspaceSummary;
  iconName: IoniconName;
  selected: boolean;
  onPress: () => void;
  isPinned: boolean;
  onPinAction: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <Pressable
      onPress={onPress}
      onLongPress={() =>
        showWorkspacePinAction({
          isPinned,
          onAction: onPinAction,
        })
      }
      style={[
        styles.workspaceTile,
        selected && styles.workspaceTileSelected,
      ]}
    >
      {({ pressed }) => (
        <View style={[styles.workspaceTileContent, pressed && styles.pressed]}>
          <View style={styles.workspaceTileHeader}>
            <Ionicons
              name={iconName}
              size={13}
              color={theme.colors.textSecondary}
            />
            <Text style={styles.workspaceTileMeta} numberOfLines={1} ellipsizeMode="tail">
              {formatWorkspaceMeta(workspace)}
            </Text>
          </View>
          <Text
            style={styles.workspaceTileTitle}
            numberOfLines={2}
            ellipsizeMode="tail"
          >
            {toPathBasename(workspace.path)}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

function showWorkspacePinAction({
  isPinned,
  onAction,
}: {
  isPinned: boolean;
  onAction: () => void;
}) {
  const actionTitle = isPinned ? 'Unpin workspace' : 'Pin workspace';
  const promptTitle = isPinned ? 'Unpin this workspace?' : 'Pin this workspace?';

  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: [actionTitle, 'Cancel'],
        cancelButtonIndex: 1,
        title: promptTitle,
      },
      (buttonIndex) => {
        if (buttonIndex === 0) {
          onAction();
        }
      }
    );
    return;
  }

  Alert.alert(promptTitle, undefined, [
    { text: actionTitle, onPress: onAction },
    { text: 'Cancel', style: 'cancel' },
  ]);
}

function LoadingRow({
  label,
  compact = false,
}: {
  label: string;
  compact?: boolean;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={[styles.statusRow, compact && styles.statusRowCompact]}>
      <ActivityIndicator color={theme.colors.textPrimary} />
      <Text style={styles.statusText}>{label}</Text>
    </View>
  );
}

function EmptyRow({
  label,
  compact = false,
}: {
  label: string;
  compact?: boolean;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={[styles.statusRow, compact && styles.statusRowCompact]}>
      <Text style={styles.statusText}>{label}</Text>
    </View>
  );
}

function toPathBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) {
    return path;
  }
  return parts[parts.length - 1] ?? path;
}

function matchesSearch(values: string[], query: string): boolean {
  if (!query) {
    return true;
  }

  return values.some((value) => value.toLowerCase().includes(query));
}

function formatWorkspaceMeta(workspace: WorkspaceSummary): string {
  const relative = formatRelativeTime(workspace.updatedAt);
  if (relative) {
    return relative;
  }

  if (workspace.chatCount === 1) {
    return '1 chat';
  }

  return `${String(workspace.chatCount)} chats`;
}

function formatRelativeTime(iso?: string): string | null {
  if (!iso) {
    return null;
  }

  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  const diffMs = Math.max(0, Date.now() - timestamp);
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  const weeks = Math.floor(days / 7);

  if (seconds < 10) return 'now';
  if (seconds < 60) return `${String(seconds)} sec ago`;
  if (minutes < 60) return `${String(minutes)} min ago`;
  if (hours < 24) return `${String(hours)} hr ago`;
  if (days < 7) return `${String(days)} ${days === 1 ? 'day' : 'days'} ago`;
  if (weeks < 5) return `${String(weeks)} wk ago`;
  return `${String(Math.floor(days / 30))} mo ago`;
}

const createStyles = (theme: AppTheme) => {
  const modalShadow = theme.isDark
    ? '0 24px 44px rgba(0, 0, 0, 0.34)'
    : '0 18px 36px rgba(15, 23, 42, 0.14)';

  return StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlayBackdrop,
  },
  outer: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
  },
  card: {
    borderRadius: 28,
    borderCurve: 'continuous',
    backgroundColor: theme.colors.bgElevated,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    overflow: 'hidden',
    boxShadow: modalShadow,
  },
  header: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
  },
  headerSpacer: {
    width: 36,
  },
  title: {
    ...theme.typography.headline,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.bgInput,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
  },
  body: {
    flex: 1,
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.lg,
    gap: theme.spacing.sm,
  },
  topContentScroll: {
    flexShrink: 1,
    flexGrow: 0,
  },
  topContentContainer: {
    gap: theme.spacing.sm,
    paddingBottom: theme.spacing.sm,
  },
  connectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
  },
  connectionText: {
    flex: 1,
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
  },
  defaultButton: {
    minHeight: 32,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bgItem,
    alignItems: 'center',
    justifyContent: 'center',
  },
  defaultButtonSelected: {
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.bgInput,
  },
  defaultButtonText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    fontWeight: '600',
  },
  defaultButtonTextSelected: {
    color: theme.colors.textPrimary,
  },
  searchField: {
    minHeight: 36,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgInput,
    paddingHorizontal: theme.spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  searchInput: {
    flex: 1,
    ...theme.typography.body,
    paddingVertical: 0,
  },
  actionCard: {
    minHeight: 44,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  actionIconWrap: {
    width: 24,
    height: 24,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.bgInput,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
  },
  actionCopy: {
    flex: 1,
    gap: 2,
  },
  actionTitle: {
    ...theme.typography.body,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
    color: theme.colors.textPrimary,
  },
  actionSubtitle: {
    ...theme.typography.caption,
    fontSize: 11,
    lineHeight: 15,
    color: theme.colors.textSecondary,
  },
  breadcrumbRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.sm,
  },
  upButton: {
    minHeight: 28,
    marginTop: 2,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.colors.bgItem,
  },
  upButtonText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    fontWeight: '600',
  },
  currentFolderChip: {
    flex: 1,
    minWidth: 0,
    minHeight: 32,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.xs,
    justifyContent: 'center',
    gap: 2,
  },
  currentFolderTitle: {
    ...theme.typography.body,
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.textPrimary,
    fontWeight: '700',
  },
  currentFolderPath: {
    ...theme.typography.mono,
    fontSize: 9,
    lineHeight: 12,
    color: theme.colors.textMuted,
  },
  sectionHeader: {
    minHeight: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
  },
  sectionTitle: {
    ...theme.typography.caption,
    fontSize: 11,
    color: theme.colors.textSecondary,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0,
  },
  refreshBadge: {
    minHeight: 22,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.full,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: theme.colors.bgInput,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
  },
  refreshBadgeText: {
    ...theme.typography.caption,
    fontSize: 10,
    lineHeight: 13,
    color: theme.colors.textMuted,
    fontWeight: '600',
  },
  favoriteGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.sm,
  },
  rowMainAction: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  workspaceTile: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    minHeight: 56,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    overflow: 'hidden',
  },
  workspaceTileSelected: {
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.bgInput,
  },
  workspaceTileContent: {
    flex: 1,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    gap: 4,
    justifyContent: 'center',
  },
  workspaceTileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minWidth: 0,
  },
  workspaceTileTitle: {
    ...theme.typography.body,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '600',
  },
  workspaceTileMeta: {
    flex: 1,
    minWidth: 0,
    ...theme.typography.caption,
    fontSize: 10,
    lineHeight: 13,
    color: theme.colors.textSecondary,
    fontWeight: '600',
  },
  errorText: {
    ...theme.typography.caption,
    color: theme.colors.error,
  },
  browserCard: {
    flex: 1,
    flexShrink: 1,
    minHeight: 120,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    overflow: 'hidden',
  },
  entryListScroll: {
    flex: 1,
  },
  entryListContent: {
    paddingVertical: theme.spacing.xs,
  },
  entryRow: {
    minHeight: ENTRY_ROW_HEIGHT,
    paddingHorizontal: theme.spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderLight,
  },
  entryRowLast: {
    borderBottomWidth: 0,
  },
  entryIconWrap: {
    width: 28,
    height: 28,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.bgInput,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
  },
  entryCopy: {
    flex: 1,
    gap: 1,
  },
  entryName: {
    ...theme.typography.body,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    paddingTop: theme.spacing.sm,
  },
  selectionSummary: {
    flex: 1,
    minWidth: 0,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    justifyContent: 'center',
    gap: 2,
  },
  selectionLabel: {
    ...theme.typography.caption,
    fontSize: 10,
    lineHeight: 13,
    color: theme.colors.textMuted,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0,
  },
  selectionTitle: {
    ...theme.typography.body,
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.textPrimary,
    fontWeight: '700',
  },
  selectionPath: {
    ...theme.typography.mono,
    fontSize: 10,
    lineHeight: 14,
    color: theme.colors.textMuted,
  },
  footerFavoriteButton: {
    width: 44,
    height: 44,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerFavoriteButtonActive: {
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.bgInput,
  },
  footerFavoriteButtonPressed: {
    opacity: 0.84,
  },
  footerUseButton: {
    width: 94,
    height: 44,
    borderRadius: theme.radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
  },
  footerUseButtonPressed: {
    backgroundColor: theme.colors.accentPressed,
  },
  footerUseButtonText: {
    ...theme.typography.body,
    color: theme.colors.accentText,
    fontWeight: '700',
  },
  statusRow: {
    flex: 1,
    minHeight: 132,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
  },
  statusRowCompact: {
    minHeight: 96,
  },
  statusText: {
    ...theme.typography.body,
    textAlign: 'center',
    color: theme.colors.textMuted,
  },
  buttonDisabled: {
    opacity: 0.42,
  },
  pressed: {
    opacity: 0.86,
  },
});
};
