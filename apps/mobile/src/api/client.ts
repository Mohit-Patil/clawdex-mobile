import {
  mapChat,
  mapChatSummary,
  readString,
  toRecord,
  toRawThread,
} from './chatMapping';
import type {
  ApprovalDecision,
  CollaborationMode,
  CreateChatRequest,
  Chat,
  ChatSummary,
  GitCommitRequest,
  GitCommitResponse,
  GitDiffResponse,
  GitPushResponse,
  GitStatusResponse,
  PendingApproval,
  ResolveApprovalResponse,
  ResolveUserInputRequest,
  ResolveUserInputResponse,
  SendChatMessageRequest,
  ModelOption,
  ReasoningEffort,
  ModelReasoningEffortOption,
  TerminalExecRequest,
  TerminalExecResponse,
} from './types';
import type { MacBridgeWsClient } from './ws';

interface HealthResponse {
  status: 'ok';
  at: string;
  uptimeSec: number;
}

interface ApiClientOptions {
  ws: MacBridgeWsClient;
}

interface AppServerListResponse {
  data?: unknown[];
}

interface AppServerReadResponse {
  thread?: unknown;
}

interface AppServerTurnResponse {
  turn?: {
    id?: string;
  };
}

interface AppServerStartResponse {
  thread?: {
    id?: string;
  };
}

interface AppServerForkResponse {
  thread?: unknown;
}

interface AppServerModelListResponse {
  data?: unknown[];
}

interface AppServerCollaborationMode {
  mode: 'plan';
  settings: {
    model: string;
    reasoning_effort: ReasoningEffort | null;
    developer_instructions: string | null;
  };
}

type AppServerThreadSetNameResponse = Record<string, never>;

const CHAT_LIST_SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'unknown'] as const;
const MOBILE_DEVELOPER_INSTRUCTIONS =
  'When you need clarification, call request_user_input instead of asking only in plain text. Provide 2-3 concise options whenever possible and use isOther when free-form input is appropriate.';
const TURN_COMPLETION_SOFT_TIMEOUT_MS = 45_000;

export class MacBridgeApiClient {
  private readonly ws: MacBridgeWsClient;
  private readonly renamedTitles = new Map<string, string>();

  constructor(options: ApiClientOptions) {
    this.ws = options.ws;
  }

  health(): Promise<HealthResponse> {
    return this.ws.request<HealthResponse>('bridge/health/read');
  }

  async listChats(): Promise<ChatSummary[]> {
    const response = await this.ws.request<AppServerListResponse>('thread/list', {
      cursor: null,
      limit: 200,
      sortKey: null,
      modelProviders: null,
      sourceKinds: CHAT_LIST_SOURCE_KINDS,
      archived: false,
      cwd: null,
    });

    const listRaw = Array.isArray(response.data) ? response.data : [];

    return listRaw
      .map((item) => {
        const rawThread = toRawThread(item);
        if (rawThread.id && rawThread.name?.trim()) {
          this.renamedTitles.set(rawThread.id, rawThread.name.trim());
        }

        const mapped = mapChatSummary(rawThread);
        if (!mapped) {
          return null;
        }

        const cachedTitle = this.renamedTitles.get(mapped.id);
        if (cachedTitle) {
          return {
            ...mapped,
            title: cachedTitle,
          };
        }

        return mapped;
      })
      .filter((item): item is ChatSummary => item !== null)
      .filter((item) => !isSubAgentSource(item.sourceKind))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createChat(body: CreateChatRequest): Promise<Chat> {
    const requestedCwd = normalizeCwd(body.cwd);
    const requestedModel = normalizeModel(body.model);
    const requestedEffort = normalizeEffort(body.effort);
    const started = await this.ws.request<AppServerStartResponse>('thread/start', {
      model: requestedModel ?? null,
      modelProvider: null,
      cwd: requestedCwd ?? null,
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      config: null,
      baseInstructions: null,
      developerInstructions: MOBILE_DEVELOPER_INSTRUCTIONS,
      personality: null,
      ephemeral: null,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });

    const chatId = started.thread?.id;
    if (!chatId) {
      throw new Error('thread/start did not return a chat id');
    }

    const initialPrompt = body.message?.trim();
    if (initialPrompt) {
      return this.sendChatMessage(chatId, {
        content: initialPrompt,
        role: 'user',
        cwd: requestedCwd ?? undefined,
        model: requestedModel ?? undefined,
        effort: requestedEffort ?? undefined,
      });
    }

    if (started.thread) {
      return this.mapChatWithCachedTitle(started.thread);
    }

    return this.getChat(chatId);
  }

  async getChat(id: string): Promise<Chat> {
    try {
      const response = await this.ws.request<AppServerReadResponse>('thread/read', {
        threadId: id,
        includeTurns: true,
      });

      return this.mapChatWithCachedTitle(response.thread);
    } catch (error) {
      const message = String((error as Error).message ?? error);
      const isMaterializationGap =
        message.includes('includeTurns') &&
        (message.includes('material') || message.includes('materialis'));

      if (!isMaterializationGap) {
        throw error;
      }

      const response = await this.ws.request<AppServerReadResponse>('thread/read', {
        threadId: id,
        includeTurns: false,
      });
      return this.mapChatWithCachedTitle(response.thread);
    }
  }

  async renameChat(id: string, name: string): Promise<Chat> {
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error('Chat name cannot be empty');
    }

    await this.trySetThreadName(id, {
      threadId: id,
      name: trimmedName,
    });
    await this.trySetThreadName(id, {
      threadId: id,
      threadName: trimmedName,
    });

    this.renamedTitles.set(id, trimmedName);
    const updated = await this.getChat(id);

    return {
      ...updated,
      title: trimmedName,
    };
  }

