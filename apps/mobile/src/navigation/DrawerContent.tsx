import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { HostBridgeApiClient } from '../api/client';
import type { ChatSummary, RpcNotification } from '../api/types';
import type { HostBridgeWsClient } from '../api/ws';
import { getChatEngineBadgeColors, getChatEngineLabel } from '../chatEngines';
import { BrandMark } from '../components/BrandMark';
import { filterDrawerChats } from './drawerChats';
import { describeAgentThreadSource } from '../screens/agentThreads';
import {
  buildChatWorkspaceSections,
  type ChatWorkspaceSection,
} from './chatThreadTree';
import { colors, spacing, typography } from '../theme';

type Screen = 'Main' | 'Settings' | 'Privacy' | 'Terms';

interface DrawerContentProps {
  api: HostBridgeApiClient;
  ws: HostBridgeWsClient;
  selectedChatId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onNavigate: (screen: Screen) => void;
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
  onSelectChat,
  onNewChat,
  onNavigate,
}: DrawerContentProps) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [collapsedWorkspaceKeys, setCollapsedWorkspaceKeys] = useState<Set<string>>(new Set());
  const [runHeartbeatAtByThread, setRunHeartbeatAtByThread] = useState<Record<string, number>>({});
  const [wsConnected, setWsConnected] = useState(ws.isConnected);
  const hasAppliedInitialCollapseRef = useRef(false);
  const chatSectionsRef = useRef<ChatWorkspaceSection[]>([]);
  const chatSections = useMemo(() => buildChatWorkspaceSections(chats), [chats]);
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
  const runningChatCount = useMemo(() => {
    const now = Date.now();
    return chats.reduce((count, chat) => {
      const runningFromHeartbeat =
        (runHeartbeatAtByThread[chat.id] ?? 0) > now - RUN_HEARTBEAT_STALE_MS;
      return count + (chat.status === 'running' || runningFromHeartbeat ? 1 : 0);
    }, 0);
  }, [chats, runHeartbeatAtByThread]);

  const loadChats = useCallback(async (showRefresh = false) => {
    if (showRefresh) {
      setRefreshing(true);
    }

    try {
      const listedChats = await api.listChats();
      const listedChatIds = new Set(listedChats.map((chat) => chat.id));
      let loadedChats: ChatSummary[] = [];

      try {
        const loadedIds = await api.listLoadedChatIds();
        const missingIds = loadedIds.filter((threadId) => !listedChatIds.has(threadId));
        if (missingIds.length > 0) {
          const loadedResults = await Promise.allSettled(
            missingIds.map((threadId) => api.getChatSummary(threadId))
          );
          loadedChats = loadedResults.flatMap((result) =>
            result.status === 'fulfilled' ? [result.value] : []
          );
        }
      } catch {
        // Keep the drawer usable if loaded-thread hydration fails.
      }

      const dedupedChats = dedupeChatsById(filterDrawerChats([...listedChats, ...loadedChats]));
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
          <View style={styles.topDeck}>
            <View style={styles.heroCard}>
              <View style={styles.heroHeaderRow}>
                <View style={styles.brandBadge}>
                  <BrandMark size={18} />
                </View>
                <View style={styles.heroCopy}>
                  <Text style={styles.heroTitle}>Clawdex</Text>
                  <Text style={styles.heroSubtitle} numberOfLines={1}>
                    Threads, terminal, and git in a focused mobile control deck.
                  </Text>
                </View>
                <View
                  style={[
                    styles.connectionBadge,
                    wsConnected
                      ? styles.connectionBadgeConnected
                      : styles.connectionBadgeDisconnected,
                  ]}
                >
                  <View
                    style={[
                      styles.connectionDot,
                      wsConnected
                        ? styles.connectionDotConnected
                        : styles.connectionDotDisconnected,
                    ]}
                  />
                  <Text
                    style={[
                      styles.connectionText,
                      wsConnected
                        ? styles.connectionTextConnected
                        : styles.connectionTextDisconnected,
                    ]}
                  >
                    {wsConnected ? 'Live' : 'Offline'}
                  </Text>
                </View>
              </View>

              <View style={styles.heroStatsRow}>
                <View style={styles.heroStat}>
                  <Text style={styles.heroStatValue}>{formatCompactCount(chats.length)}</Text>
                  <Text style={styles.heroStatLabel}>Chats</Text>
                </View>
                <View style={styles.heroStatsDivider} />
                <View style={styles.heroStat}>
                  <Text style={styles.heroStatValue}>
                    {formatCompactCount(runningChatCount)}
                  </Text>
                  <Text style={styles.heroStatLabel}>Running</Text>
                </View>
                <View style={styles.heroStatsDivider} />
                <View style={styles.heroStat}>
                  <Text style={styles.heroStatValue}>
                    {formatCompactCount(chatSections.length)}
                  </Text>
                  <Text style={styles.heroStatLabel}>Spaces</Text>
                </View>
              </View>
            </View>

            <View style={styles.actionRow}>
              <Pressable
                style={({ pressed }) => [
                  styles.primaryActionButton,
                  pressed && styles.primaryActionButtonPressed,
                ]}
                onPress={onNewChat}
              >
                <Ionicons name="add" size={18} color={colors.black} />
                <Text style={styles.primaryActionText}>New chat</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Chats</Text>
            <View style={styles.sectionCountBadge}>
              <Text style={styles.sectionCountText}>
                {formatCompactCount(chats.length)}
              </Text>
            </View>
          </View>

          {loading ? (
            <View style={styles.emptyStateCard}>
              <ActivityIndicator color={colors.textMuted} style={styles.loader} />
              <Text style={styles.emptyTitle}>Loading chats</Text>
              <Text style={styles.emptyHint}>Syncing recent threads from your bridge.</Text>
            </View>
          ) : chatSections.length === 0 ? (
            <View style={styles.emptyStateCard}>
              <View style={styles.emptyStateIconWrap}>
                <Ionicons name="sparkles-outline" size={18} color={colors.textPrimary} />
              </View>
              <Text style={styles.emptyTitle}>No chats yet</Text>
              <Text style={styles.emptyHint}>
                Start a new chat and it will show up here with live activity.
              </Text>
            </View>
          ) : (
            <SectionList
              sections={visibleChatSections}
              keyExtractor={(item) => item.chat.id}
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
                      collapsed
                        ? styles.workspaceGroupHeaderCollapsed
                        : styles.workspaceGroupHeaderExpanded,
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
                      <View style={styles.workspaceGroupCountBadge}>
                        <Text style={styles.workspaceGroupCountText}>
                          {formatCompactCount(section.itemCount)}
                        </Text>
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
                const chat = item.chat;
                const isSelected = chat.id === selectedChatId;
                const isLast = index === section.data.length - 1;
                const isRunningFromHeartbeat =
                  (runHeartbeatAtByThread[chat.id] ?? 0) > Date.now() - RUN_HEARTBEAT_STALE_MS;
                const isRunning = chat.status === 'running' || isRunningFromHeartbeat;
                const isSubAgent = item.indentLevel > 0 || Boolean(chat.parentThreadId);
                const previewText = isSubAgent
                  ? `${describeAgentThreadSource(chat, item.rootThreadId)} • ${formatChatPreview(chat)}`
                  : formatChatPreview(chat);
                const engineBadgeColors = getChatEngineBadgeColors(chat.engine);
                return (
                  <Pressable
                    style={({ pressed }) => [
                      styles.chatItem,
                      isSubAgent && styles.chatItemSubAgent,
                      isSubAgent && { marginLeft: Math.min(item.indentLevel, 4) * 18 },
                      isSelected && styles.chatItemSelected,
                      pressed && styles.chatItemPressed,
                      isLast && styles.chatItemLast,
                    ]}
                    onPress={() => onSelectChat(chat.id)}
                  >
                    <View
                      style={[
                        styles.chatItemAccent,
                        isSubAgent && styles.chatItemAccentSubAgent,
                        isSelected && styles.chatItemAccentSelected,
                        isRunning && styles.chatItemAccentRunning,
                        chat.status === 'error' && styles.chatItemAccentError,
                      ]}
                    />
                    <View style={styles.chatItemContent}>
                      <View style={styles.chatItemTopRow}>
                        {isSubAgent ? (
                          <Ionicons
                            name="git-branch-outline"
                            size={12}
                            color="#F5A524"
                            style={styles.chatSubAgentIcon}
                          />
                        ) : null}
                        <Text
                          style={[
                            styles.chatTitle,
                            isSubAgent && styles.chatTitleSubAgent,
                            isSelected && styles.chatTitleSelected,
                          ]}
                          numberOfLines={1}
                        >
                          {chat.title || 'Untitled'}
                        </Text>
                        <View
                          style={[
                            styles.engineBadge,
                            {
                              backgroundColor: engineBadgeColors.backgroundColor,
                              borderColor: engineBadgeColors.borderColor,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.engineBadgeText,
                              {
                                color: engineBadgeColors.textColor,
                              },
                            ]}
                          >
                            {getChatEngineLabel(chat.engine)}
                          </Text>
                        </View>
                        <Text
                          style={[styles.chatAge, isSelected && styles.chatAgeSelected]}
                        >
                          {relativeTime(chat.updatedAt)}
                        </Text>
                      </View>
                      <View style={styles.chatItemBottomRow}>
                        <Text
                          style={[
                            styles.chatPreview,
                            isSubAgent && styles.chatPreviewSubAgent,
                            isSelected && styles.chatPreviewSelected,
                          ]}
                          numberOfLines={1}
                        >
                          {previewText}
                        </Text>
                        {isRunning ? (
                          <View style={styles.chatMeta}>
                            <View style={[styles.statusPill, styles.statusPillRunning]}>
                              <View
                                style={[styles.statusPillDot, styles.statusPillDotRunning]}
                              />
                              <Text
                                style={[styles.statusPillText, styles.statusPillTextRunning]}
                              >
                                Live
                              </Text>
                            </View>
                          </View>
                        ) : chat.status === 'error' ? (
                          <View style={styles.chatMeta}>
                            <View style={[styles.statusPill, styles.statusPillError]}>
                              <Text
                                style={[styles.statusPillText, styles.statusPillTextError]}
                              >
                                Error
                              </Text>
                            </View>
                          </View>
                        ) : null}
                      </View>
                    </View>
                  </Pressable>
                );
              }}
            />
          )}
        </View>

        <View style={styles.footer}>
          <Pressable
            accessibilityLabel="Open settings"
            style={({ pressed }) => [
              styles.footerSettingsButton,
              pressed && styles.footerSettingsButtonPressed,
            ]}
            onPress={() => onNavigate('Settings')}
          >
            <Ionicons name="settings-outline" size={16} color={colors.textPrimary} />
            <Text style={styles.footerSettingsText}>Settings</Text>
          </Pressable>
        </View>

      </SafeAreaView>
    </View>
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

function getDefaultCollapsedWorkspaceKeys(sections: ChatWorkspaceSection[]): Set<string> {
  const collapsed = new Set<string>();
  for (let i = 1; i < sections.length; i += 1) {
    collapsed.add(sections[i].key);
  }
  return collapsed;
}

function relativeTime(iso: string): string {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  const weeks = Math.floor(days / 7);

  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  if (weeks < 5) return `${weeks}w`;
  return `${Math.floor(days / 30)}mo`;
}

function formatCompactCount(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`;
  }

  return String(value);
}

function formatChatPreview(chat: ChatSummary): string {
  const preview = chat.lastMessagePreview.trim();
  if (preview.length > 0) {
    return preview;
  }

  const errorPreview = chat.lastError?.trim();
  if (errorPreview) {
    return errorPreview;
  }

  if (chat.status === 'running') {
    return 'Run in progress';
  }

  return 'No messages yet';
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
    backgroundColor: colors.bgMain,
  },
  safeArea: {
    flex: 1,
  },
  mainContent: {
    flex: 1,
    minHeight: 0,
  },
  topDeck: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    gap: spacing.xs + 2,
  },
  heroCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.09)',
    backgroundColor: '#090C10',
    padding: spacing.sm + 2,
    gap: spacing.sm,
  },
  heroHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs + 2,
  },
  brandBadge: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#14181D',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  heroCopy: {
    flex: 1,
    gap: 2,
  },
  heroTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  heroSubtitle: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 14,
  },
  connectionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderWidth: 1,
  },
  connectionBadgeConnected: {
    backgroundColor: 'rgba(52, 199, 89, 0.12)',
    borderColor: 'rgba(52, 199, 89, 0.32)',
  },
  connectionBadgeDisconnected: {
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    borderColor: 'rgba(245, 158, 11, 0.28)',
  },
  connectionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  connectionDotConnected: {
    backgroundColor: '#34C759',
  },
  connectionDotDisconnected: {
    backgroundColor: '#F59E0B',
  },
  connectionText: {
    ...typography.caption,
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  connectionTextConnected: {
    color: '#8EE6AD',
  },
  connectionTextDisconnected: {
    color: '#F6C875',
  },
  heroStatsRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: 14,
    backgroundColor: '#050608',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
    overflow: 'hidden',
  },
  heroStat: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    paddingVertical: spacing.sm,
  },
  heroStatValue: {
    ...typography.body,
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  heroStatLabel: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 10,
    lineHeight: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  heroStatsDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.xs + 2,
  },
  primaryActionButton: {
    flex: 1,
    height: 42,
    borderRadius: 14,
    backgroundColor: '#F2F4F8',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  primaryActionButtonPressed: {
    opacity: 0.9,
  },
  primaryActionText: {
    ...typography.body,
    color: colors.black,
    fontWeight: '700',
    fontSize: 14,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  sectionTitle: {
    ...typography.caption,
    color: colors.textMuted,
    textTransform: 'uppercase',
    fontSize: 10,
    lineHeight: 12,
    letterSpacing: 0.9,
    fontWeight: '700',
  },
  sectionCountBadge: {
    minWidth: 24,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    backgroundColor: '#101317',
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionCountText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: spacing.lg,
  },
  loader: {
    marginBottom: spacing.xs,
  },
  emptyStateCard: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    backgroundColor: '#0B0D10',
    padding: spacing.md,
    alignItems: 'center',
    gap: spacing.xs + 2,
  },
  emptyStateIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#11151A',
  },
  emptyTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  emptyHint: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 15,
  },
  workspaceGroupHeader: {
    marginHorizontal: spacing.lg,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.sm,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    backgroundColor: '#0C0F13',
  },
  workspaceGroupHeaderExpanded: {
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  workspaceGroupHeaderCollapsed: {
    marginTop: spacing.xs,
    marginBottom: spacing.md,
  },
  workspaceGroupHeaderPressed: {
    backgroundColor: '#14181D',
  },
  workspaceGroupHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  workspaceGroupTitleBlock: {
    flex: 1,
  },
  workspaceGroupTitle: {
    ...typography.body,
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  workspaceGroupSubtitle: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 14,
    marginTop: 2,
  },
  workspaceGroupCountBadge: {
    minWidth: 24,
    borderRadius: 999,
    backgroundColor: '#161B20',
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  workspaceGroupCountText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  workspaceGroupHeaderMeta: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  chatItem: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.xs,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
    backgroundColor: '#080A0D',
    padding: spacing.sm,
    flexDirection: 'row',
    gap: spacing.xs + 2,
    alignItems: 'stretch',
  },
  chatItemSubAgent: {
    backgroundColor: 'rgba(255, 255, 255, 0.025)',
  },
  chatItemLast: {
    marginBottom: spacing.md,
  },
  chatItemSelected: {
    backgroundColor: '#11151A',
    borderColor: 'rgba(255, 255, 255, 0.18)',
  },
  chatItemPressed: {
    backgroundColor: '#0E1216',
  },
  chatItemAccent: {
    width: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  chatItemAccentSubAgent: {
    backgroundColor: 'rgba(245, 165, 36, 0.35)',
  },
  chatItemAccentSelected: {
    backgroundColor: colors.textPrimary,
  },
  chatItemAccentRunning: {
    backgroundColor: colors.statusRunning,
  },
  chatItemAccentError: {
    backgroundColor: colors.statusError,
  },
  chatItemContent: {
    flex: 1,
    gap: 4,
  },
  chatItemTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
  },
  chatSubAgentIcon: {
    marginRight: -2,
  },
  chatTitle: {
    ...typography.body,
    flex: 1,
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
  chatTitleSubAgent: {
    color: '#F5C06A',
  },
  chatTitleSelected: {
    color: colors.textPrimary,
  },
  engineBadge: {
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 6,
    paddingVertical: 2,
    flexShrink: 0,
  },
  engineBadgeText: {
    ...typography.caption,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  chatAge: {
    ...typography.caption,
    color: colors.textMuted,
    fontSize: 10,
    lineHeight: 12,
    fontVariant: ['tabular-nums'],
    flexShrink: 0,
  },
  chatAgeSelected: {
    color: colors.textSecondary,
  },
  chatItemBottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
  },
  chatPreview: {
    ...typography.caption,
    flex: 1,
    fontSize: 11,
    lineHeight: 14,
    color: 'rgba(232, 236, 244, 0.56)',
  },
  chatPreviewSubAgent: {
    color: 'rgba(245, 192, 106, 0.9)',
  },
  chatPreviewSelected: {
    color: colors.textMuted,
  },
  chatMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 0,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    paddingHorizontal: spacing.xs + 6,
    paddingVertical: 3,
  },
  statusPillRunning: {
    backgroundColor: 'rgba(52, 199, 89, 0.12)',
  },
  statusPillError: {
    backgroundColor: 'rgba(239, 68, 68, 0.14)',
  },
  statusPillText: {
    ...typography.caption,
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
  },
  statusPillTextRunning: {
    color: '#8EE6AD',
  },
  statusPillTextError: {
    color: '#FFB4B4',
  },
  statusPillDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusPillDotRunning: {
    backgroundColor: '#34C759',
  },
  footer: {
    marginTop: 'auto',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
  },
  footerSettingsButton: {
    height: 42,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
    backgroundColor: '#101317',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  footerSettingsButtonPressed: {
    backgroundColor: '#171B20',
  },
  footerSettingsText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontSize: 11,
    lineHeight: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
});
