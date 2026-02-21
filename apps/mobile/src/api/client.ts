import {
  mapThread,
  mapThreadSummary,
  toRawThread,
} from './threadMapping';
import type {
  ApprovalDecision,
  CreateThreadRequest,
  GitCommitRequest,
  GitCommitResponse,
  GitDiffResponse,
  GitStatusResponse,
  PendingApproval,
  ResolveApprovalResponse,
  SendThreadMessageRequest,
  TerminalExecRequest,
  TerminalExecResponse,
  Thread,
  ThreadSummary,
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

export class MacBridgeApiClient {
  private readonly ws: MacBridgeWsClient;

  constructor(options: ApiClientOptions) {
    this.ws = options.ws;
  }

  health(): Promise<HealthResponse> {
    return this.ws.request<HealthResponse>('bridge/health/read');
  }

  async listThreads(): Promise<ThreadSummary[]> {
    const response = await this.ws.request<AppServerListResponse>('thread/list', {
      cursor: null,
      limit: 200,
      sortKey: null,
      modelProviders: null,
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'unknown'],
      archived: false,
      cwd: null,
    });

    const listRaw = Array.isArray(response.data) ? response.data : [];

    return listRaw
      .map((item) => mapThreadSummary(toRawThread(item)))
      .filter((item): item is ThreadSummary => item !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createThread(body: CreateThreadRequest): Promise<Thread> {
    const started = await this.ws.request<AppServerStartResponse>('thread/start', {
      model: null,
      modelProvider: null,
      cwd: null,
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

    const threadId = started.thread?.id;
    if (!threadId) {
      throw new Error('thread/start did not return a thread id');
    }

    const initialPrompt = body.message?.trim();
    if (initialPrompt) {
      return this.sendThreadMessage(threadId, {
        content: initialPrompt,
        role: 'user',
      });
    }

    if (started.thread) {
      return mapThread(toRawThread(started.thread));
    }

    return this.getThread(threadId);
  }

  async getThread(id: string): Promise<Thread> {
    try {
      const response = await this.ws.request<AppServerReadResponse>('thread/read', {
        threadId: id,
        includeTurns: true,
      });

      return mapThread(toRawThread(response.thread));
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
      return mapThread(toRawThread(response.thread));
    }
  }

  async sendThreadMessage(id: string, body: SendThreadMessageRequest): Promise<Thread> {
    const content = body.content.trim();
    if (!content) {
      return this.getThread(id);
    }

    if ((body.role ?? 'user') !== 'user') {
      throw new Error('Only user role is supported in bridge/thread messaging');
    }

    try {
      await this.ws.request('thread/resume', {
        threadId: id,
        history: null,
        path: null,
        model: null,
        modelProvider: null,
        cwd: null,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        config: null,
        baseInstructions: null,
        developerInstructions: null,
        personality: null,
        persistExtendedHistory: true,
      });
    } catch {
      // Best effort: turn/start still works for recently started threads.
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
      cwd: null,
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
    return this.getThread(id);
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

  gitStatus(): Promise<GitStatusResponse> {
    return this.ws.request<GitStatusResponse>('bridge/git/status');
  }

  gitDiff(): Promise<GitDiffResponse> {
    return this.ws.request<GitDiffResponse>('bridge/git/diff');
  }

  gitCommit(body: GitCommitRequest): Promise<GitCommitResponse> {
    return this.ws.request<GitCommitResponse>('bridge/git/commit', body);
  }
}
