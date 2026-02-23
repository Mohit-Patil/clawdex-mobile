import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { BridgeClient, type ConnectionState, type RpcNotification } from './lib/bridgeClient';
import {
  mergeStreamingDelta,
  parseThreadDetail,
  parseThreadSummaries,
  type ThreadDetail,
  type ThreadSummary,
} from './lib/chatMapping';
import { readConfig, type MiniAppConfig } from './lib/env';
import {
  formatTelegramUserLabel,
  initializeTelegramWebApp,
  type TelegramWebApp,
} from './lib/telegramWebApp';
import './styles.css';

const THREAD_STORAGE_KEY = 'telegram-miniapp.selected-thread-id';

type RuntimeActivity =
  | { tone: 'idle'; text: string }
  | { tone: 'running'; text: string }
  | { tone: 'error'; text: string }
  | { tone: 'complete'; text: string };

interface ActiveTurnState {
  threadId: string;
  turnId: string;
}

function App() {
  const config = useMemo<MiniAppConfig>(() => readConfig(), []);
  const bridge = useMemo(
    () =>
      new BridgeClient({
        wsUrl: config.bridgeWsUrl,
        authToken: config.bridgeAuthToken,
        allowQueryTokenAuth: config.allowQueryTokenAuth,
        requestTimeoutMs: config.requestTimeoutMs,
      }),
    [config]
  );

  const selectedThreadIdRef = useRef<string | null>(null);

  const [telegramWebApp, setTelegramWebApp] = useState<TelegramWebApp | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null);
  const [composer, setComposer] = useState('');
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [activeTurn, setActiveTurn] = useState<ActiveTurnState | null>(null);
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [loadingThread, setLoadingThread] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<RuntimeActivity>({
    tone: 'idle',
    text: 'Ready',
  });

  const telegramUserLabel = formatTelegramUserLabel(telegramWebApp?.initDataUnsafe?.user);
  const selectedThreadSummary = useMemo(
    () =>
      selectedThreadId
        ? threads.find((thread) => thread.id === selectedThreadId) ?? null
        : null,
    [selectedThreadId, threads]
  );

  const refreshThreads = useCallback(async () => {
    const response = await bridge.request<{ data?: unknown[] }>('thread/list', {
      cursor: null,
      limit: 80,
      sortKey: null,
      modelProviders: null,
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
      archived: false,
      cwd: null,
    });

    const nextThreads = parseThreadSummaries(response.data);
    setThreads(nextThreads);
    return nextThreads;
  }, [bridge]);

  const loadThread = useCallback(
    async (threadId: string): Promise<void> => {
      const normalizedThreadId = threadId.trim();
      if (!normalizedThreadId) {
        return;
      }

      setLoadingThread(true);
      try {
        const response = await bridge.request<{ thread?: unknown }>('thread/read', {
          threadId: normalizedThreadId,
          includeTurns: true,
        });

        const detail = parseThreadDetail(response.thread);
        if (!detail) {
          throw new Error('Failed to parse thread data from bridge response');
        }

        setThreadDetail(detail);
        setError(null);
      } finally {
        setLoadingThread(false);
      }
    },
    [bridge]
  );

  const resumeThread = useCallback(
    async (threadId: string): Promise<void> => {
      const request = {
        threadId,
        history: null,
        path: null,
        model: config.defaultModel,
        modelProvider: null,
        cwd: config.defaultCwd,
        approvalPolicy: 'untrusted',
        sandbox: 'workspace-write',
        config: null,
        baseInstructions: null,
        developerInstructions: config.developerInstructions,
        personality: null,
        experimentalRawEvents: true,
        persistExtendedHistory: true,
      };

      try {
        await bridge.request('thread/resume', request);
      } catch (primaryError) {
        const fallbackRequest = {
          ...request,
          approvalPolicy: 'on-request',
          developerInstructions: null,
        } as Record<string, unknown>;

        delete fallbackRequest.experimentalRawEvents;
        await bridge
          .request('thread/resume', fallbackRequest)
          .catch((fallbackError) => {
            throw new Error(
              `thread/resume failed: ${(primaryError as Error).message}; fallback failed: ${(fallbackError as Error).message}`
            );
          });
      }
    },
    [bridge, config]
  );

  const createThread = useCallback(async (): Promise<string> => {
    const started = await bridge.request<{ thread?: { id?: string } }>('thread/start', {
      model: config.defaultModel,
      modelProvider: null,
      cwd: config.defaultCwd,
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      config: null,
      baseInstructions: null,
      developerInstructions: config.developerInstructions,
      personality: null,
      ephemeral: null,
      experimentalRawEvents: true,
      persistExtendedHistory: true,
    });

    const threadId = readString(started.thread?.id);
    if (!threadId) {
      throw new Error('thread/start did not return thread id');
    }

    setSelectedThreadId(threadId);
    selectedThreadIdRef.current = threadId;
    setThreadDetail(null);
    setStreamingText(null);
    setActivity({ tone: 'idle', text: 'Created new thread' });
    await refreshThreads();
    return threadId;
  }, [bridge, config, refreshThreads]);

  const handleThreadSelection = useCallback(
    async (threadId: string): Promise<void> => {
      if (!threadId || threadId === selectedThreadIdRef.current) {
        return;
      }

      setSelectedThreadId(threadId);
      selectedThreadIdRef.current = threadId;
      setStreamingText(null);
      setActivity({ tone: 'idle', text: 'Thread selected' });
      await loadThread(threadId).catch((selectionError) => {
        setError((selectionError as Error).message);
      });
    },
    [loadThread]
  );

  const submitPrompt = useCallback(async () => {
    const content = composer.trim();
    if (!content) {
      return;
    }

    setSending(true);
    setError(null);

    try {
      let threadId = selectedThreadIdRef.current;
      if (!threadId) {
        threadId = await createThread();
      }

      if (!threadId) {
        throw new Error('No active thread available');
      }

      setComposer('');
      setStreamingText(null);
      setActivity({ tone: 'running', text: 'Sending prompt…' });

      setThreadDetail((previous) => {
        if (!previous || previous.summary.id !== threadId) {
          return previous;
        }

        return {
          ...previous,
          messages: [
            ...previous.messages,
            {
              id: `optimistic-${Date.now()}`,
              role: 'user',
              content,
              createdAtMs: Date.now(),
            },
          ],
        };
      });

      await resumeThread(threadId).catch(() => {
        // Resume is best effort before turn/start.
      });

      const turnStart = await bridge.request<{ turn?: { id?: string } }>('turn/start', {
        threadId,
        input: [
          {
            type: 'text',
            text: content,
            text_elements: [],
          },
        ],
        cwd: config.defaultCwd,
        approvalPolicy: null,
        sandboxPolicy: null,
        model: config.defaultModel,
        effort: config.defaultEffort,
        summary: null,
        personality: null,
        outputSchema: null,
        collaborationMode: null,
      });

      const turnId = readString(turnStart.turn?.id);
      if (!turnId) {
        throw new Error('turn/start did not return turn id');
      }

      setActiveTurn({ threadId, turnId });
      setActivity({ tone: 'running', text: 'Thinking…' });
      await refreshThreads();
    } catch (submitError) {
      setError((submitError as Error).message);
      setActivity({ tone: 'error', text: 'Failed to send message' });
    } finally {
      setSending(false);
    }
  }, [bridge, composer, config, createThread, refreshThreads, resumeThread]);

  const interruptTurn = useCallback(async () => {
    const running = activeTurn;
    if (!running) {
      return;
    }

    try {
      await bridge.request('turn/interrupt', {
        threadId: running.threadId,
        turnId: running.turnId,
      });
      setActivity({ tone: 'complete', text: 'Stop requested' });
    } catch (interruptError) {
      setError((interruptError as Error).message);
      setActivity({ tone: 'error', text: 'Failed to stop turn' });
    }
  }, [activeTurn, bridge]);

  useEffect(() => {
    selectedThreadIdRef.current = selectedThreadId;
    if (selectedThreadId) {
      localStorage.setItem(THREAD_STORAGE_KEY, selectedThreadId);
    }
  }, [selectedThreadId]);

  useEffect(() => {
    const webApp = initializeTelegramWebApp();
    setTelegramWebApp(webApp);

    const lastSelectedThreadId = localStorage.getItem(THREAD_STORAGE_KEY);
    if (lastSelectedThreadId && lastSelectedThreadId.trim().length > 0) {
      setSelectedThreadId(lastSelectedThreadId.trim());
      selectedThreadIdRef.current = lastSelectedThreadId.trim();
    }

    bridge.start();

    const unsubscribeConnection = bridge.onConnectionState((state) => {
      setConnectionState(state);
    });

    const unsubscribeNotifications = bridge.onNotification((event) => {
      void handleNotification(event);
    });

    async function bootstrap(): Promise<void> {
      setLoadingThreads(true);
      try {
        const nextThreads = await refreshThreads();
        const currentSelection = selectedThreadIdRef.current;

        const selectedFromThreads = currentSelection
          ? nextThreads.find((thread) => thread.id === currentSelection) ?? null
          : null;

        const firstThread = nextThreads[0] ?? null;
        const preferredThreadId = selectedFromThreads?.id ?? firstThread?.id ?? null;

        if (preferredThreadId) {
          setSelectedThreadId(preferredThreadId);
          selectedThreadIdRef.current = preferredThreadId;
          await loadThread(preferredThreadId);
        }
      } catch (bootstrapError) {
        setError((bootstrapError as Error).message);
      } finally {
        setLoadingThreads(false);
      }
    }

    void bootstrap();

    return () => {
      unsubscribeConnection();
      unsubscribeNotifications();
      bridge.stop();
    };

    async function handleNotification(event: RpcNotification): Promise<void> {
      if (event.method === 'item/agentMessage/delta') {
        const params = asRecord(event.params);
        const threadId =
          readString(params?.threadId) ?? readString(params?.thread_id);
        const delta = readString(params?.delta);
        if (threadId && delta && threadId === selectedThreadIdRef.current) {
          setStreamingText((previous) => mergeStreamingDelta(previous, delta));
          setActivity({ tone: 'running', text: 'Thinking…' });
        }
        return;
      }

      if (event.method.startsWith('codex/event/')) {
        const codexDelta = readCodexAgentDelta(event);
        if (
          codexDelta &&
          codexDelta.threadId === selectedThreadIdRef.current
        ) {
          setStreamingText((previous) =>
            mergeStreamingDelta(previous, codexDelta.delta)
          );
          setActivity({ tone: 'running', text: 'Thinking…' });
        }
        return;
      }

      if (event.method === 'turn/started') {
        const started = readTurnStarted(event.params);
        if (!started) {
          return;
        }

        if (started.threadId === selectedThreadIdRef.current) {
          setActiveTurn({ threadId: started.threadId, turnId: started.turnId });
          setActivity({ tone: 'running', text: 'Turn started' });
        }
        return;
      }

      if (event.method === 'turn/completed') {
        const completed = readTurnCompleted(event.params);
        if (!completed) {
          return;
        }

        await refreshThreads().catch(() => {});

        if (completed.threadId !== selectedThreadIdRef.current) {
          return;
        }

        setActiveTurn((previous) => {
          if (!previous) {
            return null;
          }

          if (completed.turnId && previous.turnId !== completed.turnId) {
            return previous;
          }

          return null;
        });

        setStreamingText(null);
        await loadThread(completed.threadId).catch((loadError) => {
          setError((loadError as Error).message);
        });

        if (completed.status === 'failed' || completed.status === 'interrupted') {
          setActivity({
            tone: 'error',
            text: completed.errorMessage ?? `Turn ${completed.status}`,
          });
          return;
        }

        setActivity({ tone: 'complete', text: 'Turn completed' });
        return;
      }

      if (event.method === 'thread/name/updated') {
        await refreshThreads().catch(() => {});
      }
    }
  }, [bridge, loadThread, refreshThreads]);

  return (
    <div className="miniapp-shell">
      <header className="shell-header">
        <div className="brand">
          <p className="brand-eyebrow">Codex Mini App</p>
          <h1>Telegram Workspace</h1>
        </div>
        <div className="header-meta">
          <span className={`connection-pill connection-${connectionState}`}>
            {connectionState}
          </span>
          {telegramUserLabel ? <span className="user-pill">{telegramUserLabel}</span> : null}
        </div>
      </header>

      <main className="shell-main">
        <aside className="thread-pane">
          <div className="thread-pane-header">
            <h2>Threads</h2>
            <div className="thread-pane-actions">
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  void refreshThreads();
                }}
                disabled={loadingThreads}
              >
                Refresh
              </button>
              <button
                type="button"
                className="accent-btn"
                onClick={() => {
                  void createThread().then((threadId) => {
                    void loadThread(threadId).catch((loadError) => {
                      setError((loadError as Error).message);
                    });
                  });
                }}
              >
                New
              </button>
            </div>
          </div>

          <div className="thread-list">
            {threads.map((thread) => {
              const selected = thread.id === selectedThreadId;
              return (
                <button
                  key={thread.id}
                  type="button"
                  className={`thread-card ${selected ? 'selected' : ''}`}
                  onClick={() => {
                    void handleThreadSelection(thread.id);
                  }}
                >
                  <div className="thread-card-top">
                    <strong>{thread.title}</strong>
                    <span className={`status-dot status-${thread.status}`} />
                  </div>
                  <p>{thread.preview || 'No messages yet.'}</p>
                  <div className="thread-card-bottom">
                    <code>{thread.id.slice(0, 10)}</code>
                    {thread.cwd ? <small>{truncateMiddle(thread.cwd, 24)}</small> : null}
                  </div>
                </button>
              );
            })}
            {!loadingThreads && threads.length === 0 ? (
              <div className="empty-state">No threads yet. Start with “New” or send a message.</div>
            ) : null}
          </div>
        </aside>

        <section className="chat-pane">
          <div className="chat-pane-header">
            <div>
              <h2>{selectedThreadSummary?.title ?? 'No thread selected'}</h2>
              <p>
                {selectedThreadSummary
                  ? `${selectedThreadSummary.id} · ${selectedThreadSummary.status}`
                  : 'Pick a thread or create a new one.'}
              </p>
            </div>
            <div className="chat-pane-controls">
              <span className={`activity-badge activity-${activity.tone}`}>{activity.text}</span>
              <button
                type="button"
                className="ghost-btn"
                disabled={!activeTurn || activeTurn.threadId !== selectedThreadId}
                onClick={() => {
                  void interruptTurn();
                }}
              >
                Stop
              </button>
            </div>
          </div>

          <div className="message-list">
            {loadingThread ? <div className="loading-line">Loading thread…</div> : null}

            {threadDetail?.messages.map((message) => (
              <article key={message.id} className={`msg-bubble role-${message.role}`}>
                <span className="msg-role">{message.role}</span>
                <p>{message.content}</p>
              </article>
            ))}

            {streamingText ? (
              <article className="msg-bubble role-assistant streaming">
                <span className="msg-role">assistant · streaming</span>
                <p>{streamingText}</p>
              </article>
            ) : null}

            {!loadingThread && !streamingText && (!threadDetail || threadDetail.messages.length === 0) ? (
              <div className="empty-state">No messages in this thread yet.</div>
            ) : null}
          </div>

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void submitPrompt();
            }}
          >
            <textarea
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              placeholder="Message Codex…"
              rows={3}
              disabled={sending}
            />
            <div className="composer-footer">
              {error ? <span className="error-text">{error}</span> : <span />}
              <button type="submit" className="accent-btn" disabled={sending || composer.trim().length === 0}>
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}

