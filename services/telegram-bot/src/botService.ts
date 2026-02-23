import { setTimeout as delay } from 'node:timers/promises';

import type { BotConfig } from './config';
import type { BridgeClient } from './bridgeClient';
import type { Logger } from './logger';
import type { StateStore } from './stateStore';
import { TelegramApiError } from './telegramClient';
import type { TelegramClient } from './telegramClient';
import type {
  ApprovalDecision,
  BridgeNotification,
  BridgeReadThreadResponse,
  BridgeResumeThreadResponse,
  BridgeStartThreadResponse,
  BridgeTurnStartResponse,
  PendingApproval,
  PendingUserInputQuestion,
  PendingUserInputRequest,
  TelegramBotCommand,
  TelegramCallbackQuery,
  TelegramInlineKeyboardMarkup,
  TelegramMessage,
  TelegramUpdate,
  TurnRuntimeState,
  UserInputAnswerPayload,
} from './types';

interface BotServiceDependencies {
  config: BotConfig;
  logger: Logger;
  bridge: BridgeClient;
  telegram: TelegramClient;
  stateStore: StateStore;
}

interface BridgeThreadListResponse {
  data?: unknown[];
}

interface BotThreadSummary {
  id: string;
  title: string;
  preview: string | null;
  status: string | null;
  cwd: string | null;
  updatedAtMs: number;
}

type CallbackAction =
  | {
      type: 'approval';
      chatId: string;
      approvalId: string;
      decision: ApprovalDecision;
    }
  | {
      type: 'userInputOption';
      chatId: string;
      requestId: string;
      questionId: string;
      answer: string;
    }
  | {
      type: 'switchThread';
      chatId: string;
      threadId: string;
    };

interface CallbackActionEntry {
  action: CallbackAction;
  expiresAt: number;
}

interface MessageReference {
  chatId: string;
  messageId: number;
}

const CALLBACK_ACTION_TTL_MS = 24 * 60 * 60 * 1000;

export class TelegramBridgeBot {
  private readonly config: BotConfig;
  private readonly logger: Logger;
  private readonly bridge: BridgeClient;
  private readonly telegram: TelegramClient;
  private readonly stateStore: StateStore;

  private running = false;
  private updateOffset: number | undefined;
  private bridgeUnsubscribe: (() => void) | null = null;

  private callbackCounter = 1;
  private readonly callbackActions = new Map<string, CallbackActionEntry>();
  private readonly activeTurnsByThreadId = new Map<string, TurnRuntimeState>();
  private readonly approvalMessagesById = new Map<string, MessageReference>();
  private readonly pendingUserInputById = new Map<string, PendingUserInputRequest>();
  private readonly pendingUserInputByChatId = new Map<string, string>();
  private readonly userInputMessagesById = new Map<string, MessageReference>();
  private readonly lastThreadChoicesByChatId = new Map<string, string[]>();

  constructor(dependencies: BotServiceDependencies) {
    this.config = dependencies.config;
    this.logger = dependencies.logger;
    this.bridge = dependencies.bridge;
    this.telegram = dependencies.telegram;
    this.stateStore = dependencies.stateStore;
  }

  async start(): Promise<void> {
    await this.stateStore.load();
    await this.bridge.start();
    this.bridgeUnsubscribe = this.bridge.onNotification((event) => {
      void this.handleBridgeNotification(event);
    });

    this.running = true;

    await this.registerTelegramSurface();
    await this.syncPendingApprovals();

    this.logger.info('Telegram bot started', {
      bridgeWsUrl: this.config.bridge.wsUrl,
      statePath: this.config.telegram.statePath,
      unrestricted: this.config.telegram.allowUnrestricted,
    });

    await this.pollLoop();
  }

