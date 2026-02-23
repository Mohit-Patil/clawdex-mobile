import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Logger } from './logger';
import type { PersistentState } from './types';

const DEFAULT_STATE: PersistentState = {
  version: 1,
  chats: {},
};

export class StateStore {
  private state: PersistentState = DEFAULT_STATE;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistentState>;
      if (!parsed || parsed.version !== 1 || typeof parsed.chats !== 'object' || !parsed.chats) {
        this.logger.warn('State file had invalid shape. Starting with empty state.');
        this.state = DEFAULT_STATE;
        await this.persist();
        return;
      }

      this.state = {
        version: 1,
        chats: sanitizeChats(parsed.chats),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.state = DEFAULT_STATE;
        await this.persist();
        return;
      }

      throw error;
    }
  }

  getThreadId(chatId: string): string | null {
    const entry = this.state.chats[chatId];
    if (!entry?.threadId) {
      return null;
    }

    return entry.threadId;
  }

  listChatIds(): string[] {
    return Object.keys(this.state.chats);
  }

  findChatIdByThreadId(threadId: string): string | null {
    for (const [chatId, entry] of Object.entries(this.state.chats)) {
      if (entry.threadId === threadId) {
        return chatId;
      }
    }

    return null;
  }

  async setThreadId(chatId: string, threadId: string): Promise<void> {
    this.state.chats[chatId] = {
      threadId,
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
  }

  async clearChat(chatId: string): Promise<void> {
    if (!this.state.chats[chatId]) {
      return;
    }

    delete this.state.chats[chatId];
    await this.persist();
  }

  private async persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const targetDir = dirname(this.filePath);
      await mkdir(targetDir, { recursive: true });

      const tmpPath = `${this.filePath}.tmp`;
      const payload = JSON.stringify(this.state, null, 2);
      await writeFile(tmpPath, payload, 'utf8');
      await rename(tmpPath, this.filePath);
    });

    return this.writeQueue;
  }
}

function sanitizeChats(
  raw: Record<string, unknown>
): Record<string, { threadId: string; updatedAt: string }> {
  const chats: Record<string, { threadId: string; updatedAt: string }> = {};

  for (const [chatId, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') {
      continue;
    }

    const record = value as Record<string, unknown>;
    const threadId = typeof record.threadId === 'string' ? record.threadId.trim() : '';
    const updatedAt =
      typeof record.updatedAt === 'string' && record.updatedAt.trim().length > 0
        ? record.updatedAt
        : new Date().toISOString();

    if (!threadId) {
      continue;
    }

    chats[chatId] = {
      threadId,
      updatedAt,
    };
  }

  return chats;
}
