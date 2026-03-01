import {
  mapChat,
  mapChatSummary,
  readString,
  toRecord,
  type RawThread,
  toRawThread,
} from './chatMapping';
import type {
  ApprovalPolicy,
  ApprovalDecision,
  CollaborationMode,
  CreateChatRequest,
  Chat,
  ChatSummary,
  GitCommitRequest,
  GitCommitResponse,
  GitDiffResponse,
  GitFileRequest,
  GitPushResponse,
  GitStageAllResponse,
  GitStageResponse,
  GitStatusResponse,
  GitUnstageAllResponse,
  GitUnstageResponse,
  PendingApproval,
  ResolveApprovalResponse,
  ResolveUserInputRequest,
  ResolveUserInputResponse,
  SendChatMessageRequest,
  MentionInput,
  LocalImageInput,
  UploadAttachmentRequest,
  UploadAttachmentResponse,
  VoiceTranscribeRequest,
  VoiceTranscribeResponse,
  ModelOption,
  ReasoningEffort,
  ModelReasoningEffortOption,
  TerminalExecRequest,
  TerminalExecResponse,
} from './types';
import type { HostBridgeWsClient } from './ws';

interface HealthResponse {
  status: 'ok';
  at: string;
  uptimeSec: number;
}

interface ApiClientOptions {
  ws: HostBridgeWsClient;
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

interface ChatSnapshot {
  rawThread: RawThread;
  chat: Chat;
}

interface TurnInputText {
  type: 'text';
  text: string;
  text_elements: [];
}

interface TurnInputMention {
  type: 'mention';
  name: string;
  path: string;
}

interface TurnInputLocalImage {
  type: 'localImage';
  path: string;
}

interface SendChatMessageOptions {
  onTurnStarted?: (turnId: string) => void;
}

const ACTIVE_TURN_STATUSES = new Set([
  'inprogress',
  'in_progress',
  'running',
  'active',
  'queued',
  'pending',
]);

export class HostBridgeApiClient {
  private readonly ws: HostBridgeWsClient;
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
    const requestedApprovalPolicy = normalizeApprovalPolicy(body.approvalPolicy) ?? 'untrusted';
    const started = await this.ws.request<AppServerStartResponse>('thread/start', {
      model: requestedModel ?? null,
      modelProvider: null,
      cwd: requestedCwd ?? null,
      approvalPolicy: requestedApprovalPolicy,
      sandbox: 'workspace-write',
      config: null,
      baseInstructions: null,
      developerInstructions: MOBILE_DEVELOPER_INSTRUCTIONS,
      personality: null,
      ephemeral: null,
      experimentalRawEvents: true,
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
        approvalPolicy: requestedApprovalPolicy,
      });
    }

    if (started.thread) {
      return this.mapChatWithCachedTitle(started.thread);
    }

