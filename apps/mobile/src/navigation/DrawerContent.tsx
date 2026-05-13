import { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ActionSheetIOS,
  Alert,
  AppState,
  Platform,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { HostBridgeApiClient } from '../api/client';
import type { ChatEngine, ChatSummary, RpcNotification } from '../api/types';
import type { HostBridgeWsClient } from '../api/ws';
import { getChatEngineLabel, resolveChatEngine } from '../chatEngines';
import { BrandMark } from '../components/BrandMark';
import { ChatEngineIcon } from '../components/ChatEngineIcon';
import {
  DEFAULT_DRAWER_CHAT_ENGINES,
  filterDrawerChats,
  filterDrawerChatsByEngines,
  searchDrawerChats,
} from './drawerChats';
import {
  buildChatWorkspaceSections,
  type ChatWorkspaceSection,
} from './chatThreadTree';
import {
  DEFAULT_WORKSPACE_CHAT_LIMIT,
  type WorkspaceChatLimit,
} from '../appSettings';
import {
  countDrawerRunningChats,
  isDrawerChatRunning,
  isDrawerWorkspaceSectionRunning,
  pruneStaleDrawerRunIndicators,
  reconcileDrawerRunIndicatorsWithChats,
  updateDrawerRunIndicatorsForEvent,
  type DrawerRunIndicatorMap,
} from './drawerRuntimeIndicators';
import { useAppTheme, type AppTheme } from '../theme';

type Screen = 'Main' | 'Browser' | 'Settings' | 'Privacy' | 'Terms';

interface DrawerContentProps {
  api: HostBridgeApiClient;
  ws: HostBridgeWsClient;
  active: boolean;
  workspaceChatLimit?: WorkspaceChatLimit;
  selectedChatId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onNavigate: (screen: Screen) => void;
}

const DRAWER_REFRESH_CONNECTED_MS = 10_000;
const DRAWER_REFRESH_DISCONNECTED_MS = 5_000;
const DRAWER_EVENT_REFRESH_DEBOUNCE_MS = 250;
const DRAWER_OPEN_STALE_REFRESH_MS = 15_000;
const DRAWER_CHAT_CACHE_TTL_MS = 30_000;
const DRAWER_FAST_CHAT_LIST_LIMIT = 5;
const DRAWER_FULL_CHAT_LIST_LIMIT = 20;
const DRAWER_STREAM_CHAT_LIST_LIMITS = [DRAWER_FAST_CHAT_LIST_LIMIT, DRAWER_FULL_CHAT_LIST_LIMIT, 50];
const DRAWER_STREAM_BATCH_DELAY_MS = 900;
const DRAWER_DEEP_CHAT_PAGE_LIMIT = 50;
const DRAWER_DEEP_LOAD_DELAY_MS = 2500;
const DRAWER_DEEP_CHAT_CACHE_TTL_MS = Number.MAX_SAFE_INTEGER;
const PINNED_CHAT_IDS_FILE = 'clawdex-pinned-chats.json';
const PINNED_WORKSPACE_PATHS_FILE = 'clawdex-workspace-favorites.json';
const PINNED_WORKSPACE_PATHS_VERSION = 1;
const PINNED_WORKSPACE_PATHS_LIMIT = 4;
const DRAWER_WORKSPACE_ROW_HEIGHT = 58;
const DRAWER_CHAT_ROW_HEIGHT = 50;
const DRAWER_ROW_RADIUS = 14;
const DRAWER_ACTION_HEIGHT = 36;
const DRAWER_FOOTER_ACTION_HEIGHT = 52;
const DRAWER_ICON_TILE_SIZE = 26;
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
  {
    key: 'cursor',
    label: 'Cursor',
  },
];

