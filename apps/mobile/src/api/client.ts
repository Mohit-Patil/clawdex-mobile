import {
  mapChat,
  mapChatSummary,
  toRawThread,
} from './chatMapping';
import type {
  ApprovalDecision,
  CreateChatRequest,
  Chat,
  ChatSummary,
  GitCommitRequest,
  GitCommitResponse,
  GitDiffResponse,
  GitStatusResponse,
  PendingApproval,
  ResolveApprovalResponse,
  SendChatMessageRequest,
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

type AppServerThreadSetNameResponse = Record<string, never>;

const CHAT_LIST_SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'unknown'] as const;

export class MacBridgeApiClient {
  private readonly ws: MacBridgeWsClient;

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
      .map((item) => mapChatSummary(toRawThread(item)))
      .filter((item): item is ChatSummary => item !== null)
      .filter((item) => !isSubAgentSource(item.sourceKind))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createChat(body: CreateChatRequest): Promise<Chat> {
    const requestedCwd = normalizeCwd(body.cwd);
    const started = await this.ws.request<AppServerStartResponse>('thread/start', {
      model: null,
      modelProvider: null,
      cwd: requestedCwd ?? null,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      config: null,
      baseInstructions: null,
      developerInstructions: null,
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
      });
    }

    if (started.thread) {
      return mapChat(toRawThread(started.thread));
    }

    return this.getChat(chatId);
  }

  async getChat(id: string): Promise<Chat> {
    try {
      const response = await this.ws.request<AppServerReadResponse>('thread/read', {
        threadId: id,
        includeTurns: true,
      });

      return mapChat(toRawThread(response.thread));
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
      return mapChat(toRawThread(response.thread));
    }
  }

  async renameChat(id: string, name: string): Promise<Chat> {
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error('Chat name cannot be empty');
    }

    await this.ws.request<AppServerThreadSetNameResponse>('thread/name/set', {
      threadId: id,
      name: trimmedName,
    });

    const updated = await this.getChat(id);
    if (updated.title === trimmedName) {
      return updated;
    }

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
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      config: null,
      baseInstructions: null,
      developerInstructions: null,
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

    try {
      await this.ws.request('thread/resume', {
        threadId: id,
        history: null,
        path: null,
        model: null,
        modelProvider: null,
        cwd: normalizedCwd ?? null,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        config: null,
        baseInstructions: null,
        developerInstructions: null,
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
      model: null,
      effort: null,
      summary: null,
      personality: null,
      outputSchema: null,
      collaborationMode: null,
    });

    const turnId = turnStart.turn?.id;
    if (!turnId) {
      throw new Error('turn/start did not return turn id');
    }

    await this.ws.waitForTurnCompletion(id, turnId);
    return this.getChat(id);
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