  stop(): void {
    this.running = false;

    if (this.bridgeUnsubscribe) {
      this.bridgeUnsubscribe();
      this.bridgeUnsubscribe = null;
    }

    for (const turn of this.activeTurnsByThreadId.values()) {
      if (turn.flushTimer) {
        clearTimeout(turn.flushTimer);
      }
    }

    this.activeTurnsByThreadId.clear();
    this.lastThreadChoicesByChatId.clear();
    this.bridge.stop();
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.telegram.getUpdates({
          offset: this.updateOffset,
          timeoutSec: this.config.telegram.pollTimeoutSec,
          limit: this.config.telegram.pollLimit,
        });

        for (const update of updates) {
          this.updateOffset = update.update_id + 1;
          await this.handleTelegramUpdate(update);
        }
      } catch (error) {
        const retryMs = this.resolvePollRetryDelay(error);
        this.logger.warn('Telegram polling failed', {
          message: (error as Error).message,
          retryMs,
        });
        await delay(retryMs);
      }
    }
  }

  private resolvePollRetryDelay(error: unknown): number {
    if (error instanceof TelegramApiError && error.code === 429 && error.retryAfterSec) {
      return Math.max(1_000, error.retryAfterSec * 1_000);
    }

    return 2_000;
  }

  private async registerTelegramSurface(): Promise<void> {
    const commands = this.buildTelegramCommands();

    try {
      await this.telegram.setMyCommands(commands);
    } catch (error) {
      this.logger.warn('Failed to register Telegram bot commands', {
        message: (error as Error).message,
      });
    }

    const miniAppUrl = this.config.telegram.miniAppUrl;
    if (!miniAppUrl) {
      return;
    }

    try {
      await this.telegram.setChatMenuButton({
        text: this.config.telegram.menuButtonText,
        webAppUrl: miniAppUrl,
      });
    } catch (error) {
      this.logger.warn('Failed to register Telegram menu button', {
        message: (error as Error).message,
      });
    }
  }

  private buildTelegramCommands(): TelegramBotCommand[] {
    const commands: TelegramBotCommand[] = [
      { command: 'new', description: 'Start a new thread' },
      { command: 'thread', description: 'Show current thread' },
      { command: 'threads', description: 'List recent threads' },
      { command: 'use', description: 'Switch by last /threads index' },
      { command: 'switch', description: 'Switch by thread id' },
      { command: 'approvals', description: 'List pending approvals' },
      { command: 'reply', description: 'Submit user input answer' },
      { command: 'help', description: 'Show available commands' },
    ];

    if (this.config.telegram.miniAppUrl) {
      commands.splice(6, 0, {
        command: 'apps',
        description: 'Open mini app menu',
      });
    }

    return commands;
  }

  private async handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message) {
      await this.handleTelegramMessage(update.message);
      return;
    }

    if (update.callback_query) {
      await this.handleTelegramCallback(update.callback_query);
      return;
    }
  }

  private async handleTelegramMessage(message: TelegramMessage): Promise<void> {
    const text = message.text?.trim();
    if (!text) {
      return;
    }

    const chatId = toChatId(message.chat.id);
    const userId = toUserId(message.from?.id);

    if (!this.isAuthorized(chatId, userId)) {
      await this.safeSendMessage(chatId, 'This chat is not authorized to use this bot.');
      return;
    }

    if (isCommand(text)) {
      await this.handleCommand(chatId, text);
      return;
    }

    const pendingRequestId = this.pendingUserInputByChatId.get(chatId);
    if (pendingRequestId) {
      await this.resolveUserInputFromText(chatId, text, pendingRequestId);
      return;
    }

    await this.forwardPromptToCodex(chatId, text);
  }

  private async handleTelegramCallback(callbackQuery: TelegramCallbackQuery): Promise<void> {
    const chatId = callbackQuery.message ? toChatId(callbackQuery.message.chat.id) : null;
    const userId = toUserId(callbackQuery.from.id);

    if (!chatId || !this.isAuthorized(chatId, userId)) {
      await this.safeAnswerCallback(callbackQuery.id, 'Not authorized', true);
      return;
    }

    const data = callbackQuery.data?.trim();
    if (!data || !data.startsWith('cb:')) {
      await this.safeAnswerCallback(callbackQuery.id, 'Invalid callback payload', true);
      return;
    }

    const callbackId = data.slice(3);
    const entry = this.callbackActions.get(callbackId);
    if (!entry || entry.expiresAt < Date.now()) {
      this.callbackActions.delete(callbackId);
      await this.safeAnswerCallback(callbackQuery.id, 'This action has expired.', true);
      return;
    }

    if (entry.action.chatId !== chatId) {
      await this.safeAnswerCallback(callbackQuery.id, 'This action belongs to a different chat.', true);
      return;
    }

    this.callbackActions.delete(callbackId);

    if (entry.action.type === 'approval') {
      await this.resolveApprovalAction(chatId, callbackQuery.id, entry.action);
      return;
    }

    if (entry.action.type === 'switchThread') {
      await this.resolveSwitchThreadAction(chatId, callbackQuery.id, entry.action);
      return;
    }

    await this.resolveUserInputOptionAction(chatId, callbackQuery.id, entry.action);
  }

  private isAuthorized(chatId: string, userId: string | null): boolean {
    if (this.config.telegram.allowUnrestricted) {
      return true;
    }

    const allowedChats = this.config.telegram.allowedChatIds;
    const allowedUsers = this.config.telegram.allowedUserIds;

    if (allowedChats.size > 0 && !allowedChats.has(chatId)) {
      return false;
    }

    if (allowedUsers.size > 0) {
      if (!userId) {
        return false;
      }
      if (!allowedUsers.has(userId)) {
        return false;
      }
    }

    return true;
  }

  private async handleCommand(chatId: string, rawCommand: string): Promise<void> {
    const command = normalizeCommand(rawCommand);

    if (command === '/help' || command === '/start') {
      const miniAppHint = this.config.telegram.miniAppUrl
        ? ['/apps - open mini app actions']
        : [];
      await this.safeSendMessage(
        chatId,
        [
          'Commands:',
          '/new - start a new Codex thread for this chat',
          '/thread - show current mapped thread id',
          '/threads [limit] - list recent threads and quick-switch buttons',
          '/use <number> - switch to a thread from last /threads list',
          '/switch <thread_id> - switch mapping to a specific thread id',
          '/approvals - list pending approvals for this thread',
          ...miniAppHint,
          '/reply <request_id> <answer> - answer a pending request_user_input prompt',
        ].join('\n')
      );

      if (this.config.telegram.miniAppUrl) {
        await this.safeSendMessage(
          chatId,
          'Open the mini app:',
          buildMiniAppMarkup(
            this.config.telegram.menuButtonText,
            this.config.telegram.miniAppUrl
          )
        );
      }
      return;
    }

    if (command === '/new') {
      await this.stateStore.clearChat(chatId);
      const newThreadId = await this.ensureThread(chatId, { forceCreate: true });
      await this.safeSendMessage(chatId, `Started new thread: ${newThreadId}`);
      return;
    }

    if (command === '/thread') {
      const threadId = this.stateStore.getThreadId(chatId);
      if (!threadId) {
        await this.safeSendMessage(chatId, 'No thread mapped yet. Send a message to create one.');
        return;
      }

      const summary = await this.fetchThreadSummary(threadId).catch(() => null);
      if (!summary) {
        await this.safeSendMessage(chatId, `Current thread: ${threadId}`);
        return;
      }

      await this.safeSendMessage(
        chatId,
        [
          `Current thread: ${summary.id}`,
          `title: ${summary.title}`,
          summary.cwd ? `cwd: ${summary.cwd}` : null,
          summary.status ? `status: ${summary.status}` : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n')
      );
      return;
    }

    if (command === '/threads') {
      await this.handleThreadsCommand(chatId, rawCommand);
      return;
    }

    if (command === '/use') {
      await this.handleUseThreadCommand(chatId, rawCommand);
      return;
    }

    if (command === '/switch') {
      await this.handleSwitchThreadCommand(chatId, rawCommand);
      return;
    }

    if (command === '/apps') {
      await this.handleAppsCommand(chatId);
      return;
    }

    if (command === '/approvals') {
      await this.listApprovalsForChat(chatId);
      return;
    }

    if (command === '/reply') {
      await this.handleReplyCommand(chatId, rawCommand);
      return;
    }

    await this.safeSendMessage(chatId, 'Unknown command. Use /help for supported commands.');
  }

  private async handleReplyCommand(chatId: string, rawCommand: string): Promise<void> {
    const withoutPrefix = rawCommand.replace(/^\/reply(?:@\w+)?\s*/i, '').trim();
    if (!withoutPrefix) {
      await this.safeSendMessage(chatId, 'Usage: /reply <request_id> <answer>');
      return;
    }

    const parts = withoutPrefix.split(/\s+/);
    const firstToken = parts[0] ?? '';
    let requestId: string | null = null;
    let answerText = withoutPrefix;

    if (this.pendingUserInputById.has(firstToken)) {
      requestId = firstToken;
      answerText = withoutPrefix.slice(firstToken.length).trim();
    } else {
      requestId = this.pendingUserInputByChatId.get(chatId) ?? null;
      answerText = withoutPrefix;
    }

    if (!requestId) {
      await this.safeSendMessage(chatId, 'No pending input request found for this chat.');
      return;
    }

    if (!answerText) {
      await this.safeSendMessage(chatId, 'Answer cannot be empty.');
      return;
    }

    await this.resolveUserInputFromText(chatId, answerText, requestId);
  }

  private async handleThreadsCommand(chatId: string, rawCommand: string): Promise<void> {
    const rawArg = readCommandArg(rawCommand);
    const limit = parsePositiveInt(rawArg);
    if (rawArg && limit === null) {
      await this.safeSendMessage(chatId, 'Usage: /threads [limit]');
      return;
    }

    const normalizedLimit = clamp(limit ?? 8, 1, 12);
    const summaries = await this.fetchThreadSummaries(normalizedLimit);
    if (summaries.length === 0) {
      await this.safeSendMessage(chatId, 'No threads found yet.');
      return;
    }

    this.lastThreadChoicesByChatId.set(
      chatId,
      summaries.map((summary) => summary.id)
    );

    const text = buildThreadListText(this.stateStore.getThreadId(chatId), summaries);
    const markup = this.buildThreadListMarkup(chatId, summaries);
    await this.safeSendMessage(chatId, text, markup);
  }

  private async handleUseThreadCommand(chatId: string, rawCommand: string): Promise<void> {
    const rawArg = readCommandArg(rawCommand);
    const index = parsePositiveInt(rawArg);
    if (!rawArg || index === null) {
      await this.safeSendMessage(chatId, 'Usage: /use <number>');
      return;
    }

    const choices = this.lastThreadChoicesByChatId.get(chatId);
    if (!choices || choices.length === 0) {
      await this.safeSendMessage(chatId, 'No thread list cached. Run /threads first.');
      return;
    }

    if (index < 1 || index > choices.length) {
      await this.safeSendMessage(chatId, `Invalid selection. Choose 1-${String(choices.length)}.`);
      return;
    }

    const threadId = choices[index - 1];
    if (!threadId) {
      await this.safeSendMessage(chatId, 'Selected thread could not be resolved.');
      return;
    }

    await this.switchThreadForChat(chatId, threadId);
  }

  private async handleSwitchThreadCommand(chatId: string, rawCommand: string): Promise<void> {
    const threadId = readCommandArg(rawCommand);
    if (!threadId) {
      await this.safeSendMessage(chatId, 'Usage: /switch <thread_id>');
      return;
    }

    await this.switchThreadForChat(chatId, threadId);
  }

  private async handleAppsCommand(chatId: string): Promise<void> {
    const miniAppUrl = this.config.telegram.miniAppUrl;
    if (!miniAppUrl) {
      await this.safeSendMessage(chatId, 'Mini app is not configured on this bot.');
      return;
    }

    await this.safeSendMessage(
      chatId,
      'Mini app actions:',
      buildMiniAppMarkup(this.config.telegram.menuButtonText, miniAppUrl)
    );
  }

  private async switchThreadForChat(chatId: string, threadId: string): Promise<void> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      await this.safeSendMessage(chatId, 'Thread id cannot be empty.');
      return;
    }

    try {
      await this.resumeThread(normalizedThreadId);
      await this.stateStore.setThreadId(chatId, normalizedThreadId);

      const summary = await this.fetchThreadSummary(normalizedThreadId).catch(() => null);
      await this.safeSendMessage(
        chatId,
        summary
          ? `Switched to thread ${summary.id}\n${summary.title}`
          : `Switched to thread ${normalizedThreadId}`
      );
    } catch (error) {
      await this.safeSendMessage(
        chatId,
        `Failed to switch thread: ${(error as Error).message}`
      );
    }
  }

  private async fetchThreadSummaries(limit: number): Promise<BotThreadSummary[]> {
    const response = await this.bridge.request<BridgeThreadListResponse>('thread/list', {
      cursor: null,
      limit,
      sortKey: null,
      modelProviders: null,
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
      archived: false,
      cwd: null,
    });

    const rawList = Array.isArray(response.data) ? response.data : [];
    const summaries = rawList
      .map((entry) => parseThreadSummary(entry))
      .filter((entry): entry is BotThreadSummary => entry !== null)
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs);

    return summaries.slice(0, limit);
  }

  private async fetchThreadSummary(threadId: string): Promise<BotThreadSummary | null> {
    const response = await this.bridge.request<BridgeReadThreadResponse>('thread/read', {
      threadId,
      includeTurns: false,
    });

    return parseThreadSummary(response.thread);
  }

  private buildThreadListMarkup(
    chatId: string,
    summaries: BotThreadSummary[]
  ): TelegramInlineKeyboardMarkup | undefined {
    const buttonRows = summaries.slice(0, 8).map((summary, index) => {
      const callbackId = this.registerCallbackAction({
        type: 'switchThread',
        chatId,
        threadId: summary.id,
      });

      return [
        {
          text: `#${String(index + 1)} ${truncateLabel(summary.title, 28)}`,
          callback_data: `cb:${callbackId}`,
        },
      ];
    });

    if (buttonRows.length === 0) {
      return undefined;
    }

    return {
      inline_keyboard: buttonRows,
    };
  }

  private async listApprovalsForChat(chatId: string): Promise<void> {
    const threadId = this.stateStore.getThreadId(chatId);
    if (!threadId) {
      await this.safeSendMessage(chatId, 'No thread mapped yet.');
      return;
    }

    const approvals = await this.bridge.request<PendingApproval[]>('bridge/approvals/list');
    const matches = approvals.filter((approval) => approval.threadId === threadId);

    if (matches.length === 0) {
      await this.safeSendMessage(chatId, 'No pending approvals for this thread.');
      return;
    }

    for (const approval of matches) {
      await this.sendApprovalPrompt(approval);
    }
  }

  private async forwardPromptToCodex(chatId: string, userText: string): Promise<void> {
    const threadId = await this.ensureThread(chatId);

    const pendingMessage = await this.safeSendMessage(chatId, 'Thinking...');
    if (!pendingMessage) {
      this.logger.warn('Failed to send placeholder Telegram message', {
        chatId,
      });
      return;
    }

    try {
      await this.resumeThread(threadId);
    } catch (error) {
      this.logger.warn('thread/resume failed before turn/start; continuing anyway', {
        threadId,
        message: (error as Error).message,
      });
    }

    try {
      const turnStart = await this.bridge.request<BridgeTurnStartResponse>('turn/start', {
        threadId,
        input: [
          {
            type: 'text',
            text: userText,
            text_elements: [],
          },
        ],
        cwd: this.config.bridge.defaultCwd,
        approvalPolicy: null,
        sandboxPolicy: null,
        model: this.config.bridge.defaultModel,
        effort: this.config.bridge.defaultEffort,
        summary: null,
        personality: null,
        outputSchema: null,
        collaborationMode: null,
      });

      const turnId = readString((turnStart as { turn?: { id?: string } }).turn?.id);
      if (!turnId) {
        throw new Error('turn/start did not return turn id');
      }

      this.activeTurnsByThreadId.set(threadId, {
        chatId,
        threadId,
        turnId,
        messageId: pendingMessage.message_id,
        streamText: '',
        lastSentText: 'Thinking...',
        lastFlushAt: Date.now(),
        flushTimer: null,
      });
    } catch (error) {
      await this.safeEditMessage(chatId, pendingMessage.message_id, formatBridgeError(error));
      throw error;
    }
  }

  private async ensureThread(
    chatId: string,
    options: { forceCreate?: boolean } = {}
  ): Promise<string> {
    if (!options.forceCreate) {
      const existingThreadId = this.stateStore.getThreadId(chatId);
      if (existingThreadId) {
        try {
          await this.resumeThread(existingThreadId);
          return existingThreadId;
        } catch (error) {
          this.logger.warn('Existing thread resume failed. Creating a replacement thread.', {
            chatId,
            threadId: existingThreadId,
            message: (error as Error).message,
          });
          await this.stateStore.clearChat(chatId);
        }
      }
    }

    const started = await this.bridge.request<BridgeStartThreadResponse>('thread/start', {
      model: this.config.bridge.defaultModel,
      modelProvider: null,
      cwd: this.config.bridge.defaultCwd,
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      config: null,
      baseInstructions: null,
      developerInstructions: this.config.bridge.developerInstructions,
      personality: null,
      ephemeral: null,
      experimentalRawEvents: true,
      persistExtendedHistory: true,
    });

    const threadId = readString((started as { thread?: { id?: string } }).thread?.id);
    if (!threadId) {
      throw new Error('thread/start did not return thread id');
    }

    await this.stateStore.setThreadId(chatId, threadId);
    return threadId;
  }

  private async resumeThread(threadId: string): Promise<void> {
    const request = {
      threadId,
      history: null,
      path: null,
      model: this.config.bridge.defaultModel,
      modelProvider: null,
      cwd: this.config.bridge.defaultCwd,
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      config: null,
      baseInstructions: null,
      developerInstructions: this.config.bridge.developerInstructions,
      personality: null,
      experimentalRawEvents: true,
      persistExtendedHistory: true,
    };

    try {
      await this.bridge.request<BridgeResumeThreadResponse>('thread/resume', request);
      return;
    } catch (primaryError) {
      const legacyRequest = {
        ...request,
        approvalPolicy: 'on-request',
        developerInstructions: null,
      };
      delete (legacyRequest as { experimentalRawEvents?: boolean }).experimentalRawEvents;

      await this.bridge.request<BridgeResumeThreadResponse>('thread/resume', legacyRequest).catch((fallbackError) => {
        throw new Error(
          `thread/resume failed: ${(primaryError as Error).message}; fallback failed: ${(fallbackError as Error).message}`
        );
      });
    }
  }

  private async handleBridgeNotification(event: BridgeNotification): Promise<void> {
    if (event.method === 'item/agentMessage/delta') {
      const params = asRecord(event.params);
      const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
      const delta = readString(params?.delta);
      if (threadId && delta) {
        this.appendStreamDelta(threadId, delta);
      }
      return;
    }

    if (event.method.startsWith('codex/event/')) {
      const codexDelta = readCodexDelta(event);
      if (codexDelta) {
        this.appendStreamDelta(codexDelta.threadId, codexDelta.delta);
      }
      return;
    }

    if (event.method === 'turn/completed') {
      await this.handleTurnCompleted(event.params);
      return;
    }

    if (event.method === 'bridge/approval.requested') {
      const approval = parsePendingApproval(event.params);
      if (approval) {
        await this.sendApprovalPrompt(approval);
      }
      return;
    }

    if (event.method === 'bridge/approval.resolved') {
      await this.markApprovalResolved(event.params);
      return;
    }

    if (event.method === 'bridge/userInput.requested') {
      const request = parsePendingUserInputRequest(event.params);
      if (request) {
        await this.sendUserInputPrompt(request);
      }
      return;
    }

    if (event.method === 'bridge/userInput.resolved') {
      await this.markUserInputResolved(event.params);
      return;
    }
  }

  private appendStreamDelta(threadId: string, delta: string): void {
    const runtime = this.activeTurnsByThreadId.get(threadId);
    if (!runtime) {
      return;
    }

    runtime.streamText = mergeStreamingDelta(runtime.streamText, delta);
    this.scheduleStreamFlush(threadId);
  }

  private scheduleStreamFlush(threadId: string): void {
    const runtime = this.activeTurnsByThreadId.get(threadId);
    if (!runtime) {
      return;
    }

    if (runtime.flushTimer) {
      return;
    }

    const elapsedMs = Date.now() - runtime.lastFlushAt;
    const waitMs = Math.max(0, this.config.telegram.streamUpdateIntervalMs - elapsedMs);

    runtime.flushTimer = setTimeout(() => {
      runtime.flushTimer = null;
      void this.flushStreamUpdate(threadId);
    }, waitMs);
  }

  private async flushStreamUpdate(threadId: string): Promise<void> {
    const runtime = this.activeTurnsByThreadId.get(threadId);
    if (!runtime) {
      return;
    }

    const nextText = this.clampMessage(runtime.streamText.trim() || 'Thinking...');
    if (!nextText || nextText === runtime.lastSentText) {
      return;
    }

    const updated = await this.safeEditMessage(runtime.chatId, runtime.messageId, nextText);
    if (!updated) {
      return;
    }

    runtime.lastSentText = nextText;
    runtime.lastFlushAt = Date.now();
  }

  private async handleTurnCompleted(params: unknown): Promise<void> {
    const record = asRecord(params);
    const turn = asRecord(record?.turn);
    const threadId =
      readString(record?.threadId) ??
      readString(record?.thread_id) ??
      readString(turn?.threadId) ??
      readString(turn?.thread_id);
    if (!threadId) {
      return;
    }

    const runtime = this.activeTurnsByThreadId.get(threadId);
    if (!runtime) {
      return;
    }

    const completedTurnId =
      readString(turn?.id) ??
      readString(turn?.turnId) ??
      readString(record?.turnId) ??
      readString(record?.turn_id);
    if (completedTurnId && completedTurnId !== runtime.turnId) {
      return;
    }

    if (runtime.flushTimer) {
      clearTimeout(runtime.flushTimer);
      runtime.flushTimer = null;
    }

    const status = readString(turn?.status) ?? readString(record?.status);
    const turnError = asRecord(turn?.error) ?? asRecord(record?.error);
    const errorMessage = readString(turnError?.message);

    const finalText = await this.buildTurnCompletionText(
      threadId,
      completedTurnId ?? runtime.turnId,
      runtime.streamText,
      status,
      errorMessage
    );
    await this.safeEditMessage(runtime.chatId, runtime.messageId, finalText);

    this.activeTurnsByThreadId.delete(threadId);
  }

  private async buildTurnCompletionText(
    threadId: string,
    turnId: string,
    streamedText: string,
    status: string | null,
    errorMessage: string | null
  ): Promise<string> {
    const fallbackText = streamedText.trim();

    try {
      const response = await this.bridge.request<BridgeReadThreadResponse>('thread/read', {
        threadId,
        includeTurns: true,
      });

      const assistantText = extractLatestAssistantMessage(response.thread, turnId);
      if (assistantText) {
        return this.clampMessage(assistantText);
      }
    } catch (error) {
      this.logger.warn('thread/read failed when finalizing turn', {
        threadId,
        message: (error as Error).message,
      });
    }

    if (fallbackText) {
      return this.clampMessage(fallbackText);
    }

    if (status === 'failed' || status === 'interrupted') {
      return this.clampMessage(`Turn ${status}. ${errorMessage ?? 'No additional details.'}`);
    }

    return 'Turn completed.';
  }

  private async syncPendingApprovals(): Promise<void> {
    try {
      const approvals = await this.bridge.request<PendingApproval[]>('bridge/approvals/list');
      for (const approval of approvals) {
        await this.sendApprovalPrompt(approval);
      }
    } catch (error) {
      this.logger.warn('Failed to sync pending approvals at startup', {
        message: (error as Error).message,
      });
    }
  }

  private async sendApprovalPrompt(approval: PendingApproval): Promise<void> {
    if (this.approvalMessagesById.has(approval.id)) {
      return;
    }

    const chatId = this.stateStore.findChatIdByThreadId(approval.threadId);
    if (!chatId) {
      this.logger.warn('Received approval for unmapped thread. Skipping Telegram prompt.', {
        approvalId: approval.id,
        threadId: approval.threadId,
      });
      return;
    }

    const text = buildApprovalText(approval);

    const markup: TelegramInlineKeyboardMarkup = {
      inline_keyboard: [
        [
          {
            text: 'Approve',
            callback_data: `cb:${this.registerCallbackAction({
              type: 'approval',
              chatId,
              approvalId: approval.id,
              decision: 'accept',
            })}`,
          },
          {
            text: 'Approve Session',
            callback_data: `cb:${this.registerCallbackAction({
              type: 'approval',
              chatId,
              approvalId: approval.id,
              decision: 'acceptForSession',
            })}`,
          },
        ],
        [
          {
            text: 'Decline',
            callback_data: `cb:${this.registerCallbackAction({
              type: 'approval',
              chatId,
              approvalId: approval.id,
              decision: 'decline',
            })}`,
          },
          {
            text: 'Cancel',
            callback_data: `cb:${this.registerCallbackAction({
              type: 'approval',
              chatId,
              approvalId: approval.id,
              decision: 'cancel',
            })}`,
          },
        ],
      ],
    };

    const message = await this.safeSendMessage(chatId, text, markup);
    if (!message) {
      return;
    }

    this.approvalMessagesById.set(approval.id, {
      chatId,
      messageId: message.message_id,
    });
  }

  private async markApprovalResolved(params: unknown): Promise<void> {
    const record = asRecord(params);
    const approvalId = readString(record?.id);
    if (!approvalId) {
      return;
    }

    const decision = readString(record?.decision) ?? 'resolved';
    const reference = this.approvalMessagesById.get(approvalId);
    if (reference) {
      await this.safeEditMessage(
        reference.chatId,
        reference.messageId,
        this.clampMessage(`Approval ${approvalId} resolved with decision: ${decision}`)
      );
    }

    this.approvalMessagesById.delete(approvalId);
  }

  private async resolveApprovalAction(
    chatId: string,
    callbackQueryId: string,
    action: Extract<CallbackAction, { type: 'approval' }>
  ): Promise<void> {
    try {
      await this.bridge.request('bridge/approvals/resolve', {
        id: action.approvalId,
        decision: action.decision,
      });
      await this.safeAnswerCallback(callbackQueryId, `Decision sent: ${action.decision}`);
      const reference = this.approvalMessagesById.get(action.approvalId);
      if (reference) {
        await this.safeEditMessage(
          reference.chatId,
          reference.messageId,
          this.clampMessage(`Approval ${action.approvalId} resolved with decision: ${action.decision}`)
        );
      }
      this.approvalMessagesById.delete(action.approvalId);
    } catch (error) {
      await this.safeAnswerCallback(callbackQueryId, `Failed: ${(error as Error).message}`, true);
      await this.safeSendMessage(chatId, `Approval resolve failed: ${(error as Error).message}`);
    }
  }

  private async resolveSwitchThreadAction(
    chatId: string,
    callbackQueryId: string,
    action: Extract<CallbackAction, { type: 'switchThread' }>
  ): Promise<void> {
    try {
      await this.resumeThread(action.threadId);
      await this.stateStore.setThreadId(chatId, action.threadId);
      await this.safeAnswerCallback(callbackQueryId, 'Thread switched');

      const summary = await this.fetchThreadSummary(action.threadId).catch(() => null);
      await this.safeSendMessage(
        chatId,
        summary
          ? `Switched to thread ${summary.id}\n${summary.title}`
          : `Switched to thread ${action.threadId}`
      );
    } catch (error) {
      await this.safeAnswerCallback(callbackQueryId, 'Failed to switch thread', true);
      await this.safeSendMessage(chatId, `Failed to switch thread: ${(error as Error).message}`);
    }
  }

  private async sendUserInputPrompt(request: PendingUserInputRequest): Promise<void> {
    this.pendingUserInputById.set(request.id, request);

    const chatId = this.stateStore.findChatIdByThreadId(request.threadId);
    if (!chatId) {
      this.logger.warn('Received user input request for unmapped thread', {
        requestId: request.id,
        threadId: request.threadId,
      });
      return;
    }

    this.pendingUserInputByChatId.set(chatId, request.id);

    const text = buildUserInputPromptText(request);
    const markup = this.buildUserInputPromptMarkup(chatId, request);
    const message = await this.safeSendMessage(chatId, text, markup);
    if (!message) {
      return;
    }

    this.userInputMessagesById.set(request.id, {
      chatId,
      messageId: message.message_id,
    });
  }

  private buildUserInputPromptMarkup(
    chatId: string,
    request: PendingUserInputRequest
  ): TelegramInlineKeyboardMarkup | undefined {
    if (request.questions.length !== 1) {
      return undefined;
    }

    const question = request.questions[0];
    if (!question || !question.options || question.options.length === 0 || question.isSecret) {
      return undefined;
    }

    const keyboardRows = question.options.map((option) => {
      const callbackId = this.registerCallbackAction({
        type: 'userInputOption',
        chatId,
        requestId: request.id,
        questionId: question.id,
        answer: option.label,
      });

      return [
        {
          text: option.label,
          callback_data: `cb:${callbackId}`,
        },
      ];
    });

    return {
      inline_keyboard: keyboardRows,
    };
  }

  private async resolveUserInputOptionAction(
    chatId: string,
    callbackQueryId: string,
    action: Extract<CallbackAction, { type: 'userInputOption' }>
  ): Promise<void> {
    try {
      await this.bridge.request('bridge/userInput/resolve', {
        id: action.requestId,
        answers: {
          [action.questionId]: {
            answers: [action.answer],
          },
        },
      });

      await this.safeAnswerCallback(callbackQueryId, 'Answer submitted');
      await this.safeSendMessage(chatId, 'Answer submitted.');
      this.pendingUserInputById.delete(action.requestId);
      this.pendingUserInputByChatId.delete(chatId);
      this.userInputMessagesById.delete(action.requestId);
    } catch (error) {
      await this.safeAnswerCallback(callbackQueryId, `Failed: ${(error as Error).message}`, true);
      await this.safeSendMessage(chatId, `Failed to submit answer: ${(error as Error).message}`);
    }
  }

  private async resolveUserInputFromText(
    chatId: string,
    rawText: string,
    requestId: string
  ): Promise<void> {
    const request = this.pendingUserInputById.get(requestId);
    if (!request) {
      await this.safeSendMessage(chatId, 'That input request has already been resolved.');
      this.pendingUserInputByChatId.delete(chatId);
      return;
    }

    const answerPayload = parseUserInputAnswerPayload(request.questions, rawText);
    if (!answerPayload) {
      await this.safeSendMessage(
        chatId,
        [
          'Could not parse your answer for this request.',
          'For one question: send plain text.',
          'For multiple questions: use `question_id=answer;question_id_2=answer`.',
        ].join('\n')
      );
      return;
    }

    try {
      await this.bridge.request('bridge/userInput/resolve', {
        id: request.id,
        answers: answerPayload,
      });

      this.pendingUserInputById.delete(request.id);
      this.pendingUserInputByChatId.delete(chatId);

      const reference = this.userInputMessagesById.get(request.id);
      if (reference) {
        await this.safeEditMessage(
          reference.chatId,
          reference.messageId,
          this.clampMessage(`Input request ${request.id} resolved.`)
        );
      }

      this.userInputMessagesById.delete(request.id);
      await this.safeSendMessage(chatId, 'Input submitted.');
    } catch (error) {
      await this.safeSendMessage(chatId, `Failed to submit input: ${(error as Error).message}`);
    }
  }

  private async markUserInputResolved(params: unknown): Promise<void> {
    const record = asRecord(params);
    const requestId = readString(record?.id);
    if (!requestId) {
      return;
    }

    const reference = this.userInputMessagesById.get(requestId);
    if (reference) {
      await this.safeEditMessage(
        reference.chatId,
        reference.messageId,
        this.clampMessage(`Input request ${requestId} resolved.`)
      );
    }

    this.pendingUserInputById.delete(requestId);
    this.userInputMessagesById.delete(requestId);

    for (const [chatId, pendingId] of this.pendingUserInputByChatId.entries()) {
      if (pendingId === requestId) {
        this.pendingUserInputByChatId.delete(chatId);
      }
    }
  }

  private registerCallbackAction(action: CallbackAction): string {
    const callbackId = `${Date.now().toString(36)}${this.callbackCounter.toString(36)}`;
    this.callbackCounter += 1;

    this.callbackActions.set(callbackId, {
      action,
      expiresAt: Date.now() + CALLBACK_ACTION_TTL_MS,
    });

    this.gcExpiredCallbackActions();
    return callbackId;
  }

  private gcExpiredCallbackActions(): void {
    const now = Date.now();
    for (const [callbackId, entry] of this.callbackActions.entries()) {
      if (entry.expiresAt < now) {
        this.callbackActions.delete(callbackId);
      }
    }
  }

  private async safeSendMessage(
    chatId: string,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ): Promise<TelegramMessage | null> {
    try {
      return await this.telegram.sendMessage({
        chatId,
        text: this.clampMessage(text),
        replyMarkup,
      });
    } catch (error) {
      this.logger.warn('Failed to send Telegram message', {
        chatId,
        message: (error as Error).message,
      });
      return null;
    }
  }

  private async safeEditMessage(
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ): Promise<boolean> {
    try {
      await this.telegram.editMessageText({
        chatId,
        messageId,
        text: this.clampMessage(text),
        replyMarkup,
      });
      return true;
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes('message is not modified')) {
        return true;
      }

      this.logger.warn('Failed to edit Telegram message', {
        chatId,
        messageId,
        message,
      });
      return false;
    }
  }

  private async safeAnswerCallback(
    callbackQueryId: string,
    text?: string,
    showAlert?: boolean
  ): Promise<void> {
    try {
      await this.telegram.answerCallback({
        callbackQueryId,
        text,
        showAlert,
      });
    } catch (error) {
      this.logger.warn('Failed to answer callback query', {
        callbackQueryId,
        message: (error as Error).message,
      });
    }
  }

  private clampMessage(value: string): string {
    if (value.length <= this.config.telegram.messageMaxLength) {
      return value;
    }

    return `${value.slice(0, this.config.telegram.messageMaxLength - 1)}…`;
  }
}

