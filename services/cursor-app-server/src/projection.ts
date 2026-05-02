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
    const projectedTurn = cursorMessageToTurn(message);
    if (projectedTurn) {
      turns.push(projectedTurn);
      currentTurn = projectedTurn;
      continue;
    }

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

function cursorMessageToTurn(message: CursorAgentMessage): ThreadTurn | null {
  const conversationTurn = readConversationTurn(message.message);
  if (!conversationTurn) {
    return null;
  }

  if (conversationTurn.type === 'shellConversationTurn') {
    return shellConversationTurnToTurn(message.uuid, conversationTurn.turn);
  }

  const items: ThreadItem[] = [];
  const userText = readMessageText(
    readRecordValue(conversationTurn.turn, 'userMessage') ??
      readRecordValue(conversationTurn.turn, 'user_message')
  );
  if (userText.trim()) {
    items.push({
      type: 'userMessage',
      id: `${message.uuid}-user`,
      content: [{ type: 'text', text: userText }],
    });
  }

  const steps = readRecordValue(conversationTurn.turn, 'steps');
  if (Array.isArray(steps)) {
    steps.forEach((step, index) => {
      const item = conversationStepToItem(step, `${message.uuid}-step-${index}`);
      if (item) {
        items.push(item);
      }
    });
  }

  if (items.length === 0) {
    return null;
  }

  return {
    id: message.uuid,
    status: 'completed',
    items,
  };
}

function shellConversationTurnToTurn(id: string, turn: Record<string, unknown>): ThreadTurn | null {
  const command = toRecord(
    readRecordValue(turn, 'shellCommand') ?? readRecordValue(turn, 'shell_command')
  );
  const output = toRecord(
    readRecordValue(turn, 'shellOutput') ?? readRecordValue(turn, 'shell_output')
  );
  const commandText = readString(readRecordValue(command, 'command'));
  const stdout = readString(readRecordValue(output, 'stdout'));
  const stderr = readString(readRecordValue(output, 'stderr'));
  const exitCode = readNumber(
    readRecordValue(output, 'exitCode') ?? readRecordValue(output, 'exit_code')
  );
  const failed = exitCode !== null && exitCode !== 0;
  const workingDirectory = readString(
    readRecordValue(command, 'workingDirectory') ??
      readRecordValue(command, 'working_directory')
  );

  if (!commandText && !stdout && !stderr) {
    return null;
  }

  return {
    id,
    status: failed ? 'failed' : 'completed',
    items: [
      {
        type: 'toolCall',
        id: `${id}-shell`,
        tool: 'shell',
        status: failed ? 'error' : 'completed',
        args: {
          ...(commandText ? { command: commandText } : {}),
          ...(workingDirectory ? { workingDirectory } : {}),
        },
        result: {
          ...(stdout ? { stdout } : {}),
          ...(stderr ? { stderr } : {}),
          ...(exitCode !== null ? { exitCode } : {}),
        },
      },
    ],
  };
}

function conversationStepToItem(value: unknown, id: string): ThreadItem | null {
  const step = toRecord(value);
  if (!step) {
    return null;
  }

  let type = readString(readRecordValue(step, 'type'));
  let message = readRecordValue(step, 'message');
  const oneOfMessage = readOneOf(message);
  if (!type && oneOfMessage) {
    type = oneOfMessage.case;
    message = oneOfMessage.value;
  }

  if (type === 'assistantMessage' || readRecordValue(step, 'assistantMessage')) {
    const text = readMessageText(message ?? readRecordValue(step, 'assistantMessage'));
    if (!text.trim()) {
      return null;
    }
    return {
      type: 'agentMessage',
      id,
      text,
    };
  }

  if (type === 'thinkingMessage' || readRecordValue(step, 'thinkingMessage')) {
    const text = readMessageText(message ?? readRecordValue(step, 'thinkingMessage'));
    if (!text.trim()) {
      return null;
    }
    return {
      type: 'reasoning',
      id,
      text,
    };
  }

  if (type === 'toolCall' || readRecordValue(step, 'toolCall')) {
    const tool = toRecord(message ?? readRecordValue(step, 'toolCall'));
    const nestedTool = readOneOf(readRecordValue(tool, 'tool'));
    const nestedToolPayload = toRecord(nestedTool?.value);
    const result =
      readRecordValue(nestedToolPayload, 'result') ?? readRecordValue(tool, 'result');
    const truncated = toRecord(readRecordValue(tool, 'truncated')) as ThreadItem['truncated'];
    const item: ThreadItem = {
      type: 'toolCall',
      id,
      tool:
        readString(readRecordValue(tool, 'name')) ??
        readString(readRecordValue(tool, 'type')) ??
        normalizeCursorToolName(nestedTool?.case) ??
        'unknown',
      status: toolCallStatus(tool),
      args: readRecordValue(nestedToolPayload, 'args') ?? readRecordValue(tool, 'args'),
      result,
    };
    if (truncated) {
      item.truncated = truncated;
    }
    return item;
  }

  return null;
}

