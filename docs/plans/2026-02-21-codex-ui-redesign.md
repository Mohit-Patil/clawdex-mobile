# Codex-Style UI Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign the mobile chat UI to match the OpenAI Codex aesthetic — flat dark background, no gradients/blur, gold accents, terminal-inspired typography, collapsible tool blocks.

**Architecture:** Rewrite `theme.ts` with a flat dark palette, then extract 6 new components from the monolithic `MainScreen.tsx`. MainScreen becomes a thin orchestrator. DrawerContent gets rethemed to match.

**Tech Stack:** React Native 0.81 / Expo 54, react-native-markdown-display, react-native-reanimated, @expo/vector-icons (Ionicons)

---

### Task 1: Rewrite theme.ts — flat Codex palette

**Files:**
- Modify: `apps/mobile/src/theme.ts`

**Step 1: Replace the theme file**

```typescript
import { Platform, StyleSheet } from 'react-native';

export const colors = {
  // Backgrounds
  bgMain: '#0D0D0D',
  bgSidebar: '#1A1A1A',
  bgItem: '#1A1A1A',
  bgInput: 'rgba(255, 255, 255, 0.06)',

  // Borders
  border: 'rgba(255, 255, 255, 0.1)',
  borderLight: 'rgba(255, 255, 255, 0.05)',
  borderHighlight: 'rgba(255, 255, 255, 0.12)',

  // Text
  textPrimary: '#E8E8E8',
  textSecondary: '#999999',
  textMuted: 'rgba(255, 255, 255, 0.4)',

  // Accent — gold/amber
  accent: '#C8A946',
  accentPressed: '#B89A3A',

  // User bubble
  userBubble: '#1E1E1E',
  userBubbleBorder: 'rgba(255, 255, 255, 0.1)',

  // Assistant — no bubble
  assistantBubbleBg: 'transparent',
  assistantBubbleBorder: 'transparent',

  // Tool block
  toolBlockBg: 'rgba(255, 255, 255, 0.04)',
  toolBlockBorder: '#C8A946',

  // Status
  statusRunning: '#C8A946',
  statusComplete: '#10B981',
  statusError: '#EF4444',
  statusIdle: 'rgba(255, 255, 255, 0.4)',

  // Misc
  error: '#EF4444',
  errorBg: 'rgba(239, 68, 68, 0.15)',
  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  full: 999,
};

export const shadow = StyleSheet.create({
  sm: Platform.select({
    ios: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.3,
      shadowRadius: 6,
    },
    default: { elevation: 3 },
  }) as object,
});

export const typography = {
  largeTitle: {
    fontSize: 24,
    fontWeight: '700' as const,
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },
  headline: {
    fontSize: 15,
    fontWeight: '600' as const,
    color: colors.textPrimary,
  },
  body: {
    fontSize: 14,
    fontWeight: '400' as const,
    color: colors.textPrimary,
    lineHeight: 20,
  },
  caption: {
    fontSize: 12,
    fontWeight: '400' as const,
    color: colors.textMuted,
  },
  mono: {
    fontSize: 12,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    color: colors.textPrimary,
    lineHeight: 18,
  },
};
```

**Step 2: Verify no type errors**

Run: `cd apps/mobile && npx tsc --noEmit 2>&1 | head -30`
Expected: No errors (color tokens renamed to match existing references)

**Step 3: Commit**

```bash
git add apps/mobile/src/theme.ts
git commit -m "feat: rewrite theme to flat Codex-style dark palette"
```

---

### Task 2: Create ChatHeader component

**Files:**
- Create: `apps/mobile/src/components/ChatHeader.tsx`

**Step 1: Create the component**

```typescript
import { Ionicons } from '@expo/vector-icons';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography } from '../theme';

interface ChatHeaderProps {
  onOpenDrawer: () => void;
  modelName?: string;
}

export function ChatHeader({ onOpenDrawer, modelName = 'Codex' }: ChatHeaderProps) {
  return (
    <View style={styles.headerContainer}>
      <SafeAreaView>
        <View style={styles.header}>
          <Pressable onPress={onOpenDrawer} hitSlop={8} style={styles.menuBtn}>
            <Ionicons name="menu" size={22} color={colors.textPrimary} />
          </Pressable>
          <View style={styles.modelNameRow}>
            <Text style={styles.modelName}>{modelName}</Text>
            <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
          </View>
          <View style={{ flex: 1 }} />
          <Ionicons name="sparkles-outline" size={20} color={colors.textMuted} />
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  headerContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.bgMain,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderLight,
    zIndex: 10,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  menuBtn: {
    padding: spacing.xs,
  },
  modelNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  modelName: {
    ...typography.largeTitle,
    fontSize: 20,
    color: colors.textPrimary,
  },
});
```

