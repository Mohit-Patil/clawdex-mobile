export type ThreadStatus = 'idle' | 'running' | 'error' | 'complete';

export interface ThreadSummary {
  id: string;
  title: string;
  preview: string;
  status: ThreadStatus;
  updatedAtMs: number;
  cwd: string | null;
}

export interface ThreadMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAtMs: number;
}

export interface ThreadDetail {
  summary: ThreadSummary;
  messages: ThreadMessage[];
}

interface RawTurn {
  id?: string;
  status?: string;
  items?: unknown[];
}

export function parseThreadSummaries(value: unknown): ThreadSummary[] {
  const list = Array.isArray(value) ? value : [];
  const summaries = list
    .map((entry) => parseThreadSummary(entry))
    .filter((entry): entry is ThreadSummary => entry !== null)
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);

  return summaries;
}

export function parseThreadDetail(value: unknown): ThreadDetail | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const summary = parseThreadSummary(record);
  if (!summary) {
    return null;
  }

  const turns = Array.isArray(record.turns)
    ? record.turns.map((turn) => parseTurn(turn)).filter((turn): turn is RawTurn => turn !== null)
    : [];
  const messages = mapTurnMessages(turns, summary.updatedAtMs);

  return {
    summary,
    messages,
  };
}

export function mergeStreamingDelta(previous: string | null, delta: string): string {
  if (!delta) {
    return previous ?? '';
  }

  const prev = previous ?? '';
  if (!prev) {
    return delta;
  }

  if (delta === prev || prev.endsWith(delta)) {
    return prev;
  }

  if (delta.startsWith(prev)) {
    return delta;
  }

  const maxOverlap = Math.min(prev.length, delta.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (prev.endsWith(delta.slice(0, overlap))) {
      return prev + delta.slice(overlap);
    }
  }

  return prev + delta;
}

function parseThreadSummary(value: unknown): ThreadSummary | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const id = readString(record.id);
  if (!id) {
    return null;
  }

  if (isSubAgentSource(record.source)) {
    return null;
  }

  const name =
    readString(record.name) ??
    readString(record.title) ??
    readString(record.preview) ??
    `Thread ${id.slice(0, 8)}`;

  const preview = readString(record.preview) ?? '';
  const status = mapThreadStatus(record.status, record.turns);

  return {
    id,
    title: truncate(name, 88),
    preview: truncate(preview, 160),
    status,
    updatedAtMs: toTimestampMs(record.updatedAt) ?? Date.now(),
    cwd: readString(record.cwd),
  };
}

function parseTurn(value: unknown): RawTurn | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  return {
    id: readString(record.id) ?? undefined,
    status: readString(record.status) ?? undefined,
    items: Array.isArray(record.items) ? record.items : [],
  };
}

function mapTurnMessages(turns: RawTurn[], baseTimestampMs: number): ThreadMessage[] {
  const messages: ThreadMessage[] = [];

  for (const turn of turns) {
    const items = Array.isArray(turn.items) ? turn.items : [];

    for (const item of items) {
      const itemRecord = asRecord(item);
      if (!itemRecord) {
        continue;
      }

      const type = readString(itemRecord.type);
      if (type === 'userMessage') {
        const content = readUserMessageContent(itemRecord);
        if (!content) {
          continue;
        }

        messages.push({
          id: readString(itemRecord.id) ?? createLocalMessageId(),
          role: 'user',
          content,
          createdAtMs: baseTimestampMs + messages.length,
        });
        continue;
      }

      if (type === 'agentMessage') {
        const text = readString(itemRecord.text);
        if (!text || text.trim().length === 0) {
          continue;
        }

        messages.push({
          id: readString(itemRecord.id) ?? createLocalMessageId(),
          role: 'assistant',
          content: text,
          createdAtMs: baseTimestampMs + messages.length,
        });
      }
    }
  }

  return messages;
}

function readUserMessageContent(item: Record<string, unknown>): string {
  const contentEntries = Array.isArray(item.content) ? item.content : [];
  const chunks: string[] = [];

  for (const entry of contentEntries) {
    const contentRecord = asRecord(entry);
    if (!contentRecord) {
      continue;
    }

    const type = readString(contentRecord.type);
    if (type === 'text') {
      const text = readString(contentRecord.text);
      if (text) {
        chunks.push(text);
      }
      continue;
    }

    if (type === 'mention') {
      const path = readString(contentRecord.path);
      if (path) {
        chunks.push(`[file: ${path}]`);
      }
      continue;
    }

    if (type === 'localImage') {
      const path = readString(contentRecord.path);
      if (path) {
        chunks.push(`[local image: ${path}]`);
      }
      continue;
    }

    if (type === 'image') {
      const url = readString(contentRecord.url);
      if (url) {
        chunks.push(`[image: ${url}]`);
      }
    }
  }

  return chunks.join('\n').trim();
}

function mapThreadStatus(rawStatus: unknown, rawTurns: unknown): ThreadStatus {
  const statusRecord = asRecord(rawStatus);
  const statusType = readString(statusRecord?.type) ?? readString(rawStatus);

  const turns = Array.isArray(rawTurns)
    ? rawTurns.map((turn) => asRecord(turn)).filter((turn): turn is Record<string, unknown> => turn !== null)
    : [];
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const turnStatus = readString(lastTurn?.status);

  if (turnStatus === 'inProgress') {
    return 'running';
  }

  if (turnStatus === 'failed' || turnStatus === 'interrupted') {
    return 'error';
  }

  if (turnStatus === 'completed') {
    return 'complete';
  }

  if (statusType === 'systemError') {
    return 'error';
  }

  if (statusType === 'active') {
    return 'running';
  }

  if (statusType === 'idle' || statusType === 'notLoaded') {
    return turns.length > 0 ? 'complete' : 'idle';
  }

  return 'idle';
}

function isSubAgentSource(source: unknown): boolean {
  if (typeof source === 'string') {
    return source.startsWith('subAgent');
  }

  const sourceRecord = asRecord(source);
  if (!sourceRecord) {
    return false;
  }

  if (Object.prototype.hasOwnProperty.call(sourceRecord, 'subAgent')) {
    return true;
  }

  const type = readString(sourceRecord.type) ?? readString(sourceRecord.kind);
  return typeof type === 'string' && type.startsWith('subAgent');
}

function toTimestampMs(value: unknown): number | null {
  const numeric = readNumber(value);
  if (numeric === null) {
    return null;
  }

  if (numeric > 1_000_000_000_000) {
    return numeric;
  }

  if (numeric > 1_000_000_000) {
    return numeric * 1000;
  }

  return null;
}

function truncate(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) {
    return compact;
  }

  return `${compact.slice(0, Math.max(1, max - 1))}…`;
}

function createLocalMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