  async setChatWorkspace(id: string, cwd: string): Promise<Chat> {
    const normalizedCwd = normalizeCwd(cwd);
    if (!normalizedCwd) {
      throw new Error('Workspace path cannot be empty');
    }

    await this.ws.request('thread/resume', {
      threadId: id,
      history: null,
      path: null,
      model: null,
      modelProvider: null,
      cwd: normalizedCwd,
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      config: null,
      baseInstructions: null,
      developerInstructions: MOBILE_DEVELOPER_INSTRUCTIONS,
      personality: null,
      persistExtendedHistory: true,
    });

    const updated = await this.getChat(id);
    if (updated.cwd === normalizedCwd) {
      return updated;
    }

    return {
      ...updated,
      cwd: normalizedCwd,
    };
  }

  async sendChatMessage(id: string, body: SendChatMessageRequest): Promise<Chat> {
    const content = body.content.trim();
    if (!content) {
      return this.getChat(id);
    }

    if ((body.role ?? 'user') !== 'user') {
      throw new Error('Only user role is supported in bridge/chat messaging');
    }

    const normalizedCwd = normalizeCwd(body.cwd);
    const normalizedModel = normalizeModel(body.model);
    const normalizedEffort = normalizeEffort(body.effort);
    const requestedPlanMode =
      typeof body.collaborationMode === 'string' &&
      body.collaborationMode.trim().toLowerCase() === 'plan';
    let effectiveModel = normalizedModel;
    if (requestedPlanMode && !effectiveModel) {
      try {
        const models = await this.listModels(false);
        effectiveModel =
          models.find((entry) => entry.isDefault)?.id ?? models[0]?.id ?? null;
      } catch {
        // Best effort: fall back to the current thread settings if model lookup fails.
      }
    }
    const normalizedCollaborationMode = toTurnCollaborationMode(
      body.collaborationMode,
      effectiveModel,
      normalizedEffort
    );

    try {
      await this.ws.request('thread/resume', {
        threadId: id,
        history: null,
        path: null,
        model: effectiveModel ?? null,
        modelProvider: null,
        cwd: normalizedCwd ?? null,
        approvalPolicy: 'untrusted',
        sandbox: 'workspace-write',
        config: null,
        baseInstructions: null,
        developerInstructions: MOBILE_DEVELOPER_INSTRUCTIONS,
        personality: null,
        persistExtendedHistory: true,
      });
    } catch {
      // Best effort: turn/start still works for recently started chats.
    }

    const turnStart = await this.ws.request<AppServerTurnResponse>('turn/start', {
      threadId: id,
      input: [
        {
          type: 'text',
          text: content,
          text_elements: [],
        },
      ],
      cwd: normalizedCwd ?? null,
      approvalPolicy: null,
      sandboxPolicy: null,
      model: effectiveModel ?? null,
      effort: normalizedEffort ?? null,
      summary: null,
      personality: null,
      outputSchema: null,
      collaborationMode: normalizedCollaborationMode,
    });

    const turnId = turnStart.turn?.id;
    if (!turnId) {
      throw new Error('turn/start did not return turn id');
    }

    try {
      await this.ws.waitForTurnCompletion(id, turnId, TURN_COMPLETION_SOFT_TIMEOUT_MS);
    } catch (error) {
      const message = String((error as Error).message ?? error);
      const isTurnTimeout = message.toLowerCase().includes('turn timed out');
      if (!isTurnTimeout) {
        throw error;
      }
    }
    return this.getChatWithUserMessage(id, content);
  }

