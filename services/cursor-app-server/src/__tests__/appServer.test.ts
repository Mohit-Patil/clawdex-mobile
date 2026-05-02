import { PassThrough } from 'node:stream';

import { CursorAppServer } from '../appServer.js';
import { JsonRpcStdioServer } from '../jsonRpc.js';
import type {
  CursorAgentHandle,
  CursorAgentInfo,
  CursorAgentMessage,
  CursorDriver,
  CursorModelListItem,
  CursorRunHandle,
  CursorRunResult,
  CursorStreamMessage,
  ModelSelection,
} from '../types.js';

class MockRun implements CursorRunHandle {
  readonly agentId: string;
  readonly id: string;
  status: 'running' | 'finished' | 'error' | 'cancelled' = 'running';
  cancelCalls = 0;
  conversationCalls = 0;

  constructor(
    agentId: string,
    id: string,
    private readonly messages: CursorStreamMessage[],
    private readonly result: CursorRunResult
  ) {
    this.agentId = agentId;
    this.id = id;
  }

  async *stream(): AsyncGenerator<CursorStreamMessage, void> {
    for (const message of this.messages) {
      yield message;
    }
  }

  async wait(): Promise<CursorRunResult> {
    this.status = this.result.status === 'finished' ? 'finished' : this.result.status;
    return this.result;
  }

  async conversation(): Promise<unknown[]> {
    this.conversationCalls += 1;
    return [];
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
    this.status = 'cancelled';
  }
}

class MockAgent implements CursorAgentHandle {
  sent: Array<{
    message: string | { text: string; images?: Array<{ data: string; mimeType: string }> };
    model?: ModelSelection;
  }> = [];
  runs: MockRun[] = [];

  constructor(
    readonly agentId: string,
    private readonly runFactory: (agentId: string) => CursorRunHandle,
    readonly model?: ModelSelection
  ) {}

  async send(
    message: string | { text: string; images?: Array<{ data: string; mimeType: string }> },
    options?: { model?: ModelSelection }
  ): Promise<CursorRunHandle> {
    this.sent.push({ message, model: options?.model });
    const run = this.runFactory(this.agentId);
    if (run instanceof MockRun) {
      this.runs.push(run);
    }
    return run;
  }

  close(): void {}
}

class MockDriver implements CursorDriver {
  readonly agents = new Map<string, MockAgent>();
  readonly agentInfos = new Map<string, CursorAgentInfo>();
  readonly messages = new Map<string, CursorAgentMessage[]>();
  readonly models: CursorModelListItem[] = [
    {
      id: 'cursor-small',
      displayName: 'Cursor Small',
      providerName: 'Cursor',
    },
  ];
  lastCreateOptions: {
    cwd: string;
    apiKey: string;
    name?: string;
    model?: ModelSelection;
  } | null = null;
  nextRunMessages: CursorStreamMessage[] = [];
  nextRunResult: CursorRunResult = {
    id: 'run-1',
    status: 'finished',
    result: 'Done from Cursor',
  };

  async createAgent(options: {
    agentId?: string;
    cwd: string;
    apiKey: string;
    name?: string;
    model?: ModelSelection;
  }): Promise<CursorAgentHandle> {
    this.lastCreateOptions = options;
    const agentId = options.agentId ?? `cursor-agent-${this.agents.size + 1}`;
    const agent = new MockAgent(
      agentId,
      (id) => new MockRun(id, this.nextRunResult.id, this.nextRunMessages, this.nextRunResult),
      options.model
    );
    const now = Date.UTC(2026, 4, 1, 10, 0, 0);
    this.agents.set(agentId, agent);
    this.agentInfos.set(agentId, {
      agentId,
      name: options.name ?? 'Cursor Agent',
      summary: '',
      lastModified: now,
      createdAt: now,
      status: 'finished',
      runtime: 'local',
      cwd: options.cwd,
    });
    return agent;
  }

