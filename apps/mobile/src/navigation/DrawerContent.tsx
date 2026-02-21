import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { MacBridgeApiClient } from '../api/client';
import type { ChatSummary, RpcNotification } from '../api/types';
import type { MacBridgeWsClient } from '../api/ws';
import { BrandMark } from '../components/BrandMark';
import { colors, spacing, typography } from '../theme';

type Screen = 'Main' | 'Terminal' | 'Settings' | 'Privacy' | 'Terms';

interface DrawerContentProps {
  api: MacBridgeApiClient;
  ws: MacBridgeWsClient;
  selectedChatId: string | null;
  selectedDefaultCwd: string | null;
  onSelectDefaultCwd: (cwd: string | null) => void;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onNavigate: (screen: Screen) => void;
}

export function DrawerContent({
  api,
  ws,
  selectedChatId,
  selectedDefaultCwd,
  onSelectDefaultCwd,
  onSelectChat,
  onNewChat,
  onNavigate,
}: DrawerContentProps) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const workspaceOptions = useMemo(() => listWorkspaces(chats), [chats]);
  const defaultWorkspaceLabel =
    normalizeCwd(selectedDefaultCwd) ?? 'Bridge default workspace';

  const loadChats = useCallback(async () => {
    try {
      const data = await api.listChats();
      setChats(sortChats(data));
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadChats();
  }, [loadChats]);

  useEffect(() => {
    return ws.onEvent((event: RpcNotification) => {
      if (
        event.method === 'thread/started' ||
        event.method === 'thread/name/updated' ||
        event.method === 'turn/completed' ||
        event.method === 'thread/status/changed'
      ) {
        void loadChats();
      }
    });
  }, [ws, loadChats]);

  useEffect(() => {
    const timer = setInterval(() => {
      void loadChats();
    }, 4000);

    return () => clearInterval(timer);
  }, [loadChats]);

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.mainContent}>
          <View style={styles.brandRow}>
            <BrandMark size={20} />
            <Text style={styles.brandText}>Clawdex</Text>
          </View>

          {/* New Chat button */}
          <View style={styles.header}>
            <Pressable
              style={({ pressed }) => [
                styles.navItem,
                styles.newChatBtn,
                pressed && styles.navItemPressed,
              ]}
              onPress={onNewChat}
            >
              <Ionicons name="add" size={16} color={colors.textPrimary} />
              <Text style={styles.newChatText}>New chat</Text>
            </Pressable>
          </View>

          <View style={styles.workspaceSection}>
            <Text style={styles.sectionTitle}>Start Directory</Text>
            <Pressable
              style={({ pressed }) => [
                styles.workspacePicker,
                pressed && styles.workspacePickerPressed,
              ]}
              onPress={() => setWorkspacePickerOpen(true)}
            >
              <Ionicons name="folder-open-outline" size={16} color={colors.textMuted} />
              <Text style={styles.workspacePickerText} numberOfLines={1}>
                {defaultWorkspaceLabel}
              </Text>
              <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
            </Pressable>
          </View>

          {/* Nav items */}
          <NavItem icon="terminal-outline" label="Terminal" onPress={() => onNavigate('Terminal')} />
          <NavItem
            icon="shield-checkmark-outline"
            label="Privacy"
            onPress={() => onNavigate('Privacy')}
          />
          <NavItem
            icon="document-text-outline"
            label="Terms"
            onPress={() => onNavigate('Terms')}
          />

          {/* Chats section */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Chats</Text>
          </View>

          {loading ? (
            <ActivityIndicator color={colors.textMuted} style={styles.loader} />
          ) : (
            <FlatList
              data={chats}
              keyExtractor={(item) => item.id}
              style={styles.list}
              showsVerticalScrollIndicator={false}
              ListEmptyComponent={<Text style={styles.emptyText}>No chats yet</Text>}
              renderItem={({ item }) => {
                const isSelected = item.id === selectedChatId;
                return (
                  <Pressable
                    style={({ pressed }) => [
                      styles.chatItem,
                      isSelected && styles.chatItemSelected,
                      pressed && styles.chatItemPressed,
                    ]}
                    onPress={() => onSelectChat(item.id)}
                  >
                    <Text style={[styles.chatTitle, isSelected && styles.chatTitleSelected]} numberOfLines={1}>
                      {item.title || 'Untitled'}
                    </Text>
                    <Text style={styles.chatAge}>{relativeTime(item.updatedAt)}</Text>
                  </Pressable>
                );
              }}
            />
          )}
        </View>

        <View style={styles.footer}>
          <NavItem
            icon="settings-outline"
            label="Settings"
            onPress={() => onNavigate('Settings')}
            style={styles.settingsItem}
          />
        </View>
      </SafeAreaView>

      <Modal
        visible={workspacePickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setWorkspacePickerOpen(false)}
      >
        <View style={styles.workspaceModalBackdrop}>
          <View style={styles.workspaceModalCard}>
            <Text style={styles.workspaceModalTitle}>Start directory for new chats</Text>
            <ScrollView
              style={styles.workspaceModalList}
              contentContainerStyle={styles.workspaceModalListContent}
              showsVerticalScrollIndicator={false}
            >
              <WorkspaceOption
                label="Bridge default workspace"
                selected={normalizeCwd(selectedDefaultCwd) === null}
                onPress={() => {
                  onSelectDefaultCwd(null);
                  setWorkspacePickerOpen(false);
                }}
              />
              {workspaceOptions.map((cwd) => (
                <WorkspaceOption
                  key={cwd}
                  label={cwd}
                  selected={cwd === normalizeCwd(selectedDefaultCwd)}
                  onPress={() => {
                    onSelectDefaultCwd(cwd);
                    setWorkspacePickerOpen(false);
                  }}
                />
              ))}
            </ScrollView>
            <Pressable
              style={({ pressed }) => [
                styles.workspaceModalCloseBtn,
                pressed && styles.workspaceModalCloseBtnPressed,
              ]}
              onPress={() => setWorkspacePickerOpen(false)}
            >
              <Text style={styles.workspaceModalCloseText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function NavItem({
  icon,
  label,
  onPress,
  style,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  style?: object;
}) {
  return (
    <View style={style}>
      <Pressable
        style={({ pressed }) => [styles.navItem, pressed && styles.navItemPressed]}
        onPress={onPress}
      >
        <Ionicons name={icon} size={18} color={colors.textPrimary} />
        <Text style={styles.navLabel}>{label}</Text>
      </Pressable>
    </View>
  );
}

function WorkspaceOption({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.workspaceOption,
        selected && styles.workspaceOptionSelected,
        pressed && styles.workspaceOptionPressed,
      ]}
      onPress={onPress}
    >
      <Text style={[styles.workspaceOptionText, selected && styles.workspaceOptionTextSelected]} numberOfLines={2}>
        {label}
      </Text>
      {selected ? (
        <Ionicons name="checkmark-circle" size={16} color={colors.textPrimary} />
      ) : null}
    </Pressable>
  );
}

