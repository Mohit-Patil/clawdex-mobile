import type {
  Chat,
  ChatEngine,
  ChatMessage,
  ChatMessageSubAgentMeta,
  ChatPlanSnapshot,
  ChatStatus,
  ChatSummary,
  TurnPlanStep,
} from './types';

export type RawThreadStatus =
  | { type?: string }
  | string
  | null
  | undefined;

export interface RawTurn {
  id?: string;
  status?: string;
  error?: unknown;
  message?: unknown;
  errorMessage?: unknown;
  error_message?: unknown;
  detail?: unknown;
  details?: unknown;
  reason?: unknown;
  description?: unknown;
  stderr?: unknown;
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
      content?: Array<{ type?: string; text?: string; path?: string; url?: string }>;
    }
  | {
      type?: string;
      id?: string;
      text?: string;
    };

export interface RawThread {
  id?: string;
  engine?: string;
  name?: string;
  title?: string;
  preview?: string;
  modelProvider?: string;
  agentNickname?: string;
  agentRole?: string;
  createdAt?: number;
  updatedAt?: number;
  status?: RawThreadStatus;
  cwd?: string;
  source?: unknown;
  turns?: RawTurn[];
}

interface ThreadSourceMetadata {
  kind?: string;
  parentThreadId?: string;
  subAgentDepth?: number;
}

export function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => readString(entry)?.trim() ?? '')
    .filter((entry): entry is string => entry.length > 0);
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const numeric = Number(value.trim());
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return null;
}

function readFileChangePaths(item: Record<string, unknown>): string[] {
  const rawChanges = Array.isArray(item.changes) ? item.changes : [];
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const change of rawChanges) {
    const path =
      readString(change)?.trim() ??
      readString(toRecord(change)?.path)?.trim() ??
      readString(toRecord(change)?.filePath)?.trim() ??
      readString(toRecord(change)?.file_path)?.trim();
    if (!path) {
      continue;
    }
    const normalized = path.replace(/\\/g, '/');
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    paths.push(normalized);
  }

  return paths;
}

export function toPreview(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 180) {
    return collapsed;
  }

  return `${collapsed.slice(0, 177)}...`;
}

function unixSecondsToIso(value: number): string {
  return new Date(value * 1000).toISOString();
}

function normalizeLifecycleStatus(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized.length > 0 ? normalized : null;
}

function readErrorMessage(value: unknown, depth = 0): string | null {
  if (depth > 3) {
    return null;
  }

  const direct = readString(value)?.trim();
  if (direct) {
    return direct;
  }

  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const fields = [
    record.message,
    record.errorMessage,
    record.error_message,
    record.detail,
    record.details,
    record.reason,
    record.description,
    record.stderr,
    record.error,
  ];

  for (const field of fields) {
    const message = readErrorMessage(field, depth + 1);
    if (message) {
      return message;
    }
  }

  return null;
}

function mapRawStatus(status: unknown, turns: RawTurn[] | undefined): ChatStatus {
  const statusRecord = toRecord(status);
  const statusType = normalizeLifecycleStatus(
    readString(statusRecord?.type) ?? readString(status)
  );
  const hasTurns = Array.isArray(turns) && turns.length > 0;
  const lastTurn = hasTurns ? turns[turns.length - 1] : null;
  const lastTurnStatus = normalizeLifecycleStatus(readString(lastTurn?.status));
  const isIdleLikeStatus = statusType === 'idle' || statusType === 'notloaded';

  if (
    lastTurnStatus === 'inprogress' ||
    lastTurnStatus === 'running' ||
    lastTurnStatus === 'active' ||
    lastTurnStatus === 'queued' ||
    lastTurnStatus === 'pending'
  ) {
    // Some thread/read payloads can return stale turn state while the thread
    // itself is already idle/notLoaded. Prefer the thread lifecycle in that case.
    if (isIdleLikeStatus) {
      return hasTurns ? 'complete' : 'idle';
    }
    return 'running';
  }

  if (
    lastTurnStatus === 'failed' ||
    lastTurnStatus === 'interrupted' ||
    lastTurnStatus === 'error' ||
    lastTurnStatus === 'aborted' ||
    lastTurnStatus === 'cancelled' ||
    lastTurnStatus === 'canceled'
  ) {
    return 'error';
  }

  if (
    lastTurnStatus === 'completed' ||
    lastTurnStatus === 'complete' ||
    lastTurnStatus === 'success' ||
    lastTurnStatus === 'succeeded'
  ) {
    return 'complete';
  }

  if (
    statusType === 'systemerror' ||
    statusType === 'error' ||
    statusType === 'failed'
  ) {
    return 'error';
  }

  if (
    statusType === 'running' ||
    statusType === 'inprogress' ||
    statusType === 'queued' ||
    statusType === 'pending'
  ) {
    return 'running';
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
    const turnStatus = normalizeLifecycleStatus(readString(turn.status));
    if (
      turnStatus !== 'failed' &&
      turnStatus !== 'interrupted' &&
      turnStatus !== 'error' &&
      turnStatus !== 'aborted' &&
      turnStatus !== 'cancelled' &&
      turnStatus !== 'canceled'
    ) {
      continue;
    }

    const message =
      readErrorMessage(turn.error) ??
      readErrorMessage(turn.message) ??
      readErrorMessage(turn.errorMessage) ??
      readErrorMessage(turn.error_message) ??
      readErrorMessage(turn.detail) ??
      readErrorMessage(turn.details) ??
      readErrorMessage(turn.reason) ??
      readErrorMessage(turn.description) ??
      readErrorMessage(turn.stderr);
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
    engine: readString(record.engine) ?? undefined,
    name: threadName,
    title: threadName,
    preview: readString(record.preview) ?? undefined,
    modelProvider: readString(record.modelProvider) ?? undefined,
    agentNickname:
      readString(record.agentNickname) ??
      readString(record.agent_nickname) ??
      undefined,
    agentRole:
      readString(record.agentRole) ??
      readString(record.agent_role) ??
      undefined,
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
    error: record.error,
    message: record.message,
    errorMessage: record.errorMessage,
    error_message: record.error_message,
    detail: record.detail,
    details: record.details,
    reason: record.reason,
    description: record.description,
    stderr: record.stderr,
    items,
  };
}

