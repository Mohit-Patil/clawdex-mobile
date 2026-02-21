import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { ApprovalDecision, ApprovalKind, PendingApproval } from '../types';

export interface AppServerNotification {
  method: string;
  params: Record<string, unknown> | null;
}

interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcErrorShape;
}

interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
}

interface CodexAppServerClientOptions {
  cliBin: string;
  timeoutMs: number;
  onStderr?: (chunk: string) => void;
  onApprovalRequested?: (approval: PendingApproval) => void;
}

export interface ThreadListParams {
  limit?: number;
  cursor?: string | null;
  cwd?: string | null;
}

interface PendingApprovalRequest {
  requestId: string | number;
  approval: PendingApproval;
}

export class CodexAppServerClient {
  private readonly cliBin: string;
  private readonly timeoutMs: number;
  private readonly onStderr?: (chunk: string) => void;
  private readonly onApprovalRequested?: (approval: PendingApproval) => void;

  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private started = false;
  private starting: Promise<void> | null = null;
  private requestCounter = 0;
  private pending = new Map<string | number, PendingRequest>();
  private listeners = new Set<(notification: AppServerNotification) => void>();
  private approvalCounter = 0;
  private pendingApprovals = new Map<string, PendingApprovalRequest>();

  constructor(options: CodexAppServerClientOptions) {
    this.cliBin = options.cliBin;
    this.timeoutMs = options.timeoutMs;
    this.onStderr = options.onStderr;
    this.onApprovalRequested = options.onApprovalRequested;
  }

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listPendingApprovals(): PendingApproval[] {
    return [...this.pendingApprovals.values()]
      .map((entry) => structuredClone(entry.approval))
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  async resolveApproval(
    approvalId: string,
    decision: ApprovalDecision
  ): Promise<PendingApproval | null> {
    const pendingApproval = this.pendingApprovals.get(approvalId);
    if (!pendingApproval) {
      return null;
    }

    this.pendingApprovals.delete(approvalId);

    try {
      await this.writeJson({
        jsonrpc: '2.0',
        id: pendingApproval.requestId,
        result: { decision }
      });
    } catch (error) {
      this.pendingApprovals.set(approvalId, pendingApproval);
      throw error;
    }

    return structuredClone(pendingApproval.approval);
  }

  async threadList(params: ThreadListParams = {}): Promise<Record<string, unknown>> {
    return this.request('thread/list', {
      cursor: params.cursor ?? null,
      limit: params.limit ?? 100,
      sortKey: null,
      modelProviders: null,
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'unknown'],
      archived: false,
      cwd: params.cwd ?? null
    });
  }

  async threadRead(threadId: string, includeTurns = true): Promise<Record<string, unknown>> {
    return this.request('thread/read', {
      threadId,
      includeTurns
    });
  }

  async threadStart(params: {
    cwd?: string | null;
    approvalPolicy?: string;
    sandbox?: string;
  }): Promise<Record<string, unknown>> {
    return this.request('thread/start', {
      model: null,
      modelProvider: null,
      cwd: params.cwd ?? null,
      approvalPolicy: params.approvalPolicy ?? 'on-request',
      sandbox: params.sandbox ?? 'workspace-write',
      config: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      ephemeral: null,
      experimentalRawEvents: false,
      persistExtendedHistory: true
    });
  }

  async threadResume(threadId: string): Promise<Record<string, unknown>> {
    return this.request('thread/resume', {
      threadId,
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
      persistExtendedHistory: true
    });
  }

  async turnStart(threadId: string, userText: string): Promise<Record<string, unknown>> {
    return this.request('turn/start', {
      threadId,
      input: [
        {
          type: 'text',
          text: userText,
          text_elements: []
        }
      ],
      cwd: null,
      approvalPolicy: null,
      sandboxPolicy: null,
      model: null,
      effort: null,
      summary: null,
      personality: null,
      outputSchema: null,
      collaborationMode: null
    });
  }

  private async request(method: string, params: unknown): Promise<Record<string, unknown>> {
    await this.ensureStarted();
    return this.requestInternal(method, params);
  }

