import type {
  Chat,
  ChatMessage,
  ChatStatus,
  ChatSummary,
} from './types';

export type RawThreadStatus =
  | { type?: string }
  | string
  | null
  | undefined;

export interface RawTurn {
  id?: string;
  status?: string;
  error?: {
    message?: string;
  } | null;
  items?: RawThreadItem[];
}

export type RawThreadItem =
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

export interface RawThread {
  id?: string;
  preview?: string;
  modelProvider?: string;
  createdAt?: number;
  updatedAt?: number;
  status?: RawThreadStatus;
  cwd?: string;
  source?: unknown;
  turns?: RawTurn[];
}

export function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function toPreview(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 180) {
    return collapsed;
  }

  return `${collapsed.slice(0, 177)}...`;
}

function unixSecondsToIso(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return new Date().toISOString();
  }

  return new Date(value * 1000).toISOString();
}

function mapRawStatus(status: unknown, turns: RawTurn[] | undefined): ChatStatus {
  const statusRecord = toRecord(status);
  const statusType = readString(statusRecord?.type) ?? readString(status);
  const hasTurns = Array.isArray(turns) && turns.length > 0;
  const lastTurn = hasTurns ? turns[turns.length - 1] : null;
  const lastTurnStatus = readString(lastTurn?.status);
  const isIdleLikeStatus = statusType === 'idle' || statusType === 'notLoaded';

  if (lastTurnStatus === 'inProgress') {
    // Some thread/read payloads can return stale turn state while the thread
    // itself is already idle/notLoaded. Prefer the thread lifecycle in that case.
    if (isIdleLikeStatus) {
      return hasTurns ? 'complete' : 'idle';
    }
    return 'running';
  }

  if (lastTurnStatus === 'failed' || lastTurnStatus === 'interrupted') {
    return 'error';
  }

  if (lastTurnStatus === 'completed') {
    return 'complete';
  }

  if (statusType === 'systemError') {
    return 'error';
  }

  if (statusType === 'active') {
    // Some backends keep a thread "active" while loaded in memory even when no
    // turn is running. If there is no in-progress turn, avoid false "working" UI.
    return hasTurns ? 'complete' : 'idle';
  }

  if (isIdleLikeStatus) {
    return hasTurns ? 'complete' : 'idle';
  }

  return 'idle';
}

function extractLastError(turns: RawTurn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    const turnStatus = readString(turn.status);
    if (turnStatus !== 'failed' && turnStatus !== 'interrupted') {
      continue;
    }

    const message = readString(turn.error?.message);
    if (message) {
      return message;
    }

    return `turn ${turnStatus}`;
  }

  return null;
}

export function toRawThread(value: unknown): RawThread {
  const record = toRecord(value) ?? {};
  return {
    id: readString(record.id) ?? undefined,
    preview: readString(record.preview) ?? undefined,
    modelProvider: readString(record.modelProvider) ?? undefined,
    createdAt: readNumber(record.createdAt) ?? undefined,
    updatedAt: readNumber(record.updatedAt) ?? undefined,
    status: (record.status as RawThreadStatus) ?? undefined,
    cwd: readString(record.cwd) ?? undefined,
    source: record.source,
    turns: Array.isArray(record.turns)
      ? (record.turns.map((turn) => toRawTurn(turn)).filter(Boolean) as RawTurn[])
      : undefined,
  };
}

function toRawTurn(value: unknown): RawTurn | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const items = Array.isArray(record.items)
    ? (record.items
        .map((item) => toRecord(item))
        .filter((item): item is RawThreadItem => item !== null) as RawThreadItem[])
    : undefined;

  return {
    id: readString(record.id) ?? undefined,
    status: readString(record.status) ?? undefined,
    error: toRecord(record.error) as { message?: string } | null,
    items,
  };
}

export function mapChatSummary(raw: RawThread): ChatSummary | null {
  if (!raw.id) {
    return null;
  }

  const createdAt = unixSecondsToIso(raw.createdAt);
  const updatedAt = unixSecondsToIso(raw.updatedAt);
  const turns = Array.isArray(raw.turns) ? raw.turns : [];

  const lastError = extractLastError(turns);

  return {
    id: raw.id,
    title: toPreview(raw.preview || `Chat ${raw.id.slice(0, 8)}`),
    status: mapRawStatus(raw.status, turns),
    createdAt,
    updatedAt,
    statusUpdatedAt: updatedAt,
    lastMessagePreview: toPreview(raw.preview || ''),
    cwd: readString(raw.cwd) ?? undefined,
    modelProvider: readString(raw.modelProvider) ?? undefined,
    sourceKind: mapSourceKind(raw.source),
    lastError: lastError ?? undefined,
  };
}

function mapSourceKind(source: unknown): string | undefined {
  if (typeof source === 'string') {
    return source;
  }

  const sourceRecord = toRecord(source);
  if (!sourceRecord) {
    return undefined;
  }

  // Legacy shape used by older adapters.
  const legacyKind = readString(sourceRecord.kind);
  if (legacyKind) {
    return legacyKind;
  }

  // Current app-server shape: { subAgent: ... } tagged union.
  if ('subAgent' in sourceRecord) {
    const subAgent = sourceRecord.subAgent;
    if (typeof subAgent === 'string') {
      if (subAgent === 'review') return 'subAgentReview';
      if (subAgent === 'compact') return 'subAgentCompact';
      if (subAgent === 'memory_consolidation') return 'subAgentOther';
      return 'subAgent';
    }

    const subAgentRecord = toRecord(subAgent);
    if (!subAgentRecord) {
      return 'subAgent';
    }

    if (toRecord(subAgentRecord.thread_spawn)) {
      return 'subAgentThreadSpawn';
    }

    if (readString(subAgentRecord.other)) {
      return 'subAgentOther';
    }

    return 'subAgent';
  }

  const typeKind = readString(sourceRecord.type);
  if (typeKind && typeKind.startsWith('subAgent')) {
    return typeKind;
  }

  return undefined;
}

export function mapChat(raw: RawThread): Chat {
  const summary = mapChatSummary(raw);
  if (!summary) {
    throw new Error('chat id missing in app-server response');
  }

  const messages = mapMessages(raw, summary.createdAt);

  const lastPreview =
    messages.length > 0
      ? toPreview(messages[messages.length - 1].content)
      : summary.lastMessagePreview;

  return {
    ...summary,
    lastMessagePreview: lastPreview,
    messages,
  };
}

function mapMessages(raw: RawThread, fallbackCreatedAt: string): ChatMessage[] {
  const turns = Array.isArray(raw.turns) ? raw.turns : [];
  if (turns.length === 0) {
    return [];
  }

  const baseTs = new Date(fallbackCreatedAt).getTime();
  const messages: ChatMessage[] = [];

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
          id: readString(itemRecord.id) ?? generateLocalId(),
          role: 'user',
          content: text,
          createdAt: new Date(baseTs + messages.length * 1000).toISOString(),
        });
        continue;
      }

      if (itemType === 'agentMessage') {
        const text = readString(itemRecord.text) ?? '';
        if (!text.trim()) {
          continue;
        }

        messages.push({
          id: readString(itemRecord.id) ?? generateLocalId(),
          role: 'assistant',
          content: text,
          createdAt: new Date(baseTs + messages.length * 1000).toISOString(),
        });
      }
    }
  }

  return messages;
}

function generateLocalId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