function readCodexDelta(
  event: BridgeNotification
): { threadId: string; delta: string } | null {
  const params = asRecord(event.params);
  const msg = asRecord(params?.msg);

  const rawType =
    readString(msg?.type) ??
    (event.method.startsWith('codex/event/')
      ? event.method.replace('codex/event/', '')
      : null);
  const normalizedType = normalizeCodexType(rawType);
  if (normalizedType !== 'agentmessagedelta' && normalizedType !== 'agentmessagecontentdelta') {
    return null;
  }

  const threadId =
    readString(msg?.thread_id) ??
    readString(msg?.threadId) ??
    readString(params?.thread_id) ??
    readString(params?.threadId);
  const delta = readString(msg?.delta);

  if (!threadId || !delta) {
    return null;
  }

  return {
    threadId,
    delta,
  };
}

function parsePendingApproval(value: unknown): PendingApproval | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const id = readString(record.id);
  const threadId = readString(record.threadId);
  const turnId = readString(record.turnId);
  const itemId = readString(record.itemId);
  const kind = readString(record.kind);
  const requestedAt = readString(record.requestedAt);

  if (!id || !threadId || !turnId || !itemId || !kind || !requestedAt) {
    return null;
  }

  const proposedExecpolicyAmendment = Array.isArray(record.proposedExecpolicyAmendment)
    ? record.proposedExecpolicyAmendment.filter((entry): entry is string => typeof entry === 'string')
    : undefined;

  return {
    id,
    kind,
    threadId,
    turnId,
    itemId,
    requestedAt,
    reason: readString(record.reason) ?? undefined,
    command: readString(record.command) ?? undefined,
    cwd: readString(record.cwd) ?? undefined,
    grantRoot: readString(record.grantRoot) ?? undefined,
    proposedExecpolicyAmendment,
  };
}

