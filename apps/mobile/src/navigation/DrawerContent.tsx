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
import type { ChatEngine, ChatSummary, RpcNotification } from '../api/types';
import type { HostBridgeWsClient } from '../api/ws';
import { getChatEngineBadgeColors, getChatEngineLabel } from '../chatEngines';
import { BrandMark } from '../components/BrandMark';
import {
  DEFAULT_DRAWER_CHAT_ENGINES,
  filterDrawerChats,
  filterDrawerChatsByEngines,
} from './drawerChats';
import { describeAgentThreadSource } from '../screens/agentThreads';
import {
  buildChatWorkspaceSections,
  type ChatWorkspaceSection,
} from './chatThreadTree';
import { useAppTheme, type AppTheme } from '../theme';

type Screen = 'Main' | 'Browser' | 'Settings' | 'Privacy' | 'Terms';

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
const DRAWER_EVENT_REFRESH_DEBOUNCE_MS = 250;
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
const CHAT_FILTER_OPTIONS: ReadonlyArray<{
  key: ChatEngine;
  label: string;
}> = [
  {
    key: 'codex',
    label: 'Codex',
  },
  {
    key: 'opencode',
    label: 'OpenCode',
  },
];

export function DrawerContent({
  api,
  ws,
  selectedChatId,
  onSelectChat,
  onNewChat,
  onNavigate,
}: DrawerContentProps) {
  const theme = useAppTheme();
  const subAgentColor = theme.colors.warning;
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedChatEngines, setSelectedChatEngines] = useState<ChatEngine[]>(() => [
    ...DEFAULT_DRAWER_CHAT_ENGINES,
  ]);
  const [filterMenuVisible, setFilterMenuVisible] = useState(false);
  const [collapsedWorkspaceKeys, setCollapsedWorkspaceKeys] = useState<Set<string>>(new Set());
  const [runHeartbeatAtByThread, setRunHeartbeatAtByThread] = useState<Record<string, number>>({});
  const [wsConnected, setWsConnected] = useState(ws.isConnected);
  const hasAppliedInitialCollapseRef = useRef(false);
  const chatSectionsRef = useRef<ChatWorkspaceSection[]>([]);
  const loadChatsInFlightRef = useRef<Promise<void> | null>(null);
  const queuedLoadChatsRef = useRef<{ showRefresh: boolean } | null>(null);
  const scheduledLoadChatsRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const styles = useMemo(() => createStyles(theme), [theme]);
  const filteredChats = useMemo(
    () => filterDrawerChatsByEngines(chats, selectedChatEngines),
    [chats, selectedChatEngines]
  );
  const chatSections = useMemo(() => buildChatWorkspaceSections(filteredChats), [filteredChats]);
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

  const loadChatsNow = useCallback(async (showRefresh = false) => {
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
        let changed = false;
        const next: Record<string, number> = {};
        for (const [threadId, ts] of Object.entries(prev)) {
          if (!activeChatIds.has(threadId)) {
            changed = true;
            continue;
          }
          if (now - ts >= RUN_HEARTBEAT_STALE_MS) {
            changed = true;
            continue;
          }
          next[threadId] = ts;
        }
        return changed ? next : prev;
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

  const loadChats = useCallback(
    (showRefresh = false) => {
      if (showRefresh && scheduledLoadChatsRef.current) {
        clearTimeout(scheduledLoadChatsRef.current);
        scheduledLoadChatsRef.current = null;
      }

      if (loadChatsInFlightRef.current) {
        queuedLoadChatsRef.current = {
          showRefresh: showRefresh || queuedLoadChatsRef.current?.showRefresh === true,
        };
        return loadChatsInFlightRef.current;
      }

      const promise = loadChatsNow(showRefresh).finally(() => {
        loadChatsInFlightRef.current = null;
        const queuedRequest = queuedLoadChatsRef.current;
        queuedLoadChatsRef.current = null;
        if (queuedRequest) {
          void loadChats(queuedRequest.showRefresh);
        }
      });

      loadChatsInFlightRef.current = promise;
      return promise;
    },
    [loadChatsNow]
  );

  const scheduleLoadChats = useCallback(
    (delay = DRAWER_EVENT_REFRESH_DEBOUNCE_MS) => {
      if (scheduledLoadChatsRef.current) {
        return;
      }

      scheduledLoadChatsRef.current = setTimeout(() => {
        scheduledLoadChatsRef.current = null;
        void loadChats();
      }, delay);
    },
    [loadChats]
  );

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
        scheduleLoadChats();
      }
    });
  }, [scheduleLoadChats, ws]);

  useEffect(() => {
    return ws.onStatus((connected) => {
      setWsConnected(connected);
      if (connected) {
        scheduleLoadChats();
      }
    });
  }, [scheduleLoadChats, ws]);

  useEffect(() => {
    const timer = setInterval(() => {
      setRunHeartbeatAtByThread((prev) => {
        const now = Date.now();
        let changed = false;
        const next: Record<string, number> = {};
        for (const [threadId, ts] of Object.entries(prev)) {
          if (now - ts < RUN_HEARTBEAT_STALE_MS) {
            next[threadId] = ts;
          } else {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 5000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      scheduleLoadChats();
    }, wsConnected ? DRAWER_REFRESH_CONNECTED_MS : DRAWER_REFRESH_DISCONNECTED_MS);

    return () => clearInterval(timer);
  }, [scheduleLoadChats, wsConnected]);

  useEffect(() => {
    return () => {
      if (scheduledLoadChatsRef.current) {
        clearTimeout(scheduledLoadChatsRef.current);
        scheduledLoadChatsRef.current = null;
      }
    };
  }, []);

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
    setCollapsedWorkspaceKeys((prev) => {
      const validKeys = new Set(chatSections.map((section) => section.key));
      let changed = false;
      const next = new Set<string>();

      for (const key of prev) {
        if (validKeys.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      }

      const everySectionCollapsed =
        chatSections.length > 0 && chatSections.every((section) => next.has(section.key));
      if (everySectionCollapsed) {
        next.delete(chatSections[0]?.key ?? '');
        changed = true;
      }

      return changed ? next : prev;
    });
  }, [chatSections]);

  const filteredChatCount = filteredChats.length;
  const selectedChatEngineSet = useMemo(
    () => new Set(selectedChatEngines),
    [selectedChatEngines]
  );
  const hasFilteredEngines = selectedChatEngines.length < DEFAULT_DRAWER_CHAT_ENGINES.length;
  const singleSelectedEngine =
    selectedChatEngines.length === 1 ? selectedChatEngines[0] : null;
  const emptyTitle = singleSelectedEngine
    ? `No ${getChatEngineLabel(singleSelectedEngine)} chats`
    : 'No chats yet';
  const emptyHint = singleSelectedEngine
    ? `Turn ${getChatEngineLabel(
        singleSelectedEngine === 'codex' ? 'opencode' : 'codex'
      )} back on or start a new ${getChatEngineLabel(singleSelectedEngine)} chat.`
    : 'Start a new chat and it will show up here with live activity.';

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setCollapsedWorkspaceKeys(getDefaultCollapsedWorkspaceKeys(chatSectionsRef.current));
        hasAppliedInitialCollapseRef.current = true;
        scheduleLoadChats();
      }
    });

    return () => {
      subscription.remove();
    };
  }, [scheduleLoadChats]);

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

  const handleSelectChat = useCallback(
    (chatId: string) => {
      setFilterMenuVisible(false);
      onSelectChat(chatId);
    },
    [onSelectChat]
  );

  const handleNewChat = useCallback(() => {
    setFilterMenuVisible(false);
    onNewChat();
  }, [onNewChat]);

  const handleNavigate = useCallback(
    (screen: Screen) => {
      setFilterMenuVisible(false);
      onNavigate(screen);
    },
    [onNavigate]
  );

  const toggleChatEngineFilter = useCallback((engine: ChatEngine) => {
    setSelectedChatEngines((prev) => {
      const hasEngine = prev.includes(engine);
      if (hasEngine && prev.length === 1) {
        return prev;
      }

      const next = hasEngine
        ? prev.filter((entry) => entry !== engine)
        : [...prev, engine];

      return DEFAULT_DRAWER_CHAT_ENGINES.filter((entry) => next.includes(entry));
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
                  <Text style={styles.heroMeta} numberOfLines={1}>
                    {formatCompactCount(chats.length)} chats · {formatCompactCount(runningChatCount)} live
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
            </View>

            <View style={styles.actionRow}>
              <Pressable
                style={({ pressed }) => [
                  styles.primaryActionButton,
                  pressed && styles.primaryActionButtonPressed,
                ]}
                onPress={handleNewChat}
              >
                <Ionicons name="add" size={18} color={theme.colors.accentText} />
                <Text style={styles.primaryActionText}>New chat</Text>
              </Pressable>
              <Pressable
                accessibilityLabel="Open preview browser"
                style={({ pressed }) => [
                  styles.secondaryActionButton,
                  pressed && styles.secondaryActionButtonPressed,
                ]}
                onPress={() => handleNavigate('Browser')}
              >
                <Ionicons name="globe-outline" size={17} color={theme.colors.textPrimary} />
                <Text style={styles.secondaryActionText}>Browser</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Chats</Text>
            <View style={styles.sectionHeaderRight}>
              <View style={styles.filterMenuAnchor}>
                <Pressable
                  accessibilityLabel="Filter chat engines"
                  accessibilityRole="button"
                  hitSlop={6}
                  onPress={() => setFilterMenuVisible((prev) => !prev)}
                  style={({ pressed }) => [
                    styles.filterTriggerButton,
                    filterMenuVisible && styles.filterTriggerButtonOpen,
                    hasFilteredEngines && styles.filterTriggerButtonActive,
                    pressed && styles.filterTriggerButtonPressed,
                  ]}
                >
                  <Ionicons
                    name="funnel-outline"
                    size={14}
                    color={hasFilteredEngines || filterMenuVisible ? theme.colors.textPrimary : theme.colors.textMuted}
                  />
                </Pressable>
                {filterMenuVisible ? (
                  <View style={styles.filterPopover}>
                    {CHAT_FILTER_OPTIONS.map((option) => {
                      const selected = selectedChatEngineSet.has(option.key);
                      return (
                        <Pressable
                          key={option.key}
                          accessibilityLabel={`Toggle ${option.label} chats`}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: selected }}
                          onPress={() => toggleChatEngineFilter(option.key)}
                          style={({ pressed }) => [
                            styles.filterPopoverOption,
                            selected && styles.filterPopoverOptionSelected,
                            pressed && styles.filterPopoverOptionPressed,
                          ]}
                        >
                          <Text
                            style={[
                              styles.filterPopoverOptionText,
                              selected && styles.filterPopoverOptionTextSelected,
                            ]}
                          >
                            {option.label}
                          </Text>
                          {selected ? (
                            <Ionicons
                              name="checkmark"
                              size={14}
                              color={theme.colors.textPrimary}
                            />
                          ) : null}
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
              </View>
              <View style={styles.sectionCountBadge}>
                <Text style={styles.sectionCountText}>
                  {formatCompactCount(filteredChatCount)}
                </Text>
              </View>
            </View>
          </View>

          {loading ? (
            <View style={styles.emptyStateCard}>
              <ActivityIndicator color={theme.colors.textMuted} style={styles.loader} />
              <Text style={styles.emptyTitle}>Loading chats</Text>
              <Text style={styles.emptyHint}>Syncing recent threads from your bridge.</Text>
            </View>
          ) : chatSections.length === 0 ? (
            <View style={styles.emptyStateCard}>
              <View style={styles.emptyStateIconWrap}>
                <Ionicons
                  name="chatbubbles-outline"
                  size={18}
                  color={theme.colors.textPrimary}
                />
              </View>
              <Text style={styles.emptyTitle}>{emptyTitle}</Text>
              <Text style={styles.emptyHint}>{emptyHint}</Text>
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
                  tintColor={theme.colors.textMuted}
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
                          color={theme.colors.textMuted}
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
                const engineBadgeColors = getChatEngineBadgeColors(chat.engine, theme.mode);
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
                    onPress={() => handleSelectChat(chat.id)}
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
                            color={subAgentColor}
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
            onPress={() => handleNavigate('Settings')}
          >
            <Ionicons name="settings-outline" size={16} color={theme.colors.textPrimary} />
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

const createStyles = (theme: AppTheme) => {
  const connectionBadgeConnectedBg = theme.isDark
    ? 'rgba(52, 199, 89, 0.12)'
    : 'rgba(14, 159, 110, 0.16)';
  const connectionBadgeConnectedBorder = theme.isDark
    ? 'rgba(52, 199, 89, 0.32)'
    : 'rgba(14, 159, 110, 0.32)';
  const connectionBadgeDisconnectedBg = theme.isDark
    ? 'rgba(245, 158, 11, 0.12)'
    : 'rgba(197, 106, 18, 0.14)';
  const connectionBadgeDisconnectedBorder = theme.isDark
    ? 'rgba(245, 158, 11, 0.28)'
    : 'rgba(197, 106, 18, 0.28)';
  const connectionDotConnected = theme.isDark ? '#34C759' : theme.colors.statusComplete;
  const connectionDotDisconnected = theme.isDark ? '#F59E0B' : theme.colors.warning;
  const connectionTextConnected = theme.isDark ? '#8EE6AD' : '#0B7A55';
  const connectionTextDisconnected = theme.isDark ? '#F6C875' : '#9A4A0C';
  const subAgentAccent = theme.isDark
    ? 'rgba(245, 165, 36, 0.35)'
    : 'rgba(217, 119, 6, 0.22)';
  const subAgentPreview = theme.isDark
    ? 'rgba(245, 192, 106, 0.9)'
    : 'rgba(180, 83, 9, 0.82)';
  const runningPillBg = theme.isDark
    ? 'rgba(52, 199, 89, 0.12)'
    : 'rgba(14, 159, 110, 0.14)';
  const errorPillBg = theme.isDark
    ? 'rgba(239, 68, 68, 0.14)'
    : 'rgba(220, 38, 38, 0.10)';
  const runningPillText = theme.isDark ? '#8EE6AD' : '#0B7A55';
  const errorPillText = theme.isDark ? '#FFB4B4' : '#B91C1C';
  const cardShadow = theme.isDark
    ? '0 12px 28px rgba(0, 0, 0, 0.24)'
    : '0 12px 24px rgba(15, 23, 42, 0.10)';
  const drawerPrimaryActionBg = theme.isDark ? theme.colors.accent : '#3F4854';
  const drawerPrimaryActionPressed = theme.isDark ? theme.colors.accentPressed : '#2F3945';
  const drawerPrimaryActionBorder = theme.isDark
    ? theme.colors.accent
    : 'rgba(63, 72, 84, 0.18)';
  const drawerPrimaryActionShadow = theme.isDark
    ? undefined
    : '0 10px 20px rgba(47, 57, 69, 0.12)';

  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bgSidebar,
  },
  safeArea: {
    flex: 1,
  },
  mainContent: {
    flex: 1,
    minHeight: 0,
    position: 'relative',
  },
  topDeck: {
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.md,
    gap: theme.spacing.xs + 2,
  },
  heroCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgElevated,
    paddingHorizontal: theme.spacing.sm + 2,
    paddingVertical: theme.spacing.sm,
    boxShadow: cardShadow,
  },
  heroHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs + 2,
  },
  brandBadge: {
    width: 32,
    height: 32,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.bgItem,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
  },
  heroCopy: {
    flex: 1,
    gap: 2,
  },
  heroTitle: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  heroMeta: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontSize: 11,
    lineHeight: 14,
  },
  connectionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    borderWidth: 1,
  },
  connectionBadgeConnected: {
    backgroundColor: connectionBadgeConnectedBg,
    borderColor: connectionBadgeConnectedBorder,
  },
  connectionBadgeDisconnected: {
    backgroundColor: connectionBadgeDisconnectedBg,
    borderColor: connectionBadgeDisconnectedBorder,
  },
  connectionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  connectionDotConnected: {
    backgroundColor: connectionDotConnected,
  },
  connectionDotDisconnected: {
    backgroundColor: connectionDotDisconnected,
  },
  connectionText: {
    ...theme.typography.caption,
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  connectionTextConnected: {
    color: connectionTextConnected,
  },
  connectionTextDisconnected: {
    color: connectionTextDisconnected,
  },
  secondaryActionButton: {
    flex: 1,
    height: 42,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
  },
  secondaryActionButtonPressed: {
    backgroundColor: theme.colors.bgInput,
  },
  secondaryActionText: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  actionRow: {
    flexDirection: 'row',
    gap: theme.spacing.xs + 2,
  },
  primaryActionButton: {
    flex: 1,
    height: 42,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: drawerPrimaryActionBorder,
    backgroundColor: drawerPrimaryActionBg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    boxShadow: drawerPrimaryActionShadow,
  },
  primaryActionButtonPressed: {
    backgroundColor: drawerPrimaryActionPressed,
  },
  primaryActionText: {
    ...theme.typography.body,
    color: theme.colors.accentText,
    fontWeight: '700',
    fontSize: 14,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.lg,
    paddingBottom: theme.spacing.sm,
  },
  sectionHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    zIndex: 2,
  },
  sectionTitle: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
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
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionCountText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  filterMenuAnchor: {
    position: 'relative',
  },
  filterTriggerButton: {
    width: 30,
    height: 30,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterTriggerButtonOpen: {
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.bgInput,
  },
  filterTriggerButtonActive: {
    borderColor: theme.colors.borderHighlight,
  },
  filterTriggerButtonPressed: {
    opacity: 0.9,
  },
  filterPopover: {
    position: 'absolute',
    top: 36,
    right: 0,
    width: 156,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgElevated,
    padding: 6,
    gap: 4,
    shadowColor: theme.colors.shadow,
    shadowOpacity: 0.22,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
    zIndex: 6,
  },
  filterPopoverOption: {
    minHeight: 34,
    borderRadius: 10,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.xs,
  },
  filterPopoverOptionSelected: {
    backgroundColor: theme.colors.bgInput,
  },
  filterPopoverOptionPressed: {
    opacity: 0.9,
  },
  filterPopoverOptionText: {
    ...theme.typography.body,
    color: theme.colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  filterPopoverOptionTextSelected: {
    color: theme.colors.textPrimary,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: theme.spacing.lg,
  },
  loader: {
    marginBottom: theme.spacing.xs,
  },
  emptyStateCard: {
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.sm,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    padding: theme.spacing.md,
    alignItems: 'center',
    gap: theme.spacing.xs + 2,
  },
  emptyStateIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.bgInput,
  },
  emptyTitle: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  emptyHint: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 15,
  },
  workspaceGroupHeader: {
    marginHorizontal: theme.spacing.lg,
    paddingHorizontal: theme.spacing.sm + 2,
    paddingVertical: theme.spacing.sm,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
  },
  workspaceGroupHeaderExpanded: {
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xs,
  },
  workspaceGroupHeaderCollapsed: {
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.md,
  },
  workspaceGroupHeaderPressed: {
    backgroundColor: theme.colors.bgInput,
  },
  workspaceGroupHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  workspaceGroupTitleBlock: {
    flex: 1,
  },
  workspaceGroupTitle: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  workspaceGroupSubtitle: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontSize: 11,
    lineHeight: 14,
    marginTop: 2,
  },
  workspaceGroupCountBadge: {
    minWidth: 24,
    borderRadius: 999,
    backgroundColor: theme.colors.bgInput,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  workspaceGroupCountText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
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
    marginHorizontal: theme.spacing.lg,
    marginBottom: theme.spacing.xs,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    padding: theme.spacing.sm,
    flexDirection: 'row',
    gap: theme.spacing.xs + 2,
    alignItems: 'stretch',
  },
  chatItemSubAgent: {
    backgroundColor: theme.isDark ? 'rgba(255, 255, 255, 0.025)' : 'rgba(180, 83, 9, 0.04)',
  },
  chatItemLast: {
    marginBottom: theme.spacing.md,
  },
  chatItemSelected: {
    backgroundColor: theme.colors.bgInput,
    borderColor: theme.colors.borderHighlight,
  },
  chatItemPressed: {
    backgroundColor: theme.colors.bgInput,
  },
  chatItemAccent: {
    width: 4,
    borderRadius: 999,
    backgroundColor: theme.colors.bgCanvasAccent,
  },
  chatItemAccentSubAgent: {
    backgroundColor: subAgentAccent,
  },
  chatItemAccentSelected: {
    backgroundColor: theme.colors.textPrimary,
  },
  chatItemAccentRunning: {
    backgroundColor: theme.colors.statusRunning,
  },
  chatItemAccentError: {
    backgroundColor: theme.colors.statusError,
  },
  chatItemContent: {
    flex: 1,
    gap: 4,
  },
  chatItemTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs + 2,
  },
  chatSubAgentIcon: {
    marginRight: -2,
  },
  chatTitle: {
    ...theme.typography.body,
    flex: 1,
    color: theme.colors.textSecondary,
    fontSize: 14,
    fontWeight: '600',
  },
  chatTitleSubAgent: {
    color: theme.colors.warning,
  },
  chatTitleSelected: {
    color: theme.colors.textPrimary,
  },
  engineBadge: {
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 7,
    paddingVertical: 3,
    flexShrink: 0,
  },
  engineBadgeText: {
    ...theme.typography.caption,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  chatAge: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontSize: 10,
    lineHeight: 12,
    fontVariant: ['tabular-nums'],
    flexShrink: 0,
  },
  chatAgeSelected: {
    color: theme.colors.textSecondary,
  },
  chatItemBottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs + 2,
  },
  chatPreview: {
    ...theme.typography.caption,
    flex: 1,
    fontSize: 11,
    lineHeight: 14,
    color: theme.colors.textMuted,
  },
  chatPreviewSubAgent: {
    color: subAgentPreview,
  },
  chatPreviewSelected: {
    color: theme.colors.textMuted,
  },
  chatMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    flexShrink: 0,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    paddingHorizontal: theme.spacing.xs + 6,
    paddingVertical: 3,
  },
  statusPillRunning: {
    backgroundColor: runningPillBg,
  },
  statusPillError: {
    backgroundColor: errorPillBg,
  },
  statusPillText: {
    ...theme.typography.caption,
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
  },
  statusPillTextRunning: {
    color: runningPillText,
  },
  statusPillTextError: {
    color: errorPillText,
  },
  statusPillDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusPillDotRunning: {
    backgroundColor: connectionDotConnected,
  },
  footer: {
    marginTop: 'auto',
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.xs,
    paddingBottom: theme.spacing.sm,
  },
  footerSettingsButton: {
    height: 42,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
  },
  footerSettingsButtonPressed: {
    backgroundColor: theme.colors.bgInput,
  },
  footerSettingsText: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontSize: 11,
    lineHeight: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
});
};