export const DrawerContent = memo(function DrawerContentComponent({
  api,
  ws,
  active,
  workspaceChatLimit = DEFAULT_WORKSPACE_CHAT_LIMIT,
  selectedChatId,
  onSelectChat,
  onNewChat,
  onNavigate,
}: DrawerContentProps) {
  const theme = useAppTheme();
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlderChats, setLoadingOlderChats] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedChatEngines, setSelectedChatEngines] = useState<ChatEngine[]>(() => [
    ...DEFAULT_DRAWER_CHAT_ENGINES,
  ]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMenuVisible, setFilterMenuVisible] = useState(false);
  const [collapsedWorkspaceKeys, setCollapsedWorkspaceKeys] = useState<Set<string>>(new Set());
  const [pinnedChatIds, setPinnedChatIds] = useState<string[]>([]);
  const [pinnedWorkspacePaths, setPinnedWorkspacePaths] = useState<string[]>([]);
  const [workspaceVisibleCounts, setWorkspaceVisibleCounts] = useState<Record<string, number>>({});
  const [runIndicatorsByThread, setRunIndicatorsByThread] = useState<DrawerRunIndicatorMap>({});
  const [wsConnected, setWsConnected] = useState(ws.isConnected);
  const hasAppliedInitialCollapseRef = useRef(false);
  const knownWorkspaceKeysRef = useRef<Set<string>>(new Set());
  const chatSectionsRef = useRef<ChatWorkspaceSection[]>([]);
  const loadChatsInFlightRef = useRef<Promise<void> | null>(null);
  const queuedLoadChatsRef = useRef<{ showRefresh: boolean; forceRefresh: boolean } | null>(
    null
  );
  const scheduledLoadChatsRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduledLoadChatsForceRefreshRef = useRef(false);
  const scheduledDeepLoadChatsRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatListStreamRef = useRef<{ cancel: () => void } | null>(null);
  const deepLoadInFlightRef = useRef<Promise<void> | null>(null);
  const hasLoadedDeepChatListRef = useRef(false);
  const hasHydratedOnceRef = useRef(false);
  const lastLoadedAtRef = useRef(0);
  const activeRef = useRef(active);
  const chatsRef = useRef<ChatSummary[]>([]);
  const styles = useMemo(() => createStyles(theme), [theme]);
  const engineFilteredChats = useMemo(
    () => filterDrawerChatsByEngines(chats, selectedChatEngines),
    [chats, selectedChatEngines]
  );
  const filteredChats = useMemo(
    () => searchDrawerChats(engineFilteredChats, searchQuery),
    [engineFilteredChats, searchQuery]
  );
  const pinnedChatIdSet = useMemo(() => new Set(pinnedChatIds), [pinnedChatIds]);
  const pinnedWorkspacePathSet = useMemo(
    () => new Set(pinnedWorkspacePaths),
    [pinnedWorkspacePaths]
  );
  const baseChatSections = useMemo(
    () =>
      sortWorkspaceSections(
        sortPinnedChatsInSections(buildChatWorkspaceSections(engineFilteredChats), pinnedChatIds),
        pinnedWorkspacePaths
      ),
    [engineFilteredChats, pinnedChatIds, pinnedWorkspacePaths]
  );
  const workspaceChatSections = useMemo(
    () =>
      sortWorkspaceSections(
        sortPinnedChatsInSections(buildChatWorkspaceSections(filteredChats), pinnedChatIds),
        pinnedWorkspacePaths
      ),
    [filteredChats, pinnedChatIds, pinnedWorkspacePaths]
  );
  const chatSections = useMemo(
    () => workspaceChatSections,
    [workspaceChatSections]
  );
  const chatSectionByKey = useMemo(
    () => new Map(chatSections.map((section) => [section.key, section])),
    [chatSections]
  );
  const isSearching = searchQuery.trim().length > 0;
  const normalizedWorkspaceChatLimit = normalizeWorkspaceChatLimit(workspaceChatLimit);
  const visibleChatSections = useMemo(
    () =>
      chatSections.map((section) => {
        const collapsed = !isSearching && collapsedWorkspaceKeys.has(section.key);
        if (collapsed) {
          return {
            ...section,
            data: [],
          };
        }

        if (isSearching || normalizedWorkspaceChatLimit === null) {
          return section;
        }

        const visibleCount = Math.min(
          section.data.length,
          workspaceVisibleCounts[section.key] ?? normalizedWorkspaceChatLimit
        );
        return {
          ...section,
          data: section.data.slice(0, visibleCount),
        };
      }),
    [
      chatSections,
      collapsedWorkspaceKeys,
      isSearching,
      normalizedWorkspaceChatLimit,
      workspaceVisibleCounts,
    ]
  );
  const runningChatCount = useMemo(
    () => countDrawerRunningChats(chats, runIndicatorsByThread),
    [chats, runIndicatorsByThread]
  );
  const showEngineBadges = useMemo(
    () =>
      visibleChatSections.some((section) =>
        section.data.some((item) => resolveChatEngine(item.chat.engine) !== 'codex')
      ),
    [visibleChatSections]
  );

  const showAllWorkspaceChats = useCallback(
    (section: ChatWorkspaceSection) => {
      if (normalizedWorkspaceChatLimit === null) {
        return;
      }

      setWorkspaceVisibleCounts((prev) => {
        const currentCount = prev[section.key] ?? normalizedWorkspaceChatLimit;
        const nextCount = section.itemCount;
        if (nextCount <= currentCount) {
          return prev;
        }

        return {
          ...prev,
          [section.key]: nextCount,
        };
      });
    },
    [normalizedWorkspaceChatLimit]
  );

  const cancelChatListStream = useCallback(() => {
    chatListStreamRef.current?.cancel();
    chatListStreamRef.current = null;
    if (scheduledDeepLoadChatsRef.current) {
      clearTimeout(scheduledDeepLoadChatsRef.current);
      scheduledDeepLoadChatsRef.current = null;
    }
  }, []);

  const persistPinnedChatIds = useCallback(async (nextIds: string[]) => {
    const path = getPinnedChatIdsPath();
    if (!path) {
      return;
    }

    try {
      await FileSystem.writeAsStringAsync(path, JSON.stringify({ ids: nextIds }));
    } catch {
      // Best effort persistence only.
    }
  }, []);

  const persistPinnedWorkspacePaths = useCallback(async (nextPaths: string[]) => {
    const path = getPinnedWorkspacePathsPath();
    if (!path) {
      return;
    }

    try {
      await FileSystem.writeAsStringAsync(
        path,
        JSON.stringify({
          version: PINNED_WORKSPACE_PATHS_VERSION,
          paths: nextPaths,
        })
      );
    } catch {
      // Best effort persistence only.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadPinnedChatIds = async () => {
      const path = getPinnedChatIdsPath();
      if (!path) {
        return;
      }

      try {
        const raw = await FileSystem.readAsStringAsync(path);
        const ids = parsePinnedChatIds(raw);
        if (!cancelled) {
          setPinnedChatIds(ids);
        }
      } catch {
        if (!cancelled) {
          setPinnedChatIds([]);
        }
      }
    };

    void loadPinnedChatIds();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadPinnedWorkspacePaths = async () => {
      const path = getPinnedWorkspacePathsPath();
      if (!path) {
        return;
      }

      try {
        const raw = await FileSystem.readAsStringAsync(path);
        const paths = parsePinnedWorkspacePaths(raw);
        if (!cancelled) {
          setPinnedWorkspacePaths(paths);
        }
      } catch {
        if (!cancelled) {
          setPinnedWorkspacePaths([]);
        }
      }
    };

    void loadPinnedWorkspacePaths();

    return () => {
      cancelled = true;
    };
  }, []);

  const togglePinnedChat = useCallback(
    (chatId: string) => {
      setPinnedChatIds((prev) => {
        const next = prev.includes(chatId)
          ? prev.filter((id) => id !== chatId)
          : [chatId, ...prev.filter((id) => id !== chatId)];
        void persistPinnedChatIds(next);
        return next;
      });
    },
    [persistPinnedChatIds]
  );

  const showChatPinAction = useCallback(
    (chat: ChatSummary) => {
      const isPinned = pinnedChatIdSet.has(chat.id);
      const actionTitle = isPinned ? 'Unpin chat' : 'Pin chat';
      const promptTitle = isPinned ? 'Unpin this chat?' : 'Pin this chat?';
      const runAction = () => togglePinnedChat(chat.id);

      if (Platform.OS === 'ios') {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options: [actionTitle, 'Cancel'],
            cancelButtonIndex: 1,
            title: promptTitle,
          },
          (buttonIndex) => {
            if (buttonIndex === 0) {
              runAction();
            }
          }
        );
        return;
      }

      Alert.alert(promptTitle, undefined, [
        { text: actionTitle, onPress: runAction },
        { text: 'Cancel', style: 'cancel' },
      ]);
    },
    [pinnedChatIdSet, togglePinnedChat]
  );

  const togglePinnedWorkspace = useCallback(
    (workspacePath: string) => {
      setPinnedWorkspacePaths((prev) => {
        const next = prev.includes(workspacePath)
          ? prev.filter((path) => path !== workspacePath)
          : [workspacePath, ...prev.filter((path) => path !== workspacePath)].slice(
              0,
              PINNED_WORKSPACE_PATHS_LIMIT
            );
        void persistPinnedWorkspacePaths(next);
        return next;
      });
    },
    [persistPinnedWorkspacePaths]
  );

  const showWorkspacePinAction = useCallback(
    (section: ChatWorkspaceSection) => {
      const isPinned = pinnedWorkspacePathSet.has(section.key);
      const actionTitle = isPinned ? 'Unpin workspace' : 'Pin workspace';
      const promptTitle = isPinned ? 'Unpin this workspace?' : 'Pin this workspace?';
      const runAction = () => togglePinnedWorkspace(section.key);

      if (Platform.OS === 'ios') {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options: [actionTitle, 'Cancel'],
            cancelButtonIndex: 1,
            title: promptTitle,
          },
          (buttonIndex) => {
            if (buttonIndex === 0) {
              runAction();
            }
          }
        );
        return;
      }

      Alert.alert(promptTitle, undefined, [
        { text: actionTitle, onPress: runAction },
        { text: 'Cancel', style: 'cancel' },
      ]);
    },
    [pinnedWorkspacePathSet, togglePinnedWorkspace]
  );

  const loadChatsNow = useCallback(
    async (showRefresh = false, forceRefresh = false) => {
      if (showRefresh) {
        setRefreshing(true);
      }

      const applyChats = (rawChats: ChatSummary[], cacheLimit?: number) => {
        const incomingChats = sortChats(dedupeChatsById(filterDrawerChats(rawChats)));
        const shouldPreserveExisting =
          hasHydratedOnceRef.current || chatsRef.current.length > incomingChats.length;
        const nextChats = shouldPreserveExisting
          ? mergeDrawerChatBatch(chatsRef.current, incomingChats)
          : incomingChats;
        chatsRef.current = nextChats;
        setChats((previous) =>
          areDrawerChatListsEquivalent(previous, nextChats) ? previous : nextChats
        );
        if (cacheLimit) {
          const cacheKeyLimit = Math.max(cacheLimit, Math.min(nextChats.length, 200));
          api.rememberChats(nextChats, { limit: cacheKeyLimit });
        }
        hasHydratedOnceRef.current = true;
        lastLoadedAtRef.current = Date.now();
        setLoading(false);

        setRunIndicatorsByThread((prev) => reconcileDrawerRunIndicatorsWithChats(prev, nextChats));
      };

      const hydrateLoadedChats = async (listedChats: ChatSummary[], cacheLimit?: number) => {
        const listedChatIds = new Set(listedChats.map((chat) => chat.id));
        try {
          const loadedIds = await api.listLoadedChatIds();
          const missingIds = loadedIds.filter((threadId) => !listedChatIds.has(threadId));
          if (missingIds.length === 0) {
            return;
          }

          const loadedChats = await api.getChatSummaries(missingIds);
          if (loadedChats.length > 0 && activeRef.current) {
            applyChats([...listedChats, ...loadedChats], cacheLimit);
          }
        } catch {
          // Keep the drawer usable if loaded-thread hydration fails.
        }
      };

      const applyCachedDeepChats = () => {
        const cachedDeepChats = api.peekAllChats();
        if (!cachedDeepChats) {
          return false;
        }

        hasLoadedDeepChatListRef.current = true;
        if (activeRef.current) {
          setLoadingOlderChats(false);
        }
        applyChats(cachedDeepChats);
        return true;
      };

      const loadDeepChatsOnce = async () => {
        if (hasLoadedDeepChatListRef.current || deepLoadInFlightRef.current) {
          return;
        }
        if (applyCachedDeepChats()) {
          return;
        }

        const request = api
          .listAllChats({
            pageLimit: DRAWER_DEEP_CHAT_PAGE_LIMIT,
            cacheTtlMs: DRAWER_DEEP_CHAT_CACHE_TTL_MS,
            onPage: (loadedChats) => {
              if (activeRef.current) {
                applyChats(loadedChats);
              }
            },
          })
          .then((deepChats) => {
            hasLoadedDeepChatListRef.current = true;
            if (activeRef.current) {
              applyChats(deepChats);
              void hydrateLoadedChats(deepChats);
            }
          })
          .catch(() => {})
          .finally(() => {
            deepLoadInFlightRef.current = null;
            if (activeRef.current) {
              setLoadingOlderChats(false);
            }
          });

        if (activeRef.current) {
          setLoadingOlderChats(true);
        }
        deepLoadInFlightRef.current = request;
        await request;
      };

      const scheduleDeepLoadChatsOnce = () => {
        if (deepLoadInFlightRef.current) {
          if (activeRef.current) {
            setLoadingOlderChats(true);
          }
          return;
        }
        if (
          hasLoadedDeepChatListRef.current ||
          scheduledDeepLoadChatsRef.current
        ) {
          return;
        }
        if (applyCachedDeepChats()) {
          return;
        }

        scheduledDeepLoadChatsRef.current = setTimeout(() => {
          scheduledDeepLoadChatsRef.current = null;
          if (activeRef.current) {
            void loadDeepChatsOnce();
          }
        }, DRAWER_DEEP_LOAD_DELAY_MS);
      };

      let streamStarted = false;
      let streamFinished = false;
      if (!activeRef.current) {
        try {
          await api.listChats({
            limit: DRAWER_FAST_CHAT_LIST_LIMIT,
            cacheTtlMs: DRAWER_CHAT_CACHE_TTL_MS,
            forceRefresh,
          });
        } catch {
          // Hidden drawer priming is best effort.
        }
        return;
      }

      try {
        const hasCachedDeepChats = applyCachedDeepChats();
        if (hasCachedDeepChats) {
          try {
            const latestChats = await api.listChats({
              limit: showRefresh ? DRAWER_FULL_CHAT_LIST_LIMIT : DRAWER_FAST_CHAT_LIST_LIMIT,
              cacheTtlMs: DRAWER_CHAT_CACHE_TTL_MS,
              forceRefresh,
            });
            if (activeRef.current) {
              applyChats(
                latestChats,
                showRefresh ? DRAWER_FULL_CHAT_LIST_LIMIT : DRAWER_FAST_CHAT_LIST_LIMIT
              );
            }
          } catch {
            // The cached full list is already visible; newest-chat refresh is best effort.
          }
          return;
        }

        const cachedFullChats = api.peekChats({ limit: DRAWER_FULL_CHAT_LIST_LIMIT });
        const cachedFastChats = cachedFullChats
          ? null
          : api.peekChats({ limit: DRAWER_FAST_CHAT_LIST_LIMIT });
        if (cachedFullChats) {
          applyChats(cachedFullChats, DRAWER_FULL_CHAT_LIST_LIMIT);
        } else if (cachedFastChats) {
          applyChats(cachedFastChats, DRAWER_FAST_CHAT_LIST_LIMIT);
        }

        cancelChatListStream();
        const stream = await api.startChatListStream(
          {
            limits: DRAWER_STREAM_CHAT_LIST_LIMITS,
            delayMs: DRAWER_STREAM_BATCH_DELAY_MS,
          },
          (batch) => {
            if (!activeRef.current) {
              return;
            }
            applyChats(batch.chats, batch.limit);
            if (showRefresh) {
              setRefreshing(false);
            }
            if (batch.done) {
              streamFinished = true;
              chatListStreamRef.current = null;
              void hydrateLoadedChats(batch.chats, batch.limit);
              scheduleDeepLoadChatsOnce();
            }
          },
          () => {
            streamFinished = true;
            chatListStreamRef.current = null;
            if (showRefresh) {
              setRefreshing(false);
            }
            setLoading(false);
          }
        );
        streamStarted = true;
        if (!streamFinished) {
          chatListStreamRef.current = stream;
        }
      } catch {
        try {
          const fastListedChats = await api.listChats({
            limit: DRAWER_FAST_CHAT_LIST_LIMIT,
            cacheTtlMs: DRAWER_CHAT_CACHE_TTL_MS,
            forceRefresh,
          });
          if (activeRef.current) {
            applyChats(fastListedChats, DRAWER_FAST_CHAT_LIST_LIMIT);
          }

          const fullListedChats = await api.listChats({
            limit: DRAWER_FULL_CHAT_LIST_LIMIT,
            cacheTtlMs: DRAWER_CHAT_CACHE_TTL_MS,
            forceRefresh,
          });
          if (activeRef.current) {
            applyChats(fullListedChats, DRAWER_FULL_CHAT_LIST_LIMIT);
            void hydrateLoadedChats(fullListedChats, DRAWER_FULL_CHAT_LIST_LIMIT);
            scheduleDeepLoadChatsOnce();
          }
        } catch {
          // silently fail
        }
      } finally {
        if (!streamStarted || streamFinished) {
          if (showRefresh) {
            setRefreshing(false);
          }
          setLoading(false);
        }
      }
    },
    [api, cancelChatListStream]
  );

  const loadChats = useCallback(
    (showRefresh = false, forceRefresh = false) => {
      if (!active && hasHydratedOnceRef.current) {
        return Promise.resolve();
      }

      if (chatListStreamRef.current && !showRefresh) {
        return Promise.resolve();
      }

      if (showRefresh && scheduledLoadChatsRef.current) {
        clearTimeout(scheduledLoadChatsRef.current);
        scheduledLoadChatsRef.current = null;
      }

      if (loadChatsInFlightRef.current) {
        queuedLoadChatsRef.current = {
          showRefresh: showRefresh || queuedLoadChatsRef.current?.showRefresh === true,
          forceRefresh: forceRefresh || queuedLoadChatsRef.current?.forceRefresh === true,
        };
        return loadChatsInFlightRef.current;
      }

      const promise = loadChatsNow(showRefresh, forceRefresh).finally(() => {
        loadChatsInFlightRef.current = null;
        const queuedRequest = queuedLoadChatsRef.current;
        queuedLoadChatsRef.current = null;
        if (queuedRequest && !(chatListStreamRef.current && !queuedRequest.showRefresh)) {
          void loadChats(queuedRequest.showRefresh, queuedRequest.forceRefresh);
        }
      });

      loadChatsInFlightRef.current = promise;
      return promise;
    },
    [active, loadChatsNow]
  );

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    setWorkspaceVisibleCounts({});
  }, [normalizedWorkspaceChatLimit]);

  useEffect(() => {
    chatsRef.current = chats;
  }, [chats]);

  const scheduleLoadChats = useCallback(
    (delay = DRAWER_EVENT_REFRESH_DEBOUNCE_MS, forceRefresh = false) => {
      if (!active) {
        return;
      }

      if (scheduledLoadChatsRef.current) {
        scheduledLoadChatsForceRefreshRef.current =
          scheduledLoadChatsForceRefreshRef.current || forceRefresh;
        return;
      }

      scheduledLoadChatsForceRefreshRef.current = forceRefresh;
      scheduledLoadChatsRef.current = setTimeout(() => {
        scheduledLoadChatsRef.current = null;
        const shouldForceRefresh = scheduledLoadChatsForceRefreshRef.current;
        scheduledLoadChatsForceRefreshRef.current = false;
        void loadChats(false, shouldForceRefresh);
      }, delay);
    },
    [active, loadChats]
  );

  useEffect(() => {
    setWsConnected(ws.isConnected);
    const shouldPrimeHiddenDrawer = !hasHydratedOnceRef.current;
    const shouldRefreshVisibleDrawer =
      active && Date.now() - lastLoadedAtRef.current > DRAWER_OPEN_STALE_REFRESH_MS;
    if (!shouldPrimeHiddenDrawer && !shouldRefreshVisibleDrawer) {
      return;
    }

    void loadChats(false, shouldRefreshVisibleDrawer);
  }, [active, loadChats, ws]);

  useEffect(() => {
    return ws.onEvent((event: RpcNotification) => {
      setRunIndicatorsByThread((prev) => updateDrawerRunIndicatorsForEvent(prev, event));

      if (
        event.method === 'thread/started' ||
        event.method === 'turn/started' ||
        event.method === 'thread/name/updated' ||
        event.method === 'turn/completed' ||
        event.method === 'thread/status/changed'
      ) {
        scheduleLoadChats(DRAWER_EVENT_REFRESH_DEBOUNCE_MS, true);
      }
    });
  }, [scheduleLoadChats, ws]);

  useEffect(() => {
    return ws.onStatus((connected) => {
      setWsConnected(connected);
      if (connected) {
        scheduleLoadChats(DRAWER_EVENT_REFRESH_DEBOUNCE_MS, true);
      }
    });
  }, [scheduleLoadChats, ws]);

  useEffect(() => {
    const timer = setInterval(() => {
      setRunIndicatorsByThread((prev) => pruneStaleDrawerRunIndicators(prev));
    }, 5000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!active) {
      return;
    }

    const timer = setInterval(() => {
      scheduleLoadChats();
    }, wsConnected ? DRAWER_REFRESH_CONNECTED_MS : DRAWER_REFRESH_DISCONNECTED_MS);

    return () => clearInterval(timer);
  }, [active, scheduleLoadChats, wsConnected]);

  useEffect(() => {
    if (active) {
      return;
    }

    if (scheduledLoadChatsRef.current) {
      clearTimeout(scheduledLoadChatsRef.current);
      scheduledLoadChatsRef.current = null;
    }
    scheduledLoadChatsForceRefreshRef.current = false;
    cancelChatListStream();
    queuedLoadChatsRef.current = null;
    setRefreshing(false);
    setLoadingOlderChats(false);
  }, [active, cancelChatListStream]);

  useEffect(() => {
    return () => {
      if (scheduledLoadChatsRef.current) {
        clearTimeout(scheduledLoadChatsRef.current);
        scheduledLoadChatsRef.current = null;
      }
      scheduledLoadChatsForceRefreshRef.current = false;
      cancelChatListStream();
    };
  }, [cancelChatListStream]);

  useEffect(() => {
    chatSectionsRef.current = baseChatSections;
  }, [baseChatSections]);

  useEffect(() => {
    const nextKnownKeys = new Set(baseChatSections.map((section) => section.key));
    if (baseChatSections.length === 0) {
      knownWorkspaceKeysRef.current = nextKnownKeys;
      return;
    }

    setCollapsedWorkspaceKeys((prev) => {
      if (!hasAppliedInitialCollapseRef.current) {
        hasAppliedInitialCollapseRef.current = true;
        return getDefaultCollapsedWorkspaceKeys(baseChatSections);
      }

      let changed = false;
      const next = new Set<string>();

      for (const key of prev) {
        if (nextKnownKeys.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      }

      for (let index = 1; index < baseChatSections.length; index += 1) {
        const key = baseChatSections[index]?.key;
        if (key && !knownWorkspaceKeysRef.current.has(key) && !next.has(key)) {
          next.add(key);
          changed = true;
        }
      }

      const everySectionCollapsed =
        baseChatSections.length > 0 &&
        baseChatSections.every((section) => next.has(section.key));
      if (everySectionCollapsed) {
        next.delete(baseChatSections[0]?.key ?? '');
        changed = true;
      }

      return changed ? next : prev;
    });

    knownWorkspaceKeysRef.current = nextKnownKeys;
  }, [baseChatSections]);

  const filteredChatCount = filteredChats.length;
  const selectedChatEngineSet = useMemo(
    () => new Set(selectedChatEngines),
    [selectedChatEngines]
  );
  const hasFilteredEngines = selectedChatEngines.length < DEFAULT_DRAWER_CHAT_ENGINES.length;
  const hasActiveFilters = hasFilteredEngines || isSearching;
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
  const resolvedEmptyTitle = isSearching ? 'No matching chats' : emptyTitle;
  const resolvedEmptyHint = isSearching
    ? 'Try a different title, keyword, or workspace name.'
    : emptyHint;

  useEffect(() => {
    if (!active) {
      return;
    }

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setCollapsedWorkspaceKeys(getDefaultCollapsedWorkspaceKeys(chatSectionsRef.current));
        hasAppliedInitialCollapseRef.current = true;
        scheduleLoadChats(DRAWER_EVENT_REFRESH_DEBOUNCE_MS, true);
      }
    });

    return () => {
      subscription.remove();
    };
  }, [active, scheduleLoadChats]);

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
      if (!isSearching) {
        setFilterMenuVisible(false);
      }
      cancelChatListStream();
      onSelectChat(chatId);
    },
    [cancelChatListStream, isSearching, onSelectChat]
  );

  const handleNewChat = useCallback(() => {
    if (!isSearching) {
      setFilterMenuVisible(false);
    }
    cancelChatListStream();
    onNewChat();
  }, [cancelChatListStream, isSearching, onNewChat]);

  const handleNavigate = useCallback(
    (screen: Screen) => {
      if (!isSearching) {
        setFilterMenuVisible(false);
      }
      cancelChatListStream();
      onNavigate(screen);
    },
    [cancelChatListStream, isSearching, onNavigate]
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

  const handleToggleFilterMenu = useCallback(() => {
    if (filterMenuVisible) {
      if (isSearching) {
        setSearchQuery('');
      }
      setFilterMenuVisible(false);
      return;
    }

    setFilterMenuVisible(true);
  }, [filterMenuVisible, isSearching]);

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
                <Ionicons name="add" size={16} color={theme.colors.accentText} />
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
                <Ionicons name="globe-outline" size={15} color={theme.colors.textPrimary} />
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
                  onPress={handleToggleFilterMenu}
                  style={({ pressed }) => [
                    styles.filterTriggerButton,
                    filterMenuVisible && styles.filterTriggerButtonOpen,
                    hasActiveFilters && styles.filterTriggerButtonActive,
                    pressed && styles.filterTriggerButtonPressed,
                  ]}
                >
                  <Ionicons
                    name="funnel-outline"
                    size={14}
                    color={hasActiveFilters || filterMenuVisible ? theme.colors.textPrimary : theme.colors.textMuted}
                  />
                </Pressable>
              </View>
              <View style={styles.sectionCountBadge}>
                <Text style={styles.sectionCountText}>
                  {formatCompactCount(filteredChatCount)}
                </Text>
              </View>
            </View>
          </View>

          {filterMenuVisible ? (
            <View style={styles.filterPanel}>
              <View style={styles.searchField}>
                <Ionicons name="search" size={16} color={theme.colors.textMuted} />
                <TextInput
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  keyboardAppearance={theme.keyboardAppearance}
                  placeholder="Search chats"
                  placeholderTextColor={theme.colors.textMuted}
                  style={styles.searchInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                  clearButtonMode="never"
                />
                {isSearching ? (
                  <Pressable
                    accessibilityLabel="Clear chat search"
                    hitSlop={6}
                    onPress={() => setSearchQuery('')}
                    style={({ pressed }) => [
                      styles.searchClearButton,
                      pressed && styles.searchClearButtonPressed,
                    ]}
                  >
                    <Ionicons
                      name="close"
                      size={14}
                      color={theme.colors.textSecondary}
                    />
                  </Pressable>
                ) : null}
              </View>
              <View style={styles.filterChipRow}>
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
                        styles.filterChip,
                        selected && styles.filterChipSelected,
                        pressed && styles.filterChipPressed,
                      ]}
                    >
                      <Text
                        style={[
                          styles.filterChipText,
                          selected && styles.filterChipTextSelected,
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
            </View>
          ) : null}

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
                  name={isSearching ? 'search-outline' : 'chatbubbles-outline'}
                  size={18}
                  color={theme.colors.textPrimary}
                />
              </View>
              <Text style={styles.emptyTitle}>{resolvedEmptyTitle}</Text>
              <Text style={styles.emptyHint}>{resolvedEmptyHint}</Text>
            </View>
          ) : (
            <SectionList
              sections={visibleChatSections}
              keyExtractor={(item) => item.chat.id}
              style={styles.list}
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={false}
              stickySectionHeadersEnabled={false}
              removeClippedSubviews={false}
              initialNumToRender={12}
              maxToRenderPerBatch={10}
              windowSize={9}
              keyboardShouldPersistTaps="handled"
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => {
                    void loadChats(true, true);
                  }}
                  tintColor={theme.colors.textMuted}
                />
              }
              ListFooterComponent={
                loadingOlderChats ? (
                  <View style={styles.loadingMoreFooter}>
                    <ActivityIndicator size="small" color={theme.colors.textMuted} />
                  </View>
                ) : null
              }
              renderSectionHeader={({ section }) => {
                const isPinnedWorkspace = pinnedWorkspacePathSet.has(section.key);
                const collapsed = !isSearching && collapsedWorkspaceKeys.has(section.key);
                const hasLiveChat = isDrawerWorkspaceSectionRunning(
                  chatSectionByKey.get(section.key) ?? section,
                  runIndicatorsByThread
                );
                return (
                  <Pressable
                    disabled={isSearching}
                    style={({ pressed }) => [
                      styles.workspaceGroupHeader,
                      collapsed
                        ? styles.workspaceGroupHeaderCollapsed
                        : styles.workspaceGroupHeaderExpanded,
                      isPinnedWorkspace && styles.workspaceGroupHeaderPinned,
                      pressed &&
                        !isSearching &&
                        styles.workspaceGroupHeaderPressed,
                    ]}
                    onPress={() => toggleWorkspaceSection(section.key)}
                    onLongPress={() => showWorkspacePinAction(section)}
                  >
                    <View style={styles.workspaceGroupHeaderRow}>
                      {isPinnedWorkspace ? (
                        <Ionicons
                          name="pin-outline"
                          size={11}
                          color={theme.colors.textMuted}
                          style={styles.workspaceGroupPinIcon}
                        />
                      ) : null}
                      {hasLiveChat ? (
                        <View
                          accessibilityLabel="Workspace has live chat"
                          style={styles.workspaceGroupLiveDot}
                        />
                      ) : null}
                      <View style={styles.workspaceGroupIconTile}>
                        <Ionicons
                          name="folder-outline"
                          size={13}
                          color={theme.colors.textMuted}
                          style={styles.workspaceGroupIcon}
                        />
                      </View>
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
                      {!isSearching ? (
                        <View style={styles.workspaceGroupHeaderMeta}>
                          <Ionicons
                            name={collapsed ? 'chevron-forward' : 'chevron-down'}
                            size={14}
                            color={theme.colors.textMuted}
                          />
                        </View>
                      ) : null}
                    </View>
                  </Pressable>
                );
              }}
              renderSectionFooter={({ section }) => {
                const collapsed = !isSearching && collapsedWorkspaceKeys.has(section.key);
                const pageSize = normalizedWorkspaceChatLimit;
                const hiddenCount =
                  !isSearching && !collapsed && pageSize !== null
                    ? Math.max(0, section.itemCount - section.data.length)
                    : 0;
                if (hiddenCount === 0 || pageSize === null) {
                  return null;
                }

                return (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => showAllWorkspaceChats(section)}
                    style={({ pressed }) => [
                      styles.workspaceShowMoreRow,
                      pressed && styles.workspaceShowMoreRowPressed,
                    ]}
                  >
                    <Text style={styles.workspaceShowMoreText}>Show all</Text>
                    <Ionicons name="chevron-down" size={14} color={theme.colors.textSecondary} />
                  </Pressable>
                );
              }}
              renderItem={({ item, index, section }) => {
                const chat = item.chat;
                const isSelected = chat.id === selectedChatId;
                const isLast = index === section.data.length - 1;
                const isRunning = isDrawerChatRunning(chat, runIndicatorsByThread);
                const isSubAgent = item.indentLevel > 0 || Boolean(chat.parentThreadId);
                const isPinnedChat = pinnedChatIdSet.has(chat.id);
                const chatEngine = resolveChatEngine(chat.engine);
                const showEngineIcon =
                  showEngineBadges || chatEngine !== 'codex';
                const chatSubtitle = getDrawerChatSubtitle(chat);
                const chatIndent = Math.min(item.indentLevel, 4) * 14;
                return (
                  <Pressable
                    style={[
                      styles.chatItemFrame,
                      isSubAgent && {
                        marginLeft: theme.spacing.md + chatIndent,
                      },
                      isLast && styles.chatItemLast,
                    ]}
                    onPress={() => handleSelectChat(chat.id)}
                    onLongPress={() => showChatPinAction(chat)}
                  >
                    {({ pressed }) => (
                      <View
                        style={[
                          styles.chatItem,
                          isSubAgent && styles.chatItemSubAgent,
                          isSelected && styles.chatItemSelected,
                          pressed && styles.chatItemPressed,
                        ]}
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
                          <View style={styles.chatItemTextBlock}>
                            <Text
                              style={[
                                styles.chatTitle,
                                isSubAgent && styles.chatTitleSubAgent,
                                isSelected && styles.chatTitleSelected,
                              ]}
                              numberOfLines={chatSubtitle ? 1 : 2}
                            >
                              {chat.title || 'Untitled'}
                            </Text>
                            {chatSubtitle ? (
                              <Text
                                style={[
                                  styles.chatSubtitle,
                                  isSelected && styles.chatSubtitleSelected,
                                ]}
                                numberOfLines={1}
                              >
                                {chatSubtitle}
                              </Text>
                            ) : null}
                          </View>
                          <View style={styles.chatItemMeta}>
                            {isPinnedChat ? (
                              <Ionicons
                                name="pin-outline"
                                size={10}
                                color={theme.colors.textMuted}
                                style={styles.chatPinnedIcon}
                              />
                            ) : null}
                            {showEngineIcon ? (
                              <ChatEngineIcon
                                engine={chat.engine}
                                size={16}
                                style={styles.chatEngineIcon}
                              />
                            ) : null}
                            <Text
                              style={[
                                styles.chatAge,
                                isSelected && styles.chatAgeSelected,
                              ]}
                            >
                              {relativeTime(chat.updatedAt)}
                            </Text>
                          </View>
                        </View>
                      </View>
                    )}
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
            <Ionicons name="settings-outline" size={15} color={theme.colors.textPrimary} />
            <Text style={styles.footerSettingsText}>Settings</Text>
          </Pressable>
        </View>

      </SafeAreaView>
    </View>
  );
});

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

