export type CursorAppServerRuntime = 'local';

export type ThreadLifecycleStatus = 'idle' | 'running' | 'error' | 'complete';

export interface AppServerNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface ModelSelection {
  id: string;
  params?: Array<{ id: string; value: string }>;
}

export interface CursorModelListItem {
  id: string;
  displayName?: string;
  description?: string;
  providerId?: string;
  providerName?: string;
  isDefault?: boolean;
}

export interface CursorAgentInfo {
  agentId: string;
  name: string;
  summary: string;
  lastModified: number;
  createdAt?: number;
  status?: 'running' | 'finished' | 'error';
  runtime?: 'local' | 'cloud';
  cwd?: string;
}

export interface CursorAgentMessage {
  type: 'user' | 'assistant';
  uuid: string;
  agent_id: string;
  message: unknown;
}

export type CursorRunStatus = 'running' | 'finished' | 'error' | 'cancelled';

export interface CursorRunResult {
  id: string;
  status: Exclude<CursorRunStatus, 'running'>;
  result?: string;
  durationMs?: number;
  model?: ModelSelection;
  git?: CursorRunGitInfo;
}

export interface CursorRunGitBranchInfo {
  repoUrl: string;
  branch?: string;
  prUrl?: string;
}

export interface CursorRunGitInfo {
  branches: CursorRunGitBranchInfo[];
}

export type CursorStreamMessage =
  | {
      type: 'assistant';
      agent_id?: string;
      run_id?: string;
      message?: unknown;
    }
  | {
      type: 'thinking';
      agent_id?: string;
      run_id?: string;
      text?: string;
    }
  | {
      type: 'tool_call';
      agent_id?: string;
      run_id?: string;
      call_id?: string;
      name?: string;
      status?: string;
      args?: unknown;
      result?: unknown;
      truncated?: {
        args?: boolean;
        result?: boolean;
      };
    }
  | {
      type: 'status';
      agent_id?: string;
      run_id?: string;
      status?: string;
    }
  | {
      type: 'task';
      agent_id?: string;
      run_id?: string;
      text?: string;
      status?: string;
    };

export interface CursorRunHandle {
  readonly id: string;
  readonly agentId: string;
  readonly status: CursorRunStatus;
  stream(): AsyncGenerator<CursorStreamMessage, void>;
  wait(): Promise<CursorRunResult>;
  conversation(): Promise<unknown[]>;
  cancel(): Promise<void>;
}

export interface CursorAgentHandle {
  readonly agentId: string;
  readonly model?: ModelSelection;
  send(
    message: string | { text: string; images?: Array<{ data: string; mimeType: string }> },
    options?: { model?: ModelSelection }
  ): Promise<CursorRunHandle>;
  close(): void;
}

export interface CursorDriver {
  createAgent(options: {
    agentId?: string;
    cwd: string;
    apiKey: string;
    name?: string;
    model?: ModelSelection;
  }): Promise<CursorAgentHandle>;
  resumeAgent(
    agentId: string,
    options: { cwd: string; apiKey: string; model?: ModelSelection }
  ): Promise<CursorAgentHandle>;
  listAgents(options: {
    cwd: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ items: CursorAgentInfo[]; nextCursor?: string }>;
  getAgent(agentId: string, options: { cwd: string; apiKey?: string }): Promise<CursorAgentInfo>;
  listMessages(
    agentId: string,
    options: { cwd: string; limit?: number; offset?: number }
  ): Promise<CursorAgentMessage[]>;
  listModels(options: { apiKey: string }): Promise<CursorModelListItem[]>;
}

export interface ThreadItem {
  type: 'userMessage' | 'agentMessage' | 'reasoning' | 'toolCall';
  id: string;
  content?: Array<{ type: 'text'; text: string }>;
  text?: string;
  tool?: string;
  status?: string;
  args?: unknown;
  result?: unknown;
  truncated?: {
    args?: boolean;
    result?: boolean;
  };
}

export interface ThreadTurn {
  id: string;
  status: 'completed' | 'in_progress' | 'failed' | 'cancelled';
  items: ThreadItem[];
  error?: { message: string };
}

export interface ThreadRecord {
  id: string;
  name: string | null;
  title: string | null;
  preview: string;
  createdAt: number;
  updatedAt: number;
  status: { type: ThreadLifecycleStatus };
  cwd: string;
  source: 'cursorSdk';
  turns?: ThreadTurn[];
}

export interface CursorAppServerOptions {
  runtime: CursorAppServerRuntime;
  cwd?: string;
  apiKey?: string;
  defaultModel?: string;
  driver?: CursorDriver;
  now?: () => Date;
}