function parsePendingUserInputRequest(value: unknown): PendingUserInputRequest | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const id = readString(record.id);
  const threadId = readString(record.threadId);
  const turnId = readString(record.turnId);
  const itemId = readString(record.itemId);
  const requestedAt = readString(record.requestedAt);

  if (!id || !threadId || !turnId || !itemId || !requestedAt) {
    return null;
  }

  const questionsRaw = Array.isArray(record.questions) ? record.questions : [];
  const questions: PendingUserInputQuestion[] = [];

  for (const questionRaw of questionsRaw) {
    const questionRecord = asRecord(questionRaw);
    if (!questionRecord) {
      continue;
    }

    const questionId = readString(questionRecord.id);
    const header = readString(questionRecord.header);
    const questionText = readString(questionRecord.question);
    if (!questionId || !header || !questionText) {
      continue;
    }

    const optionsRaw = Array.isArray(questionRecord.options) ? questionRecord.options : null;
    const options =
      optionsRaw
        ?.map((optionRaw) => {
          const optionRecord = asRecord(optionRaw);
          if (!optionRecord) {
            return null;
          }

          const label = readString(optionRecord.label);
          const description = readString(optionRecord.description) ?? '';
          if (!label) {
            return null;
          }

          return {
            label,
            description,
          };
        })
        .filter((entry): entry is { label: string; description: string } => entry !== null) ??
      null;

    questions.push({
      id: questionId,
      header,
      question: questionText,
      isOther: readBoolean(questionRecord.isOther),
      isSecret: readBoolean(questionRecord.isSecret),
      options,
    });
  }

  return {
    id,
    threadId,
    turnId,
    itemId,
    requestedAt,
    questions,
  };
}