function readConversationTurn(
  value: unknown
): {
  type: 'agentConversationTurn' | 'shellConversationTurn';
  turn: Record<string, unknown>;
} | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const directType = readString(readRecordValue(record, 'type'));
  const directTurn = toRecord(readRecordValue(record, 'turn'));
  if (
    (directType === 'agentConversationTurn' || directType === 'shellConversationTurn') &&
    directTurn
  ) {
    return {
      type: directType,
      turn: directTurn,
    };
  }

  const agentConversationTurn = toRecord(readRecordValue(record, 'agentConversationTurn'));
  if (agentConversationTurn) {
    return {
      type: 'agentConversationTurn',
      turn: agentConversationTurn,
    };
  }

  const shellConversationTurn = toRecord(readRecordValue(record, 'shellConversationTurn'));
  if (shellConversationTurn) {
    return {
      type: 'shellConversationTurn',
      turn: shellConversationTurn,
    };
  }

  const oneOfTurn = toRecord(readRecordValue(record, 'turn'));
  const oneOfCase = readString(readRecordValue(oneOfTurn, 'case'));
  const oneOfValue = toRecord(readRecordValue(oneOfTurn, 'value'));
  if (
    (oneOfCase === 'agentConversationTurn' || oneOfCase === 'shellConversationTurn') &&
    oneOfValue
  ) {
    return {
      type: oneOfCase,
      turn: oneOfValue,
    };
  }

  return null;
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

  const record = toRecord(value);
  if (!record) {
    return '';
  }

  if (typeof record.text === 'string') {
    return record.text;
  }

  const oneOf = readOneOf(record);
  if (oneOf) {
    return readMessageText(oneOf.value);
  }

  const userMessage =
    toRecord(readRecordValue(record, 'userMessage')) ??
    toRecord(readRecordValue(record, 'user_message'));
  if (userMessage) {
    return readMessageText(userMessage);
  }

  const conversationTurn = readConversationTurn(record);
  if (conversationTurn?.type === 'agentConversationTurn') {
    const parts: string[] = [];
    const userText = readMessageText(
      readRecordValue(conversationTurn.turn, 'userMessage') ??
        readRecordValue(conversationTurn.turn, 'user_message')
    );
    if (userText.trim()) {
      parts.push(userText);
    }
    const steps = readRecordValue(conversationTurn.turn, 'steps');
    if (Array.isArray(steps)) {
      for (const step of steps) {
        const stepText = readConversationStepText(step);
        if (stepText.trim()) {
          parts.push(stepText);
        }
      }
    }
    return parts.join('');
  }

  if (conversationTurn?.type === 'shellConversationTurn') {
    const shellTurn = shellConversationTurnToTurn('preview', conversationTurn.turn);
    return (
      shellTurn?.items
        .map((item) => {
          const args = toRecord(item.args);
          const result = toRecord(item.result);
          return [
            readString(readRecordValue(args, 'command')),
            readString(readRecordValue(result, 'stdout')),
            readString(readRecordValue(result, 'stderr')),
          ]
            .filter(Boolean)
            .join('\n');
        })
        .filter(Boolean)
        .join('\n') ?? ''
    );
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

function readConversationStepText(value: unknown): string {
  const step = toRecord(value);
  if (!step) {
    return '';
  }

  const message = readRecordValue(step, 'message');
  const oneOfMessage = readOneOf(message);
  return readMessageText(
    oneOfMessage?.value ??
      message ??
      readRecordValue(step, 'assistantMessage') ??
      readRecordValue(step, 'thinkingMessage')
  );
}

function toolCallStatus(tool: Record<string, unknown> | null): string {
  const status = readString(readRecordValue(tool, 'status'));
  if (status) {
    return status;
  }

  const result = toRecord(readRecordValue(tool, 'result'));
  const resultStatus = readString(readRecordValue(result, 'status'));
  return resultStatus === 'error' ? 'error' : 'completed';
}

function normalizeCursorToolName(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const withoutSuffix = value.replace(/ToolCall$/u, '');
  return withoutSuffix.trim() ? withoutSuffix : value;
}

function readOneOf(value: unknown): { case: string; value: unknown } | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const oneOfCase = readString(readRecordValue(record, 'case'));
  if (!oneOfCase || !Object.prototype.hasOwnProperty.call(record, 'value')) {
    return null;
  }

  return {
    case: oneOfCase,
    value: readRecordValue(record, 'value'),
  };
}

function readRecordValue(
  record: Record<string, unknown> | null | undefined,
  key: string
): unknown {
  return record ? record[key] : undefined;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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

function lastTurnPreview(turns: ThreadTurn[] | undefined): string | null {
  if (!turns || turns.length === 0) {
    return null;
  }

  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    for (let itemIndex = turn.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = turn.items[itemIndex];
      const text = item.text ?? threadContentText(item.content);
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
      const text = threadContentText(item.content);
      const preview = toPreview(text);
      if (preview) {
        return preview;
      }
    }
  }

  return null;
}

function threadContentText(content: ThreadItem['content']): string {
  return content
    ?.map((entry) => (entry.type === 'text' ? entry.text : ''))
    .join('') ?? '';
}

function toUnixSeconds(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) {
    return Math.floor(Date.now() / 1000);
  }
  return Math.floor(ms / 1000);
}