**Step 2: Commit**

```bash
git add apps/mobile/src/components/ChatHeader.tsx
git commit -m "feat: add ChatHeader component with Codex-style layout"
```

---

### Task 3: Create ChatMessage component

**Files:**
- Create: `apps/mobile/src/components/ChatMessage.tsx`

**Step 1: Create the component**

This renders user messages as dark pills (right-aligned, monospace) and assistant messages as bare markdown text (no bubble, no avatar).

```typescript
import { Platform, StyleSheet, Text, View } from 'react-native';
import Markdown from 'react-native-markdown-display';
import Animated, { FadeInUp, Layout } from 'react-native-reanimated';

import type { ThreadMessage } from '../api/types';
import { colors, radius, spacing, typography } from '../theme';

interface ChatMessageProps {
  message: ThreadMessage;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <Animated.View
        entering={FadeInUp.duration(300)}
        layout={Layout.springify()}
        style={[styles.messageWrapper, styles.messageWrapperUser]}
      >
        <View style={styles.userBubble}>
          <Text style={styles.userMessageText}>{message.content}</Text>
        </View>
      </Animated.View>
    );
  }

  return (
    <Animated.View
      entering={FadeInUp.duration(300).delay(50)}
      layout={Layout.springify()}
      style={[styles.messageWrapper, styles.messageWrapperAssistant]}
    >
      <Markdown style={markdownStyles}>
        {message.content || '\u258D'}
      </Markdown>
    </Animated.View>
  );
}

const monoFont = Platform.select({ ios: 'Menlo', default: 'monospace' });

const markdownStyles = StyleSheet.create({
  body: {
    ...typography.body,
    color: colors.textPrimary,
  },
  code_inline: {
    fontFamily: monoFont,
    fontSize: 12,
    backgroundColor: 'rgba(200, 169, 70, 0.12)',
    color: colors.accent,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  code_block: {
    fontFamily: monoFont,
    fontSize: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    color: colors.textPrimary,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginVertical: spacing.sm,
  },
  fence: {
    fontFamily: monoFont,
    fontSize: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    color: colors.textPrimary,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginVertical: spacing.sm,
  },
  link: {
    color: colors.accent,
    textDecorationLine: 'underline',
  },
  paragraph: {
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  bullet_list: {
    marginVertical: spacing.xs,
  },
  ordered_list: {
    marginVertical: spacing.xs,
  },
  list_item: {
    marginVertical: 2,
  },
  strong: {
    fontWeight: '700',
    color: colors.textPrimary,
  },
  em: {
    fontStyle: 'italic',
  },
});

const styles = StyleSheet.create({
  messageWrapper: {
    maxWidth: '92%',
  },
  messageWrapperUser: {
    alignSelf: 'flex-end',
  },
  messageWrapperAssistant: {
    alignSelf: 'flex-start',
    width: '100%',
  },
  userBubble: {
    backgroundColor: colors.userBubble,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.userBubbleBorder,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  userMessageText: {
    fontFamily: monoFont,
    fontSize: 14,
    color: colors.textPrimary,
    lineHeight: 20,
  },
});
```

**Step 2: Commit**

```bash
git add apps/mobile/src/components/ChatMessage.tsx
git commit -m "feat: add ChatMessage component — dark pill user bubbles, bare markdown assistant"
```

---

### Task 4: Create ToolBlock component

**Files:**
- Create: `apps/mobile/src/components/ToolBlock.tsx`

**Step 1: Create the component**

Collapsible tool execution block with gold left border, folder icon, truncated command, and expand/collapse.

