import { randomUUID } from 'node:crypto';

import { CodexAppServerClient } from './codexAppServerClient';
import {
  toPreview,
  toRecord,
  readString,
  unixSecondsToIso,
  mapRawStatus,
  extractLastError,
  toRawThread
} from '../utils/threadMapping';
import type { RawThread } from '../utils/threadMapping';
import type {
  ApprovalDecision,
  BridgeWsEvent,
  CreateThreadInput,
  PendingApproval,
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
      },
      onApprovalRequested: (approval) => {
        this.emit({
          type: 'approval.requested',
          payload: approval
        });
        this.emitThreadRunEvent(
          approval.threadId,
          'approval.requested',
          `${approval.kind}${approval.command ? ` | ${approval.command}` : ''}`
        );
      }
    });
  }

  async listThreads(): Promise<ThreadSummary[]> {
    const response = await this.client.threadList({ cwd: null, limit: 200 });
    const listRaw = Array.isArray(response.data) ? response.data : [];

    const summaries = listRaw
      .map((item) => this.mapThreadSummary(toRawThread(item)))
      .filter((item): item is ThreadSummary => item !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return summaries;
  }

  async getThread(id: string): Promise<Thread | null> {
    return this.readAndCacheThread(id);
  }

  listPendingApprovals(): PendingApproval[] {
    return this.client.listPendingApprovals();
  }

  async resolveApproval(
    approvalId: string,
    decision: ApprovalDecision
  ): Promise<PendingApproval | null> {
    const resolved = await this.client.resolveApproval(approvalId, decision);
    if (!resolved) {
      return null;
    }

    this.emit({
      type: 'approval.resolved',
      payload: {
        id: resolved.id,
        decision,
        resolvedAt: new Date().toISOString(),
        threadId: resolved.threadId
      }
    });
    this.emitThreadRunEvent(resolved.threadId, 'approval.resolved', decision);
    return resolved;
  }

  async createThread(input: CreateThreadInput): Promise<Thread> {
    const started = await this.client.threadStart({
      cwd: this.workdir,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    });

    const raw = toRawThread(started.thread);
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
      const turn = toRecord(turnResponse.turn);
      const turnId = readString(turn?.id);
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
            readString(notification.params?.threadId) === threadId &&
            readString(notification.params?.turnId) === turnId
          ) {
            const delta = readString(notification.params?.delta);
            if (delta) {
              this.appendAssistantDelta(threadId, assistantMessageId, delta);
            }
            return;
          }

          if (
            notification.method === 'thread/status/changed' &&
            readString(notification.params?.threadId) === threadId
          ) {
            const status = mapRawStatus(notification.params?.status, undefined);
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
            readString(notification.params?.threadId) === threadId
          ) {
            const turn = toRecord(notification.params?.turn);
            const completedTurnId = readString(turn?.id);
            if (completedTurnId !== turnId) {
              return;
            }

            const turnStatus = readString(turn?.status);
            const turnError = toRecord(turn?.error);
            const turnErrorMessage = readString(turnError?.message);

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
            readString(notification.params?.threadId) === threadId
          ) {
            const item = toRecord(notification.params?.item);
            const itemType = readString(item?.type);
            if (itemType === 'commandExecution') {
              const command = readString(item?.command);
              const status = readString(item?.status);
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
    const raw = toRawThread(read.thread);
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

    const createdAt = unixSecondsToIso(raw.createdAt);
    const updatedAt = unixSecondsToIso(raw.updatedAt);
    const turns = Array.isArray(raw.turns) ? raw.turns : [];

    const title =
      this.titleOverrides.get(raw.id) ??
      toPreview(raw.preview || `Thread ${raw.id.slice(0, 8)}`);

    const lastError = extractLastError(turns);

    return {
      id: raw.id,
      title,
      status: mapRawStatus(raw.status, turns),
      createdAt,
      updatedAt,
      statusUpdatedAt: updatedAt,
      lastMessagePreview: toPreview(raw.preview || ''),
      cwd: readString(raw.cwd) ?? undefined,
      modelProvider: readString(raw.modelProvider) ?? undefined,
      sourceKind: readString(toRecord(raw.source)?.kind) ?? undefined,
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
        ? toPreview(messages[messages.length - 1].content)
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
        const itemRecord = toRecord(item);
        if (!itemRecord) {
          continue;
        }

        const itemType = readString(itemRecord.type);

        if (itemType === 'userMessage') {
          const contentItems = Array.isArray(itemRecord.content) ? itemRecord.content : [];
          const text = contentItems
            .map((entry: unknown) => {
              const entryRecord = toRecord(entry);
              if (!entryRecord) {
                return '';
              }

              const entryType = readString(entryRecord.type);
              if (entryType === 'text') {
                return readString(entryRecord.text) ?? '';
              }

              if (entryType === 'image') {
                return `[image: ${readString(entryRecord.url) ?? 'unknown'}]`;
              }

              if (entryType === 'localImage') {
                return `[local image: ${readString(entryRecord.path) ?? 'unknown'}]`;
              }

              return '';
            })
            .filter(Boolean)
            .join('\n');

          if (!text.trim()) {
            continue;
          }

          messages.push({
            id: readString(itemRecord.id) ?? randomUUID(),
            role: 'user',
            content: text,
            createdAt: new Date(baseTs + messages.length * 1000).toISOString()
          });
          continue;
        }

        if (itemType === 'agentMessage') {
          const text = readString(itemRecord.text) ?? '';
          if (!text.trim()) {
            continue;
          }

          messages.push({
            id: readString(itemRecord.id) ?? randomUUID(),
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
    thread.lastMessagePreview = toPreview(existing.content);

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
      thread.lastMessagePreview = toPreview(preview);
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
}