export function mapChatSummary(raw: RawThread): ChatSummary | null {
  if (!raw.id) {
    return null;
  }

  const createdAtSeconds = raw.createdAt ?? raw.updatedAt ?? 0;
  const updatedAtSeconds = raw.updatedAt ?? raw.createdAt ?? createdAtSeconds;
  const createdAt = unixSecondsToIso(createdAtSeconds);
  const updatedAt = unixSecondsToIso(updatedAtSeconds);
  const turns = Array.isArray(raw.turns) ? raw.turns : [];
  const sourceMetadata = readThreadSourceMetadata(raw.source);

  const lastError = extractLastError(turns);
  const previewTitle = toPreview(raw.preview || '');
  const firstUserTitle = firstUserMessagePreview(turns);
  const rawTitle = raw.name?.trim() || null;
  const displayTitle =
    rawTitle && !isGeneratedCursorThreadTitle(rawTitle, raw.id, raw.engine)
      ? rawTitle
      : previewTitle || firstUserTitle || rawTitle;

  return {
    id: raw.id,
    title: toPreview(displayTitle || `Chat ${raw.id.slice(0, 8)}`),
    status: mapRawStatus(raw.status, turns),
    createdAt,
    updatedAt,
    statusUpdatedAt: updatedAt,
    lastMessagePreview: toPreview(raw.preview || ''),
    cwd: readString(raw.cwd) ?? undefined,
    engine: readChatEngine(raw.engine),
    modelProvider: readString(raw.modelProvider) ?? undefined,
    agentNickname: readString(raw.agentNickname) ?? undefined,
    agentRole: readString(raw.agentRole) ?? undefined,
    sourceKind: sourceMetadata.kind,
    parentThreadId: sourceMetadata.parentThreadId,
    subAgentDepth: sourceMetadata.subAgentDepth,
    lastError: lastError ?? undefined,
  };
}

export function isGeneratedCursorThreadTitle(
  title: string | null | undefined,
  threadId: string | null | undefined,
  engine?: unknown
): boolean {
  const value = title?.trim().toLowerCase();
  if (!value) {
    return true;
  }

  const normalizedThreadId = threadId?.trim().toLowerCase() ?? '';
  const isCursorThread =
    readChatEngine(engine) === 'cursor' ||
    normalizedThreadId.startsWith('cursor:') ||
    value.startsWith('chat cursor:') ||
    value.startsWith('cursor agent');
  if (!isCursorThread) {
    return false;
  }

  if (
    value === 'new agent' ||
    value === 'cursor agent' ||
    value === 'untitled' ||
    value === 'untitled agent'
  ) {
    return true;
  }

  const unqualifiedThreadId = normalizedThreadId.replace(/^cursor:/u, '');
  const threadPrefix = unqualifiedThreadId.slice(0, 8);
  return (
    (Boolean(threadPrefix) && value === `cursor ${threadPrefix}`) ||
    value === `cursor ${normalizedThreadId}` ||
    value === `cursor ${unqualifiedThreadId}` ||
    value === `chat ${normalizedThreadId}` ||
    value === `chat cursor:${unqualifiedThreadId}` ||
    /^chat\s+cursor:[a-z0-9_-]+$/u.test(value) ||
    /^cursor\s+agent[-\s][0-9a-f]{2,}/u.test(value)
  );
}

function firstUserMessagePreview(turns: RawTurn[]): string | null {
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      if (item.type !== 'userMessage') {
        continue;
      }
      const text = readThreadItemText(item);
      const preview = toPreview(text);
      if (preview) {
        return preview;
      }
    }
  }

  return null;
}

function readThreadItemText(item: RawThreadItem): string {
  const record = toRecord(item);
  const text = readString(record?.text);
  if (text) {
    return text;
  }

  const content = Array.isArray(record?.content) ? record.content : [];
  if (content.length === 0) {
    return '';
  }

  return content
    .map((entry) => {
      const contentEntry = toRecord(entry);
      return readString(contentEntry?.type) === 'text'
        ? readString(contentEntry?.text) ?? ''
        : '';
    })
    .filter((entry) => entry.length > 0)
    .join('');
}