  async resumeAgent(agentId: string): Promise<CursorAgentHandle> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`unknown agent ${agentId}`);
    }
    return agent;
  }

  async listAgents(): Promise<{ items: CursorAgentInfo[]; nextCursor?: string }> {
    return {
      items: [...this.agentInfos.values()],
    };
  }

  async getAgent(agentId: string): Promise<CursorAgentInfo> {
    const info = this.agentInfos.get(agentId);
    if (!info) {
      throw new Error(`unknown agent ${agentId}`);
    }
    return info;
  }

  async listMessages(agentId: string): Promise<CursorAgentMessage[]> {
    return this.messages.get(agentId) ?? [];
  }

  async listModels(): Promise<CursorModelListItem[]> {
    return this.models;
  }
}

describe('CursorAppServer', () => {
  it('creates a strict local Cursor thread and starts a streamed turn', async () => {
    const driver = new MockDriver();
    driver.nextRunMessages = [
      {
        type: 'thinking',
        run_id: 'run-1',
        text: 'Thinking through the task',
      },
      {
        type: 'assistant',
        run_id: 'run-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done ' }],
        },
      },
      {
        type: 'assistant',
        run_id: 'run-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'from stream' }],
        },
      },
      {
        type: 'tool_call',
        run_id: 'run-1',
        call_id: 'tool-read-1',
        name: 'read',
        status: 'completed',
        args: { path: '/workspace/app/package.json' },
        result: { status: 'success', value: { content: '{}' } },
      },
      {
        type: 'thinking',
        run_id: 'run-1',
        text: 'Summarizing the result',
      },
    ];
    driver.nextRunResult = {
      id: 'run-1',
      status: 'finished',
      result: 'Done from stream',
    };
    const server = new CursorAppServer({
      runtime: 'local',
      cwd: '/workspace/app',
      apiKey: 'cursor-key',
      defaultModel: 'cursor-small',
      driver,
    });
    const notifications: string[] = [];
    server.onNotification((event) => notifications.push(event.method));

    const created = await server.request('thread/start', {
      threadName: 'Cursor mobile adapter',
    });
    const thread = created.thread as { id: string; cwd: string };
    expect(thread.id).toBe('cursor-agent-1');
    expect(thread.cwd).toBe('/workspace/app');
    expect(driver.lastCreateOptions?.apiKey).toBe('cursor-key');
    expect(driver.lastCreateOptions?.model?.id).toBe('cursor-small');

    const started = await server.request('turn/start', {
      threadId: thread.id,
      input: [
        { type: 'text', text: 'Implement this' },
        { type: 'mention', name: 'MainScreen', path: 'apps/mobile/src/screens/MainScreen.tsx' },
      ],
    });
    expect(started.turn).toEqual({ id: 'run-1' });
    expect(driver.agents.get(thread.id)?.sent[0]?.model?.id).toBe('cursor-small');

    await waitFor(() => notifications.includes('turn/completed'));
    expect(driver.agents.get(thread.id)?.runs[0]?.conversationCalls).toBe(1);
    expect(notifications).toEqual([
      'thread/started',
      'turn/started',
      'thread/status/changed',
      'item/reasoning/textDelta',
      'item/agentMessage/delta',
      'item/agentMessage/delta',
      'item/started',
      'item/completed',
      'item/reasoning/textDelta',
      'turn/completed',
      'thread/status/changed',
    ]);

    const read = await server.request('thread/read', { threadId: thread.id });
    const readThread = read.thread as {
      turns: Array<{ items: Array<{ type: string; text?: string; tool?: string }> }>;
    };
    expect(readThread.turns[0]?.items.map((item) => item.type)).toEqual([
      'userMessage',
      'toolCall',
      'reasoning',
      'agentMessage',
    ]);
    const agentItems = readThread.turns[0]?.items.filter((item) => item.type === 'agentMessage');
    const toolItems = readThread.turns[0]?.items.filter((item) => item.type === 'toolCall');
    expect(agentItems).toHaveLength(1);
    expect(agentItems?.[0]?.text).toBe('Done from stream');
    expect(toolItems?.[0]?.tool).toBe('read');
  });

  it('projects Cursor git run metadata as a completed git activity item', async () => {
    const driver = new MockDriver();
    driver.nextRunResult = {
      id: 'run-git',
      status: 'finished',
      result: 'Opened a PR.',
      git: {
        branches: [
          {
            repoUrl: 'https://github.com/example/app',
            branch: 'cursor/update-mobile-ui',
            prUrl: 'https://github.com/example/app/pull/12',
          },
        ],
      },
    };
    const server = new CursorAppServer({
      runtime: 'local',
      cwd: '/workspace/app',
      apiKey: 'cursor-key',
      defaultModel: 'cursor-small',
      driver,
    });
    const completedItems: Array<{ tool?: string; result?: unknown }> = [];
    server.onNotification((event) => {
      if (event.method === 'item/completed') {
        completedItems.push(event.params.item as { tool?: string; result?: unknown });
      }
    });

    const created = await server.request('thread/start', {});
    const thread = created.thread as { id: string };
    await server.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'Create a PR' }],
    });

    await waitFor(() => completedItems.some((item) => item.tool === 'git'));
    const read = await server.request('thread/read', { threadId: thread.id });
    const readThread = read.thread as {
      turns: Array<{ items: Array<{ type: string; tool?: string; result?: unknown }> }>;
    };
    const gitItem = readThread.turns[0]?.items.find((item) => item.tool === 'git');

    expect(gitItem).toMatchObject({
      type: 'toolCall',
      tool: 'git',
    });
  });

  it('projects chunked historical Cursor messages as one assistant reply with a useful title', async () => {
    const driver = new MockDriver();
    const now = Date.UTC(2026, 4, 1, 10, 0, 0);
    driver.agentInfos.set('cursor-agent-history', {
      agentId: 'cursor-agent-history',
      name: 'New Agent',
      summary: '',
      lastModified: now,
      createdAt: now,
      status: 'finished',
      runtime: 'local',
      cwd: '/workspace/app',
    });
    driver.messages.set('cursor-agent-history', [
      {
        type: 'user',
        uuid: 'message-user',
        agent_id: 'cursor-agent-history',
        message: 'What can you see in the code?',
      },
      {
        type: 'assistant',
        uuid: 'message-assistant-1',
        agent_id: 'cursor-agent-history',
        message: 'Expl',
      },
      {
        type: 'assistant',
        uuid: 'message-assistant-2',
        agent_id: 'cursor-agent-history',
        message: 'oring the code.',
      },
    ]);
    const server = new CursorAppServer({
      runtime: 'local',
      cwd: '/workspace/app',
      apiKey: 'cursor-key',
      defaultModel: 'cursor-small',
      driver,
    });

    const read = await server.request('thread/read', { threadId: 'cursor-agent-history' });
    const readThread = read.thread as {
      title: string | null;
      turns: Array<{ items: Array<{ type: string; text?: string }> }>;
    };
    const agentItems = readThread.turns[0]?.items.filter((item) => item.type === 'agentMessage');

    expect(readThread.title).toBe('What can you see in the code?');
    expect(agentItems).toHaveLength(1);
    expect(agentItems?.[0]?.text).toBe('Exploring the code.');
  });

  it('fails when no cwd is configured instead of falling back to process.cwd()', async () => {
    const server = new CursorAppServer({
      runtime: 'local',
      apiKey: 'cursor-key',
      defaultModel: 'cursor-small',
      driver: new MockDriver(),
    });

    await expect(server.request('thread/start', {})).rejects.toThrow(
      'no workspace fallback is allowed'
    );
  });

  it('fails when no model is configured instead of picking an implicit default', async () => {
    const server = new CursorAppServer({
      runtime: 'local',
      cwd: '/workspace/app',
      apiKey: 'cursor-key',
      driver: new MockDriver(),
    });

    await expect(server.request('thread/start', {})).rejects.toThrow(
      'CURSOR_MODEL or per-request model is required'
    );
  });

  it('reuses an explicitly configured thread model without falling back', async () => {
    const driver = new MockDriver();
    const server = new CursorAppServer({
      runtime: 'local',
      cwd: '/workspace/app',
      apiKey: 'cursor-key',
      driver,
    });

    const created = await server.request('thread/start', {
      model: 'cursor-small',
    });
    const thread = created.thread as { id: string };

    await server.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'Use the thread model' }],
    });

    expect(driver.agents.get(thread.id)?.sent[0]?.model?.id).toBe('cursor-small');
  });

  it('fails resumed turns without a configured, requested, or thread model', async () => {
    const driver = new MockDriver();
    const agent = new MockAgent('cursor-agent-existing', (id) =>
      new MockRun(id, driver.nextRunResult.id, driver.nextRunMessages, driver.nextRunResult)
    );
    driver.agents.set(agent.agentId, agent);
    driver.agentInfos.set(agent.agentId, {
      agentId: agent.agentId,
      name: 'Existing Cursor Agent',
      summary: '',
      lastModified: Date.UTC(2026, 4, 1, 10, 0, 0),
      createdAt: Date.UTC(2026, 4, 1, 10, 0, 0),
      status: 'finished',
      runtime: 'local',
      cwd: '/workspace/app',
    });
    const server = new CursorAppServer({
      runtime: 'local',
      cwd: '/workspace/app',
      apiKey: 'cursor-key',
      driver,
    });

    await expect(
      server.request('turn/start', {
        threadId: agent.agentId,
        input: [{ type: 'text', text: 'Resume without model' }],
      })
    ).rejects.toThrow('thread model is required');
  });

  it('fails model/list without CURSOR_API_KEY', async () => {
    const server = new CursorAppServer({
      runtime: 'local',
      cwd: '/workspace/app',
      defaultModel: 'cursor-small',
      driver: new MockDriver(),
    });

    await expect(server.request('model/list')).rejects.toThrow('CURSOR_API_KEY is required');
  });

  it('responds to app-server initialize without falling through to unsupported method', async () => {
    const server = new CursorAppServer({
      runtime: 'local',
      cwd: '/workspace/app',
      apiKey: 'cursor-key',
      defaultModel: 'cursor-small',
      driver: new MockDriver(),
    });

    await expect(server.request('initialize')).resolves.toMatchObject({
      serverInfo: {
        name: '@clawdex/cursor-app-server',
      },
    });
  });

  it('returns JSON-RPC errors for unsupported input instead of degrading it', async () => {
    const server = new CursorAppServer({
      runtime: 'local',
      cwd: '/workspace/app',
      apiKey: 'cursor-key',
      defaultModel: 'cursor-small',
      driver: new MockDriver(),
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = new JsonRpcStdioServer(server, input, output);
    const lines: string[] = [];
    output.on('data', (chunk: Buffer) => {
      lines.push(...chunk.toString('utf8').trim().split('\n').filter(Boolean));
    });
    rpc.start();

    const created = await server.request('thread/start', {});
    const thread = created.thread as { id: string };
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'turn/start',
        params: {
          threadId: thread.id,
          input: [{ type: 'unknownAttachment', path: '/tmp/image.png' }],
        },
      })}\n`
    );

    await waitFor(() => lines.some((line) => readJsonRpcId(line) === 1));
    const response = JSON.parse(
      lines.find((line) => readJsonRpcId(line) === 1) ?? '{}'
    ) as { error?: { message?: string } };
    expect(response.error?.message).toContain(
      'unsupported Cursor turn input item: unknownAttachment'
    );
    rpc.stop();
  });
});

function readJsonRpcId(line: string): string | number | null | undefined {
  try {
    return (JSON.parse(line) as { id?: string | number | null }).id;
  } catch {
    return undefined;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error('timed out waiting for predicate');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
