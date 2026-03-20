import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
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
import { colors, radius, spacing, typography } from '../theme';

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
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [searchQuery, setSearchQuery] = useState('');
  const topInset = Math.max(insets.top + spacing.lg, 72);
  const bottomInset = Math.max(insets.bottom + spacing.lg, 72);
  const cardHeight = Math.min(
    Math.max(560, Math.round(windowHeight * 0.82)),
    windowHeight - topInset - bottomInset
  );

  useEffect(() => {
    if (!visible) {
      setSearchQuery('');
    }
  }, [visible]);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredRecentWorkspaces = recentWorkspaces.filter((workspace) =>
    matchesSearch([workspace.path, toPathBasename(workspace.path)], normalizedSearch)
  );
  const filteredEntries = entries.filter((entry) =>
    matchesSearch([entry.name, entry.path], normalizedSearch)
  );
  const breadcrumbs = buildPathBreadcrumbs(currentPath ?? bridgeRoot);
  const footerPath = currentPath ?? bridgeRoot ?? 'Bridge default workspace';

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
                <Ionicons name="close" size={18} color={colors.textSecondary} />
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
                <Ionicons name="search" size={16} color={colors.textMuted} />
                <TextInput
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  keyboardAppearance="dark"
                  placeholder="Search folders"
                  placeholderTextColor={colors.textMuted}
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
                      <Pressable
                        key={workspace.path}
                        onPress={() => onBrowsePath(workspace.path)}
                        style={({ pressed }) => [
                          styles.recentRow,
                          workspace.path === currentPath && styles.recentRowSelected,
                          index === filteredRecentWorkspaces.length - 1 &&
                            styles.recentRowLast,
                          pressed && styles.pressed,
                        ]}
                      >
                        <View style={styles.recentIconWrap}>
                          <Ionicons name="time-outline" size={16} color={colors.textSecondary} />
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

              <Text style={styles.helperText}>Open a recent folder or browse below.</Text>

              <View style={styles.breadcrumbRow}>
                <Pressable
                  onPress={() => parentPath && onBrowsePath(parentPath)}
                  disabled={!parentPath || loadingEntries}
                  style={({ pressed }) => [
                    styles.upButton,
                    (!parentPath || loadingEntries) && styles.buttonDisabled,
                    pressed && parentPath && !loadingEntries && styles.pressed,
                  ]}
                >
                  <Ionicons name="return-up-back" size={14} color={colors.textSecondary} />
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
                              onPress={() => onBrowsePath(item.path)}
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
                      <Pressable
                        key={entry.path}
                        onPress={() => onBrowsePath(entry.path)}
                        style={({ pressed }) => [
                          styles.entryRow,
                          entry.path === selectedPath && styles.entryRowSelected,
                          index === filteredEntries.length - 1 && styles.entryRowLast,
                          pressed && styles.pressed,
                        ]}
                      >
                        <View style={styles.entryIconWrap}>
                          <Ionicons
                            name={entry.isGitRepo ? 'git-branch-outline' : 'folder-outline'}
                            size={18}
                            color={colors.textSecondary}
                          />
                        </View>
                        <View style={styles.entryCopy}>
                          <Text style={styles.entryName} numberOfLines={1}>
                            {entry.name}
                          </Text>
                        </View>
                        <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                      </Pressable>
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
                <Text style={styles.footerPath} numberOfLines={1}>
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
                    onPress={() => currentPath && onSelectPath(currentPath)}
                    disabled={!currentPath || loadingEntries}
                    style={({ pressed }) => [
                      styles.footerButton,
                      styles.footerButtonPrimary,
                      (!currentPath || loadingEntries) && styles.buttonDisabled,
                      pressed && currentPath && !loadingEntries && styles.footerButtonPrimaryPressed,
                    ]}
                  >
                    <Text style={styles.footerButtonPrimaryText}>Select Folder</Text>
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
  return (
    <View style={[styles.statusRow, compact && styles.statusRowCompact]}>
      <ActivityIndicator color={colors.textPrimary} />
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

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.62)',
  },
  outer: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  card: {
    borderRadius: 28,
    borderCurve: 'continuous',
    backgroundColor: '#07090C',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.09)',
    overflow: 'hidden',
    boxShadow: '0 24px 44px rgba(0, 0, 0, 0.34)',
  },
  header: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  headerSpacer: {
    width: 36,
  },
  title: {
    ...typography.headline,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  body: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  connectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  connectionText: {
    flex: 1,
    ...typography.caption,
    color: colors.textSecondary,
  },
  defaultButton: {
    minHeight: 32,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgItem,
    alignItems: 'center',
    justifyContent: 'center',
  },
  defaultButtonSelected: {
    borderColor: colors.borderHighlight,
    backgroundColor: colors.bgInput,
  },
  defaultButtonText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  defaultButtonTextSelected: {
    color: colors.textPrimary,
  },
  searchField: {
    minHeight: 44,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.bgInput,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  searchInput: {
    flex: 1,
    ...typography.body,
    paddingVertical: 0,
  },
  breadcrumbRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  upButton: {
    minHeight: 32,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.borderLight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.bgItem,
  },
  upButtonText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  breadcrumbScroll: {
    alignItems: 'center',
    paddingRight: spacing.md,
    gap: spacing.xs,
  },
  breadcrumbItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  breadcrumbSlash: {
    ...typography.mono,
    color: colors.textMuted,
  },
  breadcrumbChip: {
    minHeight: 30,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    justifyContent: 'center',
  },
  breadcrumbChipActive: {
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: colors.borderHighlight,
  },
  breadcrumbText: {
    ...typography.mono,
    fontSize: 12,
    color: colors.textSecondary,
  },
  breadcrumbTextActive: {
    color: colors.textPrimary,
    fontWeight: '700',
  },
  breadcrumbEmpty: {
    ...typography.caption,
    color: colors.textMuted,
  },
  sectionHeader: {
    paddingTop: spacing.xs,
  },
  sectionTitle: {
    ...typography.caption,
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  recentCard: {
    maxHeight: 184,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.bgItem,
    overflow: 'hidden',
  },
  recentRow: {
    minHeight: 54,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderLight,
  },
  recentRowSelected: {
    backgroundColor: colors.bgInput,
  },
  recentRowLast: {
    borderBottomWidth: 0,
  },
  recentIconWrap: {
    width: 30,
    height: 30,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  recentCopy: {
    flex: 1,
    gap: 2,
  },
  recentTitle: {
    ...typography.body,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  recentPath: {
    ...typography.caption,
    fontSize: 11,
    lineHeight: 15,
    color: colors.textMuted,
  },
  recentMeta: {
    ...typography.caption,
    fontSize: 11,
    lineHeight: 15,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  helperText: {
    ...typography.caption,
    fontSize: 11,
    lineHeight: 15,
    color: colors.textMuted,
  },
  errorText: {
    ...typography.caption,
    color: '#FF8A8A',
  },
  browserCard: {
    flex: 1,
    minHeight: 228,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.bgItem,
    overflow: 'hidden',
  },
  entryListScroll: {
    flex: 1,
  },
  entryListContent: {
    paddingVertical: spacing.xs,
  },
  entryRow: {
    minHeight: 54,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderLight,
  },
  entryRowSelected: {
    backgroundColor: colors.bgInput,
  },
  entryRowLast: {
    borderBottomWidth: 0,
  },
  entryIconWrap: {
    width: 32,
    height: 32,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  entryCopy: {
    flex: 1,
  },
  entryName: {
    ...typography.body,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  footer: {
    gap: spacing.sm,
  },
  footerPath: {
    ...typography.mono,
    fontSize: 10,
    lineHeight: 14,
    color: colors.textMuted,
  },
  footerActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  footerButton: {
    minHeight: 48,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    flex: 1,
  },
  footerButtonSecondary: {
    backgroundColor: colors.bgMain,
    borderWidth: 1,
    borderColor: colors.border,
  },
  footerButtonPrimary: {
    backgroundColor: colors.accent,
  },
  footerButtonPrimaryPressed: {
    backgroundColor: colors.accentPressed,
  },
  footerButtonSecondaryText: {
    ...typography.body,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  footerButtonPrimaryText: {
    ...typography.body,
    color: colors.black,
    fontWeight: '700',
  },
  statusRow: {
    flex: 1,
    minHeight: 132,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  statusRowCompact: {
    minHeight: 96,
  },
  statusText: {
    ...typography.body,
    textAlign: 'center',
    color: colors.textMuted,
  },
  buttonDisabled: {
    opacity: 0.42,
  },
  pressed: {
    opacity: 0.86,
  },
});