function mergeDrawerChatBatch(
  previous: ChatSummary[],
  incoming: ChatSummary[]
): ChatSummary[] {
  if (previous.length === 0) {
    return sortChats(incoming);
  }

  const byId = new Map<string, ChatSummary>();
  for (const chat of previous) {
    byId.set(chat.id, chat);
  }
  for (const chat of incoming) {
    byId.set(chat.id, chat);
  }

  return sortChats(Array.from(byId.values()));
}

function sortPinnedChatBranches(
  rows: ChatWorkspaceSection['data'],
  pinnedIds: string[]
): ChatWorkspaceSection['data'] {
  if (rows.length <= 1 || pinnedIds.length === 0) {
    return rows;
  }

  const pinnedOrder = new Map(pinnedIds.map((id, index) => [id, index]));
  const branches: Array<{
    rows: ChatWorkspaceSection['data'];
    pinnedOrder: number;
    firstUpdatedAt: string;
    index: number;
  }> = [];

  let currentBranch: ChatWorkspaceSection['data'] = [];
  for (const row of rows) {
    if (row.indentLevel === 0 && currentBranch.length > 0) {
      branches.push(createChatBranchSortEntry(currentBranch, pinnedOrder, branches.length));
      currentBranch = [];
    }
    currentBranch.push(row);
  }
  if (currentBranch.length > 0) {
    branches.push(createChatBranchSortEntry(currentBranch, pinnedOrder, branches.length));
  }

  if (!branches.some((branch) => branch.pinnedOrder !== Number.MAX_SAFE_INTEGER)) {
    return rows;
  }

  return branches
    .sort((left, right) => {
      if (left.pinnedOrder !== right.pinnedOrder) {
        return left.pinnedOrder - right.pinnedOrder;
      }
      if (left.pinnedOrder !== Number.MAX_SAFE_INTEGER) {
        const updatedDiff = right.firstUpdatedAt.localeCompare(left.firstUpdatedAt);
        if (updatedDiff !== 0) {
          return updatedDiff;
        }
      }
      return left.index - right.index;
    })
    .flatMap((branch) => branch.rows);
}

