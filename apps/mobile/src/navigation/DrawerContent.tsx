import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Modal,
  Pressable,
  RefreshControl,
  SafeAreaView,
  SectionList,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  type ViewStyle,
  View,
} from 'react-native';
import type { HostBridgeApiClient } from '../api/client';
import type { ChatSummary, RpcNotification } from '../api/types';
import type { HostBridgeWsClient } from '../api/ws';
import { BrandMark } from '../components/BrandMark';
import { colors, spacing, typography } from '../theme';

type Screen = 'Main' | 'Settings' | 'Privacy' | 'Terms';

interface DrawerContentProps {
  api: HostBridgeApiClient;
  ws: HostBridgeWsClient;
  selectedChatId: string | null;
  selectedDefaultCwd: string | null;
  onSelectDefaultCwd: (cwd: string | null) => void;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onNavigate: (screen: Screen) => void;
}

interface ChatWorkspaceSection {
  key: string;
  title: string;
  subtitle?: string;
  data: ChatSummary[];
}

const RUN_HEARTBEAT_STALE_MS = 20_000;
const DRAWER_REFRESH_CONNECTED_MS = 10_000;
const DRAWER_REFRESH_DISCONNECTED_MS = 5_000;
const RUN_HEARTBEAT_EVENT_TYPES = new Set([
  'task_started',
  'agent_reasoning_delta',
  'reasoning_content_delta',
  'reasoning_raw_content_delta',
  'agent_reasoning_raw_content_delta',
  'agent_reasoning_section_break',
  'agent_message_delta',
  'agent_message_content_delta',
  'exec_command_begin',
  'exec_command_end',
  'mcp_startup_update',
  'mcp_tool_call_begin',
  'web_search_begin',
  'background_event',
]);

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
  const [refreshing, setRefreshing] = useState(false);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [collapsedWorkspaceKeys, setCollapsedWorkspaceKeys] = useState<Set<string>>(new Set());
  const [runHeartbeatAtByThread, setRunHeartbeatAtByThread] = useState<Record<string, number>>({});
  const [wsConnected, setWsConnected] = useState(ws.isConnected);
  const hasAppliedInitialCollapseRef = useRef(false);
  const chatSectionsRef = useRef<ChatWorkspaceSection[]>([]);
  const workspaceOptions = useMemo(() => listWorkspaces(chats), [chats]);
  const chatSections = useMemo(() => buildWorkspaceSections(chats), [chats]);
  const visibleChatSections = useMemo(
    () =>
      chatSections.map((section) =>
        collapsedWorkspaceKeys.has(section.key)
          ? {
              ...section,
              data: [],
            }
          : section
      ),
    [chatSections, collapsedWorkspaceKeys]
  );
  const defaultWorkspaceLabel =
    normalizeCwd(selectedDefaultCwd) ?? 'Bridge default workspace';

  const loadChats = useCallback(async (showRefresh = false) => {
    if (showRefresh) {
      setRefreshing(true);
    }

    try {
      const data = await api.listChats();
      const dedupedChats = dedupeChatsById(data);
      setChats(sortChats(dedupedChats));
      const activeChatIds = new Set(dedupedChats.map((chat) => chat.id));
      setRunHeartbeatAtByThread((prev) => {
        const now = Date.now();
        const next: Record<string, number> = {};
        for (const [threadId, ts] of Object.entries(prev)) {
          if (!activeChatIds.has(threadId)) {
            continue;
          }
          if (now - ts >= RUN_HEARTBEAT_STALE_MS) {
            continue;
          }
          next[threadId] = ts;
        }
        return next;
      });
    } catch {
      // silently fail
    } finally {
      if (showRefresh) {
        setRefreshing(false);
      }
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadChats();
  }, [loadChats]);

  useEffect(() => {
    return ws.onEvent((event: RpcNotification) => {
      const threadIdFromEvent = extractThreadId(event);
      const markThreadRunning = (threadId: string | null) => {
        if (!threadId) {
          return;
        }
        setRunHeartbeatAtByThread((prev) => ({
          ...prev,
          [threadId]: Date.now(),
        }));
      };
      const clearThreadRunning = (threadId: string | null) => {
        if (!threadId) {
          return;
        }
        setRunHeartbeatAtByThread((prev) => {
          if (!(threadId in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next[threadId];
          return next;
        });
      };

      if (
        event.method === 'turn/started' ||
        event.method === 'item/started' ||
        event.method === 'item/agentMessage/delta' ||
        event.method === 'item/plan/delta' ||
        event.method === 'item/reasoning/summaryPartAdded' ||
        event.method === 'item/reasoning/summaryTextDelta' ||
        event.method === 'item/reasoning/textDelta' ||
        event.method === 'item/commandExecution/outputDelta' ||
        event.method === 'item/mcpToolCall/progress' ||
        event.method === 'turn/plan/updated' ||
        event.method === 'turn/diff/updated'
      ) {
        markThreadRunning(threadIdFromEvent);
      }

      if (event.method === 'turn/completed') {
        clearThreadRunning(threadIdFromEvent);
      }

      if (event.method.startsWith('codex/event/')) {
        const params = toRecord(event.params);
        const msg = toRecord(params?.msg);
        const codexEventType =
          readString(msg?.type) ?? event.method.replace('codex/event/', '');
        const scopedThreadId = threadIdFromEvent;

        if (RUN_HEARTBEAT_EVENT_TYPES.has(codexEventType)) {
          markThreadRunning(scopedThreadId);
        } else if (codexEventType === 'task_complete' || codexEventType === 'turn_aborted') {
          clearThreadRunning(scopedThreadId);
        }
      }

      if (
        event.method === 'thread/started' ||
        event.method === 'turn/started' ||
        event.method === 'thread/name/updated' ||
        event.method === 'turn/completed' ||
        event.method === 'thread/status/changed'
      ) {
        void loadChats();
      }
    });
  }, [ws, loadChats]);

  useEffect(() => {
    return ws.onStatus((connected) => {
      setWsConnected(connected);
      if (connected) {
        void loadChats();
      }
    });
  }, [ws, loadChats]);

  useEffect(() => {
    const timer = setInterval(() => {
      setRunHeartbeatAtByThread((prev) => {
        const now = Date.now();
        const next: Record<string, number> = {};
        for (const [threadId, ts] of Object.entries(prev)) {
          if (now - ts < RUN_HEARTBEAT_STALE_MS) {
            next[threadId] = ts;
          }
        }
        return next;
      });
    }, 5000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      void loadChats();
    }, wsConnected ? DRAWER_REFRESH_CONNECTED_MS : DRAWER_REFRESH_DISCONNECTED_MS);

    return () => clearInterval(timer);
  }, [loadChats, wsConnected]);

  useEffect(() => {
    chatSectionsRef.current = chatSections;
  }, [chatSections]);

  useEffect(() => {
    if (chatSections.length === 0 || hasAppliedInitialCollapseRef.current) {
      return;
    }

    setCollapsedWorkspaceKeys(getDefaultCollapsedWorkspaceKeys(chatSections));
    hasAppliedInitialCollapseRef.current = true;
  }, [chatSections]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setCollapsedWorkspaceKeys(getDefaultCollapsedWorkspaceKeys(chatSectionsRef.current));
        hasAppliedInitialCollapseRef.current = true;
        void loadChats();
      }
    });

    return () => {
      subscription.remove();
    };
  }, [loadChats]);

  const toggleWorkspaceSection = useCallback((sectionKey: string) => {
    setCollapsedWorkspaceKeys((prev) => {
      const next = new Set(prev);
      if (next.has(sectionKey)) {
        next.delete(sectionKey);
      } else {
        next.add(sectionKey);
      }
      return next;
    });
  }, []);

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

          {/* Chats section */}
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Chats</Text>
          </View>

          {loading ? (
            <ActivityIndicator color={colors.textMuted} style={styles.loader} />
          ) : chatSections.length === 0 ? (
            <Text style={styles.emptyText}>No chats yet</Text>
          ) : (
            <SectionList
              sections={visibleChatSections}
              keyExtractor={(item) => item.id}
              style={styles.list}
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={false}
              stickySectionHeadersEnabled={false}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => {
                    void loadChats(true);
                  }}
                  tintColor={colors.textMuted}
                />
              }
              renderSectionHeader={({ section }) => {
                const collapsed = collapsedWorkspaceKeys.has(section.key);
                return (
                  <Pressable
                    style={({ pressed }) => [
                      styles.workspaceGroupHeader,
                      collapsed ? styles.workspaceGroupHeaderCollapsed : styles.workspaceGroupHeaderExpanded,
                      pressed && styles.workspaceGroupHeaderPressed,
                    ]}
                    onPress={() => toggleWorkspaceSection(section.key)}
                  >
                    <View style={styles.workspaceGroupHeaderRow}>
                      <View style={styles.workspaceGroupTitleBlock}>
                        <Text style={styles.workspaceGroupTitle} numberOfLines={1}>
                          {section.title}
                        </Text>
                        {section.subtitle ? (
                          <Text style={styles.workspaceGroupSubtitle} numberOfLines={1}>
                            {section.subtitle}
                          </Text>
                        ) : null}
                      </View>
                      <View style={styles.workspaceGroupHeaderMeta}>
                        <Ionicons
                          name={collapsed ? 'chevron-forward' : 'chevron-down'}
                          size={14}
                          color={colors.textMuted}
                        />
                      </View>
                    </View>
                  </Pressable>
                );
              }}
              renderItem={({ item, index, section }) => {
                const isSelected = item.id === selectedChatId;
                const isLast = index === section.data.length - 1;
                const isRunningFromHeartbeat =
                  (runHeartbeatAtByThread[item.id] ?? 0) > Date.now() - RUN_HEARTBEAT_STALE_MS;
                const isRunning = item.status === 'running' || isRunningFromHeartbeat;
                return (
                  <Pressable
                    style={({ pressed }) => [
                      styles.chatItem,
                      isLast && styles.chatItemLast,
                      isSelected && styles.chatItemSelected,
                      pressed && styles.chatItemPressed,
                    ]}
                    onPress={() => onSelectChat(item.id)}
                  >
                    <Text style={[styles.chatTitle, isSelected && styles.chatTitleSelected]} numberOfLines={1}>
                      {item.title || 'Untitled'}
                    </Text>
                    <View style={styles.chatMeta}>
                      {isRunning ? (
                        <ActivityIndicator
                          size="small"
                          color={colors.statusRunning}
                          style={styles.chatSpinner}
                        />
                      ) : null}
                      <Text style={styles.chatAge}>{relativeTime(item.updatedAt)}</Text>
                    </View>
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
            pressableStyle={styles.footerNavItem}
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
  pressableStyle,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  pressableStyle?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={style}>
      <Pressable
        style={({ pressed }) => [
          styles.navItem,
          pressableStyle,
          pressed && styles.navItemPressed,
        ]}
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

function dedupeChatsById(chats: ChatSummary[]): ChatSummary[] {
  const byId = new Map<string, ChatSummary>();

  for (const chat of chats) {
    const existing = byId.get(chat.id);
    if (!existing || chat.updatedAt.localeCompare(existing.updatedAt) > 0) {
      byId.set(chat.id, chat);
    }
  }

  return Array.from(byId.values());
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

const DEFAULT_WORKSPACE_KEY = '__bridge_default_workspace__';

function workspaceKey(cwd: string | null): string {
  return cwd ?? DEFAULT_WORKSPACE_KEY;
}

function workspaceTitle(cwd: string | null): string {
  if (!cwd) {
    return 'Bridge default workspace';
  }

  const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) {
    return cwd;
  }

  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash === -1) {
    return normalized;
  }

  return normalized.slice(lastSlash + 1) || normalized;
}

function workspaceSubtitle(cwd: string | null): string | undefined {
  if (!cwd) {
    return undefined;
  }

  return cwd;
}

function buildWorkspaceSections(chats: ChatSummary[]): ChatWorkspaceSection[] {
  if (chats.length === 0) {
    return [];
  }

  const sorted = sortChats(chats);
  const byWorkspace = new Map<
    string,
    {
      cwd: string | null;
      chats: ChatSummary[];
    }
  >();

  for (const chat of sorted) {
    const cwd = normalizeCwd(chat.cwd);
    const key = workspaceKey(cwd);
    const bucket = byWorkspace.get(key);
    if (bucket) {
      bucket.chats.push(chat);
      continue;
    }

    byWorkspace.set(key, {
      cwd,
      chats: [chat],
    });
  }

  return Array.from(byWorkspace.entries())
    .sort(([, a], [, b]) => {
      const aUpdatedAt = a.chats[0]?.updatedAt ?? '';
      const bUpdatedAt = b.chats[0]?.updatedAt ?? '';
      return bUpdatedAt.localeCompare(aUpdatedAt);
    })
    .map(([key, bucket]) => ({
      key,
      title: workspaceTitle(bucket.cwd),
      subtitle: workspaceSubtitle(bucket.cwd),
      data: bucket.chats,
    }));
}

function getDefaultCollapsedWorkspaceKeys(sections: ChatWorkspaceSection[]): Set<string> {
  const collapsed = new Set<string>();
  for (let i = 1; i < sections.length; i += 1) {
    collapsed.add(sections[i].key);
  }
  return collapsed;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1d';
  return `${days}d`;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function extractThreadId(event: RpcNotification): string | null {
  const params = toRecord(event.params);
  const msg = toRecord(params?.msg);
  return (
    readString(params?.threadId) ??
    readString(params?.thread_id) ??
    readString(msg?.thread_id) ??
    readString(msg?.threadId) ??
    readString(params?.conversationId) ??
    readString(msg?.conversation_id)
  );
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
  listContent: {
    paddingBottom: spacing.md,
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
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: colors.bgItem,
  },
  chatItemLast: {
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    marginBottom: spacing.sm,
  },
  chatItemSelected: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  chatItemPressed: {
    opacity: 0.88,
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
  chatMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 0,
  },
  chatSpinner: {
    marginRight: 2,
  },
  workspaceGroupHeader: {
    marginHorizontal: spacing.md,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: '#15181D',
  },
  workspaceGroupHeaderExpanded: {
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  workspaceGroupHeaderCollapsed: {
    borderRadius: 12,
    marginBottom: spacing.sm,
  },
  workspaceGroupHeaderPressed: {
    opacity: 0.8,
  },
  workspaceGroupHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  workspaceGroupTitleBlock: {
    flex: 1,
  },
  workspaceGroupTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  workspaceGroupSubtitle: {
    ...typography.caption,
    color: colors.textMuted,
    marginTop: 1,
  },
  workspaceGroupHeaderMeta: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  settingsItem: {
    marginBottom: 0,
  },
  footerNavItem: {
    marginBottom: 0,
  },
  footer: {
    marginTop: 'auto',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
    paddingTop: spacing.md,
    paddingBottom: 0,
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
