# Codex Desktop-Style Mobile Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the bottom tab navigator with a hidden left drawer and dark Codex-style theme across all screens, with a compose/chat main screen.

**Architecture:** React Navigation Drawer wraps all screens; custom DrawerContent renders the thread list + nav items; MainScreen combines the compose ("Let's build") view and the chat view in one screen controlled by `selectedThread` state.

**Tech Stack:** React Native 0.81, Expo 54, `@react-navigation/drawer`, `react-native-reanimated` (already transitively installed via gesture-handler), `@expo/vector-icons` (already installed)

---

## Task 1: Install drawer dependency

**Files:**
- Modify: `apps/mobile/package.json`

**Step 1: Install the package**

```bash
cd apps/mobile
npx expo install @react-navigation/drawer
```

Expected output: `added N packages` with no errors.

**Step 2: Verify it resolves**

```bash
node -e "require('@react-navigation/drawer'); console.log('ok')"
```

Expected: `ok`

**Step 3: Commit**

```bash
git add apps/mobile/package.json package-lock.json
git commit -m "chore: add @react-navigation/drawer dependency"
```

---

## Task 2: Replace theme.ts with Codex dark theme

**Files:**
- Modify: `apps/mobile/src/theme.ts`

**Step 1: Replace the entire file**

```ts
// apps/mobile/src/theme.ts
import { Platform, StyleSheet } from 'react-native';

export const colors = {
  // Backgrounds
  bgMain:    '#0D1117',
  bgSidebar: '#161B22',
  bgItem:    '#21262D',
  bgInput:   '#161B22',

  // Borders
  border:    '#30363D',

  // Text
  textPrimary: '#E6EDF3',
  textMuted:   '#8B949E',

  // Accent
  accent:        '#E5622A',
  accentPressed: '#C44E1F',

  // Message bubbles
  userBubble: '#1C2128',

  // Status
  statusRunning:  '#3B82F6',
  statusComplete: '#22C55E',
  statusError:    '#EF4444',
  statusIdle:     '#6B7280',

  // Misc
  error:   '#EF4444',
  errorBg: 'rgba(239, 68, 68, 0.1)',
  white:   '#FFFFFF',
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

**Step 2: Commit**

```bash
git add apps/mobile/src/theme.ts
git commit -m "feat: replace theme with Codex dark palette"
```

---

## Task 3: Create DrawerContent component

**Files:**
- Create: `apps/mobile/src/navigation/DrawerContent.tsx`

**Step 1: Create the navigation directory**

```bash
mkdir -p apps/mobile/src/navigation
```

**Step 2: Create DrawerContent.tsx**

```tsx
// apps/mobile/src/navigation/DrawerContent.tsx
import { Ionicons } from '@expo/vector-icons';
import type { DrawerContentComponentProps } from '@react-navigation/drawer';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { MacBridgeApiClient } from '../api/client';
import type { BridgeWsEvent, ThreadSummary } from '../api/types';
import type { MacBridgeWsClient } from '../api/ws';
import { colors, spacing, typography } from '../theme';

interface DrawerContentProps extends DrawerContentComponentProps {
  api: MacBridgeApiClient;
  ws: MacBridgeWsClient;
  selectedThreadId: string | null;
  onSelectThread: (id: string) => void;
  onNewThread: () => void;
}