function readChatEngine(value: unknown): ChatEngine {
  const normalized = normalizeLifecycleStatus(readString(value));
  if (normalized === 'opencode' || normalized === 'cursor') {
    return normalized;
  }
  return 'codex';
}

function readThreadSourceMetadata(source: unknown): ThreadSourceMetadata {
  if (typeof source === 'string') {
    return {
      kind: source,
    };
  }

  const sourceRecord = toRecord(source);
  if (!sourceRecord) {
    return {};
  }

  // Legacy shape used by older adapters.
  const legacyKind = readString(sourceRecord.kind);
  if (legacyKind) {
    return {
      kind: legacyKind,
      parentThreadId:
        readString(sourceRecord.parentThreadId) ??
        readString(sourceRecord.parent_thread_id) ??
        undefined,
      subAgentDepth:
        readNumber(sourceRecord.depth) ??
        readNumber(sourceRecord.agentDepth) ??
        readNumber(sourceRecord.agent_depth) ??
        undefined,
    };
  }

  // Current app-server shape: { subAgent: ... } tagged union.
  const subAgentValue =
    sourceRecord.subAgent ??
    sourceRecord.subagent;

  if (subAgentValue !== undefined) {
    const subAgent = subAgentValue;
    if (typeof subAgent === 'string') {
      const kind =
        subAgent === 'review'
          ? 'subAgentReview'
          : subAgent === 'compact'
            ? 'subAgentCompact'
            : subAgent === 'memory_consolidation'
              ? 'subAgentOther'
              : 'subAgent';
      return {
        kind,
      };
    }

    const subAgentRecord = toRecord(subAgent);
    if (!subAgentRecord) {
      return {
        kind: 'subAgent',
      };
    }

    const threadSpawn = toRecord(subAgentRecord.thread_spawn);
    if (threadSpawn) {
      return {
        kind: 'subAgentThreadSpawn',
        parentThreadId:
          readString(threadSpawn.parentThreadId) ??
          readString(threadSpawn.parent_thread_id) ??
          undefined,
        subAgentDepth:
          readNumber(threadSpawn.depth) ??
          readNumber(threadSpawn.agentDepth) ??
          readNumber(threadSpawn.agent_depth) ??
          undefined,
      };
    }

    if (readString(subAgentRecord.other)) {
      return {
        kind: 'subAgentOther',
      };
    }

    return {
      kind: 'subAgent',
      parentThreadId:
        readString(subAgentRecord.parentThreadId) ??
        readString(subAgentRecord.parent_thread_id) ??
        undefined,
      subAgentDepth:
        readNumber(subAgentRecord.depth) ??
        readNumber(subAgentRecord.agentDepth) ??
        readNumber(subAgentRecord.agent_depth) ??
        undefined,
    };
  }

  const typeKind = readString(sourceRecord.type);
  if (typeKind && typeKind.startsWith('subAgent')) {
    return {
      kind: typeKind,
      parentThreadId:
        readString(sourceRecord.parentThreadId) ??
        readString(sourceRecord.parent_thread_id) ??
        undefined,
      subAgentDepth:
        readNumber(sourceRecord.depth) ??
        readNumber(sourceRecord.agentDepth) ??
        readNumber(sourceRecord.agent_depth) ??
        undefined,
    };
  }

  return {};
}

export function mapChat(raw: RawThread): Chat {
  const summary = mapChatSummary(raw);
  if (!summary) {
    throw new Error('chat id missing in app-server response');
  }

  const messages = mapMessages(raw, summary.createdAt);
  const plans = extractChatPlans(raw);

  const lastPreview =
    messages.length > 0
      ? toPreview(messages[messages.length - 1].content)
      : summary.lastMessagePreview;

  return {
    ...summary,
    lastMessagePreview: lastPreview,
    messages,
    latestPlan: plans.latestPlan,
    latestTurnPlan: plans.latestTurnPlan,
    latestTurnStatus: plans.latestTurnStatus,
    activeTurnId: plans.activeTurnId,
  };
}

function extractChatPlans(raw: RawThread): {
  latestPlan: ChatPlanSnapshot | null;
  latestTurnPlan: ChatPlanSnapshot | null;
  latestTurnStatus: string | null;
  activeTurnId: string | null;
} {
  const threadId = raw.id?.trim();
  const turns = Array.isArray(raw.turns) ? raw.turns : [];
  const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const latestTurnStatus = readString(latestTurn?.status);
  const activeTurnId = extractActiveTurnId(turns);

  if (!threadId || turns.length === 0) {
    return {
      latestPlan: null,
      latestTurnPlan: null,
      latestTurnStatus,
      activeTurnId,
    };
  }

  let latestPlan: ChatPlanSnapshot | null = null;
  let latestTurnPlan: ChatPlanSnapshot | null = null;

  for (const turn of turns) {
    const turnId = readString(turn.id);
    const items = Array.isArray(turn.items) ? turn.items : [];
    let latestPlanInTurn: ChatPlanSnapshot | null = null;

    for (const item of items) {
      const itemRecord = toRecord(item);
      if (!itemRecord) {
        continue;
      }

      const itemType = normalizeType(readString(itemRecord.type) ?? '');
      if (itemType !== 'plan') {
        continue;
      }

      const plan = toPlanSnapshot(itemRecord, threadId, turnId);
      if (!plan) {
        continue;
      }

      latestPlan = plan;
      latestPlanInTurn = plan;
    }

    if (turn === latestTurn) {
      latestTurnPlan = latestPlanInTurn;
    }
  }

  return {
    latestPlan,
    latestTurnPlan,
    latestTurnStatus,
    activeTurnId,
  };
}

