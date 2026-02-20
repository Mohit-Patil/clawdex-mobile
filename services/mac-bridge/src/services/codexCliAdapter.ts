import { randomUUID } from 'node:crypto';

import { CodexAppServerClient } from './codexAppServerClient';
import type {
  BridgeWsEvent,
  CreateThreadInput,
  SendThreadMessageInput,
  Thread,
  ThreadMessage,
  ThreadSummary
} from '../types';

interface CodexCliAdapterOptions {
  workdir: string;
  cliBin?: string;
  cliTimeoutMs?: number;
  emitEvent?: (event: BridgeWsEvent) => void;
}

type RawThreadStatus =
  | { type?: string }
  | string
  | null
  | undefined;

interface RawTurn {
  id?: string;
  status?: string;
  error?: {
    message?: string;
  } | null;
  items?: RawThreadItem[];
}

type RawThreadItem =
  | {
      type?: 'userMessage';
      id?: string;
      content?: Array<{ type?: string; text?: string; path?: string; url?: string }>;
    }
  | {
      type?: 'agentMessage';
      id?: string;
      text?: string;
    }
  | {
      type?: string;
      id?: string;
      text?: string;
    };

interface RawThread {
  id?: string;
  preview?: string;
  modelProvider?: string;
  createdAt?: number;
  updatedAt?: number;
  status?: RawThreadStatus;
  cwd?: string;
  source?: {
    kind?: string;
  };
  turns?: RawTurn[];
}

const DEFAULT_CLI_BIN = 'codex';
const DEFAULT_TIMEOUT_MS = 180_000;

export class ThreadBusyError extends Error {
  readonly statusCode = 409;
  readonly code = 'thread_busy';

  constructor(readonly threadId: string) {
    super(`Thread ${threadId} is currently running.`);
    this.name = 'ThreadBusyError';
  }
}

export class CodexCliAdapter {
  private readonly workdir: string;
  private readonly cliTimeoutMs: number;
  private readonly emitWsEvent?: (event: BridgeWsEvent) => void;

  private readonly client: CodexAppServerClient;
  private readonly threadCache = new Map<string, Thread>();
  private readonly titleOverrides = new Map<string, string>();
  private readonly activeRuns = new Set<string>();

  constructor(options: CodexCliAdapterOptions) {
    this.workdir = options.workdir;
    this.cliTimeoutMs = options.cliTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.emitWsEvent = options.emitEvent;

    this.client = new CodexAppServerClient({
      cliBin: options.cliBin?.trim() || DEFAULT_CLI_BIN,
      timeoutMs: this.cliTimeoutMs,
      onStderr: (chunk) => {
        const detail = chunk.trim();
        if (detail) {
          this.emitThreadRunEvent('global', 'stderr', detail.slice(0, 500));
        }
      }
    });
  }