function parseUserInputAnswerPayload(
  questions: PendingUserInputQuestion[],
  rawInput: string
): Record<string, UserInputAnswerPayload> | null {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return null;
  }

  if (questions.length === 0) {
    return null;
  }

  if (questions.length === 1) {
    const onlyQuestion = questions[0];
    if (!onlyQuestion) {
      return null;
    }

    return {
      [onlyQuestion.id]: {
        answers: [trimmed],
      },
    };
  }

  const answerPairs = trimmed
    .split(';')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (answerPairs.length === 0) {
    return null;
  }

  const parsed: Record<string, UserInputAnswerPayload> = {};
  for (const pair of answerPairs) {
    const separator = pair.indexOf('=');
    if (separator <= 0) {
      return null;
    }

    const questionId = pair.slice(0, separator).trim();
    const answer = pair.slice(separator + 1).trim();
    if (!questionId || !answer) {
      return null;
    }

    parsed[questionId] = {
      answers: [answer],
    };
  }

  return Object.keys(parsed).length > 0 ? parsed : null;
}

function extractLatestAssistantMessage(threadValue: unknown, preferredTurnId: string): string | null {
  const thread = asRecord(threadValue);
  if (!thread) {
    return null;
  }

  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const fromRequestedTurn = extractLatestAssistantMessageFromTurns(turns, preferredTurnId);
  if (fromRequestedTurn) {
    return fromRequestedTurn;
  }

  return extractLatestAssistantMessageFromTurns(turns, null);
}