    return this.getChat(chatId);
  }

  async getChat(id: string): Promise<Chat> {
    const snapshot = await this.readChatSnapshot(id);
    return snapshot.chat;
  }

  async getChatSummary(id: string): Promise<ChatSummary> {
    const response = await this.ws.request<AppServerReadResponse>('thread/read', {
      threadId: id,
      includeTurns: false,
    });
    const rawThread = toRawThread(response.thread);
    if (rawThread.id && rawThread.name?.trim()) {
      this.renamedTitles.set(rawThread.id, rawThread.name.trim());
    }

    const mapped = mapChatSummary(rawThread);
    if (!mapped) {
      throw new Error('chat id missing in app-server response');
    }

    const cachedTitle = this.renamedTitles.get(mapped.id);
    if (!cachedTitle) {
      return mapped;
    }

    return {
      ...mapped,
      title: cachedTitle,
    };
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

    await this.resumeThread(id, {
      cwd: normalizedCwd,
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

  async resumeThread(
    id: string,
    options?: {
      cwd?: string | null;
      model?: string | null;
      approvalPolicy?: ApprovalPolicy | null;
    }
  ): Promise<void> {
    const threadId = id.trim();
    if (!threadId) {
      throw new Error('thread id is required');
    }
    const requestedApprovalPolicy =
      normalizeApprovalPolicy(options?.approvalPolicy) ?? 'untrusted';
    const fallbackApprovalPolicy =
      requestedApprovalPolicy === 'never' ? 'never' : 'on-request';

    const primaryRequest = {
      threadId,
      history: null,
      path: null,
      model: normalizeModel(options?.model) ?? null,
      modelProvider: null,
      cwd: normalizeCwd(options?.cwd) ?? null,
      approvalPolicy: requestedApprovalPolicy,
      sandbox: 'workspace-write',
      config: null,
      baseInstructions: null,
      developerInstructions: MOBILE_DEVELOPER_INSTRUCTIONS,
      personality: null,
      experimentalRawEvents: true,
      persistExtendedHistory: true,
    };

    try {
      await this.ws.request('thread/resume', primaryRequest);
      return;
    } catch (primaryError) {
      // First fallback: keep raw-event streaming enabled, but relax approval policy.
      const compatibilityRequest = {
        ...primaryRequest,
        approvalPolicy: fallbackApprovalPolicy,
      };
      try {
        await this.ws.request('thread/resume', compatibilityRequest);
        return;
      } catch (compatibilityError) {
        // Final compatibility fallback for older app-server builds that reject
        // experimentalRawEvents/developerInstructions on resume.
        const legacyRequest = {
          ...compatibilityRequest,
          developerInstructions: null,
        };
        delete (legacyRequest as { experimentalRawEvents?: boolean }).experimentalRawEvents;
        try {
          await this.ws.request('thread/resume', legacyRequest);
          return;
        } catch (legacyError) {
          throw new Error(
            `thread/resume failed: ${(primaryError as Error).message}; compatibility failed: ${(compatibilityError as Error).message}; legacy fallback failed: ${(legacyError as Error).message}`
          );
        }
      }
    }
  }

  async sendChatMessage(
    id: string,
    body: SendChatMessageRequest,
    options?: SendChatMessageOptions
  ): Promise<Chat> {
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
    const normalizedApprovalPolicy = normalizeApprovalPolicy(body.approvalPolicy);
    const normalizedMentions = normalizeMentions(body.mentions);
    const normalizedLocalImages = normalizeLocalImages(body.localImages);
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
      await this.resumeThread(id, {
        model: effectiveModel,
        cwd: normalizedCwd,
        approvalPolicy: normalizedApprovalPolicy,
      });
    } catch {
      // Best effort: turn/start still works for recently started chats.
    }

    const turnStart = await this.ws.request<AppServerTurnResponse>('turn/start', {
      threadId: id,
      input: buildTurnInput(content, normalizedMentions, normalizedLocalImages),
      cwd: normalizedCwd ?? null,
      approvalPolicy: normalizedApprovalPolicy ?? null,
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
    options?.onTurnStarted?.(turnId);
    return this.getChatWithUserMessage(id, turnId, content);
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const normalizedThreadId = threadId.trim();
    const normalizedTurnId = turnId.trim();
    if (!normalizedThreadId || !normalizedTurnId) {
      throw new Error('threadId and turnId are required to interrupt a turn');
    }

    await this.ws.request<Record<string, never>>('turn/interrupt', {
      threadId: normalizedThreadId,
      turnId: normalizedTurnId,
    });
  }

  async interruptLatestTurn(threadId: string): Promise<string | null> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error('threadId is required to interrupt the active turn');
    }

    const snapshot = await this.readChatSnapshot(normalizedThreadId);
    const turns = Array.isArray(snapshot.rawThread.turns) ? snapshot.rawThread.turns : [];
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i];
      const turnId = readString(turn.id);
      const status = normalizeTurnStatus(readString(turn.status));
      if (!turnId || !status || !ACTIVE_TURN_STATUSES.has(status)) {
        continue;
      }

      await this.interruptTurn(normalizedThreadId, turnId);
      return turnId;
    }

    return null;
  }

  uploadAttachment(body: UploadAttachmentRequest): Promise<UploadAttachmentResponse> {
    return this.ws.request<UploadAttachmentResponse>('bridge/attachments/upload', body);
  }

  transcribeVoice(body: VoiceTranscribeRequest): Promise<VoiceTranscribeResponse> {
    return this.ws.request<VoiceTranscribeResponse>('bridge/voice/transcribe', body);
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
      approvalPolicy?: ApprovalPolicy | null;
    }
  ): Promise<Chat> {
    const requestedApprovalPolicy =
      normalizeApprovalPolicy(options?.approvalPolicy) ?? 'untrusted';
    const response = await this.ws.request<AppServerForkResponse>('thread/fork', {
      threadId: id,
      path: null,
      model: normalizeModel(options?.model) ?? null,
      modelProvider: null,
      cwd: normalizeCwd(options?.cwd) ?? null,
      approvalPolicy: requestedApprovalPolicy,
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

  gitStage(body: GitFileRequest): Promise<GitStageResponse> {
    const path = body.path.trim();
    if (!path) {
      return Promise.reject(new Error('path must not be empty'));
    }

    return this.ws.request<GitStageResponse>('bridge/git/stage', {
      path,
      cwd: normalizeCwd(body.cwd) ?? null,
    });
  }

  gitStageAll(cwd?: string): Promise<GitStageAllResponse> {
    const normalizedCwd = normalizeCwd(cwd);
    return this.ws.request<GitStageAllResponse>('bridge/git/stageAll', {
      cwd: normalizedCwd ?? null,
    });
  }

  gitUnstage(body: GitFileRequest): Promise<GitUnstageResponse> {
    const path = body.path.trim();
    if (!path) {
      return Promise.reject(new Error('path must not be empty'));
    }

    return this.ws.request<GitUnstageResponse>('bridge/git/unstage', {
      path,
      cwd: normalizeCwd(body.cwd) ?? null,
    });
  }

  gitUnstageAll(cwd?: string): Promise<GitUnstageAllResponse> {
    const normalizedCwd = normalizeCwd(cwd);
    return this.ws.request<GitUnstageAllResponse>('bridge/git/unstageAll', {
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

  private async readChatSnapshot(id: string): Promise<ChatSnapshot> {
    try {
      const response = await this.ws.request<AppServerReadResponse>('thread/read', {
        threadId: id,
        includeTurns: true,
      });
      const rawThread = toRawThread(response.thread);
      return {
        rawThread,
        chat: this.mapChatWithCachedTitle(rawThread),
      };
    } catch (error) {
      if (!isMaterializationGapError(error)) {
        throw error;
      }

      const response = await this.ws.request<AppServerReadResponse>('thread/read', {
        threadId: id,
        includeTurns: false,
      });
      const rawThread = toRawThread(response.thread);
      return {
        rawThread,
        chat: this.mapChatWithCachedTitle(rawThread),
      };
    }
  }

  private async getChatWithUserMessage(
    id: string,
    turnId: string,
    content: string
  ): Promise<Chat> {
    const normalizedContent = content.trim();
    let latestSnapshot = await this.readChatSnapshot(id);
    let latest = latestSnapshot.chat;

    if (!normalizedContent) {
      return latest;
    }

    const hasMatchingTurnMessage = rawThreadHasTurnUserMessage(
      latestSnapshot.rawThread,
      turnId,
      normalizedContent
    );
    const hasFallbackRecentMessage =
      !rawThreadHasTurns(latestSnapshot.rawThread) &&
      chatHasRecentUserMessage(latest, normalizedContent);
    if (hasMatchingTurnMessage || hasFallbackRecentMessage) {
      return latest;
    }

    const retryDelaysMs = [150, 300, 500, 800];
    for (const delayMs of retryDelaysMs) {
      await sleep(delayMs);
      latestSnapshot = await this.readChatSnapshot(id);
      latest = latestSnapshot.chat;

      const matchedAfterRetry = rawThreadHasTurnUserMessage(
        latestSnapshot.rawThread,
        turnId,
        normalizedContent
      );
      const matchedByFallback =
        !rawThreadHasTurns(latestSnapshot.rawThread) &&
        chatHasRecentUserMessage(latest, normalizedContent);
      if (matchedAfterRetry || matchedByFallback) {
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

function normalizeApprovalPolicy(
  policy: string | null | undefined
): ApprovalPolicy | null {
  if (typeof policy !== 'string') {
    return null;
  }

  const normalized = policy.trim().toLowerCase();
  if (
    normalized === 'untrusted' ||
    normalized === 'on-request' ||
    normalized === 'on-failure' ||
    normalized === 'never'
  ) {
    return normalized;
  }

  return null;
}

function normalizeTurnStatus(status: string | null): string | null {
  if (!status) {
    return null;
  }

  const normalized = status.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function buildTurnInput(
  content: string,
  mentions: TurnInputMention[],
  localImages: TurnInputLocalImage[]
): Array<TurnInputText | TurnInputMention | TurnInputLocalImage> {
  const textInput: TurnInputText = {
    type: 'text',
    text: content,
    text_elements: [],
  };

  if (mentions.length === 0 && localImages.length === 0) {
    return [textInput];
  }

  return [textInput, ...mentions, ...localImages];
}

function normalizeMentions(raw: MentionInput[] | undefined): TurnInputMention[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const normalized: TurnInputMention[] = [];
  const seenPaths = new Set<string>();

  for (const entry of raw) {
    if (!entry || typeof entry.path !== 'string') {
      continue;
    }

    const path = entry.path.trim();
    if (!path) {
      continue;
    }

    const dedupeKey = path.toLowerCase();
    if (seenPaths.has(dedupeKey)) {
      continue;
    }
    seenPaths.add(dedupeKey);

    const name = normalizeMentionName(entry.name, path);
    normalized.push({
      type: 'mention',
      name,
      path,
    });
  }

  return normalized;
}

function normalizeMentionName(name: string | undefined, path: string): string {
  if (typeof name === 'string') {
    const trimmed = name.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  const pathSegments = path.split(/[\\/]/).filter(Boolean);
  const inferred = pathSegments[pathSegments.length - 1];
  if (typeof inferred === 'string' && inferred.trim().length > 0) {
    return inferred.trim();
  }

  return path;
}

function normalizeLocalImages(raw: LocalImageInput[] | undefined): TurnInputLocalImage[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const normalized: TurnInputLocalImage[] = [];
  const seenPaths = new Set<string>();

  for (const entry of raw) {
    if (!entry || typeof entry.path !== 'string') {
      continue;
    }

    const path = entry.path.trim();
    if (!path) {
      continue;
    }

    const dedupeKey = path.toLowerCase();
    if (seenPaths.has(dedupeKey)) {
      continue;
    }
    seenPaths.add(dedupeKey);

    normalized.push({
      type: 'localImage',
      path,
    });
  }

  return normalized;
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

function rawThreadHasTurns(rawThread: RawThread): boolean {
  return Array.isArray(rawThread.turns) && rawThread.turns.length > 0;
}

function rawThreadHasTurnUserMessage(
  rawThread: RawThread,
  turnId: string,
  content: string
): boolean {
  const normalizedContent = content.trim();
  const normalizedTurnId = turnId.trim();
  if (!normalizedContent || !normalizedTurnId) {
    return false;
  }

  const turns = Array.isArray(rawThread.turns) ? rawThread.turns : [];
  const matchedTurn = turns.find((turn) => turn.id === normalizedTurnId);
  if (!matchedTurn || !Array.isArray(matchedTurn.items)) {
    return false;
  }

  return matchedTurn.items.some((item) => {
    const record = toRecord(item);
    if (!record || readString(record.type) !== 'userMessage') {
      return false;
    }

    return extractUserMessageText(record.content).trim() === normalizedContent;
  });
}

function extractUserMessageText(value: unknown): string {
  if (!Array.isArray(value)) {
    return '';
  }

  return value
    .map((entry) => {
      const record = toRecord(entry);
      if (!record) {
        return '';
      }

      if (readString(record.type) !== 'text') {
        return '';
      }

      return readString(record.text) ?? '';
    })
    .filter((part) => part.length > 0)
    .join('\n');
}

function appendSyntheticUserMessage(chat: Chat, content: string): Chat {
  const normalized = content.trim();
  if (!normalized) {
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

function isMaterializationGapError(error: unknown): boolean {
  const message = String((error as Error).message ?? error);
  return (
    message.includes('includeTurns') &&
    (message.includes('material') || message.includes('materialis'))
  );
}