function extractActiveTurnId(turns: RawTurn[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const turnId = readString(turn.id)?.trim();
    const turnStatus = normalizeLifecycleStatus(readString(turn.status));
    if (
      turnId &&
      (turnStatus === 'inprogress' ||
        turnStatus === 'running' ||
        turnStatus === 'active' ||
        turnStatus === 'queued' ||
        turnStatus === 'pending')
    ) {
      return turnId;
    }
  }

  return null;
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
      const normalizedItemType = normalizeType(itemType ?? '');

      if (normalizedItemType === 'usermessage') {
        const text = stringifyStructuredMessageContent(itemRecord);

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

      if (normalizedItemType === 'agentmessage') {
        const text =
          stringifyStructuredMessageContent(itemRecord) || readString(itemRecord.text) || '';
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
        const systemKind =
          normalizedItemType === 'collabtoolcall'
            ? 'subAgent'
            : normalizedItemType === 'reasoning'
              ? 'reasoning'
              : normalizedItemType === 'contextcompaction'
                ? 'compaction'
              : 'tool';
        messages.push({
          id: readString(itemRecord.id) ?? generateLocalId(),
          role: 'system',
          content: toolLikeMessage,
          systemKind,
          subAgentMeta: systemKind === 'subAgent' ? toSubAgentMeta(itemRecord) : undefined,
          createdAt: new Date(baseTs + messages.length * 1000).toISOString(),
        });
      }
    }
  }

  return messages;
}

function stringifyStructuredMessageContent(itemRecord: Record<string, unknown>): string {
  const contentItems = Array.isArray(itemRecord.content) ? itemRecord.content : [];
  if (contentItems.length === 0) {
    return '';
  }

  return stringifyStructuredContentEntries(contentItems);
}

function generateLocalId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function toPlanSnapshot(
  item: Record<string, unknown>,
  threadId: string,
  fallbackTurnId?: string | null
): ChatPlanSnapshot | null {
  const turnId =
    readString(item.turnId) ??
    readString(item.turn_id) ??
    fallbackTurnId ??
    readString(item.id);
  if (!turnId) {
    return null;
  }

  const rawSteps = Array.isArray(item.plan)
    ? item.plan
    : Array.isArray(item.steps)
      ? item.steps
      : [];
  const steps: TurnPlanStep[] = rawSteps
    .map((entry) => {
      const entryRecord = toRecord(entry);
      if (!entryRecord) {
        return null;
      }

      const step = readString(entryRecord.step);
      const status = normalizePlanStepStatus(readString(entryRecord.status));
      if (!step || !status) {
        return null;
      }

      return {
        step,
        status,
      } satisfies TurnPlanStep;
    })
    .filter((entry): entry is TurnPlanStep => entry !== null);
  const explanation = readString(item.explanation);

  if (steps.length === 0 && !explanation?.trim()) {
    return parsePlanTextSnapshot(readString(item.text), threadId, turnId);
  }

  return {
    threadId,
    turnId,
    explanation,
    steps,
  };
}

function parsePlanTextSnapshot(
  text: string | null | undefined,
  threadId: string,
  turnId: string
): ChatPlanSnapshot | null {
  const trimmed = text?.trim();
  if (!trimmed) {
    return null;
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  const hasSummaryHeader = lines.some((line) => /^summary$/i.test(line));
  const steps: TurnPlanStep[] = [];
  for (const line of lines) {
    const match = line.match(/^\d+[.)]\s+(.+)$/);
    if (!match?.[1]) {
      continue;
    }

    steps.push({
      step: match[1].trim(),
      status: 'pending',
    });
  }

  if (!hasSummaryHeader && steps.length === 0) {
    return null;
  }

  let startIndex = 0;
  if (lines.length > 1 && /plan$/i.test(lines[0])) {
    startIndex = 1;
  }
  if (lines[startIndex] && /^summary$/i.test(lines[startIndex])) {
    startIndex += 1;
  }

  const explanationLines: string[] = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\d+[.)]\s+/.test(line)) {
      break;
    }
    if (/^(summary|implementation plan|proposed plan)$/i.test(line)) {
      continue;
    }
    explanationLines.push(line);
  }

  const explanation =
    explanationLines.length > 0 ? explanationLines.join(' ').trim() : null;

  if (steps.length === 0 && !explanation) {
    return null;
  }

  return {
    threadId,
    turnId,
    explanation,
    steps,
  };
}

