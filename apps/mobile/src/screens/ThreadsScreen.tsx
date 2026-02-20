import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState
} from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle
} from 'react-native';

import type { MacBridgeApiClient } from '../api/client';
import type { BridgeWsEvent, Thread, ThreadMessage, ThreadSummary } from '../api/types';
import type { MacBridgeWsClient } from '../api/ws';
import { ActionButton, Panel, ScreenSurface } from '../ui/primitives';
import { fonts, palette, radii, spacing } from '../ui/theme';

interface ThreadsScreenProps {
  api: MacBridgeApiClient;
  ws: MacBridgeWsClient;
}

const RUN_EVENT_LIMIT = 20;

export function ThreadsScreen({ api, ws }: ThreadsScreenProps) {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [draft, setDraft] = useState('');
  const [replyDraft, setReplyDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
  const [runEvents, setRunEvents] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadThreads = useCallback(async () => {
    try {
      setLoading(true);
      const data = await api.listThreads();
      setThreads(sortThreads(data));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [api]);

  const openThread = useCallback(
    async (threadId: string) => {
      try {
        const thread = await api.getThread(threadId);
        setSelectedThreadId(threadId);
        setSelectedThread(thread);
        setThreads((previous) => upsertThreadSummary(previous, threadToSummary(thread)));
        setRunEvents([]);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [api]
  );

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  useEffect(() => {
    const unsubscribe = ws.onEvent((event) => {
      applyWsEvent(event, selectedThreadId, setThreads, setSelectedThread, setRunEvents);
    });

    return unsubscribe;
  }, [selectedThreadId, ws]);

  const createThread = useCallback(async () => {
    try {
      setCreating(true);
      const created = await api.createThread({ message: draft.trim() || undefined });
      setDraft('');
      setSelectedThreadId(created.id);
      setSelectedThread(created);
      setThreads((previous) => upsertThreadSummary(previous, threadToSummary(created)));
      setRunEvents([]);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }, [api, draft]);

  const sendMessage = useCallback(async () => {
    if (!selectedThreadId) {
      return;
    }

    const content = replyDraft.trim();
    if (!content) {
      return;
    }

    try {
      setSending(true);
      const updated = await api.sendThreadMessage(selectedThreadId, { content });
      setReplyDraft('');
      setSelectedThread(updated);
      setThreads((previous) => upsertThreadSummary(previous, threadToSummary(updated)));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [api, replyDraft, selectedThreadId]);

  const heroMeta = useMemo(() => {
    if (!selectedThread) {
      return `${String(threads.length)} threads available`;
    }

    return `Focused on ${selectedThread.title}`;
  }, [selectedThread, threads.length]);

  return (
    <ScreenSurface>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.hero}>
          <Text style={styles.heroLabel}>THREAD STUDIO</Text>
          <Text style={styles.heroTitle}>Codex Conversations</Text>
          <Text style={styles.heroMeta}>{heroMeta}</Text>
        </View>

        <Panel>
          <Text style={styles.blockTitle}>Start New Thread</Text>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Describe what you want Codex to do"
            placeholderTextColor={palette.inkMuted}
            style={styles.composeInput}
            multiline
            autoCapitalize="sentences"
          />
          <View style={styles.rowEnd}>
            <ActionButton
              label={creating ? 'Creating...' : 'Create Thread'}
              onPress={() => void createThread()}
              disabled={creating || !draft.trim()}
            />
          </View>
        </Panel>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Recent Threads</Text>
          <ActionButton
            label="Refresh"
            variant="ghost"
            compact
            onPress={() => void loadThreads()}
          />
        </View>

        <Panel style={styles.listPanel}>
          {loading ? (
            <View style={styles.loaderWrap}>
              <ActivityIndicator color={palette.accent} />
            </View>
          ) : (
            <FlatList
              data={threads}
              keyExtractor={(item: ThreadSummary) => item.id}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={threads.length === 0 ? styles.emptyList : styles.listContent}
              ListEmptyComponent={<Text style={styles.emptyText}>No threads yet.</Text>}
              renderItem={({ item }: { item: ThreadSummary }) => (
                <Pressable
                  onPress={() => void openThread(item.id)}
                  style={({ pressed }) => [
                    styles.threadCard,
                    item.id === selectedThreadId ? styles.threadCardSelected : undefined,
                    pressed ? styles.threadCardPressed : undefined
                  ]}
                >
                  <View style={styles.threadHeader}>
                    <Text numberOfLines={1} style={styles.threadTitle}>
                      {item.title}
                    </Text>
                    <View style={[styles.statusDot, statusDotStyle(item.status)]} />
                  </View>
                  <Text numberOfLines={2} style={styles.threadPreview}>
                    {item.lastMessagePreview || 'No messages yet'}
                  </Text>
                  <Text style={styles.threadMeta}>{formatThreadMeta(item)}</Text>
                </Pressable>
              )}
            />
          )}
        </Panel>

        <Panel style={styles.focusPanel}>
          <View style={styles.focusHeader}>
            <Text numberOfLines={1} style={styles.focusTitle}>
              {selectedThread?.title ?? 'Select a thread'}
            </Text>
            <View style={[styles.statusPill, statusPillStyle(selectedThread?.status ?? 'idle')]}>
              <Text style={styles.statusPillText}>{selectedThread?.status ?? 'idle'}</Text>
            </View>
          </View>

          <ScrollView
            style={styles.messagesBox}
            contentContainerStyle={styles.messagesContent}
            nestedScrollEnabled
          >
            {selectedThread ? (
              selectedThread.messages.length > 0 ? (
                selectedThread.messages.map((message) => (
                  <View
                    key={message.id}
                    style={[styles.messageBubble, messageRoleBubbleStyle(message.role)]}
                  >
                    <Text style={[styles.messageRole, messageRoleTextStyle(message.role)]}>
                      {message.role}
                    </Text>
                    <Text style={styles.messageText}>{message.content || '(streaming...)'}</Text>
                    <Text style={styles.messageTime}>{formatTime(message.createdAt)}</Text>
                  </View>
                ))
              ) : (
                <Text style={styles.placeholderText}>No messages in this thread yet.</Text>
              )
            ) : (
              <Text style={styles.placeholderText}>Tap a thread to inspect and continue the conversation.</Text>
            )}
          </ScrollView>

          {runEvents.length > 0 ? (
            <View style={styles.eventsPanel}>
              <Text style={styles.eventsTitle}>Recent Run Events</Text>
              {runEvents.slice(0, 5).map((event) => (
                <Text key={event} numberOfLines={1} style={styles.eventLine}>
                  {event}
                </Text>
              ))}
            </View>
          ) : null}

          <View style={styles.replyRow}>
            <TextInput
              value={replyDraft}
              onChangeText={setReplyDraft}
              placeholder="Reply to selected thread"
              placeholderTextColor={palette.inkMuted}
              style={styles.replyInput}
              autoCapitalize="sentences"
              multiline
              editable={selectedThreadId !== null}
            />
            <ActionButton
              label={sending ? 'Sending...' : 'Send'}
              onPress={() => void sendMessage()}
              disabled={sending || !selectedThreadId || !replyDraft.trim()}
            />
          </View>
        </Panel>

        {error ? <Text style={styles.error}>Error: {error}</Text> : null}
      </KeyboardAvoidingView>
    </ScreenSurface>
  );
}

function applyWsEvent(
  event: BridgeWsEvent,
  selectedThreadId: string | null,
  setThreads: Dispatch<SetStateAction<ThreadSummary[]>>,
  setSelectedThread: Dispatch<SetStateAction<Thread | null>>,
  setRunEvents: Dispatch<SetStateAction<string[]>>
): void {
  if (event.type === 'thread.created' || event.type === 'thread.updated') {
    setThreads((previous) => upsertThreadSummary(previous, event.payload));
    setSelectedThread((previous) => {
      if (!previous || previous.id !== event.payload.id) {
        return previous;
      }

      return {
        ...previous,
        ...event.payload
      };
    });
    return;
  }

  if (event.type === 'thread.message') {
    const message = event.payload.message;

    setThreads((previous) => {
      const preview = message.content.trim();
      if (!preview) {
        return previous;
      }

      const existing = previous.find((thread) => thread.id === event.payload.threadId);
      if (!existing) {
        return previous;
      }

      return upsertThreadSummary(previous, {
        ...existing,
        lastMessagePreview: message.content,
        updatedAt: message.createdAt
      });
    });

    setSelectedThread((previous) => {
      if (!previous || previous.id !== event.payload.threadId) {
        return previous;
      }

      return {
        ...previous,
        messages: upsertThreadMessage(previous.messages, message),
        updatedAt: message.createdAt,
        lastMessagePreview: message.content.trim() ? message.content : previous.lastMessagePreview
      };
    });

    return;
  }

  if (event.type === 'thread.message.delta') {
    setThreads((previous) => {
      const existing = previous.find((thread) => thread.id === event.payload.threadId);
      if (!existing) {
        return previous;
      }

      return upsertThreadSummary(previous, {
        ...existing,
        updatedAt: event.payload.updatedAt,
        lastMessagePreview: event.payload.content
      });
    });

    setSelectedThread((previous) => {
      if (!previous || previous.id !== event.payload.threadId) {
        return previous;
      }

      const existing = previous.messages.find((message) => message.id === event.payload.messageId);
      const streamedMessage: ThreadMessage = {
        id: event.payload.messageId,
        role: 'assistant',
        content: event.payload.content,
        createdAt: event.payload.updatedAt
      };

      const nextMessages = existing
        ? previous.messages.map((message) =>
            message.id === event.payload.messageId
              ? { ...message, content: event.payload.content }
              : message
          )
        : [...previous.messages, streamedMessage];

      return {
        ...previous,
        messages: nextMessages,
        updatedAt: event.payload.updatedAt,
        lastMessagePreview: event.payload.content
      };
    });

    return;
  }

  if (event.type === 'thread.run.event' && selectedThreadId === event.payload.threadId) {
    const line = `[${new Date(event.payload.at).toLocaleTimeString()}] ${event.payload.eventType}${event.payload.detail ? ` - ${event.payload.detail}` : ''}`;
    setRunEvents((previous) => [line, ...previous].slice(0, RUN_EVENT_LIMIT));
  }
}

function upsertThreadSummary(
  previous: ThreadSummary[],
  summary: ThreadSummary
): ThreadSummary[] {
  const index = previous.findIndex((item) => item.id === summary.id);
  const next = [...previous];

  if (index === -1) {
    next.push(summary);
  } else {
    next[index] = summary;
  }

  return sortThreads(next);
}

function upsertThreadMessage(
  previous: ThreadMessage[],
  message: ThreadMessage
): ThreadMessage[] {
  const index = previous.findIndex((item) => item.id === message.id);
  if (index === -1) {
    return [...previous, message];
  }

  const next = [...previous];
  next[index] = message;
  return next;
}

function sortThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function threadToSummary(thread: Thread): ThreadSummary {
  return {
    id: thread.id,
    title: thread.title,
    status: thread.status,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    statusUpdatedAt: thread.statusUpdatedAt,
    lastMessagePreview: thread.lastMessagePreview,
    cwd: thread.cwd,
    modelProvider: thread.modelProvider,
    sourceKind: thread.sourceKind,
    lastRunStartedAt: thread.lastRunStartedAt,
    lastRunFinishedAt: thread.lastRunFinishedAt,
    lastRunDurationMs: thread.lastRunDurationMs,
    lastRunExitCode: thread.lastRunExitCode,
    lastRunTimedOut: thread.lastRunTimedOut,
    lastError: thread.lastError
  };
}

function formatThreadMeta(item: ThreadSummary): string {
  const source = item.sourceKind ?? 'unknown source';
  const when = formatTime(item.updatedAt);
  return `${source} • updated ${when}`;
}

function formatTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function statusDotStyle(status: ThreadSummary['status']) {
  if (status === 'running') {
    return { backgroundColor: palette.info };
  }

  if (status === 'complete') {
    return { backgroundColor: palette.positive };
  }

  if (status === 'error') {
    return { backgroundColor: palette.danger };
  }

  return { backgroundColor: palette.warning };
}

function statusPillStyle(status: ThreadSummary['status']) {
  if (status === 'running') {
    return {
      backgroundColor: '#DDEBFA'
    };
  }

  if (status === 'complete') {
    return {
      backgroundColor: '#DCEFE5'
    };
  }

  if (status === 'error') {
    return {
      backgroundColor: '#F9DEDA'
    };
  }

  return {
    backgroundColor: '#F3E7D6'
  };
}

function messageRoleBubbleStyle(role: ThreadMessage['role']): ViewStyle {
  if (role === 'user') {
    return {
      alignSelf: 'flex-end',
      backgroundColor: palette.accentSoft,
      borderColor: '#E6BFA8'
    };
  }

  if (role === 'assistant') {
    return {
      alignSelf: 'flex-start',
      backgroundColor: palette.panelMuted,
      borderColor: palette.border
    };
  }

  return {
    alignSelf: 'center',
    backgroundColor: '#E2EAF2',
    borderColor: '#CDD7E3'
  };
}

function messageRoleTextStyle(role: ThreadMessage['role']) {
  if (role === 'user') {
    return { color: '#7F2F17' };
  }

  if (role === 'assistant') {
    return { color: '#51483D' };
  }

  return { color: '#274A70' };
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    gap: spacing.sm,
    paddingTop: spacing.sm
  },
  hero: {
    marginBottom: spacing.xs
  },
  heroLabel: {
    fontFamily: fonts.heading,
    fontSize: 12,
    letterSpacing: 1.3,
    color: palette.accent
  },
  heroTitle: {
    marginTop: 2,
    fontFamily: fonts.heading,
    fontSize: 28,
    color: palette.ink
  },
  heroMeta: {
    marginTop: 2,
    fontFamily: fonts.body,
    color: palette.inkMuted
  },
  blockTitle: {
    fontFamily: fonts.heading,
    fontSize: 16,
    color: palette.ink,
    marginBottom: spacing.sm
  },
  composeInput: {
    minHeight: 72,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    backgroundColor: palette.canvas,
    fontFamily: fonts.body,
    color: palette.ink,
    textAlignVertical: 'top'
  },
  rowEnd: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    justifyContent: 'flex-end'
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  sectionTitle: {
    fontFamily: fonts.heading,
    fontSize: 17,
    color: palette.ink
  },
  listPanel: {
    minHeight: 146,
    maxHeight: 210,
    padding: spacing.sm
  },
  loaderWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  listContent: {
    gap: spacing.xs,
    paddingBottom: 2
  },
  emptyList: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  emptyText: {
    fontFamily: fonts.body,
    color: palette.inkMuted
  },
  threadCard: {
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radii.md,
    padding: spacing.sm,
    backgroundColor: palette.canvas
  },
  threadCardSelected: {
    borderColor: palette.accent,
    backgroundColor: '#FBEDE5'
  },
  threadCardPressed: {
    transform: [{ scale: 0.995 }],
    opacity: 0.95
  },
  threadHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  threadTitle: {
    flex: 1,
    fontFamily: fonts.heading,
    color: palette.ink,
    fontSize: 15
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 999
  },
  threadPreview: {
    marginTop: 5,
    color: palette.ink,
    fontFamily: fonts.body
  },
  threadMeta: {
    marginTop: 6,
    color: palette.inkMuted,
    fontFamily: fonts.body,
    fontSize: 12
  },
  focusPanel: {
    flex: 1,
    padding: spacing.sm,
    gap: spacing.sm
  },
  focusHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  focusTitle: {
    flex: 1,
    fontFamily: fonts.heading,
    color: palette.ink,
    fontSize: 16
  },
  statusPill: {
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4
  },
  statusPillText: {
    fontFamily: fonts.heading,
    fontSize: 12,
    textTransform: 'uppercase',
    color: palette.ink
  },
  messagesBox: {
    flex: 1,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radii.md,
    backgroundColor: palette.canvas
  },
  messagesContent: {
    padding: spacing.sm,
    gap: spacing.sm
  },
  messageBubble: {
    width: '90%',
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    gap: 4
  },
  messageRole: {
    fontFamily: fonts.heading,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.6
  },
  messageText: {
    fontFamily: fonts.body,
    color: palette.ink,
    fontSize: 14,
    lineHeight: 19
  },
  messageTime: {
    fontFamily: fonts.body,
    color: palette.inkMuted,
    fontSize: 11,
    textAlign: 'right'
  },
  placeholderText: {
    fontFamily: fonts.body,
    color: palette.inkMuted
  },
  eventsPanel: {
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radii.md,
    backgroundColor: '#F7EFE4',
    padding: spacing.sm,
    gap: 4
  },
  eventsTitle: {
    fontFamily: fonts.heading,
    color: palette.ink,
    fontSize: 13
  },
  eventLine: {
    fontFamily: fonts.mono,
    fontSize: 11,
    color: '#4A4137'
  },
  replyRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm
  },
  replyInput: {
    flex: 1,
    maxHeight: 96,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    backgroundColor: palette.canvas,
    fontFamily: fonts.body,
    color: palette.ink,
    textAlignVertical: 'top'
  },
  error: {
    color: palette.danger,
    fontFamily: fonts.body,
    paddingHorizontal: 2
  }
});
