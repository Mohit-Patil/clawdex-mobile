import { Ionicons } from '@expo/vector-icons';
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

import type {
  FileSystemEntry,
  WorkspaceSummary,
} from '../api/types';
import { colors, radius, spacing, typography } from '../theme';

interface WorkspacePickerModalProps {
  visible: boolean;
  selectedPath?: string | null;
  bridgeRoot?: string | null;
  recentWorkspaces: WorkspaceSummary[];
  currentPath?: string | null;
  parentPath?: string | null;
  entries: FileSystemEntry[];
  draftPath: string;
  loadingRecent?: boolean;
  loadingEntries?: boolean;
  error?: string | null;
  onDraftPathChange: (value: string) => void;
  onBrowsePath: (path: string | null) => void;
  onSelectPath: (path: string | null) => void;
  onClose: () => void;
}

export function WorkspacePickerModal({
  visible,
  selectedPath = null,
  bridgeRoot = null,
  recentWorkspaces,
  currentPath = null,
  parentPath = null,
  entries,
  draftPath,
  loadingRecent = false,
  loadingEntries = false,
  error = null,
  onDraftPathChange,
  onBrowsePath,
  onSelectPath,
  onClose,
}: WorkspacePickerModalProps) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const topInset = Math.max(insets.top + spacing.lg, 72);
  const bottomInset = Math.max(insets.bottom + spacing.lg, 72);
  const cardHeight = Math.min(
    Math.max(520, Math.round(windowHeight * 0.76)),
    windowHeight - topInset - bottomInset
  );

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
            <View style={styles.handle} />
            <View style={styles.header}>
              <View style={styles.headerCopy}>
                <Text style={styles.eyebrow}>Workspace</Text>
                <Text style={styles.title}>Start directory</Text>
                <Text style={styles.subtitle}>
                  Choose a known Codex workspace or browse any folder on the bridge host.
                </Text>
              </View>
              <Pressable
                onPress={onClose}
                style={({ pressed }) => [styles.closeIconButton, pressed && styles.pressed]}
              >
                <Ionicons name="close" size={18} color={colors.textSecondary} />
              </Pressable>
            </View>

            <View style={styles.body}>
              <View style={styles.quickPicksSection}>
                <Text style={styles.sectionTitle}>Quick picks</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.quickPicksContent}
                >
                  <QuickPickChip
                    title="Bridge default"
                    meta="Auto"
                    selected={selectedPath === null}
                    onPress={() => onSelectPath(null)}
                  />
                  {!loadingRecent
                    ? recentWorkspaces.map((workspace) => (
                        <QuickPickChip
                          key={workspace.path}
                          title={toPathBasename(workspace.path)}
                          meta={workspace.chatCount === 1 ? '1 chat' : `${workspace.chatCount}`}
                          selected={workspace.path === selectedPath}
                          onPress={() => onSelectPath(workspace.path)}
                        />
                      ))
                    : null}
                </ScrollView>
                {loadingRecent ? (
                  <Text style={styles.inlineStatusText}>Refreshing known workspaces…</Text>
                ) : null}
              </View>

              <View style={styles.browserPanel}>
                <View style={styles.browserHeader}>
                  <View style={styles.browserHeaderCopy}>
                    <Text style={styles.sectionTitle}>Browse folders</Text>
                    <Text style={styles.pathValue} numberOfLines={2}>
                      {currentPath ?? bridgeRoot ?? 'Loading…'}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => parentPath && onBrowsePath(parentPath)}
                    disabled={!parentPath || loadingEntries}
                    style={({ pressed }) => [
                      styles.iconButton,
                      (!parentPath || loadingEntries) && styles.buttonDisabled,
                      pressed && parentPath && !loadingEntries && styles.pressed,
                    ]}
                  >
                    <Ionicons name="arrow-up-outline" size={18} color={colors.textPrimary} />
                  </Pressable>
                </View>

                <View style={styles.manualPathRow}>
                  <TextInput
                    value={draftPath}
                    onChangeText={onDraftPathChange}
                    keyboardAppearance="dark"
                    placeholder={bridgeRoot ?? '/path/to/workspace'}
                    placeholderTextColor={colors.textMuted}
                    style={styles.manualPathInput}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="go"
                    onSubmitEditing={() => onBrowsePath(draftPath)}
                  />
                  <Pressable
                    onPress={() => onBrowsePath(draftPath)}
                    disabled={loadingEntries}
                    style={({ pressed }) => [
                      styles.secondaryButton,
                      loadingEntries && styles.buttonDisabled,
                      pressed && !loadingEntries && styles.pressed,
                    ]}
                  >
                    <Text style={styles.secondaryButtonText}>Open</Text>
                  </Pressable>
                </View>

                <View style={styles.browserActions}>
                  <Pressable
                    onPress={() => currentPath && onSelectPath(currentPath)}
                    disabled={!currentPath || loadingEntries}
                    style={({ pressed }) => [
                      styles.primaryButton,
                      (!currentPath || loadingEntries) && styles.buttonDisabled,
                      pressed && currentPath && !loadingEntries && styles.primaryButtonPressed,
                    ]}
                  >
                    <Ionicons name="checkmark-circle-outline" size={16} color={colors.bgMain} />
                    <Text style={styles.primaryButtonText}>Use this folder</Text>
                  </Pressable>
                </View>

                {error ? <Text style={styles.errorText}>{error}</Text> : null}

                <View style={styles.entryListCard}>
                  {loadingEntries ? (
                    <LoadingRow label="Loading folders…" />
                  ) : entries.length > 0 ? (
                    <ScrollView
                      style={styles.entryListScroll}
                      contentContainerStyle={styles.entryListContent}
                      showsVerticalScrollIndicator={false}
                      keyboardShouldPersistTaps="handled"
                    >
                      {entries.map((entry) => (
                        <Pressable
                          key={entry.path}
                          onPress={() => onBrowsePath(entry.path)}
                          style={({ pressed }) => [
                            styles.entryRow,
                            entry.path === selectedPath && styles.entryRowSelected,
                            pressed && styles.pressed,
                          ]}
                        >
                          <View style={styles.entryIconWrap}>
                            <Ionicons
                              name={entry.isGitRepo ? 'git-branch-outline' : 'folder-outline'}
                              size={18}
                              color={colors.textPrimary}
                            />
                          </View>
                          <View style={styles.entryCopy}>
                            <Text style={styles.entryName} numberOfLines={1}>
                              {entry.name}
                            </Text>
                            <Text style={styles.entryPath} numberOfLines={1}>
                              {entry.path}
                            </Text>
                          </View>
                          <Ionicons
                            name="chevron-forward"
                            size={16}
                            color={colors.textMuted}
                          />
                        </Pressable>
                      ))}
                    </ScrollView>
                  ) : (
                    <EmptyRow label="No folders found here." />
                  )}
                </View>
              </View>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function QuickPickChip({
  title,
  meta,
  selected,
  onPress,
}: {
  title: string;
  meta?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.quickPickChip,
        selected && styles.quickPickChipSelected,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.quickPickTitle} numberOfLines={1}>
        {title}
      </Text>
      {meta ? (
        <Text style={styles.quickPickMeta} numberOfLines={1}>
          {meta}
        </Text>
      ) : null}
      {selected ? (
        <Ionicons name="checkmark-circle" size={16} color={colors.textPrimary} />
      ) : null}
    </Pressable>
  );
}