function normalizePlanStepStatus(value: string | null | undefined): TurnPlanStep['status'] | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/[^a-z]/g, '');
  if (normalized === 'pending') {
    return 'pending';
  }
  if (normalized === 'inprogress') {
    return 'inProgress';
  }
  if (normalized === 'completed' || normalized === 'complete') {
    return 'completed';
  }
  return null;
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

  if (type === 'reasoning') {
    const text = normalizeMultiline(reasoningTextFromItem(item), 2400);
    return withNestedDetail('• Reasoning', text);
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

  if (type === 'toolcall') {
    const tool = normalizeInline(readString(item.tool) ?? readString(item.name), 120) ?? 'unknown';
    const status = normalizeType(readString(item.status) ?? '');
    const title =
      status === 'failed' || status === 'error'
        ? `• Tool failed \`${tool}\``
        : status === 'running' || status === 'inprogress'
          ? `• Calling tool \`${tool}\``
          : `• Called tool \`${tool}\``;
    const argsDetail = toCursorToolArgsPreview(item);
    const resultDetail = toCursorToolResultPreview(item.result);
    const detail = [argsDetail ? `Input: ${argsDetail}` : null, resultDetail]
      .filter(Boolean)
      .join('\n');
    return withNestedDetail(title, detail || null);
  }

  if (type === 'functioncall' || type === 'customtoolcall') {
    return toFunctionToolLikeMessage(item);
  }

  if (type === 'functioncalloutput' || type === 'customtoolcalloutput') {
    const output =
      normalizeMultiline(readString(item.output), 2400) ??
      toStructuredPreview(item.output, 1200);
    if (!output) {
      return null;
    }
    const callId = normalizeInline(readString(item.call_id) ?? readString(item.callId), 120);
    const title = callId ? `• Tool output \`${callId}\`` : '• Tool output';
    return withNestedDetail(title, toNestedOutput(output, 8, 1600));
  }

  if (type === 'collabtoolcall') {
    const tool = normalizeType(readString(item.tool) ?? '');
    const status = normalizeType(readString(item.status) ?? '');
    const prompt = normalizeInline(readString(item.prompt), 220);
    const receiverThreadIds = readReceiverThreadIds(item);
    const primaryReceiverThreadId = normalizeInline(receiverThreadIds[0], 120);
    const newThreadId = normalizeInline(
      readString(item.newThreadId) ??
        readString(item.new_thread_id) ??
        primaryReceiverThreadId,
      120
    );
    const senderThreadId = normalizeInline(
      readString(item.senderThreadId) ?? readString(item.sender_thread_id),
      120
    );
    const agentStatus = normalizeInline(
      readString(item.agentStatus) ?? readString(item.agent_status),
      120
    );

    const title = (() => {
      if (tool === 'spawnagent') {
        if (status === 'failed' || status === 'error') {
          return '• Sub-agent spawn failed';
        }
        if (status === 'completed' || status === 'complete' || status === 'succeeded') {
          return '• Spawned sub-agent';
        }
        return '• Spawning sub-agent';
      }

      if (tool === 'sendinput') {
        return status === 'failed' || status === 'error'
          ? '• Sub-agent update failed'
          : '• Sent follow-up to sub-agent';
      }

      if (tool === 'wait') {
        return status === 'failed' || status === 'error'
          ? '• Waiting on sub-agent failed'
          : '• Waiting on sub-agent';
      }

      if (tool === 'closeagent') {
        return status === 'failed' || status === 'error'
          ? '• Closing sub-agent failed'
          : '• Closed sub-agent thread';
      }

      return status === 'failed' || status === 'error'
        ? '• Sub-agent action failed'
        : '• Updated sub-agent thread';
    })();

    const detailParts = [
      prompt ? `Prompt: ${prompt}` : null,
      newThreadId ? `Thread: ${newThreadId}` : null,
      primaryReceiverThreadId ? `Target: ${primaryReceiverThreadId}` : null,
      senderThreadId ? `From: ${senderThreadId}` : null,
      agentStatus ? `Status: ${agentStatus}` : null,
    ].filter(Boolean);

    return withNestedDetail(title, detailParts.join('\n') || null);
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
    const changedPaths = readFileChangePaths(item);
    const changeCount = changedPaths.length;
    const detail = changeCount > 0 ? changedPaths.join('\n') : null;
    const titleSuffix =
      changeCount === 0
        ? ''
        : changeCount === 1
          ? ` to ${toFileChangeTargetLabel(changedPaths[0])}`
          : ` to ${toFileChangeTargetLabel(changedPaths[0])} +${String(changeCount - 1)} more`;
    const title =
      status === 'failed' || status === 'error'
        ? `• File changes failed${titleSuffix}`
        : `• Applied file changes${titleSuffix}`;
    return withNestedDetail(title, detail);
  }

  if (type === 'imageview') {
    const path = normalizeInline(readString(item.path), 220);
    if (!path) {
      return null;
    }
    return withNestedDetail(`• Viewed image ${toFileChangeTargetLabel(path)}`, path);
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

function toFunctionToolLikeMessage(item: Record<string, unknown>): string | null {
  const rawName =
    readString(item.name) ??
    readString(item.tool) ??
    readString(item.function) ??
    readString(item.function_name);
  const toolName = normalizeInline(rawName, 160) ?? 'tool';
  const normalizedToolName = toolName.replace(/^functions\./, '');
  const status = normalizeType(readString(item.status) ?? '');
  const args = readFunctionToolArguments(item);
  const inputPreview = args ? toStructuredPreview(args, 900) : readFunctionToolInput(item);

  if (normalizedToolName === 'exec_command') {
    const command = readFunctionCommand(args) ?? normalizeInline(readFunctionToolInput(item), 240);
    const title =
      status === 'failed' || status === 'error'
        ? `• Command failed \`${command ?? 'command'}\``
        : status === 'running' || status === 'inprogress'
          ? `• Running command \`${command ?? 'command'}\``
          : `• Ran \`${command ?? 'command'}\``;
    const workdir = normalizeInline(readString(args?.workdir), 220);
    return withNestedDetail(title, workdir ? `cwd: ${workdir}` : null);
  }

  const mcpToolName = parseMcpFunctionToolName(normalizedToolName);
  if (mcpToolName) {
    const title =
      status === 'failed' || status === 'error'
        ? `• Tool failed \`${mcpToolName.server} / ${mcpToolName.tool}\``
        : status === 'running' || status === 'inprogress'
          ? `• Calling tool \`${mcpToolName.server} / ${mcpToolName.tool}\``
          : `• Called tool \`${mcpToolName.server} / ${mcpToolName.tool}\``;
    return withNestedDetail(title, inputPreview ? `Input: ${inputPreview}` : null);
  }

  if (normalizedToolName === 'search_query' || normalizedToolName === 'image_query') {
    const query = normalizeInline(readFunctionSearchQuery(args), 180);
    const title = query ? `• Searched web for "${query}"` : '• Searched web';
    return withNestedDetail(title, null);
  }

  if (normalizedToolName === 'apply_patch') {
    const patchInput = readFunctionToolInput(item);
    const changedPaths = patchInput ? readPatchTargetPaths(patchInput) : [];
    const detail = changedPaths.length > 0 ? changedPaths.join('\n') : null;
    const title =
      changedPaths.length === 0
        ? '• Applied file changes'
        : changedPaths.length === 1
          ? `• Applied file changes to ${toFileChangeTargetLabel(changedPaths[0])}`
          : `• Applied file changes to ${toFileChangeTargetLabel(changedPaths[0])} +${String(changedPaths.length - 1)} more`;
    return withNestedDetail(title, detail);
  }

  const title =
    status === 'failed' || status === 'error'
      ? `• Tool failed \`${normalizedToolName}\``
      : status === 'running' || status === 'inprogress'
        ? `• Calling tool \`${normalizedToolName}\``
        : `• Called tool \`${normalizedToolName}\``;
  return withNestedDetail(title, inputPreview ? `Input: ${inputPreview}` : null);
}

function readFunctionToolArguments(item: Record<string, unknown>): Record<string, unknown> | null {
  return (
    toRecord(item.arguments) ??
    toRecord(item.args) ??
    parseJsonObject(readString(item.arguments)) ??
    parseJsonObject(readString(item.args))
  );
}

function readFunctionToolInput(item: Record<string, unknown>): string | null {
  return (
    normalizeMultiline(readString(item.input), 1800) ??
    normalizeMultiline(readString(item.arguments), 1800) ??
    normalizeMultiline(readString(item.args), 1800)
  );
}

function readFunctionCommand(args: Record<string, unknown> | null): string | null {
  if (!args) {
    return null;
  }

  const direct =
    normalizeInline(readString(args.cmd), 240) ??
    normalizeInline(readString(args.command), 240);
  if (direct) {
    return direct;
  }

  const commandParts = readStringArray(args.cmd).concat(readStringArray(args.command));
  return commandParts.length > 0 ? normalizeInline(commandParts.join(' '), 240) : null;
}

function parseMcpFunctionToolName(name: string): { server: string; tool: string } | null {
  const segments = name.split('__').filter(Boolean);
  if (segments.length < 3 || segments[0] !== 'mcp') {
    return null;
  }

  const [, server, ...toolParts] = segments;
  const tool = toolParts.join('__');
  if (!server || !tool) {
    return null;
  }

  return { server, tool };
}

function readFunctionSearchQuery(args: Record<string, unknown> | null): string | null {
  if (!args) {
    return null;
  }

  const direct = readString(args.q) ?? readString(args.query);
  if (direct) {
    return direct;
  }

  const searchQueries = Array.isArray(args.search_query)
    ? args.search_query
    : Array.isArray(args.image_query)
      ? args.image_query
      : [];
  for (const entry of searchQueries) {
    const query = readString(toRecord(entry)?.q) ?? readString(toRecord(entry)?.query);
    if (query) {
      return query;
    }
  }

  return null;
}

function readPatchTargetPaths(input: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const patterns = [
    /^\*\*\* Update File:\s+(.+)$/gm,
    /^\*\*\* Move to:\s+(.+)$/gm,
    /^\*\*\* Add File:\s+(.+)$/gm,
    /^\*\*\* Delete File:\s+(.+)$/gm,
  ];

  for (const pattern of patterns) {
    for (const match of input.matchAll(pattern)) {
      const path = match[1]?.trim();
      if (!path || seen.has(path)) {
        continue;
      }
      seen.add(path);
      paths.push(path);
    }
  }

  return paths;
}

function toCursorToolArgsPreview(item: Record<string, unknown>): string | null {
  const args = toRecord(item.args);
  if (!args) {
    return toStructuredPreview(item.args, 320);
  }

  const directTarget =
    normalizeInline(readString(args.path), 180) ??
    normalizeInline(readString(args.filePath), 180) ??
    normalizeInline(readString(args.file_path), 180) ??
    normalizeInline(readString(args.globPattern), 180) ??
    normalizeInline(readString(args.glob_pattern), 180) ??
    normalizeInline(readString(args.command), 220);
  if (directTarget) {
    return directTarget;
  }

  return toStructuredPreview(args, 320);
}

function toCursorToolResultPreview(value: unknown): string | null {
  const record = toRecord(value);
  const status = normalizeType(readString(record?.status) ?? '');
  const isError = status === 'error' || status === 'failed';
  const gitPreview = toCursorGitResultPreview(record ?? toRecord(toRecord(value)?.value));
  if (gitPreview) {
    return gitPreview;
  }
  const preview = toStructuredPreview(record?.value ?? record?.result ?? value, 600);
  if (isError) {
    const error =
      normalizeMultiline(readString(record?.error), 600) ??
      normalizeMultiline(readString(toRecord(record?.error)?.message), 600);
    return error ? `Error: ${error}` : preview;
  }
  return preview;
}

function toCursorGitResultPreview(record: Record<string, unknown> | null): string | null {
  const rawBranches = Array.isArray(record?.branches) ? record.branches : [];
  if (rawBranches.length === 0) {
    return null;
  }

  const lines = rawBranches
    .map((entry) => {
      const branchRecord = toRecord(entry);
      if (!branchRecord) {
        return null;
      }
      const branch = normalizeInline(readString(branchRecord.branch), 180);
      const prUrl = normalizeInline(
        readString(branchRecord.prUrl) ?? readString(branchRecord.pr_url),
        220
      );
      const repoUrl = normalizeInline(
        readString(branchRecord.repoUrl) ?? readString(branchRecord.repo_url),
        220
      );
      return [
        branch ? `Branch: ${branch}` : null,
        prUrl ? `PR: ${prUrl}` : null,
        repoUrl ? `Repo: ${repoUrl}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .filter((line): line is string => Boolean(line));

  return lines.length > 0 ? lines.join('\n') : null;
}

function toSubAgentMeta(item: Record<string, unknown>): ChatMessageSubAgentMeta | undefined {
  const tool = readString(item.tool) ?? undefined;
  const prompt = normalizeInline(readString(item.prompt), 4000) ?? undefined;
  const senderThreadId =
    normalizeInline(
      readString(item.senderThreadId) ?? readString(item.sender_thread_id),
      200
    ) ?? undefined;
  const agentStatus =
    normalizeInline(
      readString(item.agentStatus) ?? readString(item.agent_status),
      200
    ) ?? undefined;
  const receiverThreadIds = readReceiverThreadIds(item);

  if (!tool && !prompt && !senderThreadId && receiverThreadIds.length === 0 && !agentStatus) {
    return undefined;
  }

  return {
    tool,
    prompt,
    senderThreadId,
    receiverThreadIds,
    agentStatus,
  };
}

function readReceiverThreadIds(item: Record<string, unknown>): string[] {
  const pluralIds = [
    ...readStringArray(item.receiverThreadIds),
    ...readStringArray(item.receiver_thread_ids),
  ];
  if (pluralIds.length > 0) {
    return Array.from(new Set(pluralIds));
  }

  const singularIds = [
    readString(item.newThreadId),
    readString(item.new_thread_id),
    readString(item.receiverThreadId),
    readString(item.receiver_thread_id),
  ]
    .map((value) => value?.trim() ?? '')
    .filter((value): value is string => value.length > 0);

  return singularIds;
}

function reasoningTextFromItem(item: Record<string, unknown>): string | null {
  const directText = readString(item.text);
  if (directText?.trim()) {
    return directText;
  }

  const content = readStringArray(item.content);
  if (content.length > 0) {
    return content.join('\n');
  }

  if (Array.isArray(item.content)) {
    const structuredContent = stringifyStructuredContentEntries(item.content);
    if (structuredContent.trim()) {
      return structuredContent;
    }
  }

  const summary = readStringArray(item.summary);
  if (summary.length > 0) {
    return summary.join('\n');
  }

  if (Array.isArray(item.summary)) {
    const structuredSummary = stringifyStructuredContentEntries(item.summary);
    if (structuredSummary.trim()) {
      return structuredSummary;
    }
  }

  return null;
}

function normalizeType(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  try {
    return toRecord(JSON.parse(value));
  } catch {
    return null;
  }
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

function toFileChangeTargetLabel(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/');
  if (!normalized) {
    return 'file';
  }

  const basename = normalized.split('/').filter(Boolean).pop();
  return basename && basename.length > 0 ? basename : normalized;
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

  const structuredPreview = toStructuredContentPreview(value, maxChars);
  if (structuredPreview) {
    return structuredPreview;
  }

  if (typeof value === 'string') {
    return normalizeMultiline(value, maxChars);
  }

  try {
    const serialized = JSON.stringify(value);
    return normalizeInline(serialized, maxChars);
  } catch {
    return null;
  }
}

function stringifyStructuredContentEntries(entries: unknown[]): string {
  return entries.flatMap((entry) => stringifyStructuredContentEntry(entry)).join('\n');
}

function stringifyStructuredContentEntry(entry: unknown): string[] {
  const entryRecord = toRecord(entry);
  if (!entryRecord) {
    const text = readString(entry)?.trim();
    return text ? [text] : [];
  }

  const entryType = normalizeType(readString(entryRecord.type) ?? '');
  if (
    entryType === 'text' ||
    entryType === 'inputtext' ||
    entryType === 'outputtext' ||
    entryType === 'summarytext'
  ) {
    const text = readStructuredText(entryRecord);
    return text ? [text] : [];
  }

  if (entryType === 'image' || entryType === 'inputimage') {
    const localImagePath = readStructuredLocalImagePath(entryRecord);
    if (localImagePath) {
      return [`[local image: ${localImagePath}]`];
    }

    const imageUrl = readStructuredImageUrl(entryRecord);
    return imageUrl ? [`[image: ${imageUrl}]`] : [];
  }

  if (entryType === 'localimage') {
    const localImagePath = readStructuredLocalImagePath(entryRecord);
    if (localImagePath) {
      return [`[local image: ${localImagePath}]`];
    }

    const imageUrl = readStructuredImageUrl(entryRecord);
    return imageUrl ? [`[image: ${imageUrl}]`] : [];
  }

  if (entryType === 'mention') {
    const mentionPath = readStructuredMentionPath(entryRecord);
    return mentionPath ? [`[file: ${mentionPath}]`] : [];
  }

  return [];
}

function readStructuredText(entryRecord: Record<string, unknown>): string | null {
  return (
    readString(entryRecord.text)?.trim() ??
    readString(toRecord(entryRecord.data)?.text)?.trim() ??
    null
  );
}

function readStructuredImageUrl(entryRecord: Record<string, unknown>): string | null {
  const data = toRecord(entryRecord.data);
  const inlineImageData =
    readString(entryRecord.data)?.trim() ??
    readString(data?.data)?.trim() ??
    null;
  const inlineImageMimeType =
    readString(entryRecord.mimeType)?.trim() ??
    readString(entryRecord.mime_type)?.trim() ??
    readString(data?.mimeType)?.trim() ??
    readString(data?.mime_type)?.trim() ??
    null;

  if (inlineImageData && inlineImageMimeType) {
    return `data:${inlineImageMimeType};base64,${inlineImageData}`;
  }

  return (
    readString(entryRecord.url)?.trim() ??
    readString(entryRecord.image_url)?.trim() ??
    readString(entryRecord.imageUrl)?.trim() ??
    readString(data?.url)?.trim() ??
    readString(data?.image_url)?.trim() ??
    readString(data?.imageUrl)?.trim() ??
    null
  );
}

function readStructuredLocalImagePath(entryRecord: Record<string, unknown>): string | null {
  const data = toRecord(entryRecord.data);
  return readString(entryRecord.path)?.trim() ?? readString(data?.path)?.trim() ?? null;
}

function readStructuredMentionPath(entryRecord: Record<string, unknown>): string | null {
  const data = toRecord(entryRecord.data);
  return readString(entryRecord.path)?.trim() ?? readString(data?.path)?.trim() ?? null;
}

function toStructuredContentPreview(value: unknown, maxChars: number): string | null {
  const lines = extractStructuredContentPreviewLines(value);
  if (lines.length === 0) {
    return null;
  }

  const previewLines: string[] = [];
  let remainingChars = maxChars;
  let textLineCount = 0;
  let mediaLineCount = 0;

  for (const line of lines) {
    if (isImageMarker(line)) {
      if (mediaLineCount >= 3) {
        break;
      }
      previewLines.push(line);
      mediaLineCount += 1;
      continue;
    }

    if (textLineCount >= 8 || remainingChars <= 0) {
      break;
    }

    const normalizedLine = normalizeMultiline(line, remainingChars);
    if (!normalizedLine) {
      continue;
    }

    previewLines.push(normalizedLine);
    textLineCount += 1;
    remainingChars -= normalizedLine.length;
  }

  return previewLines.length > 0 ? previewLines.join('\n') : null;
}

function extractStructuredContentPreviewLines(
  value: unknown,
  depth = 0
): string[] {
  if (depth > 3 || value == null) {
    return [];
  }

  if (Array.isArray(value)) {
    const directLines = value.flatMap((entry) => stringifyStructuredContentEntry(entry));
    if (directLines.length > 0) {
      return directLines;
    }

    for (const entry of value) {
      const nestedLines = extractStructuredContentPreviewLines(entry, depth + 1);
      if (nestedLines.length > 0) {
        return nestedLines;
      }
    }

    return [];
  }

  const directLines = stringifyStructuredContentEntry(value);
  if (directLines.length > 0) {
    return directLines;
  }

  const record = toRecord(value);
  if (!record) {
    return [];
  }

  const candidateKeys = [
    'content',
    'contents',
    'items',
    'item',
    'result',
    'results',
    'output',
    'data',
    'structuredContent',
    'structured_content',
    '_meta',
    'meta',
  ];
  for (const key of candidateKeys) {
    if (!(key in record)) {
      continue;
    }

    const nestedLines = extractStructuredContentPreviewLines(record[key], depth + 1);
    if (nestedLines.length > 0) {
      return nestedLines;
    }
  }

  return [];
}

function isImageMarker(value: string): boolean {
  return /^\[(?:image|local image):\s*.+?\]$/i.test(value.trim());
}