function extractLatestAssistantMessageFromTurns(
  turns: unknown[],
  preferredTurnId: string | null
): string | null {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = asRecord(turns[turnIndex]);
    if (!turn) {
      continue;
    }

    const turnId = readString(turn.id) ?? readString(turn.turnId);
    if (preferredTurnId && turnId !== preferredTurnId) {
      continue;
    }

    const items = Array.isArray(turn.items) ? turn.items : [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = asRecord(items[itemIndex]);
      if (!item) {
        continue;
      }

      if (readString(item.type) !== 'agentMessage') {
        continue;
      }

      const text = readString(item.text)?.trim();
      if (text) {
        return text;
      }
    }
  }

  return null;
}

function buildApprovalText(approval: PendingApproval): string {
  const lines = [
    'Approval required',
    `id: ${approval.id}`,
    `type: ${approval.kind}`,
  ];

  if (approval.command) {
    lines.push(`command: ${approval.command}`);
  }

  if (approval.reason) {
    lines.push(`reason: ${approval.reason}`);
  }

  if (approval.cwd) {
    lines.push(`cwd: ${approval.cwd}`);
  }

  return lines.join('\n');
}

function buildUserInputPromptText(request: PendingUserInputRequest): string {
  const lines = [`Clarification needed (request: ${request.id})`];

  for (const question of request.questions) {
    lines.push('');
    lines.push(`${question.header}: ${question.question}`);

    if (question.options && question.options.length > 0) {
      for (const option of question.options) {
        lines.push(`- ${option.label}: ${option.description}`);
      }
    }
  }

  lines.push('');
  lines.push('Reply with /reply <request_id> <answer>');
  if (request.questions.length > 1) {
    lines.push('For multiple questions use: question_id=answer;question_id_2=answer');
  }

  return lines.join('\n');
}