  async listModels(includeHidden = false): Promise<ModelOption[]> {
    const response = await this.ws.request<AppServerModelListResponse>('model/list', {
      cursor: null,
      limit: 200,
      includeHidden,
    });

    const rawList = Array.isArray(response.data) ? response.data : [];
    const models: ModelOption[] = [];

    for (const item of rawList) {
      const record = toRecord(item);
      if (!record) {
        continue;
      }

      const id = readString(record.id) ?? readString(record.model);
      if (!id) {
        continue;
      }

      const displayName = readString(record.displayName) ?? id;
      const description = readString(record.description) ?? undefined;
      const hidden = typeof record.hidden === 'boolean' ? record.hidden : undefined;
      const supportsPersonality =
        typeof record.supportsPersonality === 'boolean'
          ? record.supportsPersonality
          : undefined;
      const isDefault =
        typeof record.isDefault === 'boolean' ? record.isDefault : undefined;
      const defaultReasoningEffort = normalizeEffort(
        readString(record.defaultReasoningEffort) ?? readString(record.reasoningEffort)
      );
      const reasoningEffort = toReasoningEffortOptions(
        record.supportedReasoningEfforts ?? record.reasoningEffort
      );

      models.push({
        id,
        displayName,
        description,
        hidden,
        supportsPersonality,
        isDefault,
        defaultReasoningEffort: defaultReasoningEffort ?? undefined,
        reasoningEffort: reasoningEffort.length > 0 ? reasoningEffort : undefined,
      });
    }

    return models;
  }

  async compactChat(id: string): Promise<void> {
    await this.ws.request('thread/compact/start', {
      threadId: id,
    });
  }

  async reviewChat(id: string): Promise<void> {
    await this.ws.request('review/start', {
      threadId: id,
      target: {
        type: 'uncommittedChanges',
      },
      delivery: 'inline',
    });
  }

  async forkChat(
    id: string,
    options?: {
      cwd?: string;
      model?: string;
    }
  ): Promise<Chat> {
    const response = await this.ws.request<AppServerForkResponse>('thread/fork', {
      threadId: id,
      path: null,
      model: normalizeModel(options?.model) ?? null,
      modelProvider: null,
      cwd: normalizeCwd(options?.cwd) ?? null,
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      config: null,
      baseInstructions: null,
      developerInstructions: MOBILE_DEVELOPER_INSTRUCTIONS,
      persistExtendedHistory: true,
    });

    if (response.thread) {
      return this.mapChatWithCachedTitle(response.thread);
    }

    throw new Error('thread/fork did not return a chat payload');
  }

  listApprovals(): Promise<PendingApproval[]> {
    return this.ws.request<PendingApproval[]>('bridge/approvals/list');
  }

  resolveApproval(id: string, decision: ApprovalDecision): Promise<ResolveApprovalResponse> {
    return this.ws.request<ResolveApprovalResponse>('bridge/approvals/resolve', {
      id,
      decision,
    });
  }

  resolveUserInput(
    id: string,
    body: ResolveUserInputRequest
  ): Promise<ResolveUserInputResponse> {
    return this.ws.request<ResolveUserInputResponse>('bridge/userInput/resolve', {
      id,
      answers: body.answers,
    });
  }

  execTerminal(body: TerminalExecRequest): Promise<TerminalExecResponse> {
    return this.ws.request<TerminalExecResponse>('bridge/terminal/exec', body);
  }

  gitStatus(cwd?: string): Promise<GitStatusResponse> {
    const normalizedCwd = normalizeCwd(cwd);
    return this.ws.request<GitStatusResponse>('bridge/git/status', {
      cwd: normalizedCwd ?? null,
    });
  }

  gitDiff(cwd?: string): Promise<GitDiffResponse> {
    const normalizedCwd = normalizeCwd(cwd);
    return this.ws.request<GitDiffResponse>('bridge/git/diff', {
      cwd: normalizedCwd ?? null,
    });
  }

  gitCommit(body: GitCommitRequest): Promise<GitCommitResponse> {
    return this.ws.request<GitCommitResponse>('bridge/git/commit', {
      ...body,
      cwd: normalizeCwd(body.cwd) ?? null,
    });
  }

  gitPush(cwd?: string): Promise<GitPushResponse> {
    const normalizedCwd = normalizeCwd(cwd);
    return this.ws.request<GitPushResponse>('bridge/git/push', {
      cwd: normalizedCwd ?? null,
    });
  }

