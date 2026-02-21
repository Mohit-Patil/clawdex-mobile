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
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { MacBridgeApiClient } from '../api/client';
import type {
  ApprovalDecision,
  PendingApproval,
  RpcNotification,
  RunEvent,
  Thread,
  ThreadMessage,
} from '../api/types';
import type { MacBridgeWsClient } from '../api/ws';
import { ActivityBar, type ActivityTone } from '../components/ActivityBar';
import { ApprovalBanner } from '../components/ApprovalBanner';
import { ChatHeader } from '../components/ChatHeader';
import { ChatInput } from '../components/ChatInput';
import { ChatMessage } from '../components/ChatMessage';
import { ToolBlock } from '../components/ToolBlock';
import { TypingIndicator } from '../components/TypingIndicator';
import { colors, spacing, typography } from '../theme';

export interface MainScreenHandle {
  openThread: (id: string) => void;
  startNewThread: () => void;
}

interface MainScreenProps {
  api: MacBridgeApiClient;
  ws: MacBridgeWsClient;
  onOpenDrawer: () => void;
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

export const MainScreen = forwardRef<MainScreenHandle, MainScreenProps>(
  function MainScreen({ api, ws, onOpenDrawer }, ref) {
    const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
    const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [activeCommands, setActiveCommands] = useState<RunEvent[]>([]);
    const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
    const [streamingText, setStreamingText] = useState<string | null>(null);
    const [activity, setActivity] = useState<ActivityState>({
      tone: 'idle',
      title: 'Ready',
    });
    const [activityPhrases, setActivityPhrases] = useState<string[]>([]);
    const scrollRef = useRef<ScrollView>(null);

    // Ref so the WS handler always reads the latest thread ID without
    // needing to re-subscribe on every change.
    const threadIdRef = useRef<string | null>(null);
    threadIdRef.current = selectedThreadId;

    // Track whether a command arrived since the last delta — used to
    // know when a new thinking segment starts so we can replace the old one.
    const hadCommandRef = useRef(false);
    const reasoningSummaryRef = useRef<Record<string, string>>({});

    const appendActivityPhrase = useCallback(
      (value: string | null | undefined, seedDefaults = false) => {
        const phrase = toTickerSnippet(value);
        setActivityPhrases((prev) => {
          const base =
            seedDefaults && prev.length === 0
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
      if (activity.tone !== 'running') {
        setActivityPhrases([]);
        return;
      }

      appendActivityPhrase(toActivityPhrase(activity.title, activity.detail), true);
    }, [activity.tone, activity.title, activity.detail, appendActivityPhrase]);

    const resetComposerState = useCallback(() => {
      setSelectedThread(null);
      setSelectedThreadId(null);
      setDraft('');
      setError(null);
      setActiveCommands([]);
      setPendingApproval(null);
      setStreamingText(null);
      setActivity({
        tone: 'idle',
        title: 'Ready',
      });
      setActivityPhrases([]);
      reasoningSummaryRef.current = {};
      hadCommandRef.current = false;
    }, []);

    const startNewThread = useCallback(async () => {
      resetComposerState();
      try {
        setCreating(true);
        setActivity({
          tone: 'running',
          title: 'Creating thread',
        });
        const created = await api.createThread({});
        setSelectedThreadId(created.id);
        setSelectedThread(created);
        setError(null);
        setActivity({
          tone: 'idle',
          title: 'Thread ready',
        });
      } catch (err) {
        setError((err as Error).message);
        setActivity({
          tone: 'error',
          title: 'Failed to create thread',
          detail: (err as Error).message,
        });
      } finally {
        setCreating(false);
      }
    }, [api, resetComposerState]);

    useImperativeHandle(ref, () => ({
      openThread: (id: string) => {
        void loadThread(id);
      },
      startNewThread: () => {
        void startNewThread();
      },
    }));

    const loadThread = useCallback(
      async (threadId: string) => {
        try {
          const thread = await api.getThread(threadId);
          setSelectedThreadId(threadId);
          setSelectedThread(thread);
          setError(null);
          setActiveCommands([]);
          setPendingApproval(null);
          setStreamingText(null);
          setActivity({
            tone: 'idle',
            title: 'Ready',
          });
          reasoningSummaryRef.current = {};
          hadCommandRef.current = false;
        } catch (err) {
          setError((err as Error).message);
          setActivity({
            tone: 'error',
            title: 'Failed to load thread',
            detail: (err as Error).message,
          });
        }
      },
      [api]
    );

    const createThread = useCallback(async () => {
      const content = draft.trim();
      if (!content) return;

      const optimisticThreadId = `temp-${Date.now()}`;
      const optimisticMessage: ThreadMessage = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
      };

      const optimisticThread: Thread = {
        id: optimisticThreadId,
        title: 'New Thread...',
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        statusUpdatedAt: new Date().toISOString(),
        lastMessagePreview: content.slice(0, 50),
        messages: [optimisticMessage],
      };

      setDraft('');
      setSelectedThreadId(optimisticThreadId);
      setSelectedThread(optimisticThread);

      try {
        setCreating(true);
        setActivity({
          tone: 'running',
          title: 'Starting turn',
        });
        const created = await api.createThread({ message: content });
        setSelectedThreadId(created.id);
        setSelectedThread(created);
        setError(null);
        setActivity({
          tone: 'complete',
          title: 'Turn completed',
        });
      } catch (err) {
        setError((err as Error).message);
        setActivity({
          tone: 'error',
          title: 'Turn failed',
          detail: (err as Error).message,
        });
      } finally {
        setCreating(false);
      }
    }, [api, draft]);

    const sendMessage = useCallback(async () => {
      const content = draft.trim();
      if (!selectedThreadId || !content) return;

      const optimisticMessage: ThreadMessage = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
      };

      setDraft('');
      setSelectedThread((prev) => {
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
        const updated = await api.sendThreadMessage(selectedThreadId, { content });
        setSelectedThread(updated);
        setError(null);
        setActivity({
          tone: 'complete',
          title: 'Turn completed',
        });
      } catch (err) {
        setError((err as Error).message);
        setActivity({
          tone: 'error',
          title: 'Turn failed',
          detail: (err as Error).message,
        });
      } finally {
        setSending(false);
      }
    }, [api, draft, selectedThreadId]);

    useEffect(() => {
      const pendingApprovalId = pendingApproval?.id;

      return ws.onEvent((event: RpcNotification) => {
        const currentId = threadIdRef.current;

        // Streaming delta -> transient thinking text
        if (event.method === 'item/agentMessage/delta') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId);
          if (!threadId || currentId !== threadId) return;

          const delta = readString(params?.delta);
          if (!delta) return;

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

          const delta = readString(params?.delta);
          const itemId = readString(params?.itemId);
          const summaryIndex = readNumber(params?.summaryIndex);
          const summaryKey =
            itemId && summaryIndex !== null ? `${itemId}:${String(summaryIndex)}` : null;

          let summaryText = toTickerSnippet(delta, 64);
          if (summaryKey) {
            const accumulated = (reasoningSummaryRef.current[summaryKey] ?? '') + (delta ?? '');
            reasoningSummaryRef.current[summaryKey] = accumulated;
            summaryText = toTickerSnippet(stripMarkdownInline(accumulated), 64);
          }

          setActivity((prev) => {
            const detail = summaryText ?? prev.detail;
            if (
              prev.tone === 'running' &&
              prev.title === 'Reasoning' &&
              prev.detail === detail
            ) {
              return prev;
            }
            return {
              tone: 'running',
              title: 'Reasoning',
              detail,
            };
          });
          if (summaryText) {
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

          const turn = toRecord(params?.turn);
          const status = readString(turn?.status);
          const turnError = toRecord(turn?.error);
          const turnErrorMessage = readString(turnError?.message);

          setActiveCommands([]);
          setStreamingText(null);
          hadCommandRef.current = false;
          setActivityPhrases([]);
          reasoningSummaryRef.current = {};

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
          void loadThread(threadId);
          return;
        }

        if (event.method === 'bridge/approval.requested') {
          const parsed = toPendingApproval(event.params);
          if (parsed && parsed.threadId === currentId) {
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
            void loadThread(currentId);
            return;
          }

          if (status === 'disconnected') {
            setActivity({
              tone: 'error',
              title: 'Disconnected',
            });
          }
        }
      });
    }, [ws, pendingApproval?.id, loadThread, appendActivityPhrase]);

    useEffect(() => {
      if (!selectedThreadId) {
        return;
      }

      const syncThread = async () => {
        if (sending || creating) {
          return;
        }

        try {
          const latest = await api.getThread(selectedThreadId);
          setSelectedThread((prev) => {
            if (!prev || prev.id !== latest.id) {
              return latest;
            }

            const isUnchanged =
              prev.updatedAt === latest.updatedAt &&
              prev.messages.length === latest.messages.length;

            return isUnchanged ? prev : latest;
          });
        } catch {
          // Polling is best-effort; keep the current view if refresh fails.
        }
      };

      const timer = setInterval(() => {
        void syncThread();
      }, 2500);

      return () => clearInterval(timer);
    }, [api, selectedThreadId, sending, creating]);

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

    const handleSubmit = selectedThread ? sendMessage : createThread;
    const isLoading = sending || creating;
    const isStreaming = sending || creating || Boolean(streamingText);
    const showActivity = Boolean(selectedThreadId) || isLoading || activity.tone !== 'idle';

    return (
      <View style={styles.container}>
        <ChatHeader onOpenDrawer={onOpenDrawer} />

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
          style={styles.keyboardAvoiding}
        >
          {selectedThread ? (
            <ChatView
              thread={selectedThread}
              activeCommands={activeCommands}
              streamingText={streamingText}
              scrollRef={scrollRef}
              isStreaming={isStreaming}
            />
          ) : (
            <ComposeView onSuggestion={(s) => setDraft(s)} />
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
              onNewThread={() => void startNewThread()}
              isLoading={isLoading}
              placeholder={selectedThread ? 'Reply...' : 'Message Codex...'}
            />
          </View>
        </KeyboardAvoidingView>
      </View>
    );
  }
);

// ── Compose View ───────────────────────────────────────────────────

function ComposeView({ onSuggestion }: { onSuggestion: (s: string) => void }) {
  return (
    <View style={styles.composeContainer}>
      <Ionicons name="cube-outline" size={44} color={colors.textMuted} style={styles.composeIcon} />
      <Text style={styles.composeTitle}>Let's build</Text>
      <Text style={styles.composeSubtitle}>clawdex-mobile</Text>
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

// ── Chat View ──────────────────────────────────────────────────────

function ChatView({
  thread,
  activeCommands,
  streamingText,
  scrollRef,
  isStreaming,
}: {
  thread: Thread;
  activeCommands: RunEvent[];
  streamingText: string | null;
  scrollRef: React.RefObject<ScrollView | null>;
  isStreaming: boolean;
}) {
  const filtered = thread.messages.filter((msg) => {
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
    marginBottom: spacing.xl * 2,
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
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
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
