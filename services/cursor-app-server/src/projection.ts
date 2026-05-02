import type {
  CursorAgentInfo,
  CursorAgentMessage,
  CursorStreamMessage,
  ThreadItem,
  ThreadRecord,
  ThreadTurn,
} from './types.js';

export function projectAgentInfoToThread(
  agent: CursorAgentInfo,
  cwd: string,
  turns?: ThreadTurn[]
): ThreadRecord {
  const createdAtMs = agent.createdAt ?? agent.lastModified;
  const updatedAtMs = agent.lastModified;
  const status = agent.status === 'running'
    ? 'running'
    : agent.status === 'error'
      ? 'error'
      : turns && turns.length > 0
        ? 'complete'
        : 'idle';

  const lastPreview = lastTurnPreview(turns);
  const preview = toPreview(agent.summary || lastPreview || '');
  const titlePreview = firstUserPreview(turns) ?? preview;
  const name = displayableCursorAgentName(agent.name, agent.agentId) ?? titlePreview ?? null;

  return {
    id: agent.agentId,
    name,
    title: name,
    preview,
    createdAt: toUnixSeconds(createdAtMs),
    updatedAt: toUnixSeconds(updatedAtMs),
    status: { type: status },
    cwd: agent.cwd ?? cwd,
    source: 'cursorSdk',
    turns,
  };
}

export function messagesToTurns(messages: CursorAgentMessage[]): ThreadTurn[] {
  const turns: ThreadTurn[] = [];
  let currentTurn: ThreadTurn | null = null;

  for (const message of messages) {
    const text = readMessageText(message.message);
    if (!text.trim()) {
      continue;
    }

    if (message.type === 'user') {
      currentTurn = {
        id: message.uuid,
        status: 'completed',
        items: [
          {
            type: 'userMessage',
            id: message.uuid,
            content: [{ type: 'text', text }],
          },
        ],
      };
      turns.push(currentTurn);
      continue;
    }

    if (!currentTurn) {
      currentTurn = {
        id: `cursor-turn-${message.uuid}`,
        status: 'completed',
        items: [],
      };
      turns.push(currentTurn);
    }

    const lastItem = currentTurn.items[currentTurn.items.length - 1];
    if (lastItem?.type === 'agentMessage') {
      lastItem.text = `${lastItem.text ?? ''}${text}`;
      continue;
    }

    currentTurn.items.push({
      type: 'agentMessage',
      id: message.uuid,
      text,
    });
  }

  return turns;
}

export function displayableCursorAgentName(
  name: string | null | undefined,
  agentId: string
): string | null {
  const value = toPreview(name ?? '');
  if (!value || isGenericCursorAgentName(value, agentId)) {
    return null;
  }
  return value;
}

export function isGenericCursorAgentName(
  name: string | null | undefined,
  agentId: string
): boolean {
  const value = (name ?? '').trim().toLowerCase();
  if (!value) {
    return true;
  }

  if (
    value === 'new agent' ||
    value === 'cursor agent' ||
    value === 'untitled' ||
    value === 'untitled agent'
  ) {
    return true;
  }

  const agentPrefix = agentId.slice(0, 8).toLowerCase();
  return (
    value === `cursor ${agentPrefix}` ||
    value === `cursor ${agentId.toLowerCase()}` ||
    /^cursor\s+agent[-\s][0-9a-f]{2,}/u.test(value)
  );
}

export function streamMessageToThreadItem(message: CursorStreamMessage): ThreadItem | null {
  if (message.type === 'assistant') {
    const text = readMessageText(message.message);
    if (!text.trim()) {
      return null;
    }
    return {
      type: 'agentMessage',
      id: `${message.run_id ?? 'run'}-assistant`,
      text,
    };
  }

  if (message.type === 'thinking') {
    const text = message.text?.trim();
    if (!text) {
      return null;
    }
    return {
      type: 'reasoning',
      id: `${message.run_id ?? 'run'}-thinking`,
      text,
    };
  }

  if (message.type === 'tool_call') {
    return {
      type: 'toolCall',
      id: message.call_id ?? `${message.run_id ?? 'run'}-tool`,
      tool: message.name ?? 'unknown',
      status: message.status ?? 'running',
      args: message.args,
      result: message.result,
      truncated: message.truncated,
    };
  }

  if (message.type === 'task') {
    const text = message.text?.trim();
    if (!text) {
      return null;
    }
    return {
      type: 'reasoning',
      id: `${message.run_id ?? 'run'}-task`,
      text,
      status: message.status,
    };
  }

  return null;
}

export function readMessageText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') {
    return record.text;
  }

  if (Array.isArray(record.content)) {
    return record.content
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return '';
        }
        const content = entry as Record<string, unknown>;
        return typeof content.text === 'string' ? content.text : '';
      })
      .filter((entry) => entry.length > 0)
      .join('');
  }

  const nested = record.message;
  if (nested !== undefined && nested !== value) {
    return readMessageText(nested);
  }

  return '';
}

export function toPreview(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= 180) {
    return collapsed;
  }
  return `${collapsed.slice(0, 177)}...`;
}

function lastTurnPreview(turns: ThreadTurn[] | undefined): string | null {
  if (!turns || turns.length === 0) {
    return null;
  }

  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex];
      const text = item.text ?? item.content?.map((entry) => entry.text).join('') ?? '';
      if (text.trim()) {
        return text;
      }
    }
  }

  return null;
}

function firstUserPreview(turns: ThreadTurn[] | undefined): string | null {
  if (!turns || turns.length === 0) {
    return null;
  }

  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type !== 'userMessage') {
        continue;
      }
      const text = item.content?.map((entry) => entry.text).join('') ?? '';
      const preview = toPreview(text);
      if (preview) {
        return preview;
      }
    }
  }

  return null;
}

function toUnixSeconds(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) {
    return Math.floor(Date.now() / 1000);
  }
  return Math.floor(ms / 1000);
}