export function DrawerContent({
  navigation,
  api,
  ws,
  selectedThreadId,
  onSelectThread,
  onNewThread,
}: DrawerContentProps) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const loadThreads = useCallback(async () => {
    try {
      const data = await api.listThreads();
      setThreads(sortThreads(data));
    } catch {
      // silently fail - user will see empty list
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  useEffect(() => {
    return ws.onEvent((event: BridgeWsEvent) => {
      if (event.type === 'thread.created' || event.type === 'thread.updated') {
        setThreads((prev) => upsertThread(prev, event.payload));
      }
      if (event.type === 'thread.message.delta') {
        setThreads((prev) =>
          prev.map((t) =>
            t.id === event.payload.threadId
              ? { ...t, lastMessagePreview: event.payload.content, updatedAt: event.payload.updatedAt }
              : t
          )
        );
      }
    });
  }, [ws]);

  const handleSelectThread = useCallback(
    (id: string) => {
      onSelectThread(id);
      navigation.closeDrawer();
    },
    [onSelectThread, navigation]
  );

  const handleNewThread = useCallback(() => {
    onNewThread();
    navigation.closeDrawer();
  }, [onNewThread, navigation]);

  return (
    <SafeAreaView style={styles.container}>
      {/* New Thread button */}
      <View style={styles.header}>
        <Pressable
          style={({ pressed }) => [styles.newThreadBtn, pressed && styles.newThreadBtnPressed]}
          onPress={handleNewThread}
        >
          <Ionicons name="add" size={16} color={colors.white} />
          <Text style={styles.newThreadText}>New thread</Text>
        </Pressable>
      </View>

      {/* Nav items */}
      <NavItem
        icon="terminal-outline"
        label="Terminal"
        onPress={() => { navigation.navigate('Terminal'); }}
      />
      <NavItem
        icon="git-branch-outline"
        label="Git"
        onPress={() => { navigation.navigate('Git'); }}
      />

      {/* Threads section */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Threads</Text>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.textMuted} style={styles.loader} />
      ) : (
        <FlatList
          data={threads}
          keyExtractor={(item) => item.id}
          style={styles.list}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <Text style={styles.emptyText}>No threads yet</Text>
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [
                styles.threadItem,
                item.id === selectedThreadId && styles.threadItemSelected,
                pressed && styles.threadItemPressed,
              ]}
              onPress={() => handleSelectThread(item.id)}
            >
              <Text style={styles.threadTitle} numberOfLines={1}>
                {item.title || 'Untitled'}
              </Text>
              <Text style={styles.threadAge}>
                {relativeTime(item.updatedAt)}
              </Text>
            </Pressable>
          )}
        />
      )}

      {/* Settings pinned at bottom */}
      <NavItem
        icon="settings-outline"
        label="Settings"
        onPress={() => { navigation.navigate('Settings'); }}
        style={styles.settingsItem}
      />
    </SafeAreaView>
  );
}

function NavItem({
  icon,
  label,
  onPress,
  style,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  style?: object;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.navItem, pressed && styles.navItemPressed, style]}
      onPress={onPress}
    >
      <Ionicons name={icon} size={16} color={colors.textMuted} />
      <Text style={styles.navLabel}>{label}</Text>
    </Pressable>
  );
}

function sortThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function upsertThread(threads: ThreadSummary[], summary: ThreadSummary): ThreadSummary[] {
  const idx = threads.findIndex((t) => t.id === summary.id);
  const next = idx === -1 ? [...threads, summary] : threads.map((t, i) => (i === idx ? summary : t));
  return sortThreads(next);
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1d';
  return `${days}d`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgSidebar,
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
  },
  newThreadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  newThreadBtnPressed: {
    backgroundColor: colors.accentPressed,
  },
  newThreadText: {
    ...typography.headline,
    color: colors.white,
    fontSize: 14,
  },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  navItemPressed: {
    backgroundColor: colors.bgItem,
  },
  navLabel: {
    ...typography.body,
    color: colors.textMuted,
  },
  sectionHeader: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  sectionTitle: {
    ...typography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    color: colors.textMuted,
  },
  list: {
    flex: 1,
  },
  loader: {
    marginTop: spacing.xl,
  },
  emptyText: {
    ...typography.caption,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
  threadItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  threadItemSelected: {
    backgroundColor: colors.bgItem,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
  },
  threadItemPressed: {
    backgroundColor: colors.bgItem,
  },
  threadTitle: {
    ...typography.body,
    flex: 1,
    marginRight: spacing.sm,
  },
  threadAge: {
    ...typography.caption,
    flexShrink: 0,
  },
  settingsItem: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    marginTop: spacing.sm,
    paddingTop: spacing.md,
  },
});
```

**Step 3: Commit**

```bash
git add apps/mobile/src/navigation/DrawerContent.tsx
git commit -m "feat: add DrawerContent component with thread list"
```

---

## Task 4: Create MainScreen (compose + chat)

**Files:**
- Create: `apps/mobile/src/screens/MainScreen.tsx`

This screen has two internal states controlled by `selectedThread`:
- `null` → compose view ("Let's build")
- `Thread` → chat view with messages

```tsx
// apps/mobile/src/screens/MainScreen.tsx
import { Ionicons } from '@expo/vector-icons';
import { useDrawerStatus } from '@react-navigation/drawer';
import type { DrawerNavigationProp } from '@react-navigation/drawer';
import {
  type Dispatch,
  type SetStateAction,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  FlatList,
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
import type { BridgeWsEvent, Thread, ThreadMessage, ThreadSummary } from '../api/types';
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
  'Find and fix any TypeScript errors',
  'Summarize recent git changes',
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

    // Expose imperative handle so DrawerContent can drive selection
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

    // WebSocket updates
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
          // Scroll to bottom on new content
          setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
        }
        if (event.type === 'thread.updated' && selectedThreadId === event.payload.id) {
          setSelectedThread((prev) => prev ? { ...prev, ...event.payload } : prev);
        }
      });
    }, [ws, selectedThreadId]);

    const handleSubmit = selectedThread ? sendMessage : createThread;
    const isLoading = sending || creating;

    return (
      <SafeAreaView style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable onPress={() => navigation.openDrawer()} hitSlop={8}>
            <Ionicons name="menu" size={22} color={colors.textMuted} />
          </Pressable>
          {selectedThread ? (
            <Text style={styles.headerTitle} numberOfLines={1}>
              {selectedThread.title || 'Thread'}
            </Text>
          ) : (
            <View style={{ flex: 1 }} />
          )}
        </View>

        {/* Body */}
        {selectedThread ? (
          <ChatView
            thread={selectedThread}
            scrollRef={scrollRef}
          />
        ) : (
          <ComposeView
            onSuggestion={(s) => setDraft(s)}
          />
        )}

        {/* Error */}
        {error ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : null}

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
              placeholder={selectedThread ? 'Reply...' : 'Ask Codex anything, @ to add files'}
              placeholderTextColor={colors.textMuted}
              multiline
              returnKeyType="send"
              onSubmitEditing={() => void handleSubmit()}
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
      <Ionicons name="cube-outline" size={40} color={colors.textMuted} style={styles.composeIcon} />
      <Text style={styles.composeTitle}>Let's build</Text>
      <Text style={styles.composeSubtitle}>clawdex-mobile</Text>
      <View style={styles.suggestions}>
        {SUGGESTIONS.slice(0, 2).map((s) => (
          <Pressable
            key={s}
            style={({ pressed }) => [styles.suggestionCard, pressed && styles.suggestionCardPressed]}
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
        <Text style={styles.messageText}>
          {message.content || '▍'}
        </Text>
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
```

**Step 2: Commit**

```bash
git add apps/mobile/src/screens/MainScreen.tsx
git commit -m "feat: add MainScreen with compose and chat views"
```

---

## Task 5: Rewrite App.tsx with DrawerNavigator

**Files:**
- Modify: `apps/mobile/App.tsx`

**Step 1: Replace App.tsx entirely**

```tsx
// apps/mobile/App.tsx
import 'react-native-gesture-handler';

import { createDrawerNavigator } from '@react-navigation/drawer';
import { NavigationContainer } from '@react-navigation/native';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { View } from 'react-native';

import { MacBridgeApiClient } from './src/api/client';
import { MacBridgeWsClient } from './src/api/ws';
import { env } from './src/config';
import { DrawerContent } from './src/navigation/DrawerContent';
import { GitScreen } from './src/screens/GitScreen';
import { MainScreen, type MainScreenHandle } from './src/screens/MainScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { TerminalScreen } from './src/screens/TerminalScreen';
import { colors } from './src/theme';

type DrawerParamList = {
  Main: undefined;
  Terminal: undefined;
  Git: undefined;
  Settings: undefined;
};

const Drawer = createDrawerNavigator<DrawerParamList>();

export default function App() {
  const api = useMemo(() => new MacBridgeApiClient({ baseUrl: env.macBridgeUrl }), []);
  const ws = useMemo(() => new MacBridgeWsClient(api.wsUrl()), [api]);
  const mainRef = useRef<MainScreenHandle>(null);

  useEffect(() => {
    ws.connect();
    return () => ws.disconnect();
  }, [ws]);

  const handleSelectThread = useCallback((id: string) => {
    mainRef.current?.openThread(id);
  }, []);

  const handleNewThread = useCallback(() => {
    mainRef.current?.startNewThread();
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bgMain }}>
      <NavigationContainer>
        <Drawer.Navigator
          drawerContent={(props) => (
            <DrawerContent
              {...props}
              api={api}
              ws={ws}
              selectedThreadId={null}
              onSelectThread={handleSelectThread}
              onNewThread={handleNewThread}
            />
          )}
          screenOptions={{
            headerShown: false,
            drawerStyle: { width: 280, backgroundColor: colors.bgSidebar },
            drawerType: 'front',
            overlayColor: 'rgba(0,0,0,0.5)',
            swipeEdgeWidth: 40,
          }}
        >
          <Drawer.Screen name="Main">
            {({ navigation }) => (
              <MainScreen ref={mainRef} api={api} ws={ws} navigation={navigation} />
            )}
          </Drawer.Screen>
          <Drawer.Screen name="Terminal">
            {() => <TerminalScreen api={api} ws={ws} />}
          </Drawer.Screen>
          <Drawer.Screen name="Git">
            {() => <GitScreen api={api} />}
          </Drawer.Screen>
          <Drawer.Screen name="Settings">
            {() => <SettingsScreen api={api} ws={ws} bridgeUrl={env.macBridgeUrl} />}
          </Drawer.Screen>
        </Drawer.Navigator>
      </NavigationContainer>
    </View>
  );
}
```

**Step 2: Commit**

```bash
git add apps/mobile/App.tsx
git commit -m "feat: replace bottom tabs with drawer navigator"
```

---

## Task 6: Dark-theme TerminalScreen

**Files:**
- Modify: `apps/mobile/src/screens/TerminalScreen.tsx`

Replace the entire file with a dark-themed version (no Glass imports):

```tsx
// apps/mobile/src/screens/TerminalScreen.tsx
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import {
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
import type { MacBridgeWsClient } from '../api/ws';
import { colors, radius, spacing, typography } from '../theme';

interface TerminalScreenProps {
  api: MacBridgeApiClient;
  ws: MacBridgeWsClient;
}

export function TerminalScreen({ api, ws }: TerminalScreenProps) {
  const [command, setCommand] = useState('pwd');
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runCommand = useCallback(async () => {
    try {
      setRunning(true);
      const result = await api.execTerminal({ command });
      const lines = [
        `$ ${result.command}`,
        result.stdout || '(no stdout)',
        result.stderr ? `stderr:\n${result.stderr}` : null,
        `exit ${String(result.code)} · ${result.durationMs}ms`,
      ].filter(Boolean).join('\n\n');
      setOutput(lines);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }, [api, command]);

  useEffect(() => {
    return ws.onEvent((event) => {
      if (event.type === 'terminal.executed') {
        setOutput((prev) => `${prev}\n\n[ws] ${event.payload.command} → ${String(event.payload.code)}`.trim());
      }
    });
  }, [ws]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Ionicons name="terminal" size={16} color={colors.textMuted} />
        <Text style={styles.headerTitle}>Terminal</Text>
      </View>

      <KeyboardAvoidingView style={styles.body} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={styles.output} contentContainerStyle={styles.outputContent}>
          <Text selectable style={styles.outputText}>
            {output || 'Run a command to see output.'}
          </Text>
        </ScrollView>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.inputRow}>
          <Text style={styles.prompt}>$</Text>
          <TextInput
            style={styles.input}
            value={command}
            onChangeText={setCommand}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="send"
            onSubmitEditing={() => void runCommand()}
            placeholder="command"
            placeholderTextColor={colors.textMuted}
          />
          <Pressable
            onPress={() => void runCommand()}
            disabled={running || !command.trim()}
            style={({ pressed }) => [styles.runBtn, pressed && styles.runBtnPressed, running && styles.runBtnDisabled]}
          >
            <Ionicons name={running ? 'pause' : 'play'} size={14} color={colors.white} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgMain },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerTitle: { ...typography.headline },
  body: { flex: 1 },
  output: { flex: 1 },
  outputContent: { padding: spacing.lg },
  outputText: { ...typography.mono },
  errorText: {
    ...typography.caption,
    color: colors.error,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  prompt: { ...typography.mono, color: colors.accent },
  input: {
    flex: 1,
    ...typography.mono,
    color: colors.textPrimary,
    backgroundColor: colors.bgSidebar,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  runBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  runBtnPressed: { backgroundColor: colors.accentPressed },
  runBtnDisabled: { backgroundColor: colors.bgItem },
});
```

**Step 2: Commit**

```bash
git add apps/mobile/src/screens/TerminalScreen.tsx
git commit -m "feat: dark-theme terminal screen"
```

---

## Task 7: Dark-theme GitScreen

**Files:**
- Modify: `apps/mobile/src/screens/GitScreen.tsx`

Replace the entire file:

```tsx
// apps/mobile/src/screens/GitScreen.tsx
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { MacBridgeApiClient } from '../api/client';
import type { GitStatusResponse } from '../api/types';
import { colors, radius, spacing, typography } from '../theme';

interface GitScreenProps {
  api: MacBridgeApiClient;
}

export function GitScreen({ api }: GitScreenProps) {
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [diff, setDiff] = useState('');
  const [commitMessage, setCommitMessage] = useState('chore: checkpoint');
  const [loading, setLoading] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const [s, d] = await Promise.all([api.gitStatus(), api.gitDiff()]);
      setStatus(s);
      setDiff(d.diff);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  const commit = useCallback(async () => {
    try {
      setCommitting(true);
      const result = await api.gitCommit({ message: commitMessage });
      if (!result.committed) setError(result.stderr || 'Commit failed.');
      else setError(null);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCommitting(false);
    }
  }, [api, commitMessage, refresh]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Ionicons name="git-branch" size={16} color={colors.textMuted} />
        <Text style={styles.headerTitle}>Git</Text>
        <Pressable onPress={() => void refresh()} hitSlop={8} style={styles.refreshBtn}>
          <Ionicons name="refresh" size={16} color={colors.textMuted} />
        </Pressable>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.textMuted} style={styles.loader} />
      ) : (
        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          {/* Branch info */}
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Branch</Text>
            <Text style={styles.infoValue}>{status?.branch ?? '—'}</Text>
          </View>
          <View style={[styles.infoRow, styles.infoRowBorder]}>
            <Text style={styles.infoLabel}>Status</Text>
            <Text style={[styles.infoValue, status?.clean ? styles.clean : styles.dirty]}>
              {status?.clean ? 'clean' : 'changes'}
            </Text>
          </View>

          {/* Commit */}
          <Text style={styles.sectionLabel}>Commit message</Text>
          <TextInput
            style={styles.input}
            value={commitMessage}
            onChangeText={setCommitMessage}
            placeholder="Commit message..."
            placeholderTextColor={colors.textMuted}
          />
          <Pressable
            onPress={() => void commit()}
            disabled={committing || !commitMessage.trim()}
            style={({ pressed }) => [
              styles.commitBtn,
              pressed && styles.commitBtnPressed,
              (committing || !commitMessage.trim()) && styles.commitBtnDisabled,
            ]}
          >
            <Text style={styles.commitBtnText}>
              {committing ? 'Committing…' : 'Commit'}
            </Text>
          </Pressable>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          {/* Diff */}
          <Text style={styles.sectionLabel}>Diff</Text>
          <ScrollView style={styles.diffBox} horizontal>
            <Text selectable style={styles.diffText}>{diff || 'No changes.'}</Text>
          </ScrollView>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgMain },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerTitle: { ...typography.headline, flex: 1 },
  refreshBtn: { marginLeft: 'auto' },
  loader: { marginTop: spacing.xxl },
  body: { flex: 1 },
  bodyContent: { padding: spacing.lg, gap: spacing.md },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  infoRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  infoLabel: { ...typography.body, color: colors.textMuted },
  infoValue: { ...typography.body },
  clean: { color: colors.statusComplete },
  dirty: { color: colors.statusError },
  sectionLabel: {
    ...typography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: spacing.md,
  },
  input: {
    backgroundColor: colors.bgSidebar,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    color: colors.textPrimary,
    fontSize: 14,
  },
  commitBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
  },
  commitBtnPressed: { backgroundColor: colors.accentPressed },
  commitBtnDisabled: { backgroundColor: colors.bgItem },
  commitBtnText: { ...typography.headline, color: colors.white, fontSize: 14 },
  errorText: { ...typography.caption, color: colors.error },
  diffBox: {
    backgroundColor: colors.bgSidebar,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    maxHeight: 300,
  },
  diffText: { ...typography.mono },
});
```

**Step 2: Commit**

```bash
git add apps/mobile/src/screens/GitScreen.tsx
git commit -m "feat: dark-theme git screen"
```

---

## Task 8: Dark-theme SettingsScreen

**Files:**
- Modify: `apps/mobile/src/screens/SettingsScreen.tsx`

Replace the entire file:

```tsx
// apps/mobile/src/screens/SettingsScreen.tsx
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';

import type { MacBridgeApiClient } from '../api/client';
import type { MacBridgeWsClient } from '../api/ws';
import { colors, spacing, typography } from '../theme';

interface SettingsScreenProps {
  api: MacBridgeApiClient;
  ws: MacBridgeWsClient;
  bridgeUrl: string;
}

export function SettingsScreen({ api, ws, bridgeUrl }: SettingsScreenProps) {
  const [healthyAt, setHealthyAt] = useState<string | null>(null);
  const [uptimeSec, setUptimeSec] = useState<number | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const h = await api.health();
      setHealthyAt(h.at);
      setUptimeSec(h.uptimeSec);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api]);

  useEffect(() => {
    const t = setTimeout(() => void checkHealth(), 0);
    return () => clearTimeout(t);
  }, [checkHealth]);

  useEffect(() => ws.onStatus(setWsConnected), [ws]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Ionicons name="settings" size={16} color={colors.textMuted} />
        <Text style={styles.headerTitle}>Settings</Text>
      </View>

      <View style={styles.body}>
        <Text style={styles.sectionLabel}>Bridge</Text>
        <Text selectable style={styles.valueText}>{bridgeUrl}</Text>

        <Text style={[styles.sectionLabel, styles.sectionLabelGap]}>Health</Text>
        <Row label="Status" value={healthyAt ? 'OK' : 'Unknown'} valueColor={healthyAt ? colors.statusComplete : colors.textMuted} />
        <Row label="Last seen" value={healthyAt ?? '—'} />
        <Row label="Uptime" value={uptimeSec !== null ? `${uptimeSec}s` : '—'} />
        <Row
          label="WebSocket"
          value={wsConnected ? 'Connected' : 'Disconnected'}
          valueColor={wsConnected ? colors.statusComplete : colors.statusError}
        />

        <Pressable
          onPress={() => void checkHealth()}
          style={({ pressed }) => [styles.refreshBtn, pressed && styles.refreshBtnPressed]}
        >
          <Ionicons name="refresh" size={14} color={colors.textMuted} />
          <Text style={styles.refreshBtnText}>Refresh health</Text>
        </Pressable>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>
    </SafeAreaView>
  );
}