```typescript
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInUp } from 'react-native-reanimated';

import { colors, radius, spacing } from '../theme';

interface ToolBlockProps {
  command: string;
  status: 'running' | 'complete' | 'error';
  output?: string;
  durationMs?: number;
}

export function ToolBlock({ command, status, output, durationMs }: ToolBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = status === 'running'
    ? null
    : status === 'complete'
      ? 'checkmark'
      : 'close';

  const statusColor = status === 'running'
    ? colors.statusRunning
    : status === 'complete'
      ? colors.statusComplete
      : colors.statusError;

  return (
    <Animated.View entering={FadeInUp.duration(300)}>
      <Pressable
        style={styles.container}
        onPress={() => setExpanded(!expanded)}
      >
        <View style={styles.header}>
          <Ionicons name="folder-open" size={14} color={colors.accent} />
          <Text style={styles.command} numberOfLines={expanded ? undefined : 1}>
            {command}
          </Text>
          <View style={styles.statusRow}>
            {status === 'running' ? (
              <ActivityIndicator size="small" color={statusColor} />
            ) : (
              <>
                {statusIcon && (
                  <Ionicons name={statusIcon as any} size={14} color={statusColor} />
                )}
                {durationMs != null && (
                  <Text style={[styles.duration, { color: statusColor }]}>
                    {durationMs}ms
                  </Text>
                )}
              </>
            )}
            <Ionicons
              name={expanded ? 'chevron-up' : 'chevron-down'}
              size={14}
              color={colors.textMuted}
            />
          </View>
        </View>
        {expanded && output ? (
          <Text style={styles.output}>{output}</Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

const monoFont = Platform.select({ ios: 'Menlo', default: 'monospace' });

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.toolBlockBg,
    borderLeftWidth: 3,
    borderLeftColor: colors.toolBlockBorder,
    borderRadius: radius.sm,
    marginVertical: spacing.sm,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  command: {
    flex: 1,
    fontFamily: monoFont,
    fontSize: 12,
    color: colors.textPrimary,
    lineHeight: 18,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 0,
  },
  duration: {
    fontFamily: monoFont,
    fontSize: 11,
  },
  output: {
    fontFamily: monoFont,
    fontSize: 11,
    color: colors.textSecondary,
    lineHeight: 16,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    paddingTop: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
  },
});
```

**Step 2: Commit**

```bash
git add apps/mobile/src/components/ToolBlock.tsx
git commit -m "feat: add ToolBlock component with gold border and expand/collapse"
```

---

### Task 5: Create TypingIndicator component

**Files:**
- Create: `apps/mobile/src/components/TypingIndicator.tsx`

**Step 1: Create the component**

Three dots that pulse to show the assistant is generating.

```typescript
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { colors, spacing } from '../theme';

export function TypingIndicator() {
  const dot1 = useSharedValue(0.3);
  const dot2 = useSharedValue(0.3);
  const dot3 = useSharedValue(0.3);

  useEffect(() => {
    const animateDot = (dot: typeof dot1, delay: number) => {
      dot.value = withDelay(
        delay,
        withRepeat(
          withSequence(
            withTiming(1, { duration: 400 }),
            withTiming(0.3, { duration: 400 }),
          ),
          -1,
          false,
        ),
      );
    };
    animateDot(dot1, 0);
    animateDot(dot2, 150);
    animateDot(dot3, 300);
  }, [dot1, dot2, dot3]);

  const style1 = useAnimatedStyle(() => ({ opacity: dot1.value }));
  const style2 = useAnimatedStyle(() => ({ opacity: dot2.value }));
  const style3 = useAnimatedStyle(() => ({ opacity: dot3.value }));

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.dot, style1]} />
      <Animated.View style={[styles.dot, style2]} />
      <Animated.View style={[styles.dot, style3]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: spacing.sm,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.textMuted,
  },
});
```

**Step 2: Commit**

```bash
git add apps/mobile/src/components/TypingIndicator.tsx
git commit -m "feat: add TypingIndicator component with pulsing dots"
```

---

### Task 6: Create ChatInput component

**Files:**
- Create: `apps/mobile/src/components/ChatInput.tsx`

**Step 1: Create the component**

Bottom input bar with "+" button (new thread) and text field.

```typescript
import { Ionicons } from '@expo/vector-icons';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { colors, radius, spacing } from '../theme';

interface ChatInputProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  onNewThread: () => void;
  isLoading: boolean;
  placeholder?: string;
}

export function ChatInput({
  value,
  onChangeText,
  onSubmit,
  onNewThread,
  isLoading,
  placeholder = 'Message Codex...',
}: ChatInputProps) {
  const canSend = value.trim().length > 0 && !isLoading;

  return (
    <View style={styles.container}>
      <Pressable
        onPress={onNewThread}
        style={({ pressed }) => [styles.plusBtn, pressed && styles.plusBtnPressed]}
      >
        <Ionicons name="add" size={20} color={colors.textMuted} />
      </Pressable>

      <View style={styles.inputWrapper}>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          multiline
          onKeyPress={(e: any) => {
            if (
              Platform.OS === 'web' &&
              e.nativeEvent.key === 'Enter' &&
              !e.nativeEvent.shiftKey
            ) {
              e.preventDefault();
              if (canSend) onSubmit();
            }
          }}
        />
        {canSend || isLoading ? (
          <Pressable
            onPress={canSend ? onSubmit : undefined}
            style={styles.sendBtn}
          >
            {isLoading ? (
              <ActivityIndicator size="small" color={colors.textMuted} />
            ) : (
              <Ionicons name="arrow-up" size={14} color={colors.textPrimary} />
            )}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    paddingBottom: Platform.OS === 'ios' ? spacing.xxl : spacing.md,
    backgroundColor: colors.bgMain,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
  },
  plusBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  plusBtnPressed: {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  inputWrapper: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: colors.borderHighlight,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm : spacing.xs,
    minHeight: 36,
    maxHeight: 120,
  },
  input: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 14,
    lineHeight: 20,
    paddingVertical: 0,
  },
  sendBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.xs,
  },
});
```