function sortChats(chats: ChatSummary[]): ChatSummary[] {
  return [...chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function normalizeCwd(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function listWorkspaces(chats: ChatSummary[]): string[] {
  const sorted = [...chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const seen = new Set<string>();
  const result: string[] = [];

  for (const chat of sorted) {
    const cwd = normalizeCwd(chat.cwd);
    if (!cwd || seen.has(cwd)) {
      continue;
    }
    seen.add(cwd);
    result.push(cwd);
  }

  return result;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1d';
  return `${days}d`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgSidebar,
  },
  safeArea: {
    flex: 1,
  },
  mainContent: {
    flex: 1,
    minHeight: 0,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  brandText: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    paddingBottom: spacing.md,
  },
  workspaceSection: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.xs,
  },
  workspacePicker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgItem,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  workspacePickerPressed: {
    opacity: 0.85,
  },
  workspacePickerText: {
    ...typography.caption,
    color: colors.textSecondary,
    flex: 1,
  },
  newChatBtn: {
    marginHorizontal: 0,
    marginBottom: 0,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: colors.bgItem,
  },
  newChatText: {
    ...typography.body,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginHorizontal: spacing.md,
    borderRadius: 10,
    marginBottom: spacing.xs,
  },
  navItemPressed: {
    backgroundColor: colors.bgItem,
  },
  navLabel: {
    ...typography.body,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  sectionHeader: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  sectionTitle: {
    ...typography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  list: {
    flex: 1,
  },
  loader: {
    marginTop: spacing.xl,
  },
  emptyText: {
    ...typography.caption,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
  chatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginHorizontal: spacing.md,
    borderRadius: 10,
    marginBottom: spacing.xs,
  },
  chatItemSelected: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderHighlight,
  },
  chatItemPressed: {
    backgroundColor: colors.bgItem,
  },
  chatTitle: {
    ...typography.body,
    color: colors.textMuted,
    flex: 1,
    marginRight: spacing.sm,
  },
  chatTitleSelected: {
    color: colors.textPrimary,
    fontWeight: '600',
  },
  chatAge: {
    ...typography.caption,
    flexShrink: 0,
  },
  settingsItem: {
    marginBottom: 0,
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
  },
  workspaceModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  workspaceModalCard: {
    backgroundColor: colors.bgSidebar,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    maxHeight: '70%',
    padding: spacing.md,
    gap: spacing.sm,
  },
  workspaceModalTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  workspaceModalList: {
    maxHeight: 340,
  },
  workspaceModalListContent: {
    gap: spacing.xs,
  },
  workspaceOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: colors.bgItem,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  workspaceOptionSelected: {
    borderColor: colors.borderHighlight,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  workspaceOptionPressed: {
    opacity: 0.88,
  },
  workspaceOptionText: {
    ...typography.caption,
    color: colors.textSecondary,
    flex: 1,
  },
  workspaceOptionTextSelected: {
    color: colors.textPrimary,
    fontWeight: '600',
  },
  workspaceModalCloseBtn: {
    alignSelf: 'flex-end',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginTop: spacing.xs,
  },
  workspaceModalCloseBtnPressed: {
    opacity: 0.85,
  },
  workspaceModalCloseText: {
    ...typography.caption,
    color: colors.textPrimary,
  },
});
