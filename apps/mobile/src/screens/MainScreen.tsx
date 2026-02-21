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
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import Markdown from 'react-native-markdown-display';
import Animated, { FadeInUp, Layout } from 'react-native-reanimated';

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
        // Optionally revert optimistic state here if needed
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
      return ws.onEvent((event: BridgeWsEvent) => {
        if (event.type === 'thread.message') {
          setSelectedThread((prev) => {
            if (!prev || prev.id !== event.payload.threadId) return prev;

            const incoming = event.payload.message;
            // Deduplicate if we have an optimistic message with the exact same content
            // and the optimistic message ID starts with 'msg-'
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
      <View style={styles.container}>
        {/* Liquid Glass Background */}
        <LinearGradient
          colors={['#0F0C29', '#302B63', '#05050A']}
          style={StyleSheet.absoluteFill}
        />
        <SafeAreaView style={styles.safeArea}>

          {/* Body */}
          <View style={styles.bodyContainer}>
            {selectedThread ? (
              <ChatView thread={selectedThread} scrollRef={scrollRef} />
            ) : (
              <ComposeView onSuggestion={(s) => setDraft(s)} />
            )}

            {/* Input bar */}
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              keyboardVerticalOffset={0}
              style={styles.keyboardAvoiding}
            >
              {error ? <Text style={styles.errorText}>{error}</Text> : null}
              <BlurView intensity={70} tint="dark" style={styles.inputBarWrapper}>
                <View style={styles.inputBar}>
                  <TextInput
                    style={styles.input}
                    value={draft}
                    onChangeText={setDraft}
                    placeholder={
                      selectedThread
                        ? 'Reply...'
                        : 'Ask Codex anything...'
                    }
                    placeholderTextColor={colors.textMuted}
                    multiline
                    onKeyPress={(e: any) => {
                      if (Platform.OS === 'web' && e.nativeEvent.key === 'Enter' && !e.nativeEvent.shiftKey) {
                        e.preventDefault();
                        if (!isLoading && draft.trim()) {
                          void handleSubmit();
                        }
                      }
                    }}
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
              </BlurView>
            </KeyboardAvoidingView>

          </View>

          {/* Floating Header */}
          <BlurView intensity={80} tint="dark" style={styles.headerBlur}>
            <SafeAreaView>
              <View style={styles.header}>
                <Pressable onPress={onOpenDrawer} hitSlop={8} style={styles.menuBtn}>
                  <Ionicons name="menu" size={22} color={colors.textPrimary} />
                </Pressable>
                {selectedThread ? (
                  <Text style={styles.headerTitle} numberOfLines={1}>
                    {selectedThread.title || 'Thread'}
                  </Text>
                ) : null}
              </View>
            </SafeAreaView>
          </BlurView>
        </SafeAreaView>
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
  scrollRef,
}: {
  thread: Thread;
  scrollRef: React.RefObject<ScrollView | null>;
}) {
  const visibleMessages = thread.messages.filter((msg) => {
    const text = msg.content || '';
    if (text.includes('FINAL_TASK_RESULT_JSON')) return false;
    if (text.includes('Current working directory is:')) return false;
    if (text.includes('You are operating in task worktree')) return false;
    return true;
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
        <MessageBubble key={msg.id} message={msg} />
      ))}
    </ScrollView>
  );
}

function MessageBubble({ message }: { message: ThreadMessage }) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <Animated.View
        entering={FadeInUp.duration(400)}
        layout={Layout.springify()}
        style={[styles.messageWrapper, styles.messageWrapperUser]}
      >
        <LinearGradient
          colors={[colors.userBubbleStart, colors.userBubbleEnd]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.bubble, styles.userBubble]}
        >
          <Text style={styles.userMessageText}>{message.content}</Text>
        </LinearGradient>
      </Animated.View>
    );
  }

  return (
    <Animated.View
      entering={FadeInUp.duration(400).delay(50)}
      layout={Layout.springify()}
      style={[styles.messageWrapper, styles.messageWrapperAssistant]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs }}>
        <View style={styles.assistantAvatar}>
          <Ionicons name="terminal" size={12} color={colors.accent} />
        </View>
        <Text style={styles.roleLabel}>CODEX</Text>
      </View>
      <BlurView intensity={60} tint="dark" style={[styles.bubble, styles.assistantBubble]}>
        <Markdown style={markdownStyles}>
          {message.content || '▍'}
        </Markdown>
      </BlurView>
    </Animated.View>
  );
}

const markdownStyles = StyleSheet.create({
  body: {
    ...typography.body,
    color: colors.textPrimary,
  },
  code_inline: {
    ...typography.mono,
    backgroundColor: 'rgba(0,0,0,0.3)',
    color: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  code_block: {
    ...typography.mono,
    backgroundColor: 'rgba(0,0,0,0.3)',
    color: colors.textPrimary,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  fence: {
    ...typography.mono,
    backgroundColor: 'rgba(0,0,0,0.3)',
    color: colors.textPrimary,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  link: {
    color: colors.accent,
    textDecorationLine: 'underline',
  },
  paragraph: {
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
});

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
  safeArea: {
    flex: 1,
  },
  headerBlur: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderHighlight,
    zIndex: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  menuBtn: {
    padding: spacing.xs,
  },
  headerTitle: {
    ...typography.headline,
    flex: 1,
    color: colors.textPrimary,
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
    paddingTop: 100, // accommodate floating header
    paddingBottom: spacing.xxl * 5, // Extra padding for floating input
    gap: spacing.xl,
  },
  messageWrapper: {
    maxWidth: '92%',
  },
  messageWrapperUser: {
    alignSelf: 'flex-end',
  },
  messageWrapperAssistant: {
    alignSelf: 'flex-start',
  },
  roleLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    letterSpacing: 0.8,
  },
  assistantAvatar: {
    width: 20,
    height: 20,
    borderRadius: 6,
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(59, 130, 246, 0.2)',
  },
  bubble: {
    borderRadius: radius.md,
    padding: spacing.md,
  },
  userBubble: {
    borderBottomRightRadius: 4,
    shadowColor: colors.userBubbleStart,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  assistantBubble: {
    backgroundColor: colors.assistantBubbleBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.assistantBubbleBorder,
    borderTopLeftRadius: 4,
  },
  userMessageText: {
    ...typography.body,
    color: colors.white,
  },
  messageText: {
    ...typography.body,
  },

  // Input bar
  inputBarWrapper: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
    overflow: 'hidden',
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    paddingBottom: Platform.OS === 'ios' ? spacing.xxl : spacing.md,
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
