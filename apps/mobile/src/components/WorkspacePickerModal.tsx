import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
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
  currentPath?: string | null;
  parentPath?: string | null;
  entries: FileSystemEntry[];
  loadingRecent?: boolean;
  loadingEntries?: boolean;
  error?: string | null;
  onBrowsePath: (path: string | null) => void;
  onSelectPath: (path: string | null) => void;
  onClose: () => void;
}

interface BreadcrumbItem {
  key: string;
  label: string;
  path: string;
}

export function WorkspacePickerModal({
  visible,
  selectedPath = null,
  bridgeRoot = null,
  recentWorkspaces,
  currentPath = null,
  parentPath = null,
  entries,
  loadingRecent = false,
  loadingEntries = false,
  error = null,
  onBrowsePath,
  onSelectPath,
  onClose,
}: WorkspacePickerModalProps) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [searchQuery, setSearchQuery] = useState('');
  const [pendingSelectionPath, setPendingSelectionPath] = useState<string | null>(
    selectedPath ?? currentPath ?? bridgeRoot
  );
  const styles = useMemo(() => createStyles(theme), [theme]);
  const topInset = Math.max(insets.top + theme.spacing.lg, 72);
  const bottomInset = Math.max(insets.bottom + theme.spacing.lg, 72);
  const cardHeight = Math.min(
    Math.max(560, Math.round(windowHeight * 0.82)),
    windowHeight - topInset - bottomInset
  );

  useEffect(() => {
    if (!visible) {
      setSearchQuery('');
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    setPendingSelectionPath(selectedPath ?? currentPath ?? bridgeRoot);
  }, [bridgeRoot, currentPath, selectedPath, visible]);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredRecentWorkspaces = recentWorkspaces.filter((workspace) =>
    matchesSearch([workspace.path, toPathBasename(workspace.path)], normalizedSearch)
  );
  const filteredEntries = entries.filter((entry) =>
    matchesSearch([entry.name, entry.path], normalizedSearch)
  );
  const breadcrumbs = buildPathBreadcrumbs(currentPath ?? bridgeRoot);
  const footerPath = pendingSelectionPath ?? currentPath ?? bridgeRoot ?? 'Bridge default workspace';

  const handleBrowsePath = (path: string | null) => {
    setPendingSelectionPath(path);
    onBrowsePath(path);
  };

  const handleSelectPath = (path: string | null) => {
    setPendingSelectionPath(path);
  };

  const handleCommitSelection = (path: string | null) => {
    setPendingSelectionPath(path);
    onSelectPath(path);
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
              <Text style={styles.title}>Choose Directory</Text>
              <Pressable
                onPress={onClose}
                style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
              >
                <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
              </Pressable>
            </View>

            <View style={styles.body}>
              <View style={styles.connectionRow}>
                <Text style={styles.connectionText} numberOfLines={1}>
                  {bridgeRoot ? `Bridge root: ${bridgeRoot}` : 'Browse folders on the bridge host'}
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
                    {selectedPath === null ? 'Default' : 'Use default'}
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

              <View style={styles.sectionHeader}>
                <Text style={styles.sectionTitle}>Recent Directories</Text>
              </View>

              <View style={styles.recentCard}>
                {loadingRecent ? (
                  <LoadingRow label="Refreshing recent directories..." compact />
                ) : filteredRecentWorkspaces.length > 0 ? (
                  <ScrollView
                    showsVerticalScrollIndicator={false}
                    keyboardShouldPersistTaps="handled"
                  >
                    {filteredRecentWorkspaces.map((workspace, index) => (
                      <View
                        key={workspace.path}
                        style={[
                          styles.recentRow,
                          workspace.path === pendingSelectionPath && styles.recentRowSelected,
                          index === filteredRecentWorkspaces.length - 1 && styles.recentRowLast,
                        ]}
                      >
                        <Pressable
                          onPress={() => handleSelectPath(workspace.path)}
                          style={({ pressed }) => [styles.rowMainAction, pressed && styles.pressed]}
                        >
                          <View style={styles.recentIconWrap}>
                            <Ionicons name="time-outline" size={16} color={theme.colors.textSecondary} />
                          </View>
                          <View style={styles.recentCopy}>
                            <Text style={styles.recentTitle} numberOfLines={1}>
                              {toPathBasename(workspace.path)}
                            </Text>
                            <Text style={styles.recentPath} numberOfLines={1}>
                              {workspace.path}
                            </Text>
                          </View>
                          <Text style={styles.recentMeta}>
                            {formatWorkspaceMeta(workspace)}
                          </Text>
                        </Pressable>
                        <View style={styles.rowActions}>
                          <Pressable
                            onPress={() => handleCommitSelection(workspace.path)}
                            style={({ pressed }) => [
                              styles.rowSelectButton,
                              workspace.path === pendingSelectionPath &&
                                styles.rowSelectButtonActive,
                              pressed && styles.pressed,
                            ]}
                          >
                            <Text
                              style={[
                                styles.rowSelectButtonText,
                                workspace.path === pendingSelectionPath &&
                                  styles.rowSelectButtonTextActive,
                              ]}
                            >
                              Select
                            </Text>
                          </Pressable>
                          <Pressable
                            onPress={() => handleBrowsePath(workspace.path)}
                            style={({ pressed }) => [
                              styles.rowOpenButton,
                              pressed && styles.pressed,
                            ]}
                          >
                            <Text style={styles.rowOpenButtonText}>Open</Text>
                          </Pressable>
                        </View>
                      </View>
                    ))}
                  </ScrollView>
                ) : (
                  <EmptyRow
                    label={
                      normalizedSearch
                        ? 'No recent directories match this search.'
                        : 'No recent directories yet.'
                    }
                    compact
                  />
                )}
              </View>

              <Text style={styles.helperText}>
                Use Select for this exact folder. Use Open to browse inside it.
              </Text>

              <View style={styles.breadcrumbRow}>
                <Pressable
                  onPress={() => parentPath && handleBrowsePath(parentPath)}
                  disabled={!parentPath || loadingEntries}
                  style={({ pressed }) => [
                    styles.upButton,
                    (!parentPath || loadingEntries) && styles.buttonDisabled,
                    pressed && parentPath && !loadingEntries && styles.pressed,
                  ]}
                >
                  <Ionicons name="return-up-back" size={14} color={theme.colors.textSecondary} />
                  <Text style={styles.upButtonText}>Up one level</Text>
                </Pressable>

                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.breadcrumbScroll}
                >
                  {breadcrumbs.length > 0
                    ? breadcrumbs.map((item, index) => {
                        const isLast = index === breadcrumbs.length - 1;
                        return (
                          <View key={item.key} style={styles.breadcrumbItem}>
                            {index > 0 ? <Text style={styles.breadcrumbSlash}>/</Text> : null}
                            <Pressable
                              onPress={() => handleBrowsePath(item.path)}
                              style={({ pressed }) => [
                                styles.breadcrumbChip,
                                isLast && styles.breadcrumbChipActive,
                                pressed && styles.pressed,
                              ]}
                            >
                              <Text
                                style={[
                                  styles.breadcrumbText,
                                  isLast && styles.breadcrumbTextActive,
                                ]}
                              >
                                {item.label}
                              </Text>
                            </Pressable>
                          </View>
                        );
                      })
                    : (
                      <Text style={styles.breadcrumbEmpty}>Loading path...</Text>
                    )}
                </ScrollView>
              </View>

              {error ? <Text style={styles.errorText}>{error}</Text> : null}

              <View style={styles.browserCard}>
                {loadingEntries ? (
                  <LoadingRow label="Loading folders..." />
                ) : filteredEntries.length > 0 ? (
                  <ScrollView
                    style={styles.entryListScroll}
                    contentContainerStyle={styles.entryListContent}
                    showsVerticalScrollIndicator={false}
                    keyboardShouldPersistTaps="handled"
                  >
                    {filteredEntries.map((entry, index) => (
                      <View
                        key={entry.path}
                        style={[
                          styles.entryRow,
                          entry.path === pendingSelectionPath && styles.entryRowSelected,
                          index === filteredEntries.length - 1 && styles.entryRowLast,
                        ]}
                      >
                        <Pressable
                          onPress={() => handleSelectPath(entry.path)}
                          style={({ pressed }) => [styles.rowMainAction, pressed && styles.pressed]}
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
                        </Pressable>
                        <View style={styles.rowActions}>
                          <Pressable
                            onPress={() => handleCommitSelection(entry.path)}
                            style={({ pressed }) => [
                              styles.rowSelectButton,
                              entry.path === pendingSelectionPath &&
                                styles.rowSelectButtonActive,
                              pressed && styles.pressed,
                            ]}
                          >
                            <Text
                              style={[
                                styles.rowSelectButtonText,
                                entry.path === pendingSelectionPath &&
                                  styles.rowSelectButtonTextActive,
                              ]}
                            >
                              Select
                            </Text>
                          </Pressable>
                          <Pressable
                            onPress={() => handleBrowsePath(entry.path)}
                            style={({ pressed }) => [
                              styles.rowOpenButton,
                              pressed && styles.pressed,
                            ]}
                          >
                            <Text style={styles.rowOpenButtonText}>Open</Text>
                          </Pressable>
                        </View>
                      </View>
                    ))}
                  </ScrollView>
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
                <Text style={styles.footerPath}>
                  {footerPath}
                </Text>
                <View style={styles.footerActions}>
                  <Pressable
                    onPress={onClose}
                    style={({ pressed }) => [
                      styles.footerButton,
                      styles.footerButtonSecondary,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.footerButtonSecondaryText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => pendingSelectionPath && onSelectPath(pendingSelectionPath)}
                    disabled={!pendingSelectionPath || loadingEntries}
                    style={({ pressed }) => [
                      styles.footerButton,
                      styles.footerButtonPrimary,
                      (!pendingSelectionPath || loadingEntries) && styles.buttonDisabled,
                      pressed &&
                        pendingSelectionPath &&
                        !loadingEntries &&
                        styles.footerButtonPrimaryPressed,
                    ]}
                  >
                    <Text style={styles.footerButtonPrimaryText}>Use Selected Folder</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
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

function buildPathBreadcrumbs(path: string | null): BreadcrumbItem[] {
  if (!path) {
    return [];
  }

  const normalized = path.replace(/\\/g, '/');
  const driveMatch = normalized.match(/^[A-Za-z]:/);
  const isAbsolute = normalized.startsWith('/');
  let remainder = normalized;
  const items: BreadcrumbItem[] = [];

  if (driveMatch) {
    const root = driveMatch[0];
    items.push({ key: root, label: root, path: root });
    remainder = normalized.slice(root.length).replace(/^\/+/, '');
  } else if (isAbsolute) {
    items.push({ key: '/', label: '/', path: '/' });
    remainder = normalized.slice(1);
  }

  const parts = remainder.split('/').filter(Boolean);
  let accumulated = driveMatch ? driveMatch[0] : isAbsolute ? '' : '';

  for (const part of parts) {
    accumulated = driveMatch
      ? `${accumulated}/${part}`
      : isAbsolute
        ? `${accumulated}/${part}`
        : accumulated
          ? `${accumulated}/${part}`
          : part;
    items.push({
      key: accumulated,
      label: part,
      path: accumulated,
    });
  }

  return items;
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
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
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
    gap: theme.spacing.md,
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
    minHeight: 44,
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
  breadcrumbRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  upButton: {
    minHeight: 32,
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
  breadcrumbScroll: {
    alignItems: 'center',
    paddingRight: theme.spacing.md,
    gap: theme.spacing.xs,
  },
  breadcrumbItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  breadcrumbSlash: {
    ...theme.typography.mono,
    color: theme.colors.textMuted,
  },
  breadcrumbChip: {
    minHeight: 30,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.md,
    justifyContent: 'center',
  },
  breadcrumbChipActive: {
    backgroundColor: theme.colors.bgInput,
    borderWidth: 1,
    borderColor: theme.colors.borderHighlight,
  },
  breadcrumbText: {
    ...theme.typography.mono,
    fontSize: 12,
    color: theme.colors.textSecondary,
  },
  breadcrumbTextActive: {
    color: theme.colors.textPrimary,
    fontWeight: '700',
  },
  breadcrumbEmpty: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
  },
  sectionHeader: {
    paddingTop: theme.spacing.xs,
  },
  sectionTitle: {
    ...theme.typography.caption,
    fontSize: 11,
    color: theme.colors.textSecondary,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  recentCard: {
    maxHeight: 184,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    overflow: 'hidden',
  },
  recentRow: {
    minHeight: 54,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderLight,
  },
  rowMainAction: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  rowSelectButton: {
    minHeight: 30,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.borderHighlight,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  rowSelectButtonActive: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  rowSelectButtonText: {
    ...theme.typography.caption,
    fontSize: 11,
    color: theme.colors.textPrimary,
    fontWeight: '700',
  },
  rowSelectButtonTextActive: {
    color: theme.colors.accentText,
  },
  rowOpenButton: {
    minHeight: 30,
    paddingHorizontal: theme.spacing.sm,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.bgInput,
  },
  rowOpenButtonText: {
    ...theme.typography.caption,
    fontSize: 11,
    color: theme.colors.textSecondary,
    fontWeight: '700',
  },
  recentRowSelected: {
    backgroundColor: theme.colors.bgInput,
  },
  recentRowLast: {
    borderBottomWidth: 0,
  },
  recentIconWrap: {
    width: 30,
    height: 30,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.bgInput,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
  },
  recentCopy: {
    flex: 1,
    gap: 2,
  },
  recentTitle: {
    ...theme.typography.body,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  recentPath: {
    ...theme.typography.caption,
    fontSize: 11,
    lineHeight: 15,
    color: theme.colors.textMuted,
  },
  recentMeta: {
    ...theme.typography.caption,
    fontSize: 11,
    lineHeight: 15,
    color: theme.colors.textSecondary,
    fontWeight: '600',
  },
  helperText: {
    ...theme.typography.caption,
    fontSize: 11,
    lineHeight: 15,
    color: theme.colors.textMuted,
  },
  errorText: {
    ...theme.typography.caption,
    color: theme.colors.error,
  },
  browserCard: {
    flex: 1,
    minHeight: 228,
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
    minHeight: 54,
    paddingHorizontal: theme.spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderLight,
  },
  entryRowSelected: {
    backgroundColor: theme.colors.bgInput,
  },
  entryRowLast: {
    borderBottomWidth: 0,
  },
  entryIconWrap: {
    width: 32,
    height: 32,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.bgInput,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
  },
  entryCopy: {
    flex: 1,
  },
  entryName: {
    ...theme.typography.body,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  footer: {
    gap: theme.spacing.sm,
  },
  footerPath: {
    ...theme.typography.mono,
    fontSize: 10,
    lineHeight: 14,
    color: theme.colors.textMuted,
  },
  footerActions: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  footerButton: {
    minHeight: 48,
    borderRadius: theme.radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.spacing.lg,
    flex: 1,
  },
  footerButtonSecondary: {
    backgroundColor: theme.colors.bgInput,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  footerButtonPrimary: {
    backgroundColor: theme.colors.accent,
  },
  footerButtonPrimaryPressed: {
    backgroundColor: theme.colors.accentPressed,
  },
  footerButtonSecondaryText: {
    ...theme.typography.body,
    color: theme.colors.textSecondary,
    fontWeight: '600',
  },
  footerButtonPrimaryText: {
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
