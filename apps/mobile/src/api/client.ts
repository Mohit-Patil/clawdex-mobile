import {
  isGeneratedCursorThreadTitle,
  mapChat,
  mapChatSummary,
  readString,
  toRecord,
  type RawThread,
  toRawThread,
} from './chatMapping';
import { readAccountLoginStartResponse, readAccountSnapshot } from './account';
import { readAccountRateLimits as readSelectedAccountRateLimits } from './rateLimits';
import type {
  AccountLoginStartResponse,
  AccountSnapshot,
  AccountRateLimitSnapshot,
  ApprovalPolicy,
  ApprovalDecision,
  BrowserPreviewDiscoveryResponse,
  BrowserPreviewSession,
  BridgeCapabilities,
  BridgeStatus,
  BridgeThreadQueueActionResponse,
  BridgeThreadQueueSendResponse,
  BridgeThreadQueueState,
  DismissBridgeUiSurfaceResponse,
  BridgeRuntimeInfo,
  BridgeRestartStartResponse,
  BridgeUpdateStartResponse,
  ChatEngine,
  CodexAppServerRestartResponse,
  CursorCredentialStatus,
  CollaborationMode,
  CreateChatRequest,
  Chat,
  ChatSummary,
  GitBranchesResponse,
  GitCloneRequest,
  GitCloneResponse,
  GitCommitRequest,
  GitCommitResponse,
  GitDiffResponse,
  GitHistoryResponse,
  GitHubAuthGrantInput,
  GitHubAuthInstallResponse,
  GitFileRequest,
  GitPushResponse,
  GitStageAllResponse,
  GitStageResponse,
  GitStatusResponse,
  GitSwitchRequest,
  GitSwitchResponse,
  GitUnstageAllResponse,
  GitUnstageResponse,
  PendingApproval,
  ResolveApprovalResponse,
  ResolveBridgeUiSurfaceRequest,
  ResolveBridgeUiSurfaceResponse,
  ResolveUserInputRequest,
  ResolveUserInputResponse,
  SendChatMessageRequest,
  SteerChatTurnRequest,
  MentionInput,
  LocalImageInput,
  UploadAttachmentRequest,
  UploadAttachmentResponse,
  VoiceTranscribeRequest,
  VoiceTranscribeResponse,
  ModelOption,
  ReasoningEffort,
  ModelReasoningEffortOption,
  RpcNotification,
  ServiceTier,
  TerminalExecRequest,
  TerminalExecResponse,
  WorkspaceListResponse,
  FileSystemListRequest,
  FileSystemListResponse,
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
  nextCursor?: string | null;
  backwardsCursor?: string | null;
  next_cursor?: string | null;
  backwards_cursor?: string | null;
}

interface ThreadListStreamStartResponse {
  streamId?: string;
  started?: boolean;
}

interface AppServerLoadedThreadListResponse {
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

interface AppServerConfigReadResponse {
  config?: unknown;
}

interface AppServerAccountReadResponse {
  account?: unknown;
  requiresOpenaiAuth?: boolean;
  requires_openai_auth?: boolean;
}

interface AppServerCollaborationMode {
  mode: 'plan' | 'default' | 'ask';
  settings: {
    model: string;
    reasoning_effort: ReasoningEffort | null;
    developer_instructions: string | null;
  };
}

interface AppServerThreadRuntimeSettings {
  model: string | null;
  effort: ReasoningEffort | null;
}

interface CursorCredentialStatusResponse {
  configured?: boolean;
  valid?: boolean | null;
  source?: string | null;
  apiKeyName?: string | null;
  api_key_name?: string | null;
  userEmail?: string | null;
  user_email?: string | null;
  createdAt?: string | null;
  created_at?: string | null;
  enabled?: boolean;
  runtimeAvailable?: boolean;
  runtime_available?: boolean;
  active?: boolean;
  error?: string | null;
}

type AppServerThreadSetNameResponse = Record<string, never>;

const CHAT_LIST_SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'unknown'] as const;
const CHAT_LIST_SOURCE_KINDS_WITH_SUBAGENTS = [
  ...CHAT_LIST_SOURCE_KINDS,
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
] as const;
const MOBILE_DEVELOPER_INSTRUCTIONS =
  'When you need clarification, call request_user_input instead of asking only in plain text. Provide 2-3 concise options whenever possible and use isOther when free-form input is appropriate.';
const MOBILE_DEFAULT_SANDBOX = 'danger-full-access';
const THREAD_LIST_STREAM_BATCH_METHOD = 'bridge/thread/list/stream/batch';
const THREAD_LIST_STREAM_ERROR_METHOD = 'bridge/thread/list/stream/error';
const DEFAULT_CHAT_SUMMARY_HYDRATION_CONCURRENCY = 4;
const MAX_CHAT_SUMMARY_HYDRATION_CONCURRENCY = 8;
const TRANSIENT_THREAD_READ_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

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

interface PreparedTurnRequest {
  content: string;
  mentions: TurnInputMention[];
  localImages: TurnInputLocalImage[];
  turnStartParams: Record<string, unknown>;
}

interface PrepareTurnRequestOptions {
  skipResume?: boolean;
}

export type SendOrQueueChatMessageResult =
  | {
      disposition: 'queued';
      queue: BridgeThreadQueueState;
      turnId: null;
      chat: null;
    }
  | {
      disposition: 'sent';
      queue: BridgeThreadQueueState;
      turnId: string;
      chat: Chat;
    };

interface ListChatsOptions {
  includeSubAgents?: boolean;
  limit?: number;
  cacheTtlMs?: number;
  forceRefresh?: boolean;
}

interface ChatListPageOptions extends ListChatsOptions {
  cursor?: string | null;
}