function createChatBranchSortEntry(
  rows: ChatWorkspaceSection['data'],
  pinnedOrder: Map<string, number>,
  index: number
): {
  rows: ChatWorkspaceSection['data'];
  pinnedOrder: number;
  firstUpdatedAt: string;
  index: number;
} {
  return {
    rows,
    pinnedOrder: rows.reduce(
      (bestOrder, row) => Math.min(bestOrder, pinnedOrder.get(row.chat.id) ?? Number.MAX_SAFE_INTEGER),
      Number.MAX_SAFE_INTEGER
    ),
    firstUpdatedAt: rows[0]?.chat.updatedAt ?? '',
    index,
  };
}

function sortPinnedChatsInSections(
  sections: ChatWorkspaceSection[],
  pinnedIds: string[]
): ChatWorkspaceSection[] {
  if (sections.length === 0 || pinnedIds.length === 0) {
    return sections;
  }

  return sections.map((section) => ({
    ...section,
    data: sortPinnedChatBranches(section.data, pinnedIds),
  }));
}

function sortWorkspaceSections(
  sections: ChatWorkspaceSection[],
  pinnedWorkspacePaths: string[]
): ChatWorkspaceSection[] {
  if (sections.length <= 1 || pinnedWorkspacePaths.length === 0) {
    return sections;
  }

  const pinnedOrder = new Map(pinnedWorkspacePaths.map((path, index) => [path, index]));
  return [...sections].sort((left, right) => {
    const leftOrder = pinnedOrder.get(left.key) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = pinnedOrder.get(right.key) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    if (leftOrder !== Number.MAX_SAFE_INTEGER) {
      return left.title.localeCompare(right.title);
    }

    return 0;
  });
}

