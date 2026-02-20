export type ThreadStatus = 'idle' | 'running' | 'error' | 'complete';

export type ThreadMessageRole = 'user' | 'assistant' | 'system';

export interface ThreadMessage {
  id: string;
  role: ThreadMessageRole;
  content: string;
  createdAt: string;
}

export interface ThreadSummary {
  id: string;
  title: string;
  status: ThreadStatus;
  createdAt: string;
  updatedAt: string;
  statusUpdatedAt: string;
  lastMessagePreview: string;
  cwd?: string;
  modelProvider?: string;
  sourceKind?: string;
  lastRunStartedAt?: string;
  lastRunFinishedAt?: string;
  lastRunDurationMs?: number;
  lastRunExitCode?: number | null;
  lastRunTimedOut?: boolean;
  lastError?: string;
}

export interface Thread extends ThreadSummary {
  messages: ThreadMessage[];
}

export interface CreateThreadRequest {
  title?: string;
  message?: string;
}

export interface SendThreadMessageRequest {
  content: string;
  role?: ThreadMessageRole;
}

export interface TerminalExecRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface TerminalExecResponse {
  command: string;
  cwd: string;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface GitStatusResponse {
  branch: string;
  clean: boolean;
  raw: string;
}

export interface GitDiffResponse {
  diff: string;
}

export interface GitCommitRequest {
  message: string;
}

export interface GitCommitResponse {
  code: number | null;
  stdout: string;
  stderr: string;
  committed: boolean;
}

export type BridgeWsEvent =
  | {
      type: 'thread.created';
      payload: ThreadSummary;
    }
  | {
      type: 'thread.updated';
      payload: ThreadSummary;
    }
  | {
      type: 'thread.message';
      payload: {
        threadId: string;
        message: ThreadMessage;
      };
    }
  | {
      type: 'thread.message.delta';
      payload: {
        threadId: string;
        messageId: string;
        delta: string;
        content: string;
        updatedAt: string;
      };
    }
  | {
      type: 'thread.run.event';
      payload: {
        threadId: string;
        eventType: string;
        at: string;
        detail?: string;
      };
    }
  | {
      type: 'terminal.executed';
      payload: TerminalExecResponse;
    }
  | {
      type: 'git.updated';
      payload: GitStatusResponse;
    }
  | {
      type: 'health';
      payload: {
        status: 'ok';
        at: string;
      };
    };