function buildMiniAppMarkup(
  buttonText: string,
  miniAppUrl: string
): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: buttonText,
          web_app: {
            url: miniAppUrl,
          },
        },
      ],
    ],
  };
}

function parseThreadSummary(value: unknown): BotThreadSummary | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const id = readString(record.id);
  if (!id) {
    return null;
  }

  if (isSubAgentSource(record.source)) {
    return null;
  }

  const title =
    readString(record.name) ??
    readString(record.title) ??
    readString(record.preview) ??
    `Thread ${id.slice(0, 8)}`;

  const preview = readString(record.preview);
  const status = readThreadStatus(record.status);
  const cwd = readString(record.cwd);
  const updatedAtMs = normalizeThreadTimestampMs(record.updatedAt) ?? Date.now();

  return {
    id,
    title: title.trim() || `Thread ${id.slice(0, 8)}`,
    preview,
    status,
    cwd,
    updatedAtMs,
  };
}

function buildThreadListText(
  currentThreadId: string | null,
  summaries: BotThreadSummary[]
): string {
  const lines: string[] = ['Recent threads:'];

  for (let index = 0; index < summaries.length; index += 1) {
    const summary = summaries[index];
    if (!summary) {
      continue;
    }

    const isCurrent = currentThreadId === summary.id;
    const marker = isCurrent ? '*' : ' ';
    const parts = [
      `${String(index + 1)}.${marker} ${summary.title}`,
      `(${summary.id.slice(0, 8)})`,
      summary.status ? `[${summary.status}]` : null,
      summary.updatedAtMs ? formatRelativeTime(summary.updatedAtMs) : null,
    ].filter((entry): entry is string => Boolean(entry));

    lines.push(parts.join(' '));

    if (summary.preview) {
      lines.push(`   ${truncateLabel(summary.preview, 96)}`);
    }
  }

  lines.push('');
  lines.push('Use /use <number> or /switch <thread_id>.');
  return lines.join('\n');
}

