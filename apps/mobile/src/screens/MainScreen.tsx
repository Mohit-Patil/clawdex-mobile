import { Ionicons } from '@expo/vector-icons';
import type { DrawerNavigationProp } from '@react-navigation/drawer';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { MacBridgeApiClient } from '../api/client';
import type { BridgeWsEvent, Thread, ThreadMessage } from '../api/types';
import type { MacBridgeWsClient } from '../api/ws';
import { colors, radius, spacing, typography } from '../theme';

export interface MainScreenHandle {
  openThread: (id: string) => void;
  startNewThread: () => void;
}

interface MainScreenProps {
  api: MacBridgeApiClient;
  ws: MacBridgeWsClient;
  navigation: DrawerNavigationProp<Record<string, undefined>>;
}

const SUGGESTIONS = [
  'Explain the current codebase structure',
  'Write tests for the main module',
];

export const MainScreen = forwardRef<MainScreenHandle, MainScreenProps>(
  function MainScreen({ api, ws, navigation }, ref) {
    const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
    const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const scrollRef = useRef<ScrollView>(null);

    useImperativeHandle(ref, () => ({
      openThread: (id: string) => {
        void loadThread(id);
      },
      startNewThread: () => {
        setSelectedThread(null);
        setSelectedThreadId(null);
        setDraft('');
        setError(null);
      },
    }));

    const loadThread = useCallback(
      async (threadId: string) => {
        try {
          const thread = await api.getThread(threadId);
          setSelectedThreadId(threadId);
          setSelectedThread(thread);
          setError(null);
        } catch (err) {
          setError((err as Error).message);
        }
      },
      [api]
    );

    const createThread = useCallback(async () => {
      const content = draft.trim();
      if (!content) return;
      try {
        setCreating(true);
        const created = await api.createThread({ message: content });
        setDraft('');
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
      if (!selectedThreadId || !draft.trim()) return;
      try {
        setSending(true);
        const updated = await api.sendThreadMessage(selectedThreadId, { content: draft.trim() });
        setDraft('');
        setSelectedThread(updated);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSending(false);
      }
    }, [api, draft, selectedThreadId]);

    useEffect(() => {
      return ws.onEvent((event: BridgeWsEvent) => {
        if (event.type === 'thread.message') {
          setSelectedThread((prev) => {
            if (!prev || prev.id !== event.payload.threadId) return prev;
            return {
              ...prev,
              messages: upsertMessage(prev.messages, event.payload.message),
            };
          });
        }
        if (event.type === 'thread.message.delta') {
          setSelectedThread((prev) => {
            if (!prev || prev.id !== event.payload.threadId) return prev;
            const exists = prev.messages.find((m) => m.id === event.payload.messageId);
            const streamed: ThreadMessage = {
              id: event.payload.messageId,
              role: 'assistant',
              content: event.payload.content,
              createdAt: event.payload.updatedAt,
            };
            const messages = exists
              ? prev.messages.map((m) =>
                  m.id === event.payload.messageId ? { ...m, content: event.payload.content } : m
                )
              : [...prev.messages, streamed];
            return { ...prev, messages };
          });
          setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
        }
        if (event.type === 'thread.updated' && selectedThreadId === event.payload.id) {
          setSelectedThread((prev) => (prev ? { ...prev, ...event.payload } : prev));
        }
      });
    }, [ws, selectedThreadId]);

    const handleSubmit = selectedThread ? sendMessage : createThread;
    const isLoading = sending || creating;

    return (
      <SafeAreaView style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable onPress={() => navigation.openDrawer()} hitSlop={8} style={styles.menuBtn}>
            <Ionicons name="menu" size={22} color={colors.textMuted} />
          </Pressable>
          {selectedThread ? (
            <Text style={styles.headerTitle} numberOfLines={1}>
              {selectedThread.title || 'Thread'}
            </Text>
          ) : null}
        </View>

        {/* Body */}
        {selectedThread ? (
          <ChatView thread={selectedThread} scrollRef={scrollRef} />
        ) : (
          <ComposeView onSuggestion={(s) => setDraft(s)} />
        )}

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {/* Input bar */}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          <View style={styles.inputBar}>
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder={
                selectedThread
                  ? 'Reply...'
                  : 'Ask Codex anything, @ to add files, / for commands'
              }
              placeholderTextColor={colors.textMuted}
              multiline
            />
            <Pressable
              onPress={() => void handleSubmit()}
              disabled={isLoading || !draft.trim()}
              style={({ pressed }) => [
                styles.sendBtn,
                (!draft.trim() || isLoading) && styles.sendBtnDisabled,
                pressed && styles.sendBtnPressed,
              ]}
            >
              {isLoading ? (
                <ActivityIndicator size="small" color={colors.white} />
              ) : (
                <Ionicons name="arrow-up" size={16} color={colors.white} />
              )}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
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
  scrollRef,
}: {
  thread: Thread;
  scrollRef: React.RefObject<ScrollView | null>;
}) {
  return (
    <ScrollView
      ref={scrollRef}
      style={styles.messageList}
      contentContainerStyle={styles.messageListContent}
      showsVerticalScrollIndicator={false}
      onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
    >
      {thread.messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
    </ScrollView>
  );
}

function MessageBubble({ message }: { message: ThreadMessage }) {
  const isUser = message.role === 'user';
  return (
    <View style={styles.messageWrapper}>
      <Text style={styles.roleLabel}>{isUser ? 'YOU' : 'CODEX'}</Text>
      <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>
        <Text style={styles.messageText}>{message.content || '▍'}</Text>
      </View>
    </View>
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  menuBtn: {
    padding: spacing.xs,
  },
  headerTitle: {
    ...typography.headline,
    flex: 1,
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
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  suggestionCardPressed: {
    backgroundColor: colors.bgSidebar,
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
    paddingBottom: spacing.xxl,
    gap: spacing.lg,
  },
  messageWrapper: {
    gap: spacing.xs,
  },
  roleLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    letterSpacing: 0.8,
  },
  bubble: {
    borderRadius: radius.md,
    padding: spacing.md,
  },
  userBubble: {
    backgroundColor: colors.userBubble,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  assistantBubble: {
    backgroundColor: 'transparent',
    paddingHorizontal: 0,
  },
  messageText: {
    ...typography.body,
  },

  // Input bar
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bgMain,
  },
  input: {
    flex: 1,
    backgroundColor: colors.bgSidebar,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    color: colors.textPrimary,
    fontSize: 14,
    maxHeight: 120,
  },
  sendBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: {
    backgroundColor: colors.bgItem,
  },
  sendBtnPressed: {
    backgroundColor: colors.accentPressed,
  },

  // Error
  errorText: {
    ...typography.caption,
    color: colors.error,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
});
