import { Ionicons } from '@expo/vector-icons';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  ActionSheetIOS,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { MacBridgeApiClient } from '../api/client';
import type {
  ApprovalDecision,
  PendingApproval,
  RpcNotification,
  RunEvent,
  Chat,
  ChatSummary,
  ChatMessage as ChatTranscriptMessage,
} from '../api/types';
import type { MacBridgeWsClient } from '../api/ws';
import { ActivityBar, type ActivityTone } from '../components/ActivityBar';
import { ApprovalBanner } from '../components/ApprovalBanner';
import { ChatHeader } from '../components/ChatHeader';
import { ChatInput } from '../components/ChatInput';
import { ChatMessage } from '../components/ChatMessage';
import { BrandMark } from '../components/BrandMark';
import { ToolBlock } from '../components/ToolBlock';
import { TypingIndicator } from '../components/TypingIndicator';
import { colors, spacing, typography } from '../theme';

export interface MainScreenHandle {
  openChat: (id: string) => void;
  startNewChat: () => void;
}

interface MainScreenProps {
  api: MacBridgeApiClient;
  ws: MacBridgeWsClient;
  onOpenDrawer: () => void;
  onOpenGit: (chat: Chat) => void;
  defaultStartCwd?: string | null;
  onDefaultStartCwdChange?: (cwd: string | null) => void;
  onChatContextChange?: (chat: Chat | null) => void;
}

const SUGGESTIONS = [
  'Explain the current codebase structure',
  'Write tests for the main module',
];

interface ActivityState {
  tone: ActivityTone;
  title: string;
  detail?: string;
}

const DEFAULT_ACTIVITY_PHRASES = [
  'Analyzing text',
  'Inspecting workspace',
  'Planning next steps',
  'Running tools',
  'Preparing response',
];

