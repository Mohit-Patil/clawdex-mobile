import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from 'fastify';
import { z } from 'zod';

import { CodexCliAdapter, ThreadBusyError } from './services/codexCliAdapter';
import { GitService } from './services/gitService';
import { RealtimeHub } from './services/realtimeHub';
import {
  TerminalCommandRejectedError,
  TerminalService
} from './services/terminalService';
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
  const bridgeWorkdir = resolvePath(process.env.BRIDGE_WORKDIR ?? process.cwd());
  const bridgeAuthToken = process.env.BRIDGE_AUTH_TOKEN?.trim() ?? '';
  const allowInsecureNoAuth = parseBoolean(process.env.BRIDGE_ALLOW_INSECURE_NO_AUTH);
  const allowQueryTokenAuth = parseBoolean(process.env.BRIDGE_ALLOW_QUERY_TOKEN_AUTH);
  const terminalEnabled = !parseBoolean(process.env.BRIDGE_DISABLE_TERMINAL_EXEC);
  const terminalAllowedCommands = parseCsvList(process.env.BRIDGE_TERMINAL_ALLOWED_COMMANDS, [
    'pwd',
    'ls',
    'cat',
    'git'
  ]);
  const corsOrigins = parseCsvList(process.env.BRIDGE_CORS_ORIGINS);

  if (!bridgeAuthToken && !allowInsecureNoAuth) {
    throw new Error(
      'BRIDGE_AUTH_TOKEN is required. Set BRIDGE_ALLOW_INSECURE_NO_AUTH=true only for local development.'
    );
  }

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
  const terminal = new TerminalService({
    allowedCommands: terminalAllowedCommands
  });
  const git = new GitService(terminal, bridgeWorkdir);

  await app.register(cors, {
    origin: corsOrigins.length > 0 ? corsOrigins : false
  });

  await app.register(websocket);

  if (!authEnabled && allowInsecureNoAuth) {
    app.log.warn(
      'bridge auth is disabled by BRIDGE_ALLOW_INSECURE_NO_AUTH=true (local development only)'
    );
  }
  if (allowQueryTokenAuth) {
    app.log.warn(
      'query-token auth is enabled (BRIDGE_ALLOW_QUERY_TOKEN_AUTH=true); prefer Authorization headers instead'
    );
  }
  if (corsOrigins.length === 0) {
    app.log.info(
      'CORS response headers are disabled. Set BRIDGE_CORS_ORIGINS to allow browser origins.'
    );
  }
  if (!terminalEnabled) {
    app.log.warn('terminal exec endpoint is disabled by BRIDGE_DISABLE_TERMINAL_EXEC=true');
  } else if (terminalAllowedCommands.length === 0) {
    app.log.warn(
      'terminal allowlist is empty; all commands are currently permitted. Set BRIDGE_TERMINAL_ALLOWED_COMMANDS to restrict.'
    );
  }

  app.addHook('onRequest', async (request, reply) => {
    if (!authEnabled) {
      return;
    }

    if (request.url === '/health' || request.url.startsWith('/health?')) {
      return;
    }

    if (isAuthorized(request, bridgeAuthToken, allowQueryTokenAuth)) {
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

    if (!terminalEnabled) {
      return reply.code(403).send({
        error: 'terminal_exec_disabled',
        message: 'Terminal execution is disabled on this bridge.'
      });
    }

    const resolvedCwd = resolveCwdWithinRoot(parsed.data.cwd, bridgeWorkdir);
    if (!resolvedCwd) {
      return reply.code(400).send({
        error: 'invalid_cwd',
        message: 'cwd must stay within BRIDGE_WORKDIR'
      });
    }

    try {
      const result = await terminal.executeShell(parsed.data.command, {
        cwd: resolvedCwd,
        timeoutMs: parsed.data.timeoutMs
      });

      realtime.broadcast({
        type: 'terminal.executed',
        payload: result
      });

      return result;
    } catch (error) {
      if (error instanceof TerminalCommandRejectedError) {
        return reply.code(400).send({
          error: error.code,
          message: error.message
        });
      }

      return reply.code(500).send({
        error: 'terminal_exec_failed',
        message: (error as Error).message
      });
    }
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

function isAuthorized(
  request: FastifyRequest,
  token: string,
  allowQueryTokenAuth: boolean
): boolean {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice('Bearer '.length).trim();
    if (bearer === token) {
      return true;
    }
  }

  if (allowQueryTokenAuth) {
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
  }

  return false;
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return value.trim().toLowerCase() === 'true';
}

function parseCsvList(value: string | undefined, fallback: string[] = []): string[] {
  if (!value) {
    return [...fallback];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveCwdWithinRoot(rawCwd: string | undefined, root: string): string | null {
  const normalizedRoot = resolvePath(root);
  const requested = resolvePath(rawCwd ?? normalizedRoot);
  const rel = relative(normalizedRoot, requested);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return requested;
  }

  return null;
}
