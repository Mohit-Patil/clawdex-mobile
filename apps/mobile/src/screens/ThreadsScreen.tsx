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
  Button,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';

import type { MacBridgeApiClient } from '../api/client';
import type { BridgeWsEvent, Thread, ThreadMessage, ThreadSummary } from '../api/types';
import type { MacBridgeWsClient } from '../api/ws';

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

  const selectedThreadDetails = useMemo(() => {
    if (!selectedThread) {
      return 'Tap a thread to load details.';
    }

    const lines = [
      selectedThread.title,
      `Status: ${selectedThread.status}${selectedThread.lastRunDurationMs ? ` (${String(selectedThread.lastRunDurationMs)}ms)` : ''}`
    ];

    if (selectedThread.lastError) {
      lines.push(`Last error: ${selectedThread.lastError}`);
    }

    lines.push('');

    for (const message of selectedThread.messages) {
      lines.push(`[${message.role}] ${message.content || '(streaming...)'}`);
      lines.push('');
    }

    if (runEvents.length > 0) {
      lines.push('Run events:');
      for (const event of runEvents) {
        lines.push(event);
      }
    }

    return lines.join('\n');
  }, [runEvents, selectedThread]);

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="New thread prompt"
          style={styles.input}
          autoCapitalize="none"
        />
        <Button
          title={creating ? 'Creating...' : 'Create'}
          onPress={() => void createThread()}
          disabled={creating || !draft.trim()}
        />
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Threads</Text>
        <Button title="Refresh" onPress={() => void loadThreads()} />
      </View>

      {loading ? (
        <ActivityIndicator />
      ) : (
        <FlatList
          data={threads}
          keyExtractor={(item: ThreadSummary) => item.id}
          contentContainerStyle={threads.length === 0 ? styles.emptyList : undefined}
          ListEmptyComponent={<Text style={styles.subtle}>No threads yet.</Text>}
          renderItem={({ item }: { item: ThreadSummary }) => (
            <Pressable
              style={[
                styles.card,
                item.id === selectedThreadId ? styles.selectedCard : undefined
              ]}
              onPress={() => void openThread(item.id)}
            >
              <Text style={styles.cardTitle}>{item.title}</Text>
              <Text style={[styles.subtle, statusTextStyle(item.status)]}>
                Status: {item.status}
              </Text>
              <Text numberOfLines={2} style={styles.preview}>
                {item.lastMessagePreview || 'No messages'}
              </Text>
              {item.sourceKind || item.cwd ? (
                <Text numberOfLines={1} style={styles.subtle}>
                  {item.sourceKind ?? 'unknown source'}{item.cwd ? ` • ${item.cwd}` : ''}
                </Text>
              ) : null}
            </Pressable>
          )}
        />
      )}

      <Text style={styles.sectionTitle}>Selected Thread</Text>
      <ScrollView style={styles.detailsBox} contentContainerStyle={styles.detailsContent}>
        <Text style={styles.detailsText}>{selectedThreadDetails}</Text>
      </ScrollView>

      <View style={styles.row}>
        <TextInput
          value={replyDraft}
          onChangeText={setReplyDraft}
          placeholder="Reply to selected thread"
          style={styles.input}
          autoCapitalize="none"
          editable={selectedThreadId !== null}
        />
        <Button
          title={sending ? 'Sending...' : 'Send'}
          onPress={() => void sendMessage()}
          disabled={sending || !selectedThreadId || !replyDraft.trim()}
        />
      </View>

      {error ? <Text style={styles.error}>Error: {error}</Text> : null}
    </View>
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
        lastMessagePreview: message.content.trim()
          ? message.content
          : previous.lastMessagePreview
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

      const existing = previous.messages.find(
        (message) => message.id === event.payload.messageId
      );
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

function statusTextStyle(status: ThreadSummary['status']): {
  color: string;
} {
  if (status === 'running') {
    return { color: '#0369a1' };
  }

  if (status === 'complete') {
    return { color: '#166534' };
  }

  if (status === 'error') {
    return { color: '#b91c1c' };
  }

  return { color: '#64748b' };
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    gap: 12
  },
  row: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center'
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600'
  },
  card: {
    padding: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    marginBottom: 8,
    backgroundColor: '#f8fafc'
  },
  selectedCard: {
    borderColor: '#0f172a',
    borderWidth: 1.5
  },
  cardTitle: {
    fontWeight: '600',
    marginBottom: 4
  },
  preview: {
    marginTop: 4
  },
  detailsBox: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    minHeight: 140,
    maxHeight: 210
  },
  detailsContent: {
    padding: 10
  },
  detailsText: {
    color: '#0f172a'
  },
  subtle: {
    color: '#64748b'
  },
  emptyList: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  error: {
    color: '#b91c1c'
  }
});