const MAX_ACTIVITY_PHRASES = 8;
const RUN_WATCHDOG_MS = 15_000;
const LIKELY_RUNNING_RECENT_UPDATE_MS = 120_000;
const CODEX_RUN_HEARTBEAT_EVENT_TYPES = new Set([
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

export const MainScreen = forwardRef<MainScreenHandle, MainScreenProps>(
  function MainScreen(
    {
      api,
      ws,
      onOpenDrawer,
      onOpenGit,
      defaultStartCwd,
      onDefaultStartCwdChange,
      onChatContextChange,
    },
    ref
  ) {
    const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
    const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [activeCommands, setActiveCommands] = useState<RunEvent[]>([]);
    const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
    const [streamingText, setStreamingText] = useState<string | null>(null);
    const [renameModalVisible, setRenameModalVisible] = useState(false);
    const [renameDraft, setRenameDraft] = useState('');
    const [renaming, setRenaming] = useState(false);
    const [workspaceModalVisible, setWorkspaceModalVisible] = useState(false);
    const [workspaceOptions, setWorkspaceOptions] = useState<string[]>([]);
    const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
    const [activity, setActivity] = useState<ActivityState>({
      tone: 'idle',
      title: 'Ready',
    });
    const [activityPhrases, setActivityPhrases] = useState<string[]>([]);
    const scrollRef = useRef<ScrollView>(null);
    const sendingRef = useRef(false);
    const creatingRef = useRef(false);
    const selectedChatStatusRef = useRef<Chat['status']>('idle');

    // Ref so the WS handler always reads the latest chat ID without
    // needing to re-subscribe on every change.
    const chatIdRef = useRef<string | null>(null);
    chatIdRef.current = selectedChatId;

    // Track whether a command arrived since the last delta — used to
    // know when a new thinking segment starts so we can replace the old one.
    const hadCommandRef = useRef(false);
    const reasoningSummaryRef = useRef<Record<string, string>>({});
    const codexReasoningBufferRef = useRef('');
    const runWatchdogUntilRef = useRef(0);
    const preferredStartCwd = normalizeWorkspacePath(defaultStartCwd);

    const bumpRunWatchdog = useCallback((durationMs = RUN_WATCHDOG_MS) => {
      runWatchdogUntilRef.current = Math.max(
        runWatchdogUntilRef.current,
        Date.now() + durationMs
      );
    }, []);

    const clearRunWatchdog = useCallback(() => {
      runWatchdogUntilRef.current = 0;
    }, []);

    const appendActivityPhrase = useCallback(
      (value: string | null | undefined, seedDefaults = false) => {
        const phrase = toTickerSnippet(value);
        setActivityPhrases((prev) => {
          const shouldSeedDefaults =
            seedDefaults && prev.length === 0 && !phrase;
          const base =
            shouldSeedDefaults
              ? [...DEFAULT_ACTIVITY_PHRASES]
              : [...prev];
          if (!phrase) {
            return base;
          }

          const deduped = base.filter(
            (entry) => entry.toLowerCase() !== phrase.toLowerCase()
          );
          deduped.push(phrase);
          return deduped.slice(-MAX_ACTIVITY_PHRASES);
        });
      },
      []
    );

    useEffect(() => {
      sendingRef.current = sending;
    }, [sending]);

    useEffect(() => {
      creatingRef.current = creating;
    }, [creating]);

    useEffect(() => {
      selectedChatStatusRef.current = selectedChat?.status ?? 'idle';
    }, [selectedChat?.status]);

    useEffect(() => {
      onChatContextChange?.(selectedChat);
    }, [onChatContextChange, selectedChat]);

    const isRunContextActive = useCallback(() => {
      return (
        runWatchdogUntilRef.current > Date.now() ||
        sendingRef.current ||
        creatingRef.current ||
        selectedChatStatusRef.current === 'running'
      );
    }, []);

    useEffect(() => {
      if (activity.tone !== 'running') {
        setActivityPhrases([]);
        return;
      }

      appendActivityPhrase(toActivityPhrase(activity.title, activity.detail), true);
    }, [activity.tone, activity.title, activity.detail, appendActivityPhrase]);

    const resetComposerState = useCallback(() => {
      setSelectedChat(null);
      setSelectedChatId(null);
      setDraft('');
      setError(null);
      setActiveCommands([]);
      setPendingApproval(null);
      setStreamingText(null);
      setRenameModalVisible(false);
      setRenameDraft('');
      setRenaming(false);
      setActivity({
        tone: 'idle',
        title: 'Ready',
      });
      setActivityPhrases([]);
      reasoningSummaryRef.current = {};
      codexReasoningBufferRef.current = '';
      hadCommandRef.current = false;
      clearRunWatchdog();
    }, [clearRunWatchdog]);

    const startNewChat = useCallback(() => {
      // New chat should land on compose/home so user can pick workspace first.
      resetComposerState();
    }, [resetComposerState]);

    const refreshWorkspaceOptions = useCallback(async () => {
      setLoadingWorkspaces(true);
      try {
        const chats = await api.listChats();
        setWorkspaceOptions(extractWorkspaceOptions(chats));
      } catch {
        // Keep existing options when list refresh fails.
      } finally {
        setLoadingWorkspaces(false);
      }
    }, [api]);

    const openWorkspaceModal = useCallback(() => {
      setWorkspaceModalVisible(true);
      void refreshWorkspaceOptions();
    }, [refreshWorkspaceOptions]);

    const closeWorkspaceModal = useCallback(() => {
      if (loadingWorkspaces) {
        return;
      }
      setWorkspaceModalVisible(false);
    }, [loadingWorkspaces]);

    const selectDefaultWorkspace = useCallback(
      (cwd: string | null) => {
        onDefaultStartCwdChange?.(normalizeWorkspacePath(cwd));
        setWorkspaceModalVisible(false);
      },
      [onDefaultStartCwdChange]
    );

    const openRenameModal = useCallback(() => {
      if (!selectedChat) {
        return;
      }

      setRenameDraft(selectedChat.title || '');
      setRenameModalVisible(true);
    }, [selectedChat]);

    const openChatTitleMenu = useCallback(() => {
      if (!selectedChat) {
        return;
      }

      if (Platform.OS === 'ios') {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options: ['Rename chat', 'Cancel'],
            cancelButtonIndex: 1,
          },
          (buttonIndex) => {
            if (buttonIndex === 0) {
              openRenameModal();
            }
          }
        );
        return;
      }

      Alert.alert('Chat options', selectedChat.title || 'Current chat', [
        {
          text: 'Rename chat',
          onPress: openRenameModal,
        },
        {
          text: 'Cancel',
          style: 'cancel',
        },
      ]);
    }, [openRenameModal, selectedChat]);

    const closeRenameModal = useCallback(() => {
      if (renaming) {
        return;
      }
      setRenameModalVisible(false);
    }, [renaming]);

    const submitRenameChat = useCallback(async () => {
      if (!selectedChatId || renaming) {
        return;
      }

      const nextName = renameDraft.trim();
      if (!nextName) {
        setRenameModalVisible(false);
        return;
      }

      try {
        setRenaming(true);
        const updated = await api.renameChat(selectedChatId, nextName);
        setSelectedChat({
          ...updated,
          title: nextName,
        });
        setError(null);
        setRenameModalVisible(false);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setRenaming(false);
      }
    }, [api, renameDraft, renaming, selectedChatId]);

    useImperativeHandle(ref, () => ({
      openChat: (id: string) => {
        void loadChat(id);
      },
      startNewChat: () => {
        startNewChat();
      },
    }));

    const loadChat = useCallback(
      async (chatId: string) => {
        try {
          clearRunWatchdog();
          const chat = await api.getChat(chatId);
          setSelectedChatId(chatId);
          setSelectedChat(chat);
          setError(null);
          setActiveCommands([]);
          setPendingApproval(null);
          setStreamingText(null);
          const shouldRun = isChatLikelyRunning(chat);
          if (shouldRun) {
            bumpRunWatchdog();
            setActivity({
              tone: 'running',
              title: 'Working',
            });
            appendActivityPhrase('Working', true);
          } else {
            setActivity(
              chat.status === 'complete'
                ? {
                    tone: 'complete',
                    title: 'Turn completed',
                  }
                : chat.status === 'error'
                  ? {
                      tone: 'error',
                      title: 'Turn failed',
                      detail: chat.lastError ?? undefined,
                    }
                  : {
                      tone: 'idle',
                      title: 'Ready',
                    }
            );
          }
          reasoningSummaryRef.current = {};
          codexReasoningBufferRef.current = '';
          hadCommandRef.current = false;
        } catch (err) {
          setError((err as Error).message);
          setActivity({
            tone: 'error',
            title: 'Failed to load chat',
            detail: (err as Error).message,
          });
        }
      },
      [api, appendActivityPhrase, bumpRunWatchdog, clearRunWatchdog]
    );

    const createChat = useCallback(async () => {
      const content = draft.trim();
      if (!content) return;

      const optimisticMessage: ChatTranscriptMessage = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
      };

      setDraft('');

      try {
        setCreating(true);
        setActivity({
          tone: 'running',
          title: 'Creating chat',
        });
        const created = await api.createChat({
          cwd: preferredStartCwd ?? undefined,
        });

        setSelectedChatId(created.id);
        setSelectedChat({
          ...created,
          status: 'running',
          updatedAt: new Date().toISOString(),
          statusUpdatedAt: new Date().toISOString(),
          lastMessagePreview: content.slice(0, 50),
          messages: [...created.messages, optimisticMessage],
        });

        setActivity({
          tone: 'running',
          title: 'Working',
        });
        bumpRunWatchdog();
        appendActivityPhrase('Turn started', true);

        const updated = await api.sendChatMessage(created.id, {
          content,
          cwd: created.cwd ?? preferredStartCwd ?? undefined,
        });
        setSelectedChat(updated);
        setError(null);
        setActivity({
          tone: 'complete',
          title: 'Turn completed',
        });
        clearRunWatchdog();
      } catch (err) {
        setError((err as Error).message);
        setActivity({
          tone: 'error',
          title: 'Turn failed',
          detail: (err as Error).message,
        });
        clearRunWatchdog();
      } finally {
        setCreating(false);
      }
    }, [
      api,
      draft,
      preferredStartCwd,
      appendActivityPhrase,
      bumpRunWatchdog,
      clearRunWatchdog,
    ]);

    const sendMessage = useCallback(async () => {
      const content = draft.trim();
      if (!selectedChatId || !content) return;

      const optimisticMessage: ChatTranscriptMessage = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
      };

      setDraft('');
      setSelectedChat((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          messages: [...prev.messages, optimisticMessage],
        };
      });
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);

      try {
        setSending(true);
        setActivity({
          tone: 'running',
          title: 'Sending message',
        });
        bumpRunWatchdog();
        const updated = await api.sendChatMessage(selectedChatId, {
          content,
          cwd: selectedChat?.cwd,
        });
        setSelectedChat(updated);
        setError(null);
        setActivity({
          tone: 'complete',
          title: 'Turn completed',
        });
        clearRunWatchdog();
      } catch (err) {
        setError((err as Error).message);
        setActivity({
          tone: 'error',
          title: 'Turn failed',
          detail: (err as Error).message,
        });
        clearRunWatchdog();
      } finally {
        setSending(false);
      }
    }, [api, draft, selectedChat?.cwd, selectedChatId, bumpRunWatchdog, clearRunWatchdog]);

    useEffect(() => {
      const pendingApprovalId = pendingApproval?.id;

      return ws.onEvent((event: RpcNotification) => {
        const currentId = chatIdRef.current;

        if (event.method === 'thread/name/updated') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          if (!threadId || threadId !== currentId) {
            return;
          }

          const threadName =
            readString(params?.threadName) ?? readString(params?.thread_name);
          if (threadName && threadName.trim()) {
            setSelectedChat((prev) =>
              prev
                ? {
                    ...prev,
                    title: threadName,
                  }
                : prev
            );
          } else {
            void loadChat(threadId);
          }
          return;
        }

        if (event.method.startsWith('codex/event/')) {
          const params = toRecord(event.params);
          const msg = toRecord(params?.msg);
          const codexEventType =
            readString(msg?.type) ?? event.method.replace('codex/event/', '');
          const threadId =
            readString(msg?.thread_id) ??
            readString(msg?.threadId) ??
            readString(params?.threadId) ??
            readString(params?.conversationId) ??
            readString(msg?.conversation_id);

          if (!currentId) {
            return;
          }

          const isMatchingThread = Boolean(threadId) && threadId === currentId;
          const isUnscopedRunEvent =
            !threadId &&
            isCodexRunHeartbeatEvent(codexEventType) &&
            isRunContextActive();

          if (!isMatchingThread && !isUnscopedRunEvent) {
            return;
          }

          const activeThreadId = threadId ?? currentId;

          if (isCodexRunHeartbeatEvent(codexEventType)) {
            bumpRunWatchdog();
          }

          if (codexEventType === 'task_started') {
            setActivity({
              tone: 'running',
              title: 'Working',
            });
            appendActivityPhrase('Turn started', true);
            return;
          }

          if (
            codexEventType === 'agent_reasoning_delta' ||
            codexEventType === 'reasoning_content_delta' ||
            codexEventType === 'reasoning_raw_content_delta' ||
            codexEventType === 'agent_reasoning_raw_content_delta'
          ) {
            const delta = readString(msg?.delta);
            if (!delta) {
              return;
            }

            codexReasoningBufferRef.current += delta;
            const heading =
              extractFirstBoldSnippet(codexReasoningBufferRef.current, 56) ??
              extractFirstBoldSnippet(delta, 56);
            const summary = toTickerSnippet(stripMarkdownInline(delta), 64);

            setActivity({
              tone: 'running',
              title: heading ?? 'Reasoning',
              detail: heading ? undefined : summary ?? undefined,
            });

            if (heading) {
              setActivityPhrases([heading]);
            } else if (summary) {
              appendActivityPhrase(`Reasoning: ${summary}`, true);
            } else {
              appendActivityPhrase('Reasoning', true);
            }
            return;
          }

          if (codexEventType === 'agent_reasoning_section_break') {
            codexReasoningBufferRef.current = '';
            setActivityPhrases(['Analyzing text']);
            return;
          }

          if (
            codexEventType === 'agent_message_delta' ||
            codexEventType === 'agent_message_content_delta'
          ) {
            const delta = readString(msg?.delta);
            if (!delta) {
              return;
            }

            if (hadCommandRef.current) {
              setStreamingText(delta);
              setActiveCommands([]);
              hadCommandRef.current = false;
            } else {
              setStreamingText((prev) => (prev ?? '') + delta);
            }

            setActivity((prev) =>
              prev.tone === 'running' && prev.title === 'Thinking'
                ? prev
                : {
                    tone: 'running',
                    title: 'Thinking',
                  }
            );
            appendActivityPhrase('Drafting response', true);
            setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
            return;
          }

          if (codexEventType === 'exec_command_begin') {
            const command = toCommandDisplay(msg?.command);
            const detail = toTickerSnippet(command, 80);
            setActivity({
              tone: 'running',
              title: 'Running command',
              detail: detail ?? undefined,
            });
            appendActivityPhrase(
              detail ? `Running command: ${detail}` : 'Running command',
              true
            );
            return;
          }

          if (codexEventType === 'exec_command_end') {
            const status = readString(msg?.status);
            const command = toCommandDisplay(msg?.command);
            const detail = toTickerSnippet(command, 80);
            const failed = status === 'failed' || status === 'error';

            setActivity({
              tone: failed ? 'error' : 'running',
              title: failed ? 'Command failed' : 'Working',
              detail: detail ?? undefined,
            });
            appendActivityPhrase(
              failed
                ? detail
                  ? `Command failed: ${detail}`
                  : 'Command failed'
                : detail
                  ? `Command completed: ${detail}`
                  : 'Command completed',
              true
            );
            return;
          }

          if (codexEventType === 'mcp_startup_update') {
            const server = readString(msg?.server);
            const state =
              readString(msg?.status) ??
              readString(toRecord(msg?.status)?.type);
            const detail = [server, state].filter(Boolean).join(' · ');

            setActivity({
              tone: 'running',
              title: 'Starting MCP servers',
              detail: detail || undefined,
            });
            appendActivityPhrase(
              detail ? `Starting MCP: ${detail}` : 'Starting MCP servers',
              true
            );
            return;
          }

          if (codexEventType === 'mcp_tool_call_begin') {
            const server = readString(msg?.server);
            const tool = readString(msg?.tool);
            const detail = [server, tool].filter(Boolean).join(' / ');

            setActivity({
              tone: 'running',
              title: 'Running tool',
              detail: detail || undefined,
            });
            appendActivityPhrase(
              detail ? `Running tool: ${detail}` : 'Running tool',
              true
            );
            return;
          }

          if (codexEventType === 'web_search_begin') {
            const query = toTickerSnippet(readString(msg?.query), 64);
            setActivity({
              tone: 'running',
              title: 'Searching web',
              detail: query ?? undefined,
            });
            appendActivityPhrase(
              query ? `Searching web: ${query}` : 'Searching web',
              true
            );
            return;
          }

          if (codexEventType === 'background_event') {
            const message =
              toTickerSnippet(readString(msg?.message), 72) ??
              toTickerSnippet(readString(msg?.text), 72);
            setActivity({
              tone: 'running',
              title: message ?? 'Working',
            });
            if (message) {
              setActivityPhrases([message]);
            } else {
              appendActivityPhrase('Working', true);
            }
            return;
          }

          if (codexEventType === 'turn_aborted') {
            clearRunWatchdog();
            setActiveCommands([]);
            setStreamingText(null);
            setActivityPhrases([]);
            reasoningSummaryRef.current = {};
            codexReasoningBufferRef.current = '';
            hadCommandRef.current = false;
            setActivity({
              tone: 'error',
              title: 'Turn interrupted',
            });
            void loadChat(activeThreadId);
            return;
          }

          if (codexEventType === 'task_complete') {
            clearRunWatchdog();
            setActivity({
              tone: 'complete',
              title: 'Turn completed',
            });
            setActivityPhrases([]);
            setStreamingText(null);
            reasoningSummaryRef.current = {};
            codexReasoningBufferRef.current = '';
            hadCommandRef.current = false;
            void loadChat(activeThreadId);
            return;
          }
        }

        // Streaming delta -> transient thinking text
        if (event.method === 'item/agentMessage/delta') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId);
          if (!threadId || currentId !== threadId) return;

          const delta = readString(params?.delta);
          if (!delta) return;

          bumpRunWatchdog();
          if (hadCommandRef.current) {
            setStreamingText(delta);
            setActiveCommands([]);
            hadCommandRef.current = false;
          } else {
            setStreamingText((prev) => (prev ?? '') + delta);
          }
          setActivity((prev) =>
            prev.tone === 'running' && prev.title === 'Thinking'
              ? prev
              : {
                  tone: 'running',
                  title: 'Thinking',
                }
          );
          appendActivityPhrase('Drafting response', true);
          setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
          return;
        }

        if (event.method === 'turn/started') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(toRecord(params?.turn)?.threadId);
          if (!threadId || threadId !== currentId) {
            return;
          }
          bumpRunWatchdog();
          setActivity({
            tone: 'running',
            title: 'Turn started',
          });
          appendActivityPhrase('Turn started', true);
          return;
        }

        if (event.method === 'item/started') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId);
          if (!threadId || threadId !== currentId) {
            return;
          }
          bumpRunWatchdog();
          const item = toRecord(params?.item);
          const itemType = readString(item?.type);

          if (itemType === 'commandExecution') {
            const command = readString(item?.command);
            setActivity({
              tone: 'running',
              title: 'Running command',
              detail: command ?? undefined,
            });
            appendActivityPhrase(
              command ? `Running command: ${command}` : 'Running command',
              true
            );
            return;
          }

          if (itemType === 'fileChange') {
            setActivity({
              tone: 'running',
              title: 'Applying file changes',
            });
            appendActivityPhrase('Applying file changes', true);
            return;
          }

          if (itemType === 'mcpToolCall') {
            const server = readString(item?.server);
            const tool = readString(item?.tool);
            const detail = [server, tool].filter(Boolean).join(' / ');
            setActivity({
              tone: 'running',
              title: 'Running tool',
              detail,
            });
            appendActivityPhrase(
              detail ? `Running tool: ${detail}` : 'Running tool',
              true
            );
            return;
          }

          if (itemType === 'plan') {
            setActivity({
              tone: 'running',
              title: 'Planning',
            });
            appendActivityPhrase('Planning next steps', true);
            return;
          }

          if (itemType === 'reasoning') {
            setActivity({
              tone: 'running',
              title: 'Reasoning',
            });
            appendActivityPhrase('Reasoning through changes', true);
            return;
          }
        }

        if (event.method === 'item/plan/delta') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId);
          if (!threadId || threadId !== currentId) {
            return;
          }

          bumpRunWatchdog();
          const delta = toTickerSnippet(readString(params?.delta), 56);
          setActivity((prev) =>
            prev.tone === 'running' && prev.title === 'Planning'
              ? prev
              : {
                  tone: 'running',
                  title: 'Planning',
                }
          );
          appendActivityPhrase(
            delta ? `Plan update: ${delta}` : 'Planning next steps',
            true
          );
          return;
        }

        if (event.method === 'item/reasoning/summaryPartAdded') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId);
          if (!threadId || threadId !== currentId) {
            return;
          }

          bumpRunWatchdog();
          const itemId = readString(params?.itemId);
          const summaryIndex = readNumber(params?.summaryIndex);
          const summaryKey =
            itemId && summaryIndex !== null ? `${itemId}:${String(summaryIndex)}` : null;
          if (summaryKey && reasoningSummaryRef.current[summaryKey] === undefined) {
            reasoningSummaryRef.current[summaryKey] = '';
          }

          setActivity((prev) =>
            prev.tone === 'running' && prev.title === 'Reasoning'
              ? prev
              : {
                  tone: 'running',
                  title: 'Reasoning',
                }
          );
          setActivityPhrases(['Analyzing text']);
          return;
        }

        if (event.method === 'item/reasoning/summaryTextDelta') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId);
          if (!threadId || threadId !== currentId) {
            return;
          }

          bumpRunWatchdog();
          const delta = readString(params?.delta);
          const itemId = readString(params?.itemId);
          const summaryIndex = readNumber(params?.summaryIndex);
          const summaryKey =
            itemId && summaryIndex !== null ? `${itemId}:${String(summaryIndex)}` : null;

          let summaryText = toTickerSnippet(delta, 64);
          let heading = extractFirstBoldSnippet(delta, 56);
          if (summaryKey) {
            const accumulated = (reasoningSummaryRef.current[summaryKey] ?? '') + (delta ?? '');
            reasoningSummaryRef.current[summaryKey] = accumulated;
            summaryText = toTickerSnippet(stripMarkdownInline(accumulated), 64);
            heading = extractFirstBoldSnippet(accumulated, 56) ?? heading;
          }

          setActivity((prev) => {
            const title = heading ?? 'Reasoning';
            const detail = heading ? undefined : summaryText ?? prev.detail;
            if (
              prev.tone === 'running' &&
              prev.title === title &&
              prev.detail === detail
            ) {
              return prev;
            }
            return {
              tone: 'running',
              title,
              detail,
            };
          });
          if (heading) {
            setActivityPhrases([heading]);
          } else if (summaryText) {
            setActivityPhrases([summaryText]);
          } else {
            setActivityPhrases(['Analyzing text']);
          }
          return;
        }

        if (event.method === 'item/reasoning/textDelta') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId);
          if (!threadId || threadId !== currentId) {
            return;
          }

          bumpRunWatchdog();
          const delta = toTickerSnippet(readString(params?.delta), 56);
          setActivity((prev) =>
            prev.tone === 'running' && prev.title === 'Reasoning'
              ? prev
              : {
                  tone: 'running',
                  title: 'Reasoning',
                }
          );
          appendActivityPhrase(
            delta ? `Reasoning: ${delta}` : 'Reasoning through the task',
            true
          );
          return;
        }

        if (event.method === 'item/commandExecution/outputDelta') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId);
          if (!threadId || threadId !== currentId) {
            return;
          }

          bumpRunWatchdog();
          const delta = toLastLineSnippet(readString(params?.delta), 64);
          setActivity((prev) =>
            prev.tone === 'running' && prev.title === 'Running command'
              ? prev
              : {
                  tone: 'running',
                  title: 'Running command',
                }
          );
          appendActivityPhrase(
            delta ? `Command output: ${delta}` : 'Streaming command output',
            true
          );
          return;
        }

        if (event.method === 'item/mcpToolCall/progress') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId);
          if (!threadId || threadId !== currentId) {
            return;
          }

          bumpRunWatchdog();
          const message = toTickerSnippet(readString(params?.message), 64);
          setActivity((prev) =>
            prev.tone === 'running' && prev.title === 'Running tool'
              ? prev
              : {
                  tone: 'running',
                  title: 'Running tool',
                }
          );
          appendActivityPhrase(
            message ? `Tool progress: ${message}` : 'Running tool',
            true
          );
          return;
        }

        if (event.method === 'item/commandExecution/terminalInteraction') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId);
          if (!threadId || threadId !== currentId) {
            return;
          }

          bumpRunWatchdog();
          setActivity({
            tone: 'running',
            title: 'Terminal interaction',
          });
          appendActivityPhrase('Waiting for terminal interaction', true);
          return;
        }

        if (event.method === 'turn/plan/updated') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId);
          if (!threadId || threadId !== currentId) {
            return;
          }

          bumpRunWatchdog();
          setActivity({
            tone: 'running',
            title: 'Plan updated',
          });
          appendActivityPhrase('Plan updated', true);
          return;
        }

        if (event.method === 'turn/diff/updated') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId);
          if (!threadId || threadId !== currentId) {
            return;
          }

          bumpRunWatchdog();
          setActivity({
            tone: 'running',
            title: 'Updating diff',
          });
          appendActivityPhrase('Updating code diff', true);
          return;
        }

        // Command completion blocks
        if (event.method === 'item/completed') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId);
          if (!threadId || threadId !== currentId) {
            return;
          }

          const item = toRecord(params?.item);
          if (readString(item?.type) === 'commandExecution') {
            const command = readString(item?.command);
            const status = readString(item?.status);
            hadCommandRef.current = true;
            setActivity({
              tone: status === 'failed' ? 'error' : 'complete',
              title: status === 'failed' ? 'Command failed' : 'Command completed',
              detail: command ?? undefined,
            });
            appendActivityPhrase(
              status === 'failed'
                ? command
                  ? `Command failed: ${command}`
                  : 'Command failed'
                : command
                  ? `Command completed: ${command}`
                  : 'Command completed'
            );
            setActiveCommands((prev) => [
              ...prev,
              {
                id: `re-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                threadId,
                eventType: 'command.completed',
                at: new Date().toISOString(),
                detail: [command, status].filter(Boolean).join(' | '),
              },
            ]);
          }
          return;
        }

        // Turn completion/failure
        if (event.method === 'turn/completed') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId);
          if (!threadId || currentId !== threadId) {
            return;
          }
          clearRunWatchdog();

          const turn = toRecord(params?.turn);
          const status = readString(turn?.status);
          const turnError = toRecord(turn?.error);
          const turnErrorMessage = readString(turnError?.message);

          setActiveCommands([]);
          setStreamingText(null);
          hadCommandRef.current = false;
          setActivityPhrases([]);
          reasoningSummaryRef.current = {};
          codexReasoningBufferRef.current = '';

          if (status === 'failed' || status === 'interrupted') {
            setError(turnErrorMessage ?? `turn ${status ?? 'failed'}`);
            setActivity({
              tone: 'error',
              title: 'Turn failed',
              detail: turnErrorMessage ?? status ?? undefined,
            });
          } else {
            setActivity({
              tone: 'complete',
              title: 'Turn completed',
            });
          }
          void loadChat(threadId);
          return;
        }

        if (event.method === 'bridge/approval.requested') {
          const parsed = toPendingApproval(event.params);
          if (parsed && parsed.threadId === currentId) {
            clearRunWatchdog();
            setPendingApproval(parsed);
            setActivity({
              tone: 'idle',
              title: 'Waiting for approval',
              detail: parsed.command ?? parsed.kind,
            });
          }
          return;
        }

        if (event.method === 'bridge/approval.resolved') {
          const params = toRecord(event.params);
          const resolvedId = readString(params?.id);
          if (pendingApprovalId && resolvedId === pendingApprovalId) {
            bumpRunWatchdog();
            setPendingApproval(null);
            setActivity({
              tone: 'running',
              title: 'Approval resolved',
            });
            appendActivityPhrase('Approval resolved', true);
          }
          return;
        }

        if (event.method === 'bridge/connection/state') {
          const params = toRecord(event.params);
          const status = readString(params?.status);
          if (status === 'connected' && currentId) {
            setActivity((prev) =>
              prev.tone === 'running'
                ? prev
                : {
                    tone: 'idle',
                    title: 'Connected',
                  }
            );
            void loadChat(currentId);
            return;
          }

          if (status === 'disconnected') {
            clearRunWatchdog();
            setActivity({
              tone: 'error',
              title: 'Disconnected',
            });
          }
        }
      });
    }, [
      ws,
      pendingApproval?.id,
      loadChat,
      appendActivityPhrase,
      bumpRunWatchdog,
      clearRunWatchdog,
      isRunContextActive,
    ]);

    useEffect(() => {
      if (!selectedChatId) {
        return;
      }
      const hasPendingApproval = Boolean(pendingApproval?.id);

      const syncChat = async () => {
        if (sending || creating) {
          return;
        }

        try {
          const latest = await api.getChat(selectedChatId);
          setSelectedChat((prev) => {
            if (!prev || prev.id !== latest.id) {
              return latest;
            }

            const isUnchanged =
              prev.updatedAt === latest.updatedAt &&
              prev.messages.length === latest.messages.length;

            return isUnchanged ? prev : latest;
          });

          const shouldRunFromChat = isChatLikelyRunning(latest);
          const shouldRunFromWatchdog = runWatchdogUntilRef.current > Date.now();
          const shouldShowRunning = shouldRunFromChat || shouldRunFromWatchdog;

          if (shouldShowRunning && !hasPendingApproval) {
            bumpRunWatchdog();
            setActivity((prev) =>
              prev.tone === 'running'
                ? prev
                : {
                    tone: 'running',
                    title: 'Working',
                  }
            );
          } else if (!hasPendingApproval) {
            clearRunWatchdog();
            setActivity(
              latest.status === 'complete'
                ? {
                    tone: 'complete',
                    title: 'Turn completed',
                  }
                : latest.status === 'error'
                  ? {
                      tone: 'error',
                      title: 'Turn failed',
                      detail: latest.lastError ?? undefined,
                    }
                  : {
                      tone: 'idle',
                      title: 'Ready',
                    }
            );
            setActivityPhrases([]);
          }
        } catch {
          // Polling is best-effort; keep the current view if refresh fails.
        }
      };

      const timer = setInterval(() => {
        void syncChat();
      }, 2500);

      return () => clearInterval(timer);
    }, [
      api,
      selectedChatId,
      sending,
      creating,
      appendActivityPhrase,
      pendingApproval?.id,
      bumpRunWatchdog,
      clearRunWatchdog,
    ]);

    const handleResolveApproval = useCallback(
      async (id: string, decision: ApprovalDecision) => {
        try {
          await api.resolveApproval(id, decision);
          setPendingApproval(null);
        } catch (err) {
          setError((err as Error).message);
        }
      },
      [api]
    );

    const handleOpenGit = useCallback(() => {
      if (!selectedChat) {
        return;
      }
      onOpenGit(selectedChat);
    }, [onOpenGit, selectedChat]);

    const handleSubmit = selectedChat ? sendMessage : createChat;
    const isLoading = sending || creating;
    const isStreaming = sending || creating || Boolean(streamingText);
    const showActivity = Boolean(selectedChatId) || isLoading || activity.tone !== 'idle';
    const headerTitle = selectedChat?.title?.trim() || 'New chat';
    const workspaceLabel = selectedChat?.cwd?.trim() || 'Workspace not set';
    const defaultStartWorkspaceLabel =
      preferredStartCwd ?? 'Bridge default workspace';

    return (
      <View style={styles.container}>
        <ChatHeader
          onOpenDrawer={onOpenDrawer}
          title={headerTitle}
          onOpenTitleMenu={selectedChat ? openChatTitleMenu : undefined}
          rightIconName="git-branch-outline"
          onRightActionPress={selectedChat ? handleOpenGit : undefined}
        />

        {selectedChat ? (
          <Pressable style={styles.workspaceBar} onPress={handleOpenGit}>
            <Ionicons name="folder-open-outline" size={14} color={colors.textMuted} />
            <Text style={styles.workspaceText} numberOfLines={1}>
              {workspaceLabel}
            </Text>
          </Pressable>
        ) : null}

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
          style={styles.keyboardAvoiding}
        >
          {selectedChat ? (
            <ChatView
              chat={selectedChat}
              activeCommands={activeCommands}
              streamingText={streamingText}
              scrollRef={scrollRef}
              isStreaming={isStreaming}
            />
          ) : (
            <ComposeView
              startWorkspaceLabel={defaultStartWorkspaceLabel}
              onSuggestion={(s) => setDraft(s)}
              onOpenWorkspacePicker={openWorkspaceModal}
            />
          )}

          <View style={styles.composerContainer}>
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            {pendingApproval ? (
              <ApprovalBanner
                approval={pendingApproval}
                onResolve={handleResolveApproval}
              />
            ) : null}
            {showActivity ? (
              <ActivityBar
                title={activity.title}
                detail={activity.detail}
                tone={activity.tone}
                runningPhrases={activityPhrases}
              />
            ) : null}
            <ChatInput
              value={draft}
              onChangeText={setDraft}
              onSubmit={() => void handleSubmit()}
              onNewChat={() => void startNewChat()}
              isLoading={isLoading}
              placeholder={selectedChat ? 'Reply...' : 'Message Codex...'}
            />
          </View>
        </KeyboardAvoidingView>

        <Modal
          visible={workspaceModalVisible}
          transparent
          animationType="fade"
          onRequestClose={closeWorkspaceModal}
        >
          <View style={styles.workspaceModalBackdrop}>
            <View style={styles.workspaceModalCard}>
              <Text style={styles.workspaceModalTitle}>Select start directory</Text>
              <ScrollView
                style={styles.workspaceModalList}
                contentContainerStyle={styles.workspaceModalListContent}
                showsVerticalScrollIndicator={false}
              >
                <WorkspaceOption
                  label="Bridge default workspace"
                  selected={preferredStartCwd === null}
                  onPress={() => selectDefaultWorkspace(null)}
                />
                {workspaceOptions.map((cwd) => (
                  <WorkspaceOption
                    key={cwd}
                    label={cwd}
                    selected={cwd === preferredStartCwd}
                    onPress={() => selectDefaultWorkspace(cwd)}
                  />
                ))}
              </ScrollView>
              <View style={styles.workspaceModalActions}>
                {loadingWorkspaces ? (
                  <Text style={styles.workspaceModalLoading}>Refreshing…</Text>
                ) : (
                  <View />
                )}
                <Pressable
                  onPress={closeWorkspaceModal}
                  style={({ pressed }) => [
                    styles.workspaceModalCloseBtn,
                    pressed && styles.workspaceModalCloseBtnPressed,
                  ]}
                >
                  <Text style={styles.workspaceModalCloseText}>Close</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        <Modal
          visible={renameModalVisible}
          transparent
          animationType="fade"
          onRequestClose={closeRenameModal}
        >
          <View style={styles.renameModalBackdrop}>
            <View style={styles.renameModalCard}>
              <Text style={styles.renameModalTitle}>Rename chat</Text>
              <TextInput
                value={renameDraft}
                onChangeText={setRenameDraft}
                placeholder="Chat name"
                placeholderTextColor={colors.textMuted}
                style={styles.renameModalInput}
                autoFocus
                editable={!renaming}
                maxLength={120}
              />
              <View style={styles.renameModalActions}>
                <Pressable
                  onPress={closeRenameModal}
                  style={({ pressed }) => [
                    styles.renameModalButton,
                    styles.renameModalButtonSecondary,
                    pressed && styles.renameModalButtonPressed,
                  ]}
                  disabled={renaming}
                >
                  <Text style={styles.renameModalButtonSecondaryText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={() => void submitRenameChat()}
                  style={({ pressed }) => [
                    styles.renameModalButton,
                    styles.renameModalButtonPrimary,
                    pressed && styles.renameModalButtonPrimaryPressed,
                    (renaming || !renameDraft.trim()) && styles.renameModalButtonDisabled,
                  ]}
                  disabled={renaming || !renameDraft.trim()}
                >
                  <Text style={styles.renameModalButtonPrimaryText}>
                    {renaming ? 'Saving...' : 'Save'}
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    );
  }
);

// ── Compose View ───────────────────────────────────────────────────

function ComposeView({
  startWorkspaceLabel,
  onSuggestion,
  onOpenWorkspacePicker,
}: {
  startWorkspaceLabel: string;
  onSuggestion: (s: string) => void;
  onOpenWorkspacePicker: () => void;
}) {
  return (
    <View style={styles.composeContainer}>
      <View style={styles.composeIcon}>
        <BrandMark size={52} />
      </View>
      <Text style={styles.composeTitle}>Let's build</Text>
      <Text style={styles.composeSubtitle}>clawdex-mobile</Text>
      <Pressable
        style={({ pressed }) => [
          styles.workspaceSelectBtn,
          pressed && styles.workspaceSelectBtnPressed,
        ]}
        onPress={onOpenWorkspacePicker}
      >
        <Ionicons name="folder-open-outline" size={16} color={colors.textMuted} />
        <Text style={styles.workspaceSelectLabel} numberOfLines={1}>
          {startWorkspaceLabel}
        </Text>
        <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
      </Pressable>
      <View style={styles.suggestions}>
        {SUGGESTIONS.map((s) => (
          <Pressable
            key={s}
            style={({ pressed }) => [
              styles.suggestionCard,
              pressed && styles.suggestionCardPressed,
            ]}
            onPress={() => onSuggestion(s)}
          >
            <Text style={styles.suggestionText}>{s}</Text>
          </Pressable>
        ))}
      </View>
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

// ── Chat View ──────────────────────────────────────────────────────

function ChatView({
  chat,
  activeCommands,
  streamingText,
  scrollRef,
  isStreaming,
}: {
  chat: Chat;
  activeCommands: RunEvent[];
  streamingText: string | null;
  scrollRef: React.RefObject<ScrollView | null>;
  isStreaming: boolean;
}) {
  const filtered = chat.messages.filter((msg) => {
    const text = msg.content || '';
    if (text.includes('FINAL_TASK_RESULT_JSON')) return false;
    if (text.includes('Current working directory is:')) return false;
    if (text.includes('You are operating in task worktree')) return false;
    if (msg.role === 'assistant' && !text.trim()) return false;
    return true;
  });

  // For each consecutive run of assistant messages, only keep the last
  // one (the final answer). Earlier ones are intermediate thinking.
  const visibleMessages = filtered.filter((msg, i) => {
    if (msg.role !== 'assistant') return true;
    const next = filtered[i + 1];
    return !next || next.role !== 'assistant';
  });

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.messageList}
      contentContainerStyle={styles.messageListContent}
      showsVerticalScrollIndicator={false}
      onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
    >
      {visibleMessages.map((msg) => (
        <ChatMessage key={msg.id} message={msg} />
      ))}
      {streamingText ? (
        <Text style={styles.streamingText} numberOfLines={4}>
          {streamingText}
        </Text>
      ) : null}
      {activeCommands.map((cmd) => {
        if (!cmd.detail) return null;
        const parts = cmd.detail.split('|').map((s) => s.trim());
        const command = parts[0] || cmd.detail;
        const status = parts[1] === 'error' ? ('error' as const) : ('complete' as const);
        return <ToolBlock key={cmd.id} command={command} status={status} />;
      })}
      {isStreaming && !streamingText && activeCommands.length === 0 ? <TypingIndicator /> : null}
    </ScrollView>
  );
}

// ── Helpers ────────────────────────────────────────────────────────

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeWorkspacePath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractWorkspaceOptions(chats: ChatSummary[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const chat of chats) {
    const cwd = normalizeWorkspacePath(chat.cwd);
    if (!cwd || seen.has(cwd)) {
      continue;
    }
    seen.add(cwd);
    result.push(cwd);
  }

  return result;
}

function stripMarkdownInline(value: string): string {
  return value
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[_~]/g, '');
}

function toTickerSnippet(
  value: string | null | undefined,
  maxLength = 72
): string | null {
  if (!value) {
    return null;
  }

  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return null;
  }

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  return `${cleaned.slice(0, Math.max(1, maxLength - 1))}…`;
}

function toLastLineSnippet(
  value: string | null | undefined,
  maxLength = 72
): string | null {
  if (!value) {
    return null;
  }

  const line = value
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(-1)[0];

  return toTickerSnippet(line ?? null, maxLength);
}

function toActivityPhrase(title: string, detail?: string): string | null {
  const compactTitle = toTickerSnippet(title, 36);
  const compactDetail = toTickerSnippet(detail ?? null, 64);

  if (compactTitle && compactDetail) {
    return `${compactTitle}: ${compactDetail}`;
  }

  return compactTitle ?? compactDetail ?? null;
}

function isCodexRunHeartbeatEvent(codexEventType: string): boolean {
  return CODEX_RUN_HEARTBEAT_EVENT_TYPES.has(codexEventType);
}

function isChatLikelyRunning(chat: Chat): boolean {
  if (chat.status === 'running') {
    return true;
  }

  if (chat.status === 'error') {
    return false;
  }

  const lastMessage = chat.messages[chat.messages.length - 1];
  if (!lastMessage || lastMessage.role !== 'user') {
    return false;
  }

  const updatedAtMs = Date.parse(chat.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return false;
  }

  return Date.now() - updatedAtMs < LIKELY_RUNNING_RECENT_UPDATE_MS;
}

function extractFirstBoldSnippet(
  value: string | null | undefined,
  maxLength = 56
): string | null {
  if (!value) {
    return null;
  }

  const match = value.match(/\*\*([^*]+)\*\*/);
  if (!match) {
    return null;
  }

  return toTickerSnippet(match[1], maxLength);
}

function toCommandDisplay(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const parts = value.filter((entry): entry is string => typeof entry === 'string');
  if (parts.length === 0) {
    return null;
  }

  return parts.join(' ');
}

function toPendingApproval(value: unknown): PendingApproval | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const id = readString(record.id);
  const kind = readString(record.kind);
  const threadId = readString(record.threadId);
  const turnId = readString(record.turnId);
  const itemId = readString(record.itemId);
  const requestedAt = readString(record.requestedAt);

  if (
    !id ||
    !kind ||
    !threadId ||
    !turnId ||
    !itemId ||
    !requestedAt ||
    (kind !== 'commandExecution' && kind !== 'fileChange')
  ) {
    return null;
  }

  return {
    id,
    kind,
    threadId,
    turnId,
    itemId,
    requestedAt,
    reason: readString(record.reason) ?? undefined,
    command: readString(record.command) ?? undefined,
    cwd: readString(record.cwd) ?? undefined,
    grantRoot: readString(record.grantRoot) ?? undefined,
  };
}

// ── Styles ─────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgMain,
  },

  bodyContainer: {
    flex: 1,
  },
  keyboardAvoiding: {
    flex: 1,
  },
  composerContainer: {
    backgroundColor: colors.bgMain,
  },
  workspaceBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    backgroundColor: colors.bgMain,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderLight,
  },
  workspaceText: {
    ...typography.caption,
    color: colors.textSecondary,
    flex: 1,
  },
  renameModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  workspaceModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  workspaceModalCard: {
    backgroundColor: colors.bgItem,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
    maxHeight: '70%',
  },
  workspaceModalTitle: {
    ...typography.headline,
    color: colors.textPrimary,
  },
  workspaceModalList: {
    maxHeight: 320,
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
    backgroundColor: colors.bgMain,
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
  workspaceModalActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  workspaceModalLoading: {
    ...typography.caption,
    color: colors.textMuted,
  },
  workspaceModalCloseBtn: {
    borderRadius: 10,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgMain,
  },
  workspaceModalCloseBtnPressed: {
    opacity: 0.85,
  },
  workspaceModalCloseText: {
    ...typography.body,
    color: colors.textPrimary,
  },
  renameModalCard: {
    backgroundColor: colors.bgItem,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  renameModalTitle: {
    ...typography.headline,
    color: colors.textPrimary,
  },
  renameModalInput: {
    color: colors.textPrimary,
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 15,
  },
  renameModalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  renameModalButton: {
    borderRadius: 10,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderWidth: 1,
  },
  renameModalButtonSecondary: {
    borderColor: colors.border,
    backgroundColor: colors.bgMain,
  },
  renameModalButtonSecondaryText: {
    ...typography.body,
    color: colors.textPrimary,
  },
  renameModalButtonPrimary: {
    borderColor: colors.accent,
    backgroundColor: colors.accent,
  },
  renameModalButtonPrimaryPressed: {
    backgroundColor: colors.accentPressed,
    borderColor: colors.accentPressed,
  },
  renameModalButtonDisabled: {
    opacity: 0.45,
  },
  renameModalButtonPressed: {
    opacity: 0.8,
  },
  renameModalButtonPrimaryText: {
    ...typography.body,
    color: colors.black,
    fontWeight: '600',
  },

  // Compose
  composeContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl * 2,
  },
  composeIcon: {
    marginBottom: spacing.lg,
  },
  composeTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  },
  composeSubtitle: {
    ...typography.body,
    color: colors.textMuted,
    marginBottom: spacing.lg,
  },
  workspaceSelectBtn: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderLight,
    backgroundColor: colors.bgItem,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.xl * 2,
  },
  workspaceSelectBtnPressed: {
    opacity: 0.85,
  },
  workspaceSelectLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    flex: 1,
  },
  suggestions: {
    flexDirection: 'row',
    gap: spacing.md,
    width: '100%',
  },
  suggestionCard: {
    flex: 1,
    backgroundColor: colors.bgItem,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing.md,
  },
  suggestionCardPressed: {
    backgroundColor: colors.bgInput,
  },
  suggestionText: {
    ...typography.caption,
    color: colors.textPrimary,
    lineHeight: 18,
  },

  // Chat
  messageList: {
    flex: 1,
  },
  messageListContent: {
    padding: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.xl,
  },

  // Streaming thinking text
  streamingText: {
    ...typography.body,
    fontStyle: 'italic',
    color: colors.textMuted,
    lineHeight: 20,
  },

  // Error
  errorText: {
    ...typography.caption,
    color: colors.error,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
});