function LoadingRow({ label }: { label: string }) {
  return (
    <View style={styles.statusRow}>
      <ActivityIndicator color={colors.textPrimary} />
      <Text style={styles.statusText}>{label}</Text>
    </View>
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <View style={styles.statusRow}>
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

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.56)',
  },
  outer: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  card: {
    borderRadius: 26,
    borderCurve: 'continuous',
    backgroundColor: '#0F1218',
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    boxShadow: '0 24px 44px rgba(0, 0, 0, 0.34)',
  },
  handle: {
    alignSelf: 'center',
    width: 48,
    height: 5,
    borderRadius: radius.full,
    backgroundColor: 'rgba(255,255,255,0.16)',
    marginTop: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  headerCopy: {
    flex: 1,
    gap: spacing.xs,
  },
  eyebrow: {
    ...typography.caption,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  title: {
    ...typography.largeTitle,
    fontSize: 22,
  },
  subtitle: {
    ...typography.body,
    color: colors.textMuted,
  },
  closeIconButton: {
    marginTop: 2,
    width: 34,
    height: 34,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  body: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.lg,
  },
  quickPicksSection: {
    gap: spacing.sm,
  },
  quickPicksContent: {
    gap: spacing.sm,
    paddingRight: spacing.lg,
  },
  quickPickChip: {
    minWidth: 112,
    maxWidth: 172,
    minHeight: 54,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.bgItem,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    justifyContent: 'center',
    gap: 2,
  },
  quickPickChipSelected: {
    borderColor: colors.borderHighlight,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  quickPickTitle: {
    ...typography.body,
    fontWeight: '600',
  },
  quickPickMeta: {
    ...typography.caption,
    color: colors.textMuted,
  },
  inlineStatusText: {
    ...typography.caption,
    color: colors.textMuted,
  },
  sectionTitle: {
    ...typography.headline,
  },
  browserPanel: {
    flex: 1,
    gap: spacing.md,
  },
  browserHeader: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
  },
  browserHeaderCopy: {
    flex: 1,
    gap: spacing.xs,
  },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgItem,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pathValue: {
    ...typography.mono,
    fontSize: 11,
  },
  browserActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  manualPathRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
  },
  manualPathInput: {
    flex: 1,
    minHeight: 46,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.bgInput,
    paddingHorizontal: spacing.md,
    ...typography.body,
  },
  primaryButton: {
    minHeight: 46,
    borderRadius: radius.lg,
    backgroundColor: colors.textPrimary,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    flex: 1,
  },
  primaryButtonPressed: {
    opacity: 0.82,
  },
  primaryButtonText: {
    ...typography.body,
    color: colors.bgMain,
    fontWeight: '600',
  },
  secondaryButton: {
    minHeight: 46,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgItem,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  secondaryButtonText: {
    ...typography.body,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.42,
  },
  entryListCard: {
    flex: 1,
    minHeight: 240,
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
    paddingBottom: spacing.sm,
  },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.bgItem,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderLight,
  },
  entryRowSelected: {
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  entryIconWrap: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  entryCopy: {
    flex: 1,
    gap: 2,
  },
  entryName: {
    ...typography.body,
    fontWeight: '600',
  },
  entryPath: {
    ...typography.caption,
    color: colors.textMuted,
  },
  errorText: {
    ...typography.caption,
    color: '#FF8A8A',
  },
  statusRow: {
    flex: 1,
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  statusText: {
    ...typography.body,
    textAlign: 'center',
    color: colors.textMuted,
  },
  pressed: {
    opacity: 0.84,
  },
});