interface ChatListPage {
  chats: ChatSummary[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

interface ListAllChatsOptions {
  includeSubAgents?: boolean;
  pageLimit?: number;
  cacheTtlMs?: number;
  forceRefresh?: boolean;
  onPage?: (chats: ChatSummary[], page: ChatListPage) => void;
}

interface ChatListStreamOptions {
  includeSubAgents?: boolean;
  limits?: number[];
  delayMs?: number;
}

interface ChatListStreamBatch {
  streamId: string;
  limit: number;
  done: boolean;
  chats: ChatSummary[];
}

interface ChatListStreamController {
  streamId: string;
  cancel: () => void;
}

interface AccountRateLimitsReadOptions {
  cacheTtlMs?: number;
  forceRefresh?: boolean;
}

interface AccountReadOptions {
  refreshToken?: boolean;
}

interface AccountLoginCompletedNotification {
  loginId: string | null;
  success: boolean;
  error: string | null;
}

interface ChatReadOptions {
  cacheTtlMs?: number;
  forceRefresh?: boolean;
}

interface ChatSummariesReadOptions {
  concurrency?: number;
}

interface CacheEntry<T> {
  value: T;
  loadedAt: number;
}

const DEFAULT_PREFETCH_CACHE_TTL_MS = 30_000;
const DEFAULT_CHAT_LIST_LIMIT = 20;
const DEFAULT_SUB_AGENT_CHAT_LIST_LIMIT = 50;
const CHAT_LIST_STREAM_INITIAL_LIMIT = 5;

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
  private readonly chatListCache = new Map<string, CacheEntry<ChatSummary[]>>();
  private readonly chatListInFlight = new Map<string, Promise<ChatSummary[]>>();
  private readonly allChatListCache = new Map<string, CacheEntry<ChatSummary[]>>();
  private readonly allChatListInFlight = new Map<string, Promise<ChatSummary[]>>();
  private readonly chatCache = new Map<string, CacheEntry<Chat>>();
  private readonly chatInFlight = new Map<string, Promise<Chat>>();
  private accountRateLimitsCache: CacheEntry<AccountRateLimitSnapshot | null> | null = null;
  private accountRateLimitsInFlight: Promise<AccountRateLimitSnapshot | null> | null = null;

  constructor(options: ApiClientOptions) {
    this.ws = options.ws;
  }

  health(): Promise<HealthResponse> {
    return this.ws.request<HealthResponse>('bridge/health/read');
  }

  readBridgeStatus(): Promise<BridgeStatus> {
    return this.ws.request<BridgeStatus>('bridge/status/read');
  }

  readBridgeCapabilities(): Promise<BridgeCapabilities> {
    return this.ws.request<BridgeCapabilities>('bridge/capabilities/read');
  }

  readBridgeRuntime(): Promise<BridgeRuntimeInfo> {
    return this.ws.request<BridgeRuntimeInfo>('bridge/runtime/read');
  }

  async readCursorCredentials(): Promise<CursorCredentialStatus> {
    const response = await this.ws.request<CursorCredentialStatusResponse>(
      'bridge/cursor/credentials/read'
    );
    return readCursorCredentialStatus(response);
  }

  startBridgeUpdate(version = 'latest'): Promise<BridgeUpdateStartResponse> {
    return this.ws.request<BridgeUpdateStartResponse>('bridge/update/start', {
      version,
    });
  }

  startBridgeRestart(): Promise<BridgeRestartStartResponse> {
    return this.ws.request<BridgeRestartStartResponse>('bridge/restart/start');
  }

  restartCodexAppServer(): Promise<CodexAppServerRestartResponse> {
    return this.ws.request<CodexAppServerRestartResponse>('bridge/codex/app-server/restart');
  }

  peekAccountRateLimits(): AccountRateLimitSnapshot | null {
    return this.accountRateLimitsCache?.value ?? null;
  }

  rememberAccountRateLimits(snapshot: AccountRateLimitSnapshot | null): void {
    this.accountRateLimitsCache = {
      value: snapshot,
      loadedAt: Date.now(),
    };
  }

  primeAccountRateLimits(
    options?: AccountRateLimitsReadOptions
  ): Promise<AccountRateLimitSnapshot | null> {
    return this.readAccountRateLimits({
      cacheTtlMs: DEFAULT_PREFETCH_CACHE_TTL_MS,
      ...options,
    });
  }

  async readAccountRateLimits(
    options: AccountRateLimitsReadOptions = {}
  ): Promise<AccountRateLimitSnapshot | null> {
    const cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 0);
    if (!options.forceRefresh && cacheTtlMs > 0 && this.accountRateLimitsCache) {
      const ageMs = Date.now() - this.accountRateLimitsCache.loadedAt;
      if (ageMs <= cacheTtlMs) {
        return this.accountRateLimitsCache.value;
      }
    }

    if (this.accountRateLimitsInFlight) {
      return this.accountRateLimitsInFlight;
    }

    const request = this.ws
      .request<Record<string, unknown>>('account/rateLimits/read')
      .then((response) => {
        const snapshot = readSelectedAccountRateLimits(response);
        this.rememberAccountRateLimits(snapshot);
        return snapshot;
      })
      .finally(() => {
        this.accountRateLimitsInFlight = null;
      });

    this.accountRateLimitsInFlight = request;
    return request;
  }

  async readAccount(options: AccountReadOptions = {}): Promise<AccountSnapshot> {
    const response = await this.ws.request<AppServerAccountReadResponse>('account/read', {
      refreshToken: options.refreshToken === true,
    });
    return readAccountSnapshot(response);
  }

  async startChatGptAccountLogin(): Promise<AccountLoginStartResponse> {
    const response = await this.ws.request<Record<string, unknown>>('account/login/start', {
      type: 'chatgpt',
      codexStreamlinedLogin: true,
    });
    return readAccountLoginStartResponse(response);
  }

  async startChatGptDeviceCodeAccountLogin(): Promise<AccountLoginStartResponse> {
    const response = await this.ws.request<Record<string, unknown>>('account/login/start', {
      type: 'chatgptDeviceCode',
    });
    return readAccountLoginStartResponse(response);
  }

  async forwardCodexAuthCallback(callbackUrl: string): Promise<void> {
    await this.ws.request('bridge/codex/auth/callback/forward', {
      callbackUrl,
    });
  }

  async waitForAccountLoginCompleted(
    loginId: string | null,
    timeoutMs = 90_000
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe = () => {};
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        unsubscribe();
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };

      timeout = setTimeout(() => {
        finish(new Error('Codex login did not finish. Return here after ChatGPT confirms login.'));
      }, timeoutMs);