  async listThreads(): Promise<ThreadSummary[]> {
    const response = await this.client.threadList({ cwd: null, limit: 200 });
    const listRaw = Array.isArray(response.data) ? response.data : [];

    const summaries = listRaw
      .map((item) => this.mapThreadSummary(this.toRawThread(item)))
      .filter((item): item is ThreadSummary => item !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return summaries;
  }

  async getThread(id: string): Promise<Thread | null> {
    return this.readAndCacheThread(id);
  }

  async createThread(input: CreateThreadInput): Promise<Thread> {
    const started = await this.client.threadStart({
      cwd: this.workdir,
      approvalPolicy: 'never',
      sandbox: 'workspace-write'
    });

    const raw = this.toRawThread(started.thread);
    const threadId = raw.id;
    if (!threadId) {
      throw new Error('app-server did not return a thread id');
    }

    const title = input.title?.trim();
    if (title) {
      this.titleOverrides.set(threadId, title);
    }

    const mapped = this.mapThreadWithTurns(raw);
    this.threadCache.set(mapped.id, mapped);
    this.emitThreadSummaryEvent('thread.created', mapped);

    const initialPrompt = input.message?.trim();
    if (initialPrompt) {
      const updated = await this.appendMessage(threadId, {
        content: initialPrompt,
        role: 'user'
      });
      if (!updated) {
        throw new Error('failed to load created thread after initial prompt');
      }
      return updated;
    }

    return structuredClone(mapped);
  }

  async appendMessage(
    id: string,
    input: SendThreadMessageInput
  ): Promise<Thread | null> {
    const content = input.content.trim();
    if (!content) {
      return this.getThread(id);
    }

    let thread: Thread | null = this.threadCache.get(id) ?? null;
    if (!thread) {
      thread = await this.readAndCacheThread(id);
    }

    if (!thread) {
      return null;
    }

    if (thread.status === 'running' || this.activeRuns.has(id)) {
      throw new ThreadBusyError(id);
    }

    const role = input.role ?? 'user';
    const userMessage = this.createMessage(role, content);
    this.appendThreadMessage(thread, userMessage);
    this.emitThreadMessage(thread.id, userMessage);

    if (role !== 'user') {
      this.threadCache.set(thread.id, thread);
      this.emitThreadSummaryEvent('thread.updated', thread);
      return structuredClone(thread);
    }

    const assistantMessage = this.createMessage('assistant', '');
    this.appendThreadMessage(thread, assistantMessage);
    this.threadCache.set(thread.id, thread);

    this.emitThreadSummaryEvent('thread.updated', thread);
    this.emitThreadMessage(thread.id, assistantMessage);

    this.activeRuns.add(thread.id);
    this.setThreadStatus(thread, 'running');
    thread.lastRunStartedAt = new Date().toISOString();
    thread.lastRunFinishedAt = undefined;
    thread.lastRunDurationMs = undefined;
    thread.lastRunExitCode = undefined;
    thread.lastRunTimedOut = false;
    thread.lastError = undefined;
    this.emitThreadSummaryEvent('thread.updated', thread);
    this.emitThreadRunEvent(thread.id, 'run.started', 'Starting turn via codex app-server');

    const startedAtMs = Date.now();

    try {
      await this.client.threadResume(thread.id);
      const turnResponse = await this.client.turnStart(thread.id, content);
      const turn = this.toRecord(turnResponse.turn);
      const turnId = this.readString(turn?.id);
      if (!turnId) {
        throw new Error('turn/start did not return turn id');
      }

      await this.waitForTurnCompletion(thread.id, turnId, assistantMessage.id);

      const refreshed = await this.readAndCacheThread(thread.id);
      if (!refreshed) {
        throw new Error('thread disappeared after turn completion');
      }

      refreshed.lastRunStartedAt = thread.lastRunStartedAt;
      refreshed.lastRunFinishedAt = new Date().toISOString();
      refreshed.lastRunDurationMs = Date.now() - startedAtMs;
      refreshed.lastRunExitCode = 0;
      refreshed.lastRunTimedOut = false;
      this.threadCache.set(refreshed.id, refreshed);
      this.emitThreadSummaryEvent('thread.updated', refreshed);

      return structuredClone(refreshed);
    } catch (error) {
      thread.lastRunFinishedAt = new Date().toISOString();
      thread.lastRunDurationMs = Date.now() - startedAtMs;
      thread.lastRunExitCode = 1;
      thread.lastRunTimedOut = false;
      thread.lastError = (error as Error).message;
      this.setThreadStatus(thread, 'error');
      this.threadCache.set(thread.id, thread);
      this.emitThreadSummaryEvent('thread.updated', thread);
      this.emitThreadRunEvent(thread.id, 'run.failed', thread.lastError);
      throw error;
    } finally {
      this.activeRuns.delete(thread.id);
    }
  }

  private async waitForTurnCompletion(
    threadId: string,
    turnId: string,
    assistantMessageId: string
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`turn timed out after ${String(this.cliTimeoutMs)}ms`));
      }, this.cliTimeoutMs);

      const unsubscribe = this.client.onNotification((notification) => {
        try {
          if (
            notification.method === 'item/agentMessage/delta' &&
            this.readString(notification.params?.threadId) === threadId &&
            this.readString(notification.params?.turnId) === turnId
          ) {
            const delta = this.readString(notification.params?.delta);
            if (delta) {
              this.appendAssistantDelta(threadId, assistantMessageId, delta);
            }
            return;
          }

          if (
            notification.method === 'thread/status/changed' &&
            this.readString(notification.params?.threadId) === threadId
          ) {
            const status = this.mapRawStatus(notification.params?.status, undefined);
            const thread = this.threadCache.get(threadId);
            if (thread) {
              this.setThreadStatus(thread, status);
              this.threadCache.set(thread.id, thread);
              this.emitThreadSummaryEvent('thread.updated', thread);
            }
            return;
          }

          if (
            notification.method === 'turn/completed' &&
            this.readString(notification.params?.threadId) === threadId
          ) {
            const turn = this.toRecord(notification.params?.turn);
            const completedTurnId = this.readString(turn?.id);
            if (completedTurnId !== turnId) {
              return;
            }

            const turnStatus = this.readString(turn?.status);
            const turnError = this.toRecord(turn?.error);
            const turnErrorMessage = this.readString(turnError?.message);

            const thread = this.threadCache.get(threadId);
            if (thread) {
              if (turnStatus === 'failed' || turnStatus === 'interrupted') {
                this.setThreadStatus(thread, 'error');
                thread.lastError = turnErrorMessage ?? `turn ${turnStatus ?? 'failed'}`;
                this.emitThreadRunEvent(threadId, 'run.failed', thread.lastError);
              } else {
                this.setThreadStatus(thread, 'complete');
                thread.lastError = undefined;
                this.emitThreadRunEvent(threadId, 'run.completed');
              }
              this.threadCache.set(thread.id, thread);
              this.emitThreadSummaryEvent('thread.updated', thread);
            }

            clearTimeout(timeout);
            unsubscribe();
            resolve();
            return;
          }

          if (
            notification.method === 'item/completed' &&
            this.readString(notification.params?.threadId) === threadId
          ) {
            const item = this.toRecord(notification.params?.item);
            const itemType = this.readString(item?.type);
            if (itemType === 'commandExecution') {
              const command = this.readString(item?.command);
              const status = this.readString(item?.status);
              this.emitThreadRunEvent(
                threadId,
                'command.completed',
                [command, status].filter(Boolean).join(' | ')
              );
            }
          }
        } catch (error) {
          clearTimeout(timeout);
          unsubscribe();
          reject(error);
        }
      });
    });
  }

  private async readAndCacheThread(id: string): Promise<Thread | null> {
    const read = await this.client.threadRead(id, true);
    const raw = this.toRawThread(read.thread);
    if (!raw.id) {
      return null;
    }

    const mapped = this.mapThreadWithTurns(raw);
    this.threadCache.set(mapped.id, mapped);
    return structuredClone(mapped);
  }

  private mapThreadSummary(raw: RawThread): ThreadSummary | null {
    if (!raw.id) {
      return null;
    }

    const createdAt = this.unixSecondsToIso(raw.createdAt);
    const updatedAt = this.unixSecondsToIso(raw.updatedAt);
    const turns = Array.isArray(raw.turns) ? raw.turns : [];

    const title =
      this.titleOverrides.get(raw.id) ??
      this.toPreview(raw.preview || `Thread ${raw.id.slice(0, 8)}`);

    const lastError = this.extractLastError(turns);

    return {
      id: raw.id,
      title,
      status: this.mapRawStatus(raw.status, turns),
      createdAt,
      updatedAt,
      statusUpdatedAt: updatedAt,
      lastMessagePreview: this.toPreview(raw.preview || ''),
      cwd: this.readString(raw.cwd) ?? undefined,
      modelProvider: this.readString(raw.modelProvider) ?? undefined,
      sourceKind: this.readString(this.toRecord(raw.source)?.kind) ?? undefined,
      lastError: lastError ?? undefined
    };
  }

  private mapThreadWithTurns(raw: RawThread): Thread {
    const summary = this.mapThreadSummary(raw);
    if (!summary) {
      throw new Error('thread id missing in app-server response');
    }

    const messages = this.mapMessages(raw, summary.createdAt);

    const lastPreview =
      messages.length > 0
        ? this.toPreview(messages[messages.length - 1].content)
        : summary.lastMessagePreview;

    return {
      ...summary,
      lastMessagePreview: lastPreview,
      messages
    };
  }

  private mapMessages(raw: RawThread, fallbackCreatedAt: string): ThreadMessage[] {
    const turns = Array.isArray(raw.turns) ? raw.turns : [];
    if (turns.length === 0) {
      return [];
    }

    const baseTs = new Date(fallbackCreatedAt).getTime();
    const messages: ThreadMessage[] = [];

    for (const turn of turns) {
      const items = Array.isArray(turn.items) ? turn.items : [];
      for (const item of items) {
        const itemRecord = this.toRecord(item);
        if (!itemRecord) {
          continue;
        }

        const itemType = this.readString(itemRecord.type);

        if (itemType === 'userMessage') {
          const contentItems = Array.isArray(itemRecord.content) ? itemRecord.content : [];
          const text = contentItems
            .map((entry: unknown) => {
              const entryRecord = this.toRecord(entry);
              if (!entryRecord) {
                return '';
              }

              const entryType = this.readString(entryRecord.type);
              if (entryType === 'text') {
                return this.readString(entryRecord.text) ?? '';
              }

              if (entryType === 'image') {
                return `[image: ${this.readString(entryRecord.url) ?? 'unknown'}]`;
              }

              if (entryType === 'localImage') {
                return `[local image: ${this.readString(entryRecord.path) ?? 'unknown'}]`;
              }

              return '';
            })
            .filter(Boolean)
            .join('\n');

          if (!text.trim()) {
            continue;
          }

          messages.push({
            id: this.readString(itemRecord.id) ?? randomUUID(),
            role: 'user',
            content: text,
            createdAt: new Date(baseTs + messages.length * 1000).toISOString()
          });
          continue;
        }

        if (itemType === 'agentMessage') {
          const text = this.readString(itemRecord.text) ?? '';
          if (!text.trim()) {
            continue;
          }

          messages.push({
            id: this.readString(itemRecord.id) ?? randomUUID(),
            role: 'assistant',
            content: text,
            createdAt: new Date(baseTs + messages.length * 1000).toISOString()
          });
        }
      }
    }

    return messages;
  }

  private appendAssistantDelta(threadId: string, messageId: string, delta: string): void {
    const thread = this.threadCache.get(threadId);
    if (!thread || !delta) {
      return;
    }

    const existing = thread.messages.find((message) => message.id === messageId);
    if (!existing) {
      return;
    }

    existing.content += delta;
    const updatedAt = new Date().toISOString();
    thread.updatedAt = updatedAt;
    thread.lastMessagePreview = this.toPreview(existing.content);

    this.threadCache.set(thread.id, thread);

    this.emit({
      type: 'thread.message.delta',
      payload: {
        threadId,
        messageId,
        delta,
        content: existing.content,
        updatedAt
      }
    });

    this.emitThreadSummaryEvent('thread.updated', thread);
  }

  private setThreadStatus(thread: Thread, status: Thread['status']): void {
    const now = new Date().toISOString();
    thread.status = status;
    thread.statusUpdatedAt = now;
    thread.updatedAt = now;
  }

  private appendThreadMessage(thread: Thread, message: ThreadMessage): void {
    thread.messages.push(message);
    thread.updatedAt = message.createdAt;

    const preview = message.content.trim();
    if (preview) {
      thread.lastMessagePreview = this.toPreview(preview);
    }

    this.threadCache.set(thread.id, thread);
  }

  private createMessage(role: ThreadMessage['role'], content: string): ThreadMessage {
    return {
      id: randomUUID(),
      role,
      content,
      createdAt: new Date().toISOString()
    };
  }

  private emitThreadSummaryEvent(
    type: 'thread.created' | 'thread.updated',
    thread: Thread
  ): void {
    this.emit({
      type,
      payload: this.toSummary(thread)
    });
  }

  private emitThreadMessage(threadId: string, message: ThreadMessage): void {
    this.emit({
      type: 'thread.message',
      payload: {
        threadId,
        message: structuredClone(message)
      }
    });
  }

  private emitThreadRunEvent(threadId: string, eventType: string, detail?: string): void {
    this.emit({
      type: 'thread.run.event',
      payload: {
        threadId,
        eventType,
        at: new Date().toISOString(),
        detail
      }
    });
  }

  private toSummary(thread: Thread): ThreadSummary {
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

  private emit(event: BridgeWsEvent): void {
    this.emitWsEvent?.(event);
  }

  private mapRawStatus(status: unknown, turns: RawTurn[] | undefined): Thread['status'] {
    const statusRecord = this.toRecord(status);
    const statusType = this.readString(statusRecord?.type);

    if (statusType === 'active') {
      return 'running';
    }

    if (statusType === 'systemError') {
      return 'error';
    }

    const lastTurn = Array.isArray(turns) && turns.length > 0 ? turns[turns.length - 1] : null;
    const lastTurnStatus = this.readString(lastTurn?.status);

    if (lastTurnStatus === 'inProgress') {
      return 'running';
    }

    if (lastTurnStatus === 'failed' || lastTurnStatus === 'interrupted') {
      return 'error';
    }

    if (lastTurnStatus === 'completed') {
      return 'complete';
    }

    if (statusType === 'idle' || statusType === 'notLoaded') {
      return Array.isArray(turns) && turns.length > 0 ? 'complete' : 'idle';
    }

    return 'idle';
  }

  private extractLastError(turns: RawTurn[]): string | null {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i];
      const turnStatus = this.readString(turn.status);
      if (turnStatus !== 'failed' && turnStatus !== 'interrupted') {
        continue;
      }

      const message = this.readString(turn.error?.message);
      if (message) {
        return message;
      }

      return `turn ${turnStatus}`;
    }

    return null;
  }

  private toRawThread(value: unknown): RawThread {
    const record = this.toRecord(value) ?? {};
    return {
      id: this.readString(record.id) ?? undefined,
      preview: this.readString(record.preview) ?? undefined,
      modelProvider: this.readString(record.modelProvider) ?? undefined,
      createdAt: this.readNumber(record.createdAt) ?? undefined,
      updatedAt: this.readNumber(record.updatedAt) ?? undefined,
      status: (record.status as RawThreadStatus) ?? undefined,
      cwd: this.readString(record.cwd) ?? undefined,
      source: this.toRecord(record.source) as { kind?: string } | undefined,
      turns: Array.isArray(record.turns)
        ? (record.turns.map((turn) => this.toRawTurn(turn)).filter(Boolean) as RawTurn[])
        : undefined
    };
  }

  private toRawTurn(value: unknown): RawTurn | null {
    const record = this.toRecord(value);
    if (!record) {
      return null;
    }

    const items = Array.isArray(record.items)
      ? (record.items
          .map((item) => this.toRecord(item))
          .filter((item): item is RawThreadItem => item !== null) as RawThreadItem[])
      : undefined;

    return {
      id: this.readString(record.id) ?? undefined,
      status: this.readString(record.status) ?? undefined,
      error: this.toRecord(record.error) as { message?: string } | null,
      items
    };
  }

  private unixSecondsToIso(value: number | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return new Date().toISOString();
    }

    return new Date(value * 1000).toISOString();
  }

  private toPreview(value: string): string {
    const collapsed = value.replace(/\s+/g, ' ').trim();
    if (collapsed.length <= 180) {
      return collapsed;
    }

    return `${collapsed.slice(0, 177)}...`;
  }

  private toRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : null;
  }

  private readString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
}