function readThreadStatus(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  return readString(record.type);
}

function isSubAgentSource(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.startsWith('subAgent');
  }

  const record = asRecord(value);
  if (!record) {
    return false;
  }

  if (Object.prototype.hasOwnProperty.call(record, 'subAgent')) {
    return true;
  }

  const type = readString(record.type) ?? readString(record.kind);
  if (!type) {
    return false;
  }

  return type.startsWith('subAgent');
}

function normalizeThreadTimestampMs(value: unknown): number | null {
  const timestamp = readFiniteNumber(value);
  if (timestamp === null) {
    return null;
  }

  if (timestamp > 1_000_000_000_000) {
    return timestamp;
  }

  if (timestamp > 1_000_000_000) {
    return timestamp * 1000;
  }

  return null;
}

function formatRelativeTime(timestampMs: number): string {
  const deltaMs = Date.now() - timestampMs;
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    return 'just now';
  }

  const deltaMinutes = Math.floor(deltaMs / 60_000);
  if (deltaMinutes < 1) {
    return 'just now';
  }
  if (deltaMinutes < 60) {
    return `${String(deltaMinutes)}m ago`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${String(deltaHours)}h ago`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  return `${String(deltaDays)}d ago`;
}

function mergeStreamingDelta(previous: string | null, delta: string): string {
  if (!delta) {
    return previous ?? '';
  }

  const prev = previous ?? '';
  if (!prev) {
    return delta;
  }

  if (delta === prev || prev.endsWith(delta)) {
    return prev;
  }

  if (delta.startsWith(prev)) {
    return delta;
  }

  const maxOverlap = Math.min(prev.length, delta.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (prev.endsWith(delta.slice(0, overlap))) {
      return prev + delta.slice(overlap);
    }
  }

  return prev + delta;
}

function normalizeCodexType(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeCommand(text: string): string {
  const firstToken = text.trim().split(/\s+/, 1)[0] ?? '';
  const command = firstToken.toLowerCase();
  const mentionIndex = command.indexOf('@');
  return mentionIndex > 0 ? command.slice(0, mentionIndex) : command;
}

function readCommandArg(rawCommand: string): string | null {
  const trimmed = rawCommand.trim();
  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace < 0) {
    return null;
  }

  const arg = trimmed.slice(firstSpace + 1).trim();
  return arg.length > 0 ? arg : null;
}

function parsePositiveInt(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncateLabel(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) {
    return collapsed;
  }

  return `${collapsed.slice(0, Math.max(1, max - 1))}…`;
}

function isCommand(text: string): boolean {
  return text.trim().startsWith('/');
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number') {
    return null;
  }

  return Number.isFinite(value) ? value : null;
}

function toChatId(value: number): string {
  return String(value);
}

function toUserId(value: number | undefined): string | null {
  if (typeof value !== 'number') {
    return null;
  }

  return String(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  return value as Record<string, unknown>;
}

function formatBridgeError(error: unknown): string {
  const message = (error as Error).message;
  return `Request failed: ${message}`;
}