      unsubscribe = this.ws.onEvent((event: RpcNotification) => {
        if (event.method !== 'account/login/completed') {
          return;
        }

        const completion = readAccountLoginCompletedNotification(event.params);
        if (!completion) {
          return;
        }

        if (loginId && completion.loginId && completion.loginId !== loginId) {
          return;
        }

        if (!completion.success) {
          finish(new Error(completion.error ?? 'Codex login did not complete.'));
          return;
        }

        finish();
      });
    });
  }

  async loginWithChatGptAuthTokens(input: {
    accessToken: string;
    chatgptAccountId: string;
    chatgptPlanType?: string | null;
  }): Promise<AccountLoginStartResponse> {
    const response = await this.ws.request<Record<string, unknown>>('account/login/start', {
      type: 'chatgptAuthTokens',
      accessToken: input.accessToken,
      chatgptAccountId: input.chatgptAccountId,
      chatgptPlanType: input.chatgptPlanType ?? null,
    });
    return readAccountLoginStartResponse(response);
  }

  async cancelAccountLogin(loginId: string): Promise<void> {
    await this.ws.request('account/login/cancel', { loginId });
  }

  async logoutAccount(): Promise<void> {
    await this.ws.request('account/logout');
  }

  peekChats(options: ListChatsOptions = {}): ChatSummary[] | null {
    const cached = this.chatListCache.get(this.chatListCacheKey(options));
    return cached ? cloneChatSummaries(cached.value) : null;
  }

  rememberChats(chats: ChatSummary[], options: ListChatsOptions = {}): void {
    this.chatListCache.set(this.chatListCacheKey(options), {
      value: cloneChatSummaries(chats),
      loadedAt: Date.now(),
    });

    if (chats.length > 0) {
      this.mergeIntoAllChatListCaches(chats);
    }
  }

  peekAllChats(options: ListAllChatsOptions = {}): ChatSummary[] | null {
    const cached = this.allChatListCache.get(this.allChatListCacheKey(options));
    return cached ? cloneChatSummaries(cached.value) : null;
  }

  rememberAllChats(chats: ChatSummary[], options: ListAllChatsOptions = {}): void {
    this.allChatListCache.set(this.allChatListCacheKey(options), {
      value: cloneChatSummaries(chats),
      loadedAt: Date.now(),
    });
  }

  peekChat(id: string): Chat | null {
    const cached = this.chatCache.get(id.trim());
    return cached ? cloneChat(cached.value) : null;
  }

  peekChatSummary(id: string): ChatSummary | null {
    const threadId = id.trim();
    if (!threadId) {
      return null;
    }

    const cachedChat = this.chatCache.get(threadId);
    if (cachedChat) {
      return cloneChatSummary(cachedChat.value);
    }

    for (const cachedList of this.chatListCache.values()) {
      const match = cachedList.value.find((chat) => chat.id === threadId);
      if (match) {
        return cloneChatSummary(match);
      }
    }

    for (const cachedList of this.allChatListCache.values()) {
      const match = cachedList.value.find((chat) => chat.id === threadId);
      if (match) {
        return cloneChatSummary(match);
      }
    }

    return null;
  }

  peekChatShell(id: string): Chat | null {
    const cachedChat = this.peekChat(id);
    if (cachedChat) {
      return cachedChat;
    }

    const summary = this.peekChatSummary(id);
    return summary ? chatShellFromSummary(summary) : null;
  }

  rememberChat(chat: Chat): void {
    const cloned = cloneChat(chat);
    this.chatCache.set(chat.id, {
      value: cloned,
      loadedAt: Date.now(),
    });

    for (const [key, cachedList] of this.chatListCache.entries()) {
      const index = cachedList.value.findIndex((entry) => entry.id === chat.id);
      if (index < 0) {
        continue;
      }

      const nextList = cloneChatSummaries(cachedList.value);
      nextList[index] = cloneChatSummary(chat);
      this.chatListCache.set(key, {
        value: nextList,
        loadedAt: cachedList.loadedAt,
      });
    }

    for (const [key, cachedList] of this.allChatListCache.entries()) {
      const index = cachedList.value.findIndex((entry) => entry.id === chat.id);
      if (index < 0) {
        continue;
      }

      const nextList = cloneChatSummaries(cachedList.value);
      nextList[index] = cloneChatSummary(chat);
      this.allChatListCache.set(key, {
        value: nextList,
        loadedAt: cachedList.loadedAt,
      });
    }
  }

  primeChats(options: ListChatsOptions = {}): Promise<ChatSummary[]> {
    return this.listChats({
      cacheTtlMs: DEFAULT_PREFETCH_CACHE_TTL_MS,
      ...options,
    });
  }

  async listChats(options: ListChatsOptions = {}): Promise<ChatSummary[]> {
    const cacheKey = this.chatListCacheKey(options);
    const cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 0);
    const cached = this.chatListCache.get(cacheKey);
    if (!options.forceRefresh && cacheTtlMs > 0 && cached) {
      const ageMs = Date.now() - cached.loadedAt;
      if (ageMs <= cacheTtlMs) {
        return cloneChatSummaries(cached.value);
      }
    }

    const inFlight = this.chatListInFlight.get(cacheKey);
    if (inFlight) {
      return cloneChatSummaries(await inFlight);
    }

    const request = this.fetchChats(options).finally(() => {
      this.chatListInFlight.delete(cacheKey);
    });

    this.chatListInFlight.set(cacheKey, request);
    return cloneChatSummaries(await request);
  }

  async listAllChats(options: ListAllChatsOptions = {}): Promise<ChatSummary[]> {
    const cacheKey = this.allChatListCacheKey(options);
    const cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 0);
    const cached = this.allChatListCache.get(cacheKey);
    if (!options.forceRefresh && cacheTtlMs > 0 && cached) {
      const ageMs = Date.now() - cached.loadedAt;
      if (ageMs <= cacheTtlMs) {
        return cloneChatSummaries(cached.value);
      }
    }

    const inFlight = this.allChatListInFlight.get(cacheKey);
    if (inFlight) {
      return cloneChatSummaries(await inFlight);
    }

    const request = this.fetchAllChats(options).finally(() => {
      this.allChatListInFlight.delete(cacheKey);
    });
    this.allChatListInFlight.set(cacheKey, request);
    return cloneChatSummaries(await request);
  }

  async startChatListStream(
    options: ChatListStreamOptions = {},
    onBatch: (batch: ChatListStreamBatch) => void,
    onError?: (error: Error) => void
  ): Promise<ChatListStreamController> {
    const includeSubAgents = options.includeSubAgents === true;
    const limits = normalizeChatListStreamLimits(
      options.limits,
      includeSubAgents ? DEFAULT_SUB_AGENT_CHAT_LIST_LIMIT : DEFAULT_CHAT_LIST_LIMIT
    );
    const streamId = `mobile-thread-list-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    let closed = false;

    const unsubscribe = this.ws.onEvent((event: RpcNotification) => {
      const params = toRecord(event.params);
      if (!params || readString(params.streamId) !== streamId) {
        return;
      }

      if (event.method === THREAD_LIST_STREAM_ERROR_METHOD) {
        closed = true;
        unsubscribe();
        onError?.(new Error(readString(params.error) ?? 'thread list stream failed'));
        return;
      }

      if (event.method !== THREAD_LIST_STREAM_BATCH_METHOD) {
        return;
      }

      const limit = normalizeListLimit(params.limit);
      const rawList = Array.isArray(params.data) ? params.data : [];
      const chats = this.mapChatListItems(rawList, includeSubAgents);
      this.rememberChats(chats, {
        includeSubAgents,
        limit,
      });

      onBatch({
        streamId,
        limit,
        done: params.done === true,
        chats,
      });

      if (params.done === true) {
        closed = true;
        unsubscribe();
      }
    });

    const cancel = () => {
      if (closed) {
        return;
      }
      closed = true;
      unsubscribe();
      void this.ws
        .request('bridge/thread/list/stream/cancel', {
          streamId,
        })
        .catch(() => {});
    };

    try {
      const response = await this.ws.request<ThreadListStreamStartResponse>(
        'bridge/thread/list/stream/start',
        {
          streamId,
          includeSubAgents,
          limits,
          delayMs:
            typeof options.delayMs === 'number' && Number.isFinite(options.delayMs)
              ? Math.max(0, Math.round(options.delayMs))
              : undefined,
        }
      );
      if (readString(response.streamId) !== streamId || response.started === false) {
        cancel();
        throw new Error('thread list stream did not start');
      }
    } catch (error) {
      cancel();
      throw error;
    }

    return {
      streamId,
      cancel,
    };
  }

  private async fetchChats(options: ListChatsOptions): Promise<ChatSummary[]> {
    const page = await this.fetchChatPage(options);
    this.rememberChats(page.chats, options);
    return page.chats;
  }

  private async fetchAllChats(options: ListAllChatsOptions): Promise<ChatSummary[]> {
    const includeSubAgents = options.includeSubAgents === true;
    const pageLimit = normalizeListLimit(
      options.pageLimit ??
        (includeSubAgents ? DEFAULT_SUB_AGENT_CHAT_LIST_LIMIT : DEFAULT_CHAT_LIST_LIMIT)
    );
    let cursor: string | null = null;
    let chats: ChatSummary[] = [];

    do {
      const page = await this.fetchChatPage({
        includeSubAgents,
        limit: pageLimit,
        cursor,
        forceRefresh: true,
      });
      chats = mergeChatSummariesById(chats, page.chats);
      if (options.onPage) {
        options.onPage(cloneChatSummaries(chats), {
          ...page,
          chats: cloneChatSummaries(page.chats),
        });
      }
      cursor = page.nextCursor;
    } while (cursor);

    this.rememberAllChats(chats, options);
    return chats;
  }

  private async fetchChatPage(options: ChatListPageOptions): Promise<ChatListPage> {
    const includeSubAgents = options?.includeSubAgents === true;
    const limit = normalizeListLimit(
      options.limit ?? (includeSubAgents ? DEFAULT_SUB_AGENT_CHAT_LIST_LIMIT : DEFAULT_CHAT_LIST_LIMIT)
    );
    const response = await this.ws.request<AppServerListResponse>('thread/list', {
      cursor: normalizeCursor(options.cursor),
      limit,
      sortKey: 'updated_at',
      modelProviders: null,
      sourceKinds: includeSubAgents
        ? CHAT_LIST_SOURCE_KINDS_WITH_SUBAGENTS
        : CHAT_LIST_SOURCE_KINDS,
      archived: false,
      cwd: null,
    });

    const listRaw = Array.isArray(response.data) ? response.data : [];
    const chats = this.mapChatListItems(listRaw, includeSubAgents);

    return {
      chats,
      nextCursor:
        readString(response.nextCursor) ?? readString(response.next_cursor) ?? null,
      backwardsCursor:
        readString(response.backwardsCursor) ?? readString(response.backwards_cursor) ?? null,
    };
  }

  private mapChatListItems(listRaw: unknown[], includeSubAgents: boolean): ChatSummary[] {
    return listRaw
      .map((item) => {
        const rawThread = toRawThread(item);
        this.rememberRawThreadTitle(rawThread);

        const mapped = mapChatSummary(rawThread);
        if (!mapped) {
          return null;
        }

        return this.applyRememberedTitle(mapped);
      })
      .filter((item): item is ChatSummary => item !== null)
      .filter((item) => includeSubAgents || !isSubAgentSource(item.sourceKind))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private chatListCacheKey(options: ListChatsOptions): string {
    const includeSubAgents = options.includeSubAgents === true;
    const limit = normalizeListLimit(
      options.limit ?? (includeSubAgents ? DEFAULT_SUB_AGENT_CHAT_LIST_LIMIT : DEFAULT_CHAT_LIST_LIMIT)
    );
    return `${includeSubAgents ? 'with-subagents' : 'default'}:${String(limit)}`;
  }

  private allChatListCacheKey(options: ListAllChatsOptions): string {
    return options.includeSubAgents === true ? 'with-subagents' : 'default';
  }

  private mergeIntoAllChatListCaches(chats: ChatSummary[]): void {
    for (const [key, cachedList] of this.allChatListCache.entries()) {
      this.allChatListCache.set(key, {
        value: mergeChatSummariesById(cachedList.value, chats),
        loadedAt: cachedList.loadedAt,
      });
    }
  }

  async listLoadedChatIds(): Promise<string[]> {
    const response = await this.ws.request<AppServerLoadedThreadListResponse>(
      'thread/loaded/list',
      undefined
    );
    const ids = Array.isArray(response.data) ? response.data : [];
    return ids
      .map((value) => readString(value)?.trim() ?? '')
      .filter((value): value is string => value.length > 0);
  }

  async listWorkspaceRoots(limit = 200): Promise<WorkspaceListResponse> {
    const response = await this.ws.request<Record<string, unknown>>('bridge/workspaces/list', {
      limit,
    });
    return readWorkspaceListResponse(response);
  }

  async listFilesystemEntries(
    request?: FileSystemListRequest
  ): Promise<FileSystemListResponse> {
    const params: Record<string, unknown> = {
      path: normalizeCwd(request?.path) ?? null,
      includeHidden: request?.includeHidden === true,
      directoriesOnly: request?.directoriesOnly !== false,
    };
    if (request?.includeGitRepo === true) {
      params.includeGitRepo = true;
    }
    const response = await this.ws.request<Record<string, unknown>>('bridge/fs/list', params);
    return readFileSystemListResponse(response);
  }

  async createBrowserPreviewSession(targetUrl: string): Promise<BrowserPreviewSession> {
    const response = await this.ws.request<Record<string, unknown>>(
      'bridge/browser/session/create',
      {
        targetUrl,
      }
    );
    const session = readBrowserPreviewSession(response);
    if (!session) {
      throw new Error('bridge/browser/session/create returned an invalid session payload');
    }
    return session;
  }

  async listBrowserPreviewSessions(): Promise<BrowserPreviewSession[]> {
    const response = await this.ws.request<Record<string, unknown>>('bridge/browser/sessions/list');
    const record = toRecord(response) ?? {};
    const rawSessions = Array.isArray(record.sessions) ? record.sessions : [];
    return rawSessions
      .map((entry) => readBrowserPreviewSession(entry))
      .filter((entry): entry is BrowserPreviewSession => entry !== null);
  }

  async closeBrowserPreviewSession(sessionId: string): Promise<boolean> {
    const response = await this.ws.request<Record<string, unknown>>(
      'bridge/browser/session/close',
      {
        sessionId,
      }
    );
    return response.closed === true;
  }

  async discoverBrowserPreviewTargets(): Promise<BrowserPreviewDiscoveryResponse> {
    const response = await this.ws.request<Record<string, unknown>>(
      'bridge/browser/targets/discover'
    );
    return readBrowserPreviewDiscoveryResponse(response);
  }

  async createChat(body: CreateChatRequest): Promise<Chat> {
    const requestedEngine = normalizeChatEngine(body.engine);
    const requestedCwd = normalizeCwd(body.cwd);
    const requestedModel = normalizeModel(body.model);
    const requestedEffort = normalizeEffort(body.effort);
    const requestedServiceTier = normalizeServiceTier(body.serviceTier);
    const requestedApprovalPolicy = normalizeApprovalPolicy(body.approvalPolicy) ?? 'untrusted';
    const started = await this.ws.request<AppServerStartResponse>('thread/start', {
      engine: requestedEngine ?? undefined,
      model: requestedModel ?? null,
      modelProvider: null,
      cwd: requestedCwd ?? null,
      approvalPolicy: requestedApprovalPolicy,
      sandbox: MOBILE_DEFAULT_SANDBOX,
      config: toThreadConfig(requestedServiceTier),
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

  async getChat(id: string, options: ChatReadOptions = {}): Promise<Chat> {
    const threadId = id.trim();
    const cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 0);
    const cached = this.chatCache.get(threadId);
    if (!options.forceRefresh && cacheTtlMs > 0 && cached) {
      const ageMs = Date.now() - cached.loadedAt;
      if (ageMs <= cacheTtlMs) {
        return cloneChat(cached.value);
      }
    }

    const inFlight = this.chatInFlight.get(threadId);
    if (inFlight) {
      return cloneChat(await inFlight);
    }

    const request = this.readChatSnapshot(threadId)
      .then((snapshot) => {
        this.rememberChat(snapshot.chat);
        return snapshot.chat;
      })
      .finally(() => {
        this.chatInFlight.delete(threadId);
      });

    this.chatInFlight.set(threadId, request);
    return cloneChat(await request);
  }

  async getChatSummary(id: string): Promise<ChatSummary> {
    const response = await this.readAppServerThread(id, false);
    const rawThread = toRawThread(response.thread);
    this.rememberRawThreadTitle(rawThread);

    const mapped = mapChatSummary(rawThread);
    if (!mapped) {
      throw new Error('chat id missing in app-server response');
    }

    const summary = this.applyRememberedTitle(mapped);
    const cachedChat = this.peekChat(summary.id);
    this.rememberChat(
      cachedChat
        ? {
            ...cachedChat,
            ...summary,
            messages: cachedChat.messages,
          }
        : chatShellFromSummary(summary)
    );

    return summary;
  }

  async getChatSummaries(
    ids: readonly string[],
    options: ChatSummariesReadOptions = {}
  ): Promise<ChatSummary[]> {
    const uniqueIds = normalizeUniqueThreadIds(ids);
    if (uniqueIds.length === 0) {
      return [];
    }

    const concurrency = normalizeConcurrency(
      options.concurrency,
      DEFAULT_CHAT_SUMMARY_HYDRATION_CONCURRENCY,
      MAX_CHAT_SUMMARY_HYDRATION_CONCURRENCY
    );
    const results: Array<ChatSummary | null> = Array(uniqueIds.length).fill(null);
    let nextIndex = 0;

    const workers = Array.from(
      { length: Math.min(concurrency, uniqueIds.length) },
      async () => {
        while (nextIndex < uniqueIds.length) {
          const index = nextIndex;
          nextIndex += 1;
          try {
            results[index] = await this.getChatSummary(uniqueIds[index]);
          } catch {
            results[index] = null;
          }
        }
      }
    );

    await Promise.all(workers);
    return results.filter((summary): summary is ChatSummary => summary !== null);
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
  ): Promise<AppServerThreadRuntimeSettings> {
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
      sandbox: MOBILE_DEFAULT_SANDBOX,
      config: null,
      baseInstructions: null,
      developerInstructions: MOBILE_DEVELOPER_INSTRUCTIONS,
      personality: null,
      experimentalRawEvents: true,
      persistExtendedHistory: true,
    };

    try {
      const response = await this.ws.request<Record<string, unknown>>(
        'thread/resume',
        primaryRequest
      );
      return readThreadRuntimeSettings(response);
    } catch (primaryError) {
      // First fallback: keep raw-event streaming enabled, but relax approval policy.
      const compatibilityRequest = {
        ...primaryRequest,
        approvalPolicy: fallbackApprovalPolicy,
      };
      try {
        const response = await this.ws.request<Record<string, unknown>>(
          'thread/resume',
          compatibilityRequest
        );
        return readThreadRuntimeSettings(response);
      } catch (compatibilityError) {
        // Final compatibility fallback for older app-server builds that reject
        // experimentalRawEvents/developerInstructions on resume.
        const legacyRequest = {
          ...compatibilityRequest,
          developerInstructions: null,
        };
        delete (legacyRequest as { experimentalRawEvents?: boolean }).experimentalRawEvents;
        try {
          const response = await this.ws.request<Record<string, unknown>>(
            'thread/resume',
            legacyRequest
          );
          return readThreadRuntimeSettings(response);
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
    const prepared = await this.prepareTurnRequest(id, body);
    if (!prepared.content) {
      return this.getChat(id);
    }
    const turnStart = await this.ws.request<AppServerTurnResponse>(
      'turn/start',
      prepared.turnStartParams
    );

    const turnId = turnStart.turn?.id;
    if (!turnId) {
      throw new Error('turn/start did not return turn id');
    }
    options?.onTurnStarted?.(turnId);
    return this.getChatWithUserMessage(
      id,
      turnId,
      prepared.content,
      prepared.mentions,
      prepared.localImages
    );
  }

  async sendOrQueueChatMessage(
    id: string,
    body: SendChatMessageRequest,
    options?: PrepareTurnRequestOptions
  ): Promise<SendOrQueueChatMessageResult> {
    const prepared = await this.prepareTurnRequest(id, body, options);
    if (!prepared.content) {
      return {
        disposition: 'sent',
        queue: await this.readThreadQueue(id),
        turnId: '',
        chat: await this.getChat(id),
      };
    }

    const response = await this.ws.request<BridgeThreadQueueSendResponse>(
      'bridge/thread/queue/send',
      {
        threadId: id,
        content: prepared.content,
        turnStart: prepared.turnStartParams,
      }
    );

    if (response.disposition === 'queued') {
      return {
        disposition: 'queued',
        queue: response.queue,
        turnId: null,
        chat: null,
      };
    }

    const turnId = response.turnId?.trim();
    if (!turnId) {
      throw new Error('bridge/thread/queue/send did not return turn id for sent message');
    }

    const chat = await this.getChatWithUserMessage(
      id,
      turnId,
      prepared.content,
      prepared.mentions,
      prepared.localImages
    );

    return {
      disposition: 'sent',
      queue: response.queue,
      turnId,
      chat,
    };
  }

  async steerChatTurn(
    threadId: string,
    expectedTurnId: string,
    body: SteerChatTurnRequest
  ): Promise<void> {
    const normalizedThreadId = threadId.trim();
    const normalizedExpectedTurnId = expectedTurnId.trim();
    const content = body.content.trim();
    if (!normalizedThreadId || !normalizedExpectedTurnId || !content) {
      return;
    }

    const normalizedMentions = normalizeMentions(body.mentions);
    const normalizedLocalImages = normalizeLocalImages(body.localImages);

    await this.ws.request<Record<string, never>>('turn/steer', {
      threadId: normalizedThreadId,
      expectedTurnId: normalizedExpectedTurnId,
      input: buildTurnInput(content, normalizedMentions, normalizedLocalImages),
    });
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

  readThreadQueue(threadId: string): Promise<BridgeThreadQueueState> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      return Promise.resolve({
        threadId: '',
        items: [],
        lastError: null,
      });
    }

    return this.ws.request<BridgeThreadQueueState>('bridge/thread/queue/read', {
      threadId: normalizedThreadId,
    });
  }

  steerQueuedThreadMessage(
    threadId: string,
    itemId: string
  ): Promise<BridgeThreadQueueActionResponse> {
    return this.ws.request<BridgeThreadQueueActionResponse>('bridge/thread/queue/steer', {
      threadId: threadId.trim(),
      itemId: itemId.trim(),
    });
  }

  cancelQueuedThreadMessage(
    threadId: string,
    itemId: string
  ): Promise<BridgeThreadQueueActionResponse> {
    return this.ws.request<BridgeThreadQueueActionResponse>('bridge/thread/queue/cancel', {
      threadId: threadId.trim(),
      itemId: itemId.trim(),
    });
  }

  uploadAttachment(body: UploadAttachmentRequest): Promise<UploadAttachmentResponse> {
    return this.ws.request<UploadAttachmentResponse>('bridge/attachments/upload', body);
  }

  transcribeVoice(body: VoiceTranscribeRequest): Promise<VoiceTranscribeResponse> {
    return this.ws.request<VoiceTranscribeResponse>('bridge/voice/transcribe', body);
  }

  async listModels(
    includeHidden = false,
    options?: {
      threadId?: string | null;
      engine?: ChatEngine | null;
    }
  ): Promise<ModelOption[]> {
    const normalizedThreadId =
      typeof options?.threadId === 'string' && options.threadId.trim().length > 0
        ? options.threadId.trim()
        : null;
    const normalizedEngine = normalizeChatEngine(options?.engine);
    const response = await this.ws.request<AppServerModelListResponse>('model/list', {
      cursor: null,
      limit: 200,
      includeHidden,
      threadId: normalizedThreadId,
      engine: normalizedEngine ?? undefined,
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
      const providerId = readString(record.providerId) ?? readString(record.providerID);
      const providerName = readString(record.providerName);
      const contextWindow = readPositiveIntegerLike(
        record.contextWindow ?? record.modelContextWindow ?? record.model_context_window
      );
      const connected =
        typeof record.connected === 'boolean' ? record.connected : undefined;
      const authRequired =
        typeof record.authRequired === 'boolean' ? record.authRequired : undefined;
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
        providerId: providerId ?? undefined,
        providerName: providerName ?? undefined,
        contextWindow: contextWindow ?? undefined,
        connected,
        authRequired,
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
      serviceTier?: ServiceTier;
      approvalPolicy?: ApprovalPolicy | null;
    }
  ): Promise<Chat> {
    const requestedApprovalPolicy =
      normalizeApprovalPolicy(options?.approvalPolicy) ?? 'untrusted';
    const requestedServiceTier = normalizeServiceTier(options?.serviceTier);
    const response = await this.ws.request<AppServerForkResponse>('thread/fork', {
      threadId: id,
      path: null,
      model: normalizeModel(options?.model) ?? null,
      modelProvider: null,
      cwd: normalizeCwd(options?.cwd) ?? null,
      approvalPolicy: requestedApprovalPolicy,
      sandbox: MOBILE_DEFAULT_SANDBOX,
      config: toThreadConfig(requestedServiceTier),
      baseInstructions: null,
      developerInstructions: MOBILE_DEVELOPER_INSTRUCTIONS,
      persistExtendedHistory: true,
    });

    if (response.thread) {
      return this.mapChatWithCachedTitle(response.thread);
    }

    throw new Error('thread/fork did not return a chat payload');
  }

  async readServiceTierPreference(): Promise<ServiceTier | null> {
    const response = await this.ws.request<AppServerConfigReadResponse>('config/read', {
      includeLayers: false,
      cwd: null,
    });
    const config = toRecord(response.config);
    return normalizeServiceTier(readString(config?.service_tier));
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

  resolveBridgeUiSurface(
    id: string,
    body: ResolveBridgeUiSurfaceRequest
  ): Promise<ResolveBridgeUiSurfaceResponse> {
    return this.ws.request<ResolveBridgeUiSurfaceResponse>('bridge/ui/resolve', {
      id,
      threadId: body.threadId,
      turnId: body.turnId ?? null,
      actionId: body.actionId,
    });
  }

  dismissBridgeUiSurface(
    id: string,
    threadId?: string | null
  ): Promise<DismissBridgeUiSurfaceResponse> {
    return this.ws.request<DismissBridgeUiSurfaceResponse>('bridge/ui/dismiss', {
      id,
      threadId: threadId ?? null,
    });
  }

  execTerminal(body: TerminalExecRequest): Promise<TerminalExecResponse> {
    return this.ws.request<TerminalExecResponse>('bridge/terminal/exec', body);
  }

  installGitHubAuth(
    body:
      | {
          accessToken: string;
          repositories?: string[];
        }
      | {
          grants: GitHubAuthGrantInput[];
        }
  ): Promise<GitHubAuthInstallResponse> {
    const grants =
      'grants' in body
        ? body.grants
        : [
            {
              accessToken: body.accessToken,
              repositories: body.repositories ?? [],
            },
          ];

    const normalizedGrants = grants
      .map((grant) => ({
        accessToken: grant.accessToken.trim(),
        repositories: (grant.repositories ?? [])
          .map((repository) => repository.trim())
          .filter((repository) => repository.length > 0),
      }))
      .filter((grant) => grant.accessToken.length > 0);

    if (normalizedGrants.length === 0) {
      return Promise.reject(new Error('At least one GitHub auth grant is required'));
    }

    return this.ws.request<GitHubAuthInstallResponse>('bridge/github/auth/install', {
      grants: normalizedGrants,
    });
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

  gitHistory(cwd?: string, limit = 12): Promise<GitHistoryResponse> {
    const normalizedCwd = normalizeCwd(cwd);
    return this.ws.request<GitHistoryResponse>('bridge/git/history', {
      cwd: normalizedCwd ?? null,
      limit,
    });
  }

  gitBranches(cwd?: string): Promise<GitBranchesResponse> {
    const normalizedCwd = normalizeCwd(cwd);
    return this.ws.request<GitBranchesResponse>('bridge/git/branches', {
      cwd: normalizedCwd ?? null,
    });
  }

  gitClone(body: GitCloneRequest): Promise<GitCloneResponse> {
    const url = body.url.trim();
    const directoryName = body.directoryName.trim();
    if (!url) {
      return Promise.reject(new Error('url must not be empty'));
    }
    if (!directoryName) {
      return Promise.reject(new Error('directoryName must not be empty'));
    }

    return this.ws.request<GitCloneResponse>('bridge/git/clone', {
      url,
      parentPath: normalizeCwd(body.parentPath) ?? null,
      directoryName,
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

  gitSwitch(body: GitSwitchRequest): Promise<GitSwitchResponse> {
    const branch = body.branch.trim();
    if (!branch) {
      return Promise.reject(new Error('branch must not be empty'));
    }

    return this.ws.request<GitSwitchResponse>('bridge/git/switch', {
      branch,
      cwd: normalizeCwd(body.cwd) ?? null,
    });
  }

  gitPush(cwd?: string): Promise<GitPushResponse> {
    const normalizedCwd = normalizeCwd(cwd);
    return this.ws.request<GitPushResponse>('bridge/git/push', {
      cwd: normalizedCwd ?? null,
    });
  }

  private async prepareTurnRequest(
    id: string,
    body: SendChatMessageRequest,
    options?: PrepareTurnRequestOptions
  ): Promise<PreparedTurnRequest> {
    const content = body.content.trim();
    if (!content) {
      return {
        content: '',
        mentions: [],
        localImages: [],
        turnStartParams: {
          threadId: id,
          input: [],
        },
      };
    }

    if ((body.role ?? 'user') !== 'user') {
      throw new Error('Only user role is supported in bridge/chat messaging');
    }

    const cachedSummary = this.peekChatSummary(id);
    const cachedCursorCwd =
      cachedSummary?.engine === 'cursor' ? normalizeCwd(cachedSummary.cwd) : null;
    const normalizedCwd = normalizeCwd(body.cwd) ?? cachedCursorCwd;
    const cachedEngine = normalizeChatEngine(cachedSummary?.engine);
    const normalizedModel = normalizeModel(body.model);
    const normalizedEffort = normalizeEffort(body.effort);
    const normalizedServiceTier = normalizeServiceTier(body.serviceTier);
    const normalizedApprovalPolicy = normalizeApprovalPolicy(body.approvalPolicy);
    const normalizedMentions = normalizeMentions(body.mentions);
    const normalizedLocalImages = normalizeLocalImages(body.localImages);
    const requestedCollaborationMode = normalizeCollaborationMode(body.collaborationMode);
    let resumedThreadSettings: AppServerThreadRuntimeSettings | null = null;

    if (!options?.skipResume) {
      try {
        resumedThreadSettings = await this.resumeThread(id, {
          model: normalizedModel,
          cwd: normalizedCwd,
          approvalPolicy: normalizedApprovalPolicy,
        });
      } catch {
        // Best effort: turn/start still works for recently started chats.
      }
    }

    let effectiveModel = normalizedModel ?? resumedThreadSettings?.model ?? null;
    if (requestedCollaborationMode && !effectiveModel && !options?.skipResume) {
      try {
        const models = await this.listModels(false, {
          threadId: id,
          ...(cachedEngine ? { engine: cachedEngine } : {}),
        });
        effectiveModel =
          models.find((entry) => entry.isDefault)?.id ?? models[0]?.id ?? null;
      } catch {
        // Best effort: fall back to the current thread settings if model lookup fails.
      }
    }

    const effectiveEffort =
      requestedCollaborationMode
        ? normalizedEffort ?? resumedThreadSettings?.effort ?? null
        : normalizedEffort;
    const normalizedCollaborationMode = toTurnCollaborationMode(
      requestedCollaborationMode,
      effectiveModel,
      effectiveEffort,
      cachedEngine
    );

    return {
      content,
      mentions: normalizedMentions,
      localImages: normalizedLocalImages,
      turnStartParams: {
        threadId: id,
        input: buildTurnInput(content, normalizedMentions, normalizedLocalImages),
        cwd: normalizedCwd ?? null,
        approvalPolicy: normalizedApprovalPolicy ?? null,
        sandboxPolicy: null,
        model: effectiveModel ?? null,
        effort: effectiveEffort ?? null,
        serviceTier: normalizedServiceTier ?? null,
        summary: 'auto',
        personality: null,
        outputSchema: null,
        collaborationMode: normalizedCollaborationMode,
      },
    };
  }

  private mapChatWithCachedTitle(rawThreadValue: unknown): Chat {
    const rawThread = toRawThread(rawThreadValue);
    this.rememberRawThreadTitle(rawThread);

    const mapped = mapChat(rawThread);
    const chat = this.applyRememberedTitle(mapped);
    this.rememberChat(chat);
    return chat;
  }

  private rememberRawThreadTitle(rawThread: RawThread): void {
    const threadId = rawThread.id?.trim();
    const rawTitle = rawThread.name?.trim();
    if (!threadId || !rawTitle) {
      return;
    }

    if (isGeneratedCursorThreadTitle(rawTitle, threadId, rawThread.engine)) {
      const cachedTitle = this.renamedTitles.get(threadId);
      if (isGeneratedCursorThreadTitle(cachedTitle, threadId, rawThread.engine)) {
        this.renamedTitles.delete(threadId);
      }
      return;
    }

    this.renamedTitles.set(threadId, rawTitle);
  }

  private applyRememberedTitle<T extends ChatSummary>(mapped: T): T {
    const cachedTitle = this.renamedTitles.get(mapped.id);
    if (!cachedTitle) {
      return mapped;
    }

    if (isGeneratedCursorThreadTitle(cachedTitle, mapped.id, mapped.engine)) {
      this.renamedTitles.delete(mapped.id);
      return mapped;
    }

    if (
      mapped.engine === 'cursor' &&
      !isGeneratedCursorThreadTitle(mapped.title, mapped.id, mapped.engine)
    ) {
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
      const response = await this.readAppServerThread(id, true);
      const rawThread = toRawThread(response.thread);
      return {
        rawThread,
        chat: this.mapChatWithCachedTitle(rawThread),
      };
    } catch (error) {
      if (!isMaterializationGapError(error)) {
        throw error;
      }

      const response = await this.readAppServerThread(id, false);
      const rawThread = toRawThread(response.thread);
      return {
        rawThread,
        chat: this.mapChatWithCachedTitle(rawThread),
      };
    }
  }

  private async readAppServerThread(
    threadId: string,
    includeTurns: boolean
  ): Promise<AppServerReadResponse> {
    let lastTransientError: unknown = null;
    for (let attempt = 0; attempt <= TRANSIENT_THREAD_READ_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const cachedSummary = this.peekChatSummary(threadId);
        const cursorCwd =
          cachedSummary?.engine === 'cursor' ? normalizeCwd(cachedSummary.cwd) : null;
        return await this.ws.request<AppServerReadResponse>('thread/read', {
          threadId,
          includeTurns,
          ...(cursorCwd ? { cwd: cursorCwd } : {}),
        });
      } catch (error) {
        if (!isTransientThreadReadError(error)) {
          throw error;
        }
        lastTransientError = error;
        const retryDelayMs = TRANSIENT_THREAD_READ_RETRY_DELAYS_MS[attempt];
        if (retryDelayMs === undefined) {
          throw error;
        }
        await sleep(retryDelayMs);
      }
    }

    throw lastTransientError;
  }

  private async getChatWithUserMessage(
    id: string,
    turnId: string,
    content: string,
    mentions: TurnInputMention[] = [],
    localImages: TurnInputLocalImage[] = []
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
      normalizedContent,
      mentions,
      localImages
    );
    const hasFallbackRecentMessage =
      !rawThreadHasTurns(latestSnapshot.rawThread) &&
      chatHasRecentUserMessage(latest, normalizedContent, mentions, localImages);
    if (hasMatchingTurnMessage || hasFallbackRecentMessage) {
      this.rememberChat(latest);
      return latest;
    }

    const retryDelaysMs = [25, 50, 100, 150];
    for (const delayMs of retryDelaysMs) {
      await sleep(delayMs);
      latestSnapshot = await this.readChatSnapshot(id);
      latest = latestSnapshot.chat;

      const matchedAfterRetry = rawThreadHasTurnUserMessage(
        latestSnapshot.rawThread,
        turnId,
        normalizedContent,
        mentions,
        localImages
      );
      const matchedByFallback =
        !rawThreadHasTurns(latestSnapshot.rawThread) &&
        chatHasRecentUserMessage(latest, normalizedContent, mentions, localImages);
      if (matchedAfterRetry || matchedByFallback) {
        this.rememberChat(latest);
        return latest;
      }
    }

    const synthetic = appendSyntheticUserMessage(
      latest,
      normalizedContent,
      mentions,
      localImages
    );
    this.rememberChat(synthetic);
    return synthetic;
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

function normalizeListLimit(limit: unknown): number {
  return typeof limit === 'number' && Number.isFinite(limit)
    ? Math.max(1, Math.min(200, Math.round(limit)))
    : DEFAULT_CHAT_LIST_LIMIT;
}

function normalizeCursor(cursor: unknown): string | null {
  if (typeof cursor !== 'string') {
    return null;
  }
  const trimmed = cursor.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeUniqueThreadIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string') {
      continue;
    }
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeConcurrency(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(max, Math.round(value)))
    : fallback;
}

function normalizeChatListStreamLimits(limits: unknown, fallbackLimit: number): number[] {
  const rawLimits = Array.isArray(limits) ? limits : [CHAT_LIST_STREAM_INITIAL_LIMIT, fallbackLimit];
  const normalized: number[] = [];
  for (const limit of rawLimits) {
    const nextLimit = normalizeListLimit(limit);
    if (!normalized.includes(nextLimit)) {
      normalized.push(nextLimit);
    }
  }

  return normalized.length > 0 ? normalized : [normalizeListLimit(fallbackLimit)];
}

function mergeChatSummariesById(
  previous: ChatSummary[],
  incoming: ChatSummary[]
): ChatSummary[] {
  const byId = new Map<string, ChatSummary>();
  for (const chat of previous) {
    byId.set(chat.id, chat);
  }
  for (const chat of incoming) {
    byId.set(chat.id, chat);
  }
  return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function readTimestampIso(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      return new Date((numeric > 1_000_000_000_000 ? numeric : numeric * 1000)).toISOString();
    }

    const parsedMs = Date.parse(trimmed);
    return Number.isFinite(parsedMs) ? new Date(parsedMs).toISOString() : null;
  }

  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date((value > 1_000_000_000_000 ? value : value * 1000)).toISOString();
  }

  return null;
}

function readAccountLoginCompletedNotification(
  value: unknown
): AccountLoginCompletedNotification | null {
  const record = toRecord(value);
  if (!record || typeof record.success !== 'boolean') {
    return null;
  }

  return {
    loginId: readString(record.loginId) ?? readString(record.login_id),
    success: record.success,
    error: readString(record.error),
  };
}

function readWorkspaceListResponse(value: unknown): WorkspaceListResponse {
  const record = toRecord(value) ?? {};
  const workspacesRaw = Array.isArray(record.workspaces) ? record.workspaces : [];

  return {
    bridgeRoot: normalizeCwd(readString(record.bridgeRoot)) ?? '',
    allowOutsideRootCwd: record.allowOutsideRootCwd === true,
    workspaces: workspacesRaw
      .map((entry) => {
        const workspace = toRecord(entry);
        if (!workspace) {
          return null;
        }

        const path = normalizeCwd(readString(workspace.path));
        if (!path) {
          return null;
        }

        const rawChatCount = workspace.chatCount;
        const chatCount =
          typeof rawChatCount === 'number'
            ? Math.max(0, Math.trunc(rawChatCount))
            : typeof rawChatCount === 'string'
              ? Math.max(0, Number.parseInt(rawChatCount, 10) || 0)
              : 0;
        const updatedAt = readTimestampIso(workspace.updatedAt);

        return {
          path,
          chatCount,
          ...(updatedAt ? { updatedAt } : {}),
        };
      })
      .filter((entry): entry is WorkspaceListResponse['workspaces'][number] => entry !== null),
  };
}

function readFileSystemListResponse(value: unknown): FileSystemListResponse {
  const record = toRecord(value) ?? {};
  const entriesRaw = Array.isArray(record.entries) ? record.entries : [];

  return {
    bridgeRoot: normalizeCwd(readString(record.bridgeRoot)) ?? '',
    path: normalizeCwd(readString(record.path)) ?? '',
    parentPath: normalizeCwd(readString(record.parentPath)) ?? null,
    entries: entriesRaw
      .map((entry) => {
        const item = toRecord(entry);
        if (!item) {
          return null;
        }

        const path = normalizeCwd(readString(item.path));
        const name = normalizeCwd(readString(item.name));
        if (!path || !name) {
          return null;
        }

        return {
          name,
          path,
          kind: readString(item.kind) ?? 'directory',
          hidden: item.hidden === true,
          selectable: item.selectable !== false,
          isGitRepo: item.isGitRepo === true,
        };
      })
      .filter((entry): entry is FileSystemListResponse['entries'][number] => entry !== null),
  };
}

function readBrowserPreviewSession(value: unknown): BrowserPreviewSession | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const sessionId = readString(record.sessionId)?.trim() ?? '';
  const targetUrl = readString(record.targetUrl)?.trim() ?? '';
  const bootstrapPath = readString(record.bootstrapPath)?.trim() ?? '';
  const previewBaseUrl = readString(record.previewBaseUrl)?.trim() || null;
  const previewPortRaw = record.previewPort;
  const previewPort =
    typeof previewPortRaw === 'number'
      ? Math.max(1, Math.trunc(previewPortRaw))
      : typeof previewPortRaw === 'string'
        ? Math.max(1, Number.parseInt(previewPortRaw, 10) || 0)
        : 0;
  const createdAt = readTimestampIso(record.createdAt);
  const lastAccessedAt = readTimestampIso(record.lastAccessedAt);

  if (!sessionId || !targetUrl || !bootstrapPath || previewPort <= 0 || !createdAt) {
    return null;
  }

  return {
    sessionId,
    targetUrl,
    previewPort,
    ...(previewBaseUrl ? { previewBaseUrl } : {}),
    bootstrapPath,
    createdAt,
    lastAccessedAt: lastAccessedAt ?? createdAt,
  };
}

function readBrowserPreviewDiscoveryResponse(value: unknown): BrowserPreviewDiscoveryResponse {
  const record = toRecord(value) ?? {};
  const rawSuggestions = Array.isArray(record.suggestions) ? record.suggestions : [];

  return {
    scannedAt: readTimestampIso(record.scannedAt) ?? new Date(0).toISOString(),
    suggestions: rawSuggestions
      .map((entry) => {
        const item = toRecord(entry);
        if (!item) {
          return null;
        }

        const targetUrl = readString(item.targetUrl)?.trim() ?? '';
        const label = readString(item.label)?.trim() ?? '';
        const portRaw = item.port;
        const port =
          typeof portRaw === 'number'
            ? Math.max(1, Math.trunc(portRaw))
            : typeof portRaw === 'string'
              ? Math.max(1, Number.parseInt(portRaw, 10) || 0)
              : 0;
        if (!targetUrl || !label || port <= 0) {
          return null;
        }

        return {
          targetUrl,
          label,
          port,
        };
      })
      .filter(
        (entry): entry is BrowserPreviewDiscoveryResponse['suggestions'][number] => entry !== null
      ),
  };
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

function normalizeServiceTier(
  serviceTier: ServiceTier | string | null | undefined
): ServiceTier | null {
  if (typeof serviceTier !== 'string') {
    return null;
  }

  const normalized = serviceTier.trim().toLowerCase();
  if (normalized === 'flex' || normalized === 'fast') {
    return normalized;
  }

  return null;
}

function toThreadConfig(
  serviceTier: ServiceTier | null
): Record<string, ServiceTier> | null {
  if (!serviceTier) {
    return null;
  }

  return {
    service_tier: serviceTier,
  };
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
  effort: ReasoningEffort | null,
  engine: ChatEngine | null
): AppServerCollaborationMode | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized !== 'plan' && normalized !== 'default' && normalized !== 'ask') {
    return null;
  }

  if (normalized === 'ask' && engine !== 'cursor') {
    return null;
  }

  if (!model) {
    return null;
  }

  return {
    mode: normalized,
    settings: {
      model,
      reasoning_effort: effort,
      developer_instructions: null,
    },
  };
}

function normalizeCollaborationMode(
  value: CollaborationMode | string | null | undefined
): CollaborationMode | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'plan' || normalized === 'default' || normalized === 'ask') {
    return normalized;
  }

  return null;
}

function normalizeChatEngine(value: string | null | undefined): ChatEngine | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'opencode' || normalized === 'cursor') {
    return normalized;
  }

  return null;
}

function readThreadRuntimeSettings(value: unknown): AppServerThreadRuntimeSettings {
  const record = toRecord(value);
  return {
    model: normalizeModel(readString(record?.model)),
    effort: normalizeEffort(
      readString(record?.reasoningEffort) ?? readString(record?.reasoning_effort)
    ),
  };
}

function readCursorCredentialStatus(value: unknown): CursorCredentialStatus {
  const record = toRecord(value) ?? {};
  const sourceRaw = readString(record.source);
  const source = sourceRaw === 'env' ? sourceRaw : null;

  return {
    configured: record.configured === true,
    valid: typeof record.valid === 'boolean' ? record.valid : null,
    source,
    apiKeyName: readString(record.apiKeyName) ?? readString(record.api_key_name),
    userEmail: readString(record.userEmail) ?? readString(record.user_email),
    createdAt: readString(record.createdAt) ?? readString(record.created_at),
    enabled: record.enabled === true,
    runtimeAvailable:
      record.runtimeAvailable === true || record.runtime_available === true,
    active: record.active === true,
    error: readString(record.error),
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

function readPositiveIntegerLike(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  const match = /^([0-9]+(?:\.[0-9]+)?)([km])?$/.exec(normalized);
  if (!match) {
    return null;
  }

  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  const multiplier = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1;
  return Math.floor(numeric * multiplier);
}

function chatHasRecentUserMessage(
  chat: Chat,
  content: string,
  mentions: TurnInputMention[] = [],
  localImages: TurnInputLocalImage[] = [],
  tailSize = 8
): boolean {
  const normalized = buildExpectedUserMessageContent(content.trim(), mentions, localImages);
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
  content: string,
  mentions: TurnInputMention[] = [],
  localImages: TurnInputLocalImage[] = []
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

    return (
      buildExpectedUserMessageContent(
        extractUserMessageText(record.content).trim(),
        extractUserMessageMentions(record.content),
        extractUserMessageLocalImages(record.content)
      ) === buildExpectedUserMessageContent(normalizedContent, mentions, localImages)
    );
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

function extractUserMessageMentions(value: unknown): TurnInputMention[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const mentions: TurnInputMention[] = [];
  for (const entry of value) {
    const record = toRecord(entry);
    if (!record || readString(record.type) !== 'mention') {
      continue;
    }

    const path = readString(record.path)?.trim();
    if (!path) {
      continue;
    }

    mentions.push({
      type: 'mention',
      path,
      name: normalizeMentionName(readString(record.name) ?? undefined, path),
    });
  }

  return mentions;
}

function extractUserMessageLocalImages(value: unknown): TurnInputLocalImage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const images: TurnInputLocalImage[] = [];
  for (const entry of value) {
    const record = toRecord(entry);
    if (!record || readString(record.type) !== 'localImage') {
      continue;
    }

    const path = readString(record.path)?.trim();
    if (!path) {
      continue;
    }

    images.push({
      type: 'localImage',
      path,
    });
  }

  return images;
}

function buildExpectedUserMessageContent(
  content: string,
  mentions: TurnInputMention[] = [],
  localImages: TurnInputLocalImage[] = []
): string {
  const normalized = content.trim();
  const mentionLines = mentions.map((mention) => `[file: ${mention.path}]`);
  const localImageLines = localImages.map((image) => `[local image: ${image.path}]`);
  return [normalized, ...mentionLines, ...localImageLines]
    .filter((part) => part.trim().length > 0)
    .join('\n');
}

function chatShellFromSummary(summary: ChatSummary): Chat {
  return {
    ...cloneChatSummary(summary),
    messages: [],
    latestPlan: null,
    latestTurnPlan: null,
    latestTurnStatus: null,
    activeTurnId: null,
  };
}

function cloneChatSummary(chat: ChatSummary): ChatSummary {
  return { ...chat };
}

function cloneChatSummaries(chats: ChatSummary[]): ChatSummary[] {
  return chats.map(cloneChatSummary);
}

function cloneChat(chat: Chat): Chat {
  return {
    ...chat,
    messages: chat.messages.map((message) => ({
      ...message,
      subAgentMeta: message.subAgentMeta
        ? {
            ...message.subAgentMeta,
            receiverThreadIds: message.subAgentMeta.receiverThreadIds
              ? [...message.subAgentMeta.receiverThreadIds]
              : undefined,
          }
        : undefined,
    })),
    latestPlan: cloneChatPlan(chat.latestPlan),
    latestTurnPlan: cloneChatPlan(chat.latestTurnPlan),
  };
}

function cloneChatPlan<T extends Chat['latestPlan'] | Chat['latestTurnPlan']>(
  plan: T
): T {
  if (!plan) {
    return plan;
  }

  return {
    ...plan,
    steps: plan.steps.map((step) => ({ ...step })),
  } as T;
}

function appendSyntheticUserMessage(
  chat: Chat,
  content: string,
  mentions: TurnInputMention[] = [],
  localImages: TurnInputLocalImage[] = []
): Chat {
  const normalized = buildExpectedUserMessageContent(content.trim(), mentions, localImages);
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

function isTransientThreadReadError(error: unknown): boolean {
  const message = String((error as Error).message ?? error).toLowerCase();
  return (
    message.includes('failed to read thread') &&
    message.includes('thread-store internal error') &&
    message.includes('rollout') &&
    message.includes('is empty')
  );
}