**Step 2: Commit**

```bash
git add apps/mobile/src/components/ChatInput.tsx
git commit -m "feat: add ChatInput component with + button and text field"
```

---

### Task 7: Rewrite MainScreen.tsx — wire up new components

**Files:**
- Modify: `apps/mobile/src/screens/MainScreen.tsx`

**Step 1: Replace MainScreen with the refactored version**

This removes all LinearGradient/BlurView usage, replaces inline MessageBubble with `ChatMessage`, uses `ChatHeader`, `ChatInput`, and `TypingIndicator`. Keeps existing state management and WebSocket logic intact.

```typescript
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
import type { BridgeWsEvent, Thread, ThreadMessage } from '../api/types';
import type { MacBridgeWsClient } from '../api/ws';
import { ChatHeader } from '../components/ChatHeader';
import { ChatInput } from '../components/ChatInput';
import { ChatMessage } from '../components/ChatMessage';
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

    const startNewThread = useCallback(() => {
      setSelectedThread(null);
      setSelectedThreadId(null);
      setDraft('');
      setError(null);
    }, []);

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
    const isStreaming = selectedThread?.status === 'running';

    return (
      <View style={styles.container}>
        <ChatHeader onOpenDrawer={onOpenDrawer} />

        <View style={styles.bodyContainer}>
          {selectedThread ? (
            <ChatView
              thread={selectedThread}
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
  scrollRef,
  isStreaming,
}: {
  thread: Thread;
  scrollRef: React.RefObject<ScrollView | null>;
  isStreaming: boolean;
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
        <ChatMessage key={msg.id} message={msg} />
      ))}
      {isStreaming ? <TypingIndicator /> : null}
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

  // Error
  errorText: {
    ...typography.caption,
    color: colors.error,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
});
```

**Step 2: Verify compilation**

Run: `cd apps/mobile && npx tsc --noEmit 2>&1 | head -30`
Expected: No type errors

**Step 3: Commit**

```bash
git add apps/mobile/src/screens/MainScreen.tsx
git commit -m "feat: refactor MainScreen to use extracted Codex-style components"
```

---

### Task 8: Retheme DrawerContent.tsx

**Files:**
- Modify: `apps/mobile/src/navigation/DrawerContent.tsx`

**Step 1: Replace BlurView with flat dark background, update colors**

Remove `import { BlurView } from 'expo-blur'`. Replace the `<BlurView>` wrapper with a plain `<View>` using `backgroundColor: colors.bgSidebar`. Update the "New Thread" button to use `colors.accent`. Update selected thread highlight to use gold accent instead of blue.

Key style changes:
- `container`: `backgroundColor: colors.bgSidebar` (flat `#1A1A1A`)
- Remove `<BlurView intensity={80} tint="dark" style={StyleSheet.absoluteFill} />`
- `newThreadBtn`: `backgroundColor: colors.accent` (gold)
- `threadItemSelected`: `backgroundColor: 'rgba(200, 169, 70, 0.1)'`, `borderColor: 'rgba(200, 169, 70, 0.2)'`

**Step 2: Verify compilation**

Run: `cd apps/mobile && npx tsc --noEmit 2>&1 | head -30`
Expected: No type errors

**Step 3: Commit**

```bash
git add apps/mobile/src/navigation/DrawerContent.tsx
git commit -m "feat: retheme DrawerContent to flat dark Codex style"
```

---

### Task 9: Visual smoke test

**Step 1: Start the Expo dev server**

Run: `cd apps/mobile && npx expo start`

**Step 2: Verify on device/simulator**

Check:
- [ ] Main screen has flat `#0D0D0D` background (no gradient)
- [ ] Header shows hamburger + "Codex >" + sparkle icon
- [ ] Compose view shows suggestion cards with dark theme
- [ ] User messages render as dark pills, right-aligned, monospace
- [ ] Assistant messages render as bare markdown, no bubble
- [ ] Typing indicator (three dots) appears when thread is running
- [ ] "+" button in input bar works (creates new thread)
- [ ] Drawer opens with flat dark background, gold "New thread" button
- [ ] Code blocks in markdown have dark bg, gold inline code

**Step 3: Fix any visual issues found**

Iterate on colors/spacing as needed.

**Step 4: Final commit**

```bash
git add -A
git commit -m "fix: visual polish for Codex-style UI"
```
