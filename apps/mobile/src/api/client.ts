import type {
  CreateThreadRequest,
  GitCommitRequest,
  GitCommitResponse,
  GitDiffResponse,
  GitStatusResponse,
  SendThreadMessageRequest,
  TerminalExecRequest,
  TerminalExecResponse,
  Thread,
  ThreadSummary
} from './types';

interface HealthResponse {
  status: 'ok';
  at: string;
  uptimeSec: number;
}

interface ApiClientOptions {
  baseUrl: string;
  timeoutMs?: number;
}

export class MacBridgeApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  wsUrl(): string {
    const wsBase = this.baseUrl.startsWith('https://')
      ? this.baseUrl.replace('https://', 'wss://')
      : this.baseUrl.replace('http://', 'ws://');

    return `${wsBase}/ws`;
  }

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/health');
  }

  listThreads(): Promise<ThreadSummary[]> {
    return this.request<ThreadSummary[]>('/threads');
  }

  createThread(body: CreateThreadRequest): Promise<Thread> {
    return this.request<Thread>('/threads', {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  getThread(id: string): Promise<Thread> {
    return this.request<Thread>(`/threads/${encodeURIComponent(id)}`);
  }

  sendThreadMessage(id: string, body: SendThreadMessageRequest): Promise<Thread> {
    return this.request<Thread>(`/threads/${encodeURIComponent(id)}/message`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  execTerminal(body: TerminalExecRequest): Promise<TerminalExecResponse> {
    return this.request<TerminalExecResponse>('/terminal/exec', {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  gitStatus(): Promise<GitStatusResponse> {
    return this.request<GitStatusResponse>('/git/status');
  }

  gitDiff(): Promise<GitDiffResponse> {
    return this.request<GitDiffResponse>('/git/diff');
  }

  gitCommit(body: GitCommitRequest): Promise<GitCommitResponse> {
    return this.request<GitCommitResponse>('/git/commit', {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(init.headers ?? {})
        },
        signal: controller.signal
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status}: ${body}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