function areDrawerChatListsEquivalent(
  previous: ChatSummary[],
  next: ChatSummary[]
): boolean {
  if (previous === next) {
    return true;
  }
  if (previous.length !== next.length) {
    return false;
  }

  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index];
    const right = next[index];
    if (
      left.id !== right.id ||
      left.title !== right.title ||
      left.status !== right.status ||
      left.updatedAt !== right.updatedAt ||
      left.lastMessagePreview !== right.lastMessagePreview ||
      left.cwd !== right.cwd ||
      left.engine !== right.engine ||
      left.sourceKind !== right.sourceKind ||
      left.parentThreadId !== right.parentThreadId ||
      left.subAgentDepth !== right.subAgentDepth ||
      left.lastError !== right.lastError
    ) {
      return false;
    }
  }

  return true;
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

function getDrawerChatSubtitle(chat: ChatSummary): string | null {
  const error = chat.lastError?.trim();
  if (error) {
    return error;
  }

  const preview = chat.lastMessagePreview?.trim();
  const title = chat.title?.trim();
  if (preview && preview !== title) {
    return preview;
  }

  return null;
}

function formatCompactCount(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`;
  }

  return String(value);
}

function normalizeWorkspaceChatLimit(value: WorkspaceChatLimit): WorkspaceChatLimit {
  return value === 10 || value === 25 || value === null ? value : DEFAULT_WORKSPACE_CHAT_LIMIT;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function getPinnedChatIdsPath(): string | null {
  const base = FileSystem.documentDirectory;
  return base ? `${base}${PINNED_CHAT_IDS_FILE}` : null;
}

function getPinnedWorkspacePathsPath(): string | null {
  const base = FileSystem.documentDirectory;
  return base ? `${base}${PINNED_WORKSPACE_PATHS_FILE}` : null;
}

function parsePinnedChatIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const ids = Array.isArray(parsed)
      ? parsed
      : toRecord(parsed)?.ids;
    if (!Array.isArray(ids)) {
      return [];
    }

    return Array.from(
      new Set(
        ids
          .filter((id): id is string => typeof id === 'string')
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
      )
    );
  } catch {
    return [];
  }
}

function parsePinnedWorkspacePaths(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const paths = Array.isArray(parsed)
      ? parsed
      : toRecord(parsed)?.paths;
    if (!Array.isArray(paths)) {
      return [];
    }

    return Array.from(
      new Set(
        paths
          .filter((path): path is string => typeof path === 'string')
          .map((path) => path.trim())
          .filter((path) => path.length > 0)
      )
    ).slice(0, PINNED_WORKSPACE_PATHS_LIMIT);
  } catch {
    return [];
  }
}

const createStyles = (theme: AppTheme) => {
  const connectionDotConnected = theme.colors.success;
  const connectionDotDisconnected = theme.colors.warning;
  const cardShadow = theme.isDark
    ? '0 10px 24px rgba(0, 0, 0, 0.22)'
    : '0 10px 20px rgba(15, 23, 42, 0.10)';
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
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.sm,
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
    backgroundColor: theme.colors.successBg,
    borderColor: theme.colors.successBorder,
  },
  connectionBadgeDisconnected: {
    backgroundColor: theme.colors.warningBg,
    borderColor: theme.colors.warningBorder,
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
    letterSpacing: 0,
  },
  connectionTextConnected: {
    color: theme.colors.success,
  },
  connectionTextDisconnected: {
    color: theme.colors.warning,
  },
  secondaryActionButton: {
    flex: 1,
    height: DRAWER_ACTION_HEIGHT,
    borderRadius: 12,
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
    fontSize: 13,
    fontWeight: '700',
  },
  actionRow: {
    flexDirection: 'row',
    gap: theme.spacing.xs + 2,
  },
  primaryActionButton: {
    flex: 1,
    height: DRAWER_ACTION_HEIGHT,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    boxShadow: drawerPrimaryActionShadow,
  },
  primaryActionButtonPressed: {
    backgroundColor: theme.colors.accentPressed,
    borderColor: theme.colors.accentPressed,
  },
  primaryActionText: {
    ...theme.typography.body,
    color: theme.colors.accentText,
    fontWeight: '700',
    fontSize: 13,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.md,
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
    letterSpacing: 0,
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
  filterPanel: {
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgElevated,
    padding: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  filterChipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs + 2,
  },
  filterChip: {
    minHeight: 34,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  filterChipSelected: {
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.bgInput,
  },
  filterChipPressed: {
    opacity: 0.9,
  },
  filterChipText: {
    ...theme.typography.body,
    color: theme.colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  filterChipTextSelected: {
    color: theme.colors.textPrimary,
  },
  searchField: {
    minHeight: 40,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgInput,
    paddingLeft: theme.spacing.md,
    paddingRight: theme.spacing.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  searchInput: {
    flex: 1,
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    paddingVertical: 0,
    fontSize: 14,
  },
  searchClearButton: {
    width: 28,
    height: 28,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchClearButtonPressed: {
    backgroundColor: theme.colors.bgItem,
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
  loadingMoreFooter: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: theme.spacing.xs,
    paddingBottom: theme.spacing.lg,
  },
  emptyStateCard: {
    marginHorizontal: theme.spacing.md,
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
    minHeight: DRAWER_WORKSPACE_ROW_HEIGHT,
    marginHorizontal: theme.spacing.md,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 8,
    borderRadius: DRAWER_ROW_RADIUS,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgElevated,
    justifyContent: 'center',
  },
  workspaceGroupHeaderExpanded: {
    marginTop: 4,
    marginBottom: 5,
  },
  workspaceGroupHeaderCollapsed: {
    marginTop: 4,
    marginBottom: 6,
  },
  workspaceGroupHeaderPinned: {
    borderColor: theme.colors.borderHighlight,
  },
  workspaceGroupHeaderPressed: {
    backgroundColor: theme.colors.bgInput,
  },
  workspaceGroupHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  workspaceGroupTitleBlock: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    gap: 2,
  },
  workspaceGroupPinIcon: {
    opacity: 0.75,
  },
  workspaceGroupIconTile: {
    width: 34,
    height: 34,
    borderRadius: 11,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  workspaceGroupIcon: {
    opacity: 0.82,
  },
  workspaceGroupLiveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: connectionDotConnected,
    flexShrink: 0,
  },
  workspaceGroupTitle: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    fontSize: 14,
    lineHeight: 17,
    fontWeight: '700',
  },
  workspaceGroupSubtitle: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontSize: 11,
    lineHeight: 13,
  },
  workspaceGroupCountBadge: {
    minWidth: 22,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: 7,
    paddingVertical: 2,
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
  workspaceShowMoreRow: {
    marginLeft: theme.spacing.md,
    marginRight: theme.spacing.md,
    marginTop: theme.spacing.xs,
    marginBottom: 6,
    minHeight: DRAWER_ACTION_HEIGHT,
    borderRadius: DRAWER_ROW_RADIUS,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    paddingVertical: 6,
  },
  workspaceShowMoreRowPressed: {
    backgroundColor: theme.colors.bgInput,
  },
  workspaceShowMoreText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
  },
  chatItemFrame: {
    marginLeft: theme.spacing.md,
    marginRight: theme.spacing.md,
    marginBottom: 5,
  },
  chatItem: {
    minHeight: DRAWER_CHAT_ROW_HEIGHT,
    borderRadius: DRAWER_ROW_RADIUS - 1,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.sm + 1,
    paddingVertical: 6,
    flexDirection: 'row',
    gap: 7,
    alignItems: 'center',
  },
  chatItemSubAgent: {
    backgroundColor: theme.colors.bgElevated,
  },
  chatItemLast: {
    marginBottom: 8,
  },
  chatItemSelected: {
    backgroundColor: theme.colors.bgInput,
    borderColor: theme.colors.borderHighlight,
    borderWidth: 1.5,
  },
  chatItemPressed: {
    backgroundColor: theme.colors.bgInput,
  },
  chatItemAccent: {
    width: 3,
    alignSelf: 'stretch',
    borderRadius: 999,
    backgroundColor: theme.colors.bgCanvasAccent,
    opacity: 0.72,
  },
  chatItemAccentSubAgent: {
    backgroundColor: theme.colors.warningBorder,
  },
  chatItemAccentSelected: {
    width: 4,
    backgroundColor: theme.colors.textPrimary,
    opacity: 1,
  },
  chatItemAccentRunning: {
    backgroundColor: theme.colors.statusRunning,
    opacity: 1,
  },
  chatItemAccentError: {
    backgroundColor: theme.colors.statusError,
    opacity: 1,
  },
  chatItemContent: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  chatItemTextBlock: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    gap: 3,
  },
  chatItemMeta: {
    minWidth: 28,
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 4,
    flexShrink: 0,
  },
  chatIconTile: {
    width: DRAWER_ICON_TILE_SIZE,
    height: DRAWER_ICON_TILE_SIZE,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgElevated,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  chatIconTileSelected: {
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.bgItem,
  },
  chatIconTileRunning: {
    borderColor: theme.colors.borderHighlight,
  },
  chatIconTileError: {
    borderColor: theme.colors.statusError,
    backgroundColor: theme.colors.errorBg,
  },
  chatPinnedIcon: {
    flexShrink: 0,
    opacity: 0.72,
  },
  chatEngineIcon: {
    opacity: 0.92,
  },
  chatTitle: {
    ...theme.typography.body,
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 16,
    fontWeight: '700',
  },
  chatTitleSubAgent: {
    color: theme.colors.textSecondary,
  },
  chatTitleSelected: {
    color: theme.colors.textPrimary,
    fontWeight: '700',
  },
  chatSubtitle: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontSize: 10,
    lineHeight: 13,
  },
  chatSubtitleSelected: {
    color: theme.colors.textSecondary,
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
    color: theme.colors.textPrimary,
  },
  footer: {
    marginTop: 'auto',
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.xs,
    paddingBottom: 0,
  },
  footerSettingsButton: {
    height: DRAWER_FOOTER_ACTION_HEIGHT,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
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
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
});
};
