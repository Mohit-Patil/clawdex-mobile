import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from 'fastify';
import { z } from 'zod';

import { CodexCliAdapter, ThreadBusyError } from './services/codexCliAdapter';
import { GitService } from './services/gitService';
import { RealtimeHub } from './services/realtimeHub';
import { TerminalService } from './services/terminalService';
import type {
  ApprovalDecision,
  BridgeWsEvent,
  CreateThreadInput,
  SendThreadMessageInput
} from './types';

const createThreadSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  message: z.string().trim().min(1).max(20_000).optional()
});

const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  role: z.enum(['user', 'assistant', 'system']).optional()
});

const terminalExecSchema = z.object({
  command: z.string().trim().min(1),
  cwd: z.string().trim().min(1).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional()
});

const gitCommitSchema = z.object({
  message: z.string().trim().min(1).max(500)
});

const approvalDecisionSchema = z.object({
  decision: z.enum(['accept', 'acceptForSession', 'decline', 'cancel'])
});

interface IdParams {
  id: string;
}

type CreateThreadRequest = FastifyRequest<{ Body: CreateThreadInput }>;
type MessageRequest = FastifyRequest<{
  Params: IdParams;
  Body: SendThreadMessageInput;
}>;
type ThreadByIdRequest = FastifyRequest<{ Params: IdParams }>;
type TerminalExecBody = z.infer<typeof terminalExecSchema>;
type TerminalRequest = FastifyRequest<{ Body: TerminalExecBody }>;
type GitCommitBody = z.infer<typeof gitCommitSchema>;
type GitCommitRequest = FastifyRequest<{ Body: GitCommitBody }>;
type ApprovalDecisionBody = z.infer<typeof approvalDecisionSchema>;
type ApprovalDecisionRequest = FastifyRequest<{
  Params: IdParams;
  Body: ApprovalDecisionBody;
}>;

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true
  });

  const startupAt = Date.now();
  const bridgeWorkdir = process.env.BRIDGE_WORKDIR ?? process.cwd();
  const bridgeAuthToken = process.env.BRIDGE_AUTH_TOKEN?.trim() ?? '';
  const authEnabled = bridgeAuthToken.length > 0;
  const realtime = new RealtimeHub();

  const codex = new CodexCliAdapter({
    workdir: bridgeWorkdir,
    cliBin: process.env.CODEX_CLI_BIN ?? undefined,
    cliTimeoutMs: parseTimeoutMs(process.env.CODEX_CLI_TIMEOUT_MS),
    emitEvent: (event) => {
      realtime.broadcast(event);
    }
  });
  const terminal = new TerminalService();
  const git = new GitService(terminal, bridgeWorkdir);

  await app.register(cors, {
    origin: true
  });

  await app.register(websocket);

  if (!authEnabled) {
    app.log.warn(
      'bridge auth is disabled: set BRIDGE_AUTH_TOKEN to require Authorization on REST/WS routes'
    );
  }

  app.addHook('onRequest', async (request, reply) => {
    if (!authEnabled) {
      return;
    }

    if (request.url === '/health' || request.url.startsWith('/health?')) {
      return;
    }

    if (isAuthorized(request, bridgeAuthToken)) {
      return;
    }

    return reply.code(401).send({
      error: 'unauthorized',
      message: 'Missing or invalid bridge token'
    });
  });

  app.get('/ws', { websocket: true }, (socket) => {
    realtime.addClient(socket);

    const healthEvent: BridgeWsEvent = {
      type: 'health',
      payload: {
        status: 'ok',
        at: new Date().toISOString()
      }
    };

    socket.send(JSON.stringify(healthEvent));
  });

  app.get('/health', async () => {
    return {
      status: 'ok' as const,
      at: new Date().toISOString(),
      uptimeSec: Math.floor((Date.now() - startupAt) / 1000)
    };
  });

  app.get('/threads', async () => {
    return codex.listThreads();
  });

  app.post('/threads', async (request: CreateThreadRequest, reply: FastifyReply) => {
    const parsed = createThreadSchema.safeParse((request.body ?? {}) as CreateThreadInput);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const thread = await codex.createThread(parsed.data);
    return reply.code(201).send(thread);
  });

  app.get('/threads/:id', async (request: ThreadByIdRequest, reply: FastifyReply) => {
    const thread = await codex.getThread(request.params.id);
    if (!thread) {
      return reply.code(404).send({ error: 'thread_not_found' });
    }

    return thread;
  });

  app.post(
    '/threads/:id/message',
    async (request: MessageRequest, reply: FastifyReply) => {
      const parsed = sendMessageSchema.safeParse(
        (request.body ?? {}) as SendThreadMessageInput
      );
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      try {
        const thread = await codex.appendMessage(request.params.id, parsed.data);
        if (!thread) {
          return reply.code(404).send({ error: 'thread_not_found' });
        }

        return thread;
      } catch (error) {
        if (error instanceof ThreadBusyError) {
          return reply.code(409).send({
            error: error.code,
            message: error.message,
            threadId: error.threadId
          });
        }

        return reply.code(500).send({
          error: 'thread_message_failed',
          message: (error as Error).message
        });
      }
    }
  );

  app.get('/approvals', async () => {
    return codex.listPendingApprovals();
  });

  app.post(
    '/approvals/:id/decision',
    async (request: ApprovalDecisionRequest, reply: FastifyReply) => {
      const parsed = approvalDecisionSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      const resolved = await codex.resolveApproval(
        request.params.id,
        parsed.data.decision as ApprovalDecision
      );
      if (!resolved) {
        return reply.code(404).send({ error: 'approval_not_found' });
      }

      return {
        ok: true as const,
        approval: resolved,
        decision: parsed.data.decision
      };
    }
  );

  app.post('/terminal/exec', async (request: TerminalRequest, reply: FastifyReply) => {
    const parsed = terminalExecSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const result = await terminal.executeShell(parsed.data.command, {
      cwd: parsed.data.cwd ?? bridgeWorkdir,
      timeoutMs: parsed.data.timeoutMs
    });

    realtime.broadcast({
      type: 'terminal.executed',
      payload: result
    });

    return result;
  });

  app.get('/git/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      return await git.getStatus();
    } catch (error) {
      return reply.code(500).send({
        error: 'git_status_failed',
        message: (error as Error).message
      });
    }
  });

  app.get('/git/diff', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      return await git.getDiff();
    } catch (error) {
      return reply.code(500).send({
        error: 'git_diff_failed',
        message: (error as Error).message
      });
    }
  });

  app.post('/git/commit', async (request: GitCommitRequest, reply: FastifyReply) => {
    const parsed = gitCommitSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const commit = await git.commit(parsed.data.message);
      const status = await git.getStatus();

      realtime.broadcast({
        type: 'git.updated',
        payload: status
      });

      return commit;
    } catch (error) {
      return reply.code(500).send({
        error: 'git_commit_failed',
        message: (error as Error).message
      });
    }
  });

  return app;
}

function parseTimeoutMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return Math.floor(parsed);
}

function isAuthorized(request: FastifyRequest, token: string): boolean {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice('Bearer '.length).trim();
    if (bearer === token) {
      return true;
    }
  }

  const queryToken = (() => {
    try {
      const parsedUrl = new URL(request.url, 'http://localhost');
      return parsedUrl.searchParams.get('token');
    } catch {
      return null;
    }
  })();

  if (queryToken && queryToken === token) {
    return true;
  }

  return false;
}