  private mapChatWithCachedTitle(rawThreadValue: unknown): Chat {
    const rawThread = toRawThread(rawThreadValue);
    if (rawThread.id && rawThread.name?.trim()) {
      this.renamedTitles.set(rawThread.id, rawThread.name.trim());
    }

    const mapped = mapChat(rawThread);
    const cachedTitle = this.renamedTitles.get(mapped.id);
    if (!cachedTitle) {
      return mapped;
    }

    return {
      ...mapped,
      title: cachedTitle,
    };
  }

  private async trySetThreadName(
    threadId: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.ws.request<AppServerThreadSetNameResponse>('thread/name/set', payload);
    } catch (error) {
      const message = String((error as Error).message ?? error);
      const expectedFieldMismatch =
        message.includes('threadName') ||
        message.includes('name') ||
        message.includes('missing field') ||
        message.includes('unknown field');

      if (!expectedFieldMismatch) {
        throw error;
      }

      const triedThreadName = Object.prototype.hasOwnProperty.call(payload, 'threadName');
      const nameValue = readString(payload.threadName) ?? readString(payload.name);
      if (!nameValue) {
        throw error;
      }

      const fallbackPayload = triedThreadName
        ? {
            threadId,
            name: nameValue,
          }
        : {
            threadId,
            threadName: nameValue,
          };

      await this.ws.request<AppServerThreadSetNameResponse>('thread/name/set', fallbackPayload);
    }
  }

  private async getChatWithUserMessage(id: string, content: string): Promise<Chat> {
    const normalizedContent = content.trim();
    let latest = await this.getChat(id);
    if (!normalizedContent || chatHasRecentUserMessage(latest, normalizedContent)) {
      return latest;
    }

    const retryDelaysMs = [150, 300, 500, 800];
    for (const delayMs of retryDelaysMs) {
      await sleep(delayMs);
      latest = await this.getChat(id);
      if (chatHasRecentUserMessage(latest, normalizedContent)) {
        return latest;
      }
    }

    return appendSyntheticUserMessage(latest, normalizedContent);
  }
}

function isSubAgentSource(sourceKind: string | undefined): boolean {
  return typeof sourceKind === 'string' && sourceKind.startsWith('subAgent');
}

function normalizeCwd(cwd: string | null | undefined): string | null {
  if (typeof cwd !== 'string') {
    return null;
  }
  const trimmed = cwd.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeModel(model: string | null | undefined): string | null {
  if (typeof model !== 'string') {
    return null;
  }

  const trimmed = model.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeEffort(effort: string | null | undefined): ReasoningEffort | null {
  if (typeof effort !== 'string') {
    return null;
  }

  const normalized = effort.trim().toLowerCase();
  if (
    normalized === 'none' ||
    normalized === 'minimal' ||
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh'
  ) {
    return normalized;
  }

  return null;
}

function toTurnCollaborationMode(
  value: CollaborationMode | string | null | undefined,
  model: string | null,
  effort: ReasoningEffort | null
): AppServerCollaborationMode | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized !== 'plan') {
    return null;
  }

  if (!model) {
    return null;
  }

  return {
    mode: 'plan',
    settings: {
      model,
      reasoning_effort: effort,
      developer_instructions: null,
    },
  };
}

function toReasoningEffortOptions(raw: unknown): ModelReasoningEffortOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const options: ModelReasoningEffortOption[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const directEffort = normalizeEffort(entry);
      if (directEffort) {
        options.push({
          effort: directEffort,
        });
      }
      continue;
    }

    const record = toRecord(entry);
    if (!record) {
      continue;
    }

    const effort = normalizeEffort(
      readString(record.reasoningEffort) ?? readString(record.effort)
    );
    if (!effort) {
      continue;
    }

    options.push({
      effort,
      description: readString(record.description) ?? undefined,
    });
  }

  return options;
}

function chatHasRecentUserMessage(chat: Chat, content: string, tailSize = 8): boolean {
  const normalized = content.trim();
  if (!normalized) {
    return true;
  }

  const tail = chat.messages.slice(-tailSize);
  return tail.some(
    (message) => message.role === 'user' && message.content.trim() === normalized
  );
}

function appendSyntheticUserMessage(chat: Chat, content: string): Chat {
  const normalized = content.trim();
  if (!normalized || chatHasRecentUserMessage(chat, normalized)) {
    return chat;
  }

  const createdAt = new Date().toISOString();
  return {
    ...chat,
    updatedAt: createdAt,
    lastMessagePreview: normalized.slice(0, 120),
    messages: [
      ...chat.messages,
      {
        id: `local-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: normalized,
        createdAt,
      },
    ],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
