import type { ThreadStatus } from '../types';

// ---------------------------------------------------------------------------
// Raw types from codex app-server JSON responses
// ---------------------------------------------------------------------------

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
  source?: {
    kind?: string;
  };
  turns?: RawTurn[];
}

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

export function toPreview(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 180) {
    return collapsed;
  }

  return `${collapsed.slice(0, 177)}...`;
}

export function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function unixSecondsToIso(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return new Date().toISOString();
  }

  return new Date(value * 1000).toISOString();
}

export function mapRawStatus(status: unknown, turns: RawTurn[] | undefined): ThreadStatus {
  const statusRecord = toRecord(status);
  const statusType = readString(statusRecord?.type);

  if (statusType === 'active') {
    return 'running';
  }

  if (statusType === 'systemError') {
    return 'error';
  }

  const lastTurn = Array.isArray(turns) && turns.length > 0 ? turns[turns.length - 1] : null;
  const lastTurnStatus = readString(lastTurn?.status);

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

export function extractLastError(turns: RawTurn[]): string | null {
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
    source: toRecord(record.source) as { kind?: string } | undefined,
    turns: Array.isArray(record.turns)
      ? (record.turns.map((turn) => toRawTurn(turn)).filter(Boolean) as RawTurn[])
      : undefined
  };
}

export function toRawTurn(value: unknown): RawTurn | null {
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
    items
  };
}