function readCodexAgentDelta(
  event: RpcNotification
): { threadId: string; delta: string } | null {
  const params = asRecord(event.params);
  const msg = asRecord(params?.msg);

  const type =
    normalizeType(readString(msg?.type)) ??
    normalizeType(event.method.replace('codex/event/', ''));
  if (type !== 'agentmessagedelta' && type !== 'agentmessagecontentdelta') {
    return null;
  }

  const threadId =
    readString(msg?.thread_id) ??
    readString(msg?.threadId) ??
    readString(params?.thread_id) ??
    readString(params?.threadId);
  const delta = readString(msg?.delta);

  if (!threadId || !delta) {
    return null;
  }

  return {
    threadId,
    delta,
  };
}

function readTurnStarted(params: unknown): { threadId: string; turnId: string } | null {
  const record = asRecord(params);
  const turn = asRecord(record?.turn);

  const threadId =
    readString(record?.threadId) ??
    readString(record?.thread_id) ??
    readString(turn?.threadId) ??
    readString(turn?.thread_id);
  const turnId =
    readString(record?.turnId) ??
    readString(record?.turn_id) ??
    readString(turn?.id) ??
    readString(turn?.turnId);

  if (!threadId || !turnId) {
    return null;
  }

  return {
    threadId,
    turnId,
  };
}

function readTurnCompleted(
  params: unknown
): { threadId: string; turnId: string | null; status: string | null; errorMessage: string | null } | null {
  const record = asRecord(params);
  const turn = asRecord(record?.turn);

  const threadId =
    readString(record?.threadId) ??
    readString(record?.thread_id) ??
    readString(turn?.threadId) ??
    readString(turn?.thread_id);

  if (!threadId) {
    return null;
  }

  const errorRecord = asRecord(turn?.error) ?? asRecord(record?.error);

  return {
    threadId,
    turnId:
      readString(record?.turnId) ??
      readString(record?.turn_id) ??
      readString(turn?.id) ??
      readString(turn?.turnId),
    status: readString(turn?.status) ?? readString(record?.status),
    errorMessage: readString(errorRecord?.message),
  };
}

function normalizeType(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }

  const left = Math.ceil((max - 1) / 2);
  const right = Math.floor((max - 1) / 2);
  return `${value.slice(0, left)}…${value.slice(value.length - right)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export default App;