function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, valueColor ? { color: valueColor } : undefined]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgMain },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerTitle: { ...typography.headline },
  body: { padding: spacing.lg, gap: spacing.sm },
  sectionLabel: {
    ...typography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  sectionLabelGap: { marginTop: spacing.xl },
  valueText: {
    ...typography.mono,
    color: colors.textMuted,
    backgroundColor: colors.bgSidebar,
    borderRadius: 6,
    padding: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowLabel: { ...typography.body, color: colors.textMuted },
  rowValue: { ...typography.body },
  refreshBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  refreshBtnPressed: { backgroundColor: colors.bgItem },
  refreshBtnText: { ...typography.body, color: colors.textMuted, fontSize: 13 },
  errorText: { ...typography.caption, color: colors.error, marginTop: spacing.md },
});
```

**Step 2: Commit**

```bash
git add apps/mobile/src/screens/SettingsScreen.tsx
git commit -m "feat: dark-theme settings screen"
```

---

## Task 9: Remove unused files and verify build

**Files:**
- Delete: `apps/mobile/src/screens/ThreadsScreen.tsx` (replaced by MainScreen)
- Delete: `apps/mobile/src/components/Glass.tsx` (replaced by direct theme usage)
- Delete: `apps/mobile/src/ui/` directory (old warm theme, no longer used)

**Step 1: Delete old files**

```bash
rm apps/mobile/src/screens/ThreadsScreen.tsx
rm apps/mobile/src/components/Glass.tsx
rm -rf apps/mobile/src/ui/
```

**Step 2: Verify TypeScript compiles**

```bash
cd apps/mobile
npx tsc --noEmit 2>&1 | grep -v '__tests__'
```

Expected: no output (no errors in UI files).

**Step 3: Confirm Metro bundles without errors**

Check the Metro console — expected: `Bundled Nms apps/mobile/index.js (N modules)` with no red errors.

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: remove old glass components and ThreadsScreen"
```

---

## Verification

After all tasks:

1. Launch app — should show dark `#0D1117` background with `≡` hamburger top-left
2. Swipe right from left edge — drawer slides open showing "New thread" button + threads + Terminal/Git/Settings nav items
3. Tap a thread — drawer closes, chat view shows with messages
4. Tap "New thread" — drawer closes, compose view shows "Let's build" hero
5. Navigate to Terminal/Git/Settings from drawer — each screen shows dark theme
6. Type a message and tap send — message appears as user bubble, assistant streams in

---

## Notes

- `react-native-reanimated` is already a transitive dependency of `react-native-gesture-handler` (already installed). Drawer uses it automatically.
- The `selectedThreadId` prop passed to `DrawerContent` is `null` for now. If you want the drawer to highlight the active thread, wire it up via a shared state or context in a follow-up.
- Suggestion cards show hardcoded strings for now. These can be made dynamic from the API later.
