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
  BridgeWsEvent,
  PendingApproval,
  RunEvent,
  Thread,
  ThreadMessage,
} from '../api/types';
import type { MacBridgeWsClient } from '../api/ws';
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
    const scrollRef = useRef<ScrollView>(null);

    // Ref so the WS handler always reads the latest thread ID without
    // needing to re-subscribe on every change.
    const threadIdRef = useRef<string | null>(null);
    threadIdRef.current = selectedThreadId;

    // Track whether a command arrived since the last delta — used to
    // know when a new thinking segment starts so we can replace the old one.
    const hadCommandRef = useRef(false);

    useImperativeHandle(ref, () => ({
      openThread: (id: string) => {
        void loadThread(id);
      },
      startNewThread: () => {
        setSelectedThread(null);
        setSelectedThreadId(null);
        setDraft('');
        setError(null);
        setActiveCommands([]);
        setPendingApproval(null);
        setStreamingText(null);
        hadCommandRef.current = false;
      },
    }));

    const startNewThread = useCallback(() => {
      setSelectedThread(null);
      setSelectedThreadId(null);
      setDraft('');
      setError(null);
      setActiveCommands([]);
      setPendingApproval(null);
      setStreamingText(null);
      hadCommandRef.current = false;
    }, []);

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
          hadCommandRef.current = false;
        } catch (err) {
          setError((err as Error).message);
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
        const created = await api.createThread({ message: content });
        setSelectedThreadId(created.id);
        setSelectedThread(created);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
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
        const updated = await api.sendThreadMessage(selectedThreadId, { content });
        setSelectedThread(updated);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSending(false);
      }
    }, [api, draft, selectedThreadId]);

    useEffect(() => {
      const pendingApprovalId = pendingApproval?.id;

      return ws.onEvent((event: BridgeWsEvent) => {
        const currentId = threadIdRef.current;

        // ── Adopt real thread ID during optimistic creation ──
        if (event.type === 'thread.created' && currentId?.startsWith('temp-')) {
          setSelectedThreadId(event.payload.id);
          setSelectedThread((prev) =>
            prev ? { ...prev, id: event.payload.id } : prev
          );
          return;
        }

        // ── Full message (user echo, initial assistant stub) ──
        if (event.type === 'thread.message') {
          setSelectedThread((prev) => {
            if (!prev || prev.id !== event.payload.threadId) return prev;

            const incoming = event.payload.message;
            const existingOptimisticIdx = prev.messages.findIndex(
              (m) => m.id.startsWith('msg-') && m.role === incoming.role && m.content === incoming.content
            );

            let newMessages = [...prev.messages];
            if (existingOptimisticIdx !== -1) {
              newMessages[existingOptimisticIdx] = incoming;
            } else {
              newMessages = upsertMessage(newMessages, incoming);
            }

            return {
              ...prev,
              messages: newMessages,
            };
          });
        }

        // ── Streaming delta → transient thinking text ──
        if (event.type === 'thread.message.delta') {
          if (currentId !== event.payload.threadId) return;
          if (hadCommandRef.current) {
            // New thinking segment — replace previous thinking + commands
            setStreamingText(event.payload.delta);
            setActiveCommands([]);
            hadCommandRef.current = false;
          } else {
            // Continue current thinking segment
            setStreamingText((prev) => (prev ?? '') + event.payload.delta);
          }
          setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
        }

        // ── Thread status changes ──
        if (event.type === 'thread.updated' && currentId === event.payload.id) {
          const nowDone = event.payload.status !== 'running';
          if (nowDone) {
            setStreamingText(null);
            setActiveCommands([]);
            hadCommandRef.current = false;
            void loadThread(event.payload.id);
          }
          setSelectedThread((prev) => (prev ? { ...prev, ...event.payload } : prev));
        }

        // ── Run events (commands, completion) ──
        if (event.type === 'thread.run.event' && currentId === event.payload.threadId) {
          const { eventType } = event.payload;
          if (eventType === 'command.completed') {
            // Add tool block below the current thinking text
            hadCommandRef.current = true;
            setActiveCommands((prev) => [
              ...prev,
              { id: `re-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ...event.payload },
            ]);
          }
          if (eventType === 'run.completed' || eventType === 'run.failed') {
            setActiveCommands([]);
            setStreamingText(null);
            hadCommandRef.current = false;
          }
        }

        // ── Approvals ──
        if (event.type === 'approval.requested' && currentId === event.payload.threadId) {
          setPendingApproval(event.payload);
        }
        if (event.type === 'approval.resolved' && pendingApprovalId === event.payload.id) {
          setPendingApproval(null);
        }
      });
    }, [ws, pendingApproval?.id, loadThread]);

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
    const isStreaming = selectedThread?.status === 'running';

    return (
      <View style={styles.container}>
        <ChatHeader onOpenDrawer={onOpenDrawer} />

        <View style={styles.bodyContainer}>
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

          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={0}
            style={styles.keyboardAvoiding}
          >
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            {pendingApproval ? (
              <ApprovalBanner
                approval={pendingApproval}
                onResolve={handleResolveApproval}
              />
            ) : null}
            <ChatInput
              value={draft}
              onChangeText={setDraft}
              onSubmit={() => void handleSubmit()}
              onNewThread={startNewThread}
              isLoading={isLoading}
              placeholder={selectedThread ? 'Reply...' : 'Message Codex...'}
            />
          </KeyboardAvoidingView>
        </View>
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

function upsertMessage(messages: ThreadMessage[], message: ThreadMessage): ThreadMessage[] {
  const idx = messages.findIndex((m) => m.id === message.id);
  if (idx === -1) return [...messages, message];
  return messages.map((m, i) => (i === idx ? message : m));
}

// ── Styles ─────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgMain,
  },

  bodyContainer: {
    flex: 1,
    position: 'relative',
  },
  keyboardAvoiding: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
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
    paddingTop: 100,
    paddingBottom: spacing.xxl * 5,
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