  private async requestInternal(
    method: string,
    params: unknown
  ): Promise<Record<string, unknown>> {
    const id = `${Date.now()}-${++this.requestCounter}`;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    const result = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server request timeout: ${method}`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timeout
      });

      this.writeJson(payload).catch((error) => {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });

    if (!this.isRecord(result)) {
      throw new Error(`app-server returned non-object result for ${method}`);
    }

    return result;
  }

  private async ensureStarted(): Promise<void> {
    if (this.started) {
      return;
    }

    if (this.starting) {
      return this.starting;
    }

    this.starting = this.startInternal();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startInternal(): Promise<void> {
    const child = spawn(this.cliBin, ['app-server', '--listen', 'stdio://'], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;

      let newlineIndex = this.stdoutBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
        this.handleLine(line);
        newlineIndex = this.stdoutBuffer.indexOf('\n');
      }
    });

    child.stderr.on('data', (chunk: string) => {
      this.onStderr?.(chunk);
    });

    child.on('error', (error) => {
      this.failAllPending(error);
      this.pendingApprovals.clear();
      this.started = false;
    });

    child.on('close', (code, signal) => {
      this.failAllPending(
        new Error(
          `codex app-server closed (code=${String(code)} signal=${String(signal)})`
        )
      );
      this.pendingApprovals.clear();
      this.started = false;
      this.child = null;
    });

    const initializeResult = await this.requestInternal('initialize', {
      clientInfo: {
        name: 'codex-mobile-bridge',
        title: 'Codex Mobile Bridge',
        version: '0.1.0'
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: null
      }
    });

    if (!this.isRecord(initializeResult)) {
      throw new Error('app-server initialize returned invalid payload');
    }

    await this.writeJson({
      jsonrpc: '2.0',
      method: 'initialized',
      params: null
    });

    this.started = true;
  }

  private handleLine(line: string): void {
    if (!line) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    if (!this.isRecord(parsed)) {
      return;
    }

    const hasMethod = typeof parsed.method === 'string';
    const hasId = typeof parsed.id === 'string' || typeof parsed.id === 'number';

    if (hasMethod && hasId) {
      this.handleServerRequest({
        id: parsed.id as string | number,
        method: String(parsed.method),
        params: parsed.params
      });
      return;
    }

    if (hasMethod) {
      this.emitNotification({
        method: String(parsed.method),
        params: this.isRecord(parsed.params) ? parsed.params : null
      });
      return;
    }

    if ('id' in parsed) {
      this.handleResponse({
        id: (parsed.id as string | number | null) ?? null,
        result: parsed.result,
        error: this.isRecord(parsed.error)
          ? {
            code: Number(parsed.error.code),
            message: String(parsed.error.message),
            data: parsed.error.data
          }
          : undefined
      });
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    const requestId = response.id;
    if (requestId === null || requestId === undefined) {
      return;
    }

    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(requestId);

    if (response.error) {
      console.error(`[RPC ERROR]`, JSON.stringify(response.error));
      pending.reject(
        new Error(
          `app-server error ${String(response.error.code)}: ${response.error.message}`
        )
      );
      return;
    }

    pending.resolve(response.result ?? null);
  }

  private handleServerRequest(request: JsonRpcRequest): void {
    const method = request.method;

    if (method === 'item/commandExecution/requestApproval') {
      this.queueApprovalRequest('commandExecution', request);
      return;
    }

    if (method === 'item/fileChange/requestApproval') {
      this.queueApprovalRequest('fileChange', request);
      return;
    }

    void this.writeJson({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32601,
        message: `Unsupported server request method: ${method}`
      }
    });
  }

  private queueApprovalRequest(kind: ApprovalKind, request: JsonRpcRequest): void {
    const params = this.isRecord(request.params) ? request.params : {};
    const threadId = this.readString(params.threadId) ?? 'unknown-thread';
    const turnId = this.readString(params.turnId) ?? 'unknown-turn';
    const itemId = this.readString(params.itemId) ?? 'unknown-item';

    const approval: PendingApproval = {
      id: `${Date.now()}-${++this.approvalCounter}`,
      kind,
      threadId,
      turnId,
      itemId,
      requestedAt: new Date().toISOString(),
      reason: this.readString(params.reason) ?? undefined,
      command: this.readString(params.command) ?? undefined,
      cwd: this.readString(params.cwd) ?? undefined,
      grantRoot: this.readString(params.grantRoot) ?? undefined
    };

    this.pendingApprovals.set(approval.id, {
      requestId: request.id,
      approval
    });

    this.onApprovalRequested?.(structuredClone(approval));
  }

  private emitNotification(notification: AppServerNotification): void {
    for (const listener of this.listeners) {
      listener(notification);
    }
  }

  private async writeJson(payload: Record<string, unknown>): Promise<void> {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error('app-server stdin is not writable');
    }

    const line = JSON.stringify(payload);
    await new Promise<void>((resolve, reject) => {
      this.child?.stdin.write(`${line}\n`, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private failAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private readString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }
}
