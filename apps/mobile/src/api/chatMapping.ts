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
  name?: string;
  title?: string;
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
  const threadName =
    readString(record.name) ??
    readString(record.title) ??
    readString(record.threadName) ??
    readString(record.thread_name) ??
    undefined;
  return {
    id: readString(record.id) ?? undefined,
    name: threadName,
    title: threadName,
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
  const displayTitle = raw.name ?? raw.preview;

  return {
    id: raw.id,
    title: toPreview(displayTitle || `Chat ${raw.id.slice(0, 8)}`),
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
        continue;
      }

      const toolLikeMessage = toToolLikeMessage(itemRecord);
      if (toolLikeMessage) {
        messages.push({
          id: readString(itemRecord.id) ?? generateLocalId(),
          role: 'system',
          content: toolLikeMessage,
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

function toToolLikeMessage(item: Record<string, unknown>): string | null {
  const rawType = readString(item.type);
  if (!rawType) {
    return null;
  }

  const type = normalizeType(rawType);

  if (type === 'plan') {
    const text = normalizeMultiline(readString(item.text), 1800);
    return text || null;
  }

  if (type === 'commandexecution') {
    const command = normalizeInline(readString(item.command), 240) ?? 'command';
    const status = normalizeType(readString(item.status) ?? '');
    const output =
      normalizeMultiline(readString(item.aggregatedOutput), 2400) ??
      normalizeMultiline(readString(item.aggregated_output), 2400);
    const exitCode = readNumber(item.exitCode) ?? readNumber(item.exit_code);
    const title =
      status === 'failed' || status === 'error'
        ? `• Command failed \`${command}\``
        : `• Ran \`${command}\``;
    const outputPreview = output ? toNestedOutput(output, 8, 1600) : null;
    const detail = outputPreview ?? (exitCode !== null ? `exit code ${String(exitCode)}` : null);
    return withNestedDetail(title, detail);
  }

  if (type === 'mcptoolcall') {
    const server = normalizeInline(readString(item.server), 120);
    const tool = normalizeInline(readString(item.tool), 120);
    const label = [server, tool].filter(Boolean).join(' / ') || 'MCP tool call';
    const status = normalizeType(readString(item.status) ?? '');
    const errorRecord = toRecord(item.error);
    const errorDetail =
      normalizeInline(readString(errorRecord?.message), 240) ??
      normalizeInline(readString(item.error), 240);
    const resultDetail = toStructuredPreview(item.result, 240);
    const detail =
      status === 'failed' || status === 'error'
        ? errorDetail ?? resultDetail
        : resultDetail;
    const title =
      status === 'failed' || status === 'error'
        ? `• Tool failed \`${label}\``
        : `• Called tool \`${label}\``;
    return withNestedDetail(title, detail);
  }

  if (type === 'websearch') {
    const query = normalizeInline(readString(item.query), 180);
    const actionRecord = toRecord(item.action);
    const actionType = normalizeType(readString(actionRecord?.type) ?? '');
    let detail: string | null = query;

    if (actionType === 'openpage') {
      detail = normalizeInline(readString(actionRecord?.url), 240) ?? detail;
    } else if (actionType === 'findinpage') {
      const url = normalizeInline(readString(actionRecord?.url), 180);
      const pattern = normalizeInline(readString(actionRecord?.pattern), 120);
      detail = [url, pattern ? `pattern: ${pattern}` : null].filter(Boolean).join(' | ') || detail;
    }

    const title = query ? `• Searched web for "${query}"` : '• Searched web';
    return withNestedDetail(title, detail && detail !== query ? detail : null);
  }

  if (type === 'filechange') {
    const status = normalizeType(readString(item.status) ?? '');
    const changeCount = Array.isArray(item.changes) ? item.changes.length : 0;
    const detail =
      changeCount > 0
        ? `${String(changeCount)} file${changeCount === 1 ? '' : 's'} changed`
        : null;
    const title =
      status === 'failed' || status === 'error'
        ? '• File changes failed'
        : '• Applied file changes';
    return withNestedDetail(title, detail);
  }

  if (type === 'imageview') {
    const path = normalizeInline(readString(item.path), 220);
    if (!path) {
      return null;
    }
    return `• Viewed image\n  └ ${path}`;
  }

  if (type === 'enteredreviewmode') {
    return '• Entered review mode';
  }

  if (type === 'exitedreviewmode') {
    return '• Exited review mode';
  }

  if (type === 'contextcompaction') {
    return '• Compacted conversation context';
  }

  return null;
}

function normalizeType(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function normalizeInline(value: string | null, maxChars: number): string | null {
  if (!value) {
    return null;
  }

  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return null;
  }

  if (cleaned.length <= maxChars) {
    return cleaned;
  }

  return `${cleaned.slice(0, Math.max(1, maxChars - 1))}…`;
}

function normalizeMultiline(value: string | null, maxChars: number): string | null {
  if (!value) {
    return null;
  }

  const cleaned = value
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!cleaned) {
    return null;
  }

  if (cleaned.length <= maxChars) {
    return cleaned;
  }

  return `${cleaned.slice(0, Math.max(1, maxChars - 1))}…`;
}

function toNestedOutput(
  value: string,
  maxLines: number,
  maxChars: number
): string | null {
  const normalized = normalizeMultiline(value, maxChars);
  if (!normalized) {
    return null;
  }

  const lines = normalized
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }

  const limited = lines.slice(0, maxLines);
  return limited.join('\n');
}

function withNestedDetail(title: string, detail: string | null): string {
  if (!detail) {
    return title;
  }

  const lines = detail
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return title;
  }

  const first = `  └ ${lines[0]}`;
  if (lines.length === 1) {
    return `${title}\n${first}`;
  }

  const rest = lines.slice(1).map((line) => `    ${line}`);
  return [title, first, ...rest].join('\n');
}

function toStructuredPreview(value: unknown, maxChars: number): string | null {
  if (value == null) {
    return null;
  }

  if (typeof value === 'string') {
    return normalizeInline(value, maxChars);
  }

  try {
    const serialized = JSON.stringify(value);
    return normalizeInline(serialized, maxChars);
  } catch {
    return null;
  }
}
