import type { Ionicons } from '@expo/vector-icons';
import * as FileSystem from 'expo-file-system/legacy';
import type { ComponentProps } from 'react';

import type {
  ApprovalMode,
  ApprovalPolicy,
  BridgeUiAction,
  BridgeUiBlock,
  BridgeUiChecklistItem,
  BridgeUiSurface,
  BridgeQueuedMessage,
  BridgeThreadQueueError,
  BridgeThreadQueueState,
  Chat,
  ChatEngine,
  ChatSummary,
  CollaborationMode,
  LocalImageInput,
  MentionInput,
  PendingApproval,
  PendingUserInputRequest,
  ReasoningEffort,
  RunEvent,
  ServiceTier,
  TurnPlanStep,
  ChatMessage as ChatTranscriptMessage,
} from '../api/types';
import type { ActivityTone } from '../components/ActivityBar';
import type { ComposerUsageLimitAlertModel } from '../components/usageLimitBadges';

export interface ActivityState {
  tone: ActivityTone;
  title: string;
  detail?: string;
}

export interface ActivePlanState {
  threadId: string;
  turnId: string;
  explanation: string | null;
  steps: TurnPlanStep[];
  deltaText: string;
  updatedAt: string;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface IdleTaskHandle {
  cancel: () => void;
}

export function scheduleIdleTask(task: () => void, timeout = 500): IdleTaskHandle {
  if (typeof globalThis.requestIdleCallback === 'function') {
    const handle = globalThis.requestIdleCallback(task, { timeout });
    return {
      cancel: () => {
        if (typeof globalThis.cancelIdleCallback === 'function') {
          globalThis.cancelIdleCallback(handle);
        }
      },
    };
  }

  const timeoutId = setTimeout(task, 0);
  return {
    cancel: () => {
      clearTimeout(timeoutId);
    },
  };
}

export interface PendingPlanImplementationPrompt {
  threadId: string;
  turnId: string;
}

export type AttachmentMenuAction =
  | 'workspace-path'
  | 'phone-file'
  | 'phone-image'
  | 'phone-camera'
  | null;

export type WorkspacePickerPurpose = 'default-start' | 'git-checkout-destination';

export interface ThreadContextUsage {
  totalTokens: number | null;
  lastTokens: number | null;
  modelContextWindow: number | null;
  updatedAtMs: number;
}

export interface ThreadRuntimeSnapshot {
  activity?: ActivityState;
  activeCommands?: RunEvent[];
  streamingText?: string | null;
  pendingApproval?: PendingApproval | null;
  pendingUserInputRequest?: PendingUserInputRequest | null;
  bridgeUiSurfaces?: BridgeUiSurface[];
  queuedMessages?: BridgeQueuedMessage[];
  queuedMessageError?: BridgeThreadQueueError | null;
  contextUsage?: ThreadContextUsage | null;
  plan?: ActivePlanState | null;
  activeTurnId?: string | null;
  runWatchdogUntil?: number;
  updatedAtMs: number;
}

export interface ComposerAttachmentChip {
  id: string;
  label: string;
}

export interface PendingOptimisticUserMessage {
  message: ChatTranscriptMessage;
  userOrdinal: number;
}

export interface PendingOptimisticQueuedMessage {
  id: string;
  content: string;
  createdAt: string;
}

export interface AutoScrollState {
  shouldStickToBottom: boolean;
  isUserInteracting: boolean;
  isMomentumScrolling: boolean;
}

export interface SlashCommandDefinition {
  name: string;
  summary: string;
  argsHint?: string;
  mobileSupported: boolean;
  aliases?: string[];
  availabilityNote?: string;
}

export const MAX_ACTIVE_COMMANDS = 16;
export const RUN_WATCHDOG_MS = 60_000;
export const LARGE_CHAT_MESSAGE_COUNT_THRESHOLD = 120;
export const CHAT_INITIAL_VISIBLE_MESSAGE_WINDOW = 80;
export const CHAT_MESSAGE_PAGE_SIZE = 80;
export const CHAT_AUTO_LOAD_OLDER_TOP_THRESHOLD_PX = 96;
export const WORKSPACE_FAVORITES_FILE = 'clawdex-workspace-favorites.json';
export const WORKSPACE_FAVORITES_VERSION = 1;
export const WORKSPACE_FAVORITES_LIMIT = 4;
export const LIKELY_RUNNING_RECENT_UPDATE_MS = 30_000;
export const UNANSWERED_USER_RUNNING_TTL_MS = 90_000;
export const ACTIVE_CHAT_SYNC_INTERVAL_MS = 2_000;
export const IDLE_CHAT_SYNC_INTERVAL_MS = 5_000;
export const BACKGROUND_CHAT_SYNC_INTERVAL_MS = 15_000;
export const AGENT_THREADS_SYNC_INTERVAL_MS = 10_000;
export const AGENT_THREADS_IDLE_SYNC_INTERVAL_MS = 20_000;
export const AGENT_THREADS_BACKGROUND_SYNC_INTERVAL_MS = 30_000;
export const AGENT_THREADS_LIST_LIMIT = 20;
export const APP_FOCUS_DISCONNECT_GRACE_MS = 5_000;
export const ACTIVITY_DETAIL_HOLD_MS = 2_500;
export const GENERIC_RUNNING_ACTIVITY_DELAY_MS = 1_200;
export const CONTEXT_WINDOW_BASELINE_TOKENS = 5_000;
export const GENERIC_RUNNING_ACTIVITY_TITLES = new Set(['working', 'thinking']);
export const CHAT_DRAFTS_FILE = 'chat-drafts.json';
export const CHAT_DRAFTS_VERSION = 1;
export const CHAT_MODEL_PREFERENCES_FILE = 'chat-model-preferences.json';
export const CHAT_MODEL_PREFERENCES_VERSION = 1;
export const CHAT_PLAN_SNAPSHOTS_FILE = 'chat-plan-snapshots.json';
export const CHAT_PLAN_SNAPSHOTS_VERSION = 1;
export const CHAT_BRIDGE_UI_SURFACES_FILE = 'chat-bridge-ui-surfaces.json';
export const CHAT_BRIDGE_UI_SURFACES_VERSION = 1;
export const CHAT_NEW_DRAFT_KEY = '__new_chat__';
export const STREAMING_SCROLL_THROTTLE_MS = 48;
export const PLAN_IMPLEMENTATION_TITLE = 'Implement this plan?';
export const PLAN_IMPLEMENTATION_YES = 'Yes, implement this plan';
export const PLAN_IMPLEMENTATION_NO = 'No, stay in Plan mode';
export const PLAN_IMPLEMENTATION_CODING_MESSAGE = 'Implement the plan.';
export const INLINE_OPTION_LINE_PATTERN =
  /^(?:[-*+]\s*)?(?:\d{1,2}\s*[.):-]|\(\d{1,2}\)\s*[.):-]?|\[\d{1,2}\]\s*|[A-Ca-c]\s*[.):-]|\([A-Ca-c]\)\s*[.):-]?|option\s+\d{1,2}\s*[.):-]?)\s*(.+)$/i;
export const INLINE_CHOICE_CUE_PATTERNS = [
  /\bchoose\b/i,
  /\bselect\b/i,
  /\bpick\b/i,
  /\bwould you like\b/i,
  /\bshould i\b/i,
  /\bprefer\b/i,
  /\bconfirm\b/i,
  /\b(?:reply|respond)\s+with\b/i,
  /\blet me know\b.*\b(which|what|option|one)\b/i,
  /\bwhich\b.*\b(option|one)\b/i,
  /\bwhat\b.*\b(option|one)\b/i,
];
export const CODEX_RUN_HEARTBEAT_EVENT_TYPES = new Set([
  'taskstarted',
  'agentreasoningdelta',
  'reasoningcontentdelta',
  'reasoningrawcontentdelta',
  'agentreasoningrawcontentdelta',
  'agentreasoningsectionbreak',
  'agentmessagedelta',
  'agentmessagecontentdelta',
  'execcommandbegin',
  'execcommandend',
  'mcpstartupupdate',
  'mcptoolcallbegin',
  'websearchbegin',
  'backgroundevent',
]);
export const CODEX_RUN_COMPLETION_EVENT_TYPES = new Set(['taskcomplete']);
export const CODEX_RUN_ABORT_EVENT_TYPES = new Set([
  'turnaborted',
  'taskinterrupted',
]);
export const CODEX_RUN_FAILURE_EVENT_TYPES = new Set([
  'taskfailed',
  'turnfailed',
]);
export const EXTERNAL_RUNNING_STATUS_HINTS = new Set([
  'running',
  'inprogress',
  'active',
  'queued',
  'pending',
]);
export const EXTERNAL_ERROR_STATUS_HINTS = new Set([
  'failed',
  'error',
  'interrupted',
  'aborted',
]);
export const EXTERNAL_COMPLETE_STATUS_HINTS = new Set([
  'complete',
  'completed',
  'success',
  'succeeded',
]);

export interface ChatModelPreference {
  modelId: string | null;
  effort: ReasoningEffort | null;
  serviceTier: ServiceTier | null;
  updatedAt: string;
}

export type SelectedServiceTier = ServiceTier | null | undefined;

export const SLASH_COMMANDS: SlashCommandDefinition[] = [
  {
    name: 'permissions',
    summary: 'Set approvals and sandbox permissions',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'sandbox-add-read-dir',
    summary: 'Grant sandbox read access to extra directory',
    argsHint: '<absolute-path>',
    mobileSupported: false,
    availabilityNote: 'Windows Codex CLI only.',
  },
  {
    name: 'agent',
    summary: 'Switch the active sub-agent thread',
    argsHint: '[thread]',
    mobileSupported: true,
  },
  {
    name: 'apps',
    summary: 'Browse and insert apps/connectors',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'compact',
    summary: 'Compact current thread history',
    mobileSupported: true,
  },
  {
    name: 'diff',
    summary: 'Open Git view for current chat',
    mobileSupported: true,
  },
  {
    name: 'exit',
    summary: 'Exit Codex CLI',
    mobileSupported: false,
    availabilityNote: 'Not applicable on mobile.',
  },
  {
    name: 'experimental',
    summary: 'Toggle experimental features',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'feedback',
    summary: 'Send feedback diagnostics',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'goal',
    summary: 'Create or inspect an active goal',
    argsHint: '[objective]',
    mobileSupported: true,
  },
  {
    name: 'init',
    summary: 'Generate AGENTS.md scaffold',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'logout',
    summary: 'Sign out from Codex',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'mcp',
    summary: 'List configured MCP tools',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'mention',
    summary: 'Attach file/folder context to prompt',
    argsHint: '<path>',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'model',
    summary: 'Open model picker or set model by id',
    argsHint: '<model-id>',
    mobileSupported: true,
  },
  {
    name: 'plan',
    summary: 'Toggle plan mode or run next prompt in plan mode',
    argsHint: '[prompt]',
    mobileSupported: true,
  },
  {
    name: 'personality',
    summary: 'Set response personality',
    argsHint: '<friendly|pragmatic|none>',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'ps',
    summary: 'Show background terminal jobs',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'fork',
    summary: 'Fork current conversation into a new chat',
    mobileSupported: true,
  },
  {
    name: 'resume',
    summary: 'Resume a saved conversation',
    mobileSupported: false,
    availabilityNote: 'Use chat list on mobile for now.',
  },
  {
    name: 'new',
    summary: 'Start a new conversation',
    mobileSupported: true,
  },
  {
    name: 'quit',
    summary: 'Exit Codex CLI',
    mobileSupported: false,
    aliases: ['exit'],
    availabilityNote: 'Not applicable on mobile.',
  },
  {
    name: 'review',
    summary: 'Run review on uncommitted changes',
    mobileSupported: true,
  },
  {
    name: 'status',
    summary: 'Show current session status',
    mobileSupported: true,
  },
  {
    name: 'debug-config',
    summary: 'Inspect config layers and diagnostics',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'statusline',
    summary: 'Configure footer status-line fields',
    mobileSupported: false,
    availabilityNote: 'Available in Codex CLI only right now.',
  },
  {
    name: 'approvals',
    summary: 'Alias for /permissions',
    mobileSupported: false,
    aliases: ['permissions'],
    availabilityNote: 'Alias supported in CLI; use /permissions there.',
  },
  {
    name: 'help',
    summary: 'List slash commands',
    mobileSupported: true,
  },
  {
    name: 'rename',
    summary: 'Rename current chat',
    argsHint: '<new-name>',
    mobileSupported: true,
  },
];

// ── Helpers ────────────────────────────────────────────────────────

export function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const values = value.filter((entry): entry is string => typeof entry === 'string');
  return values.length > 0 ? values : null;
}

export function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readIntegerLike(value: unknown): number | null {
  const numberValue = readNumber(value);
  if (numberValue !== null) {
    return Math.max(0, Math.floor(numberValue));
  }

  const stringValue = readString(value)?.trim();
  if (!stringValue) {
    return null;
  }

  const parsed = Number(stringValue);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : null;
}

export function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function mergeThreadContextUsage(
  previous: ThreadContextUsage | null,
  next: ThreadContextUsage | null
): ThreadContextUsage | null {
  if (!next) {
    return previous;
  }

  return {
    totalTokens: next.totalTokens ?? previous?.totalTokens ?? null,
    lastTokens: next.lastTokens ?? previous?.lastTokens ?? null,
    modelContextWindow: next.modelContextWindow ?? previous?.modelContextWindow ?? null,
    updatedAtMs: next.updatedAtMs,
  };
}

export function formatTokenCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions >= 10 ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }

  if (abs >= 1_000) {
    const thousands = value / 1_000;
    return `${thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
  }

  return String(Math.round(value));
}

export function compactPlanDelta(value: string): string {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .slice(-1200);
}

export function buildNextPlanStateFromDelta(
  previous: ActivePlanState | null,
  threadId: string,
  turnId: string,
  rawDelta: string
): ActivePlanState {
  const sameTurn =
    previous && previous.threadId === threadId && previous.turnId === turnId;
  const nextDelta = compactPlanDelta(
    sameTurn ? `${previous.deltaText}\n${rawDelta}` : rawDelta
  );

  return {
    threadId,
    turnId,
    explanation: sameTurn ? previous.explanation : null,
    steps: sameTurn ? previous.steps : [],
    deltaText: nextDelta,
    updatedAt: new Date().toISOString(),
  };
}

export function buildNextPlanStateFromUpdate(
  previous: ActivePlanState | null,
  next: {
    threadId: string;
    turnId: string;
    explanation: string | null;
    plan: TurnPlanStep[];
  }
): ActivePlanState {
  const sameTurn =
    previous &&
    previous.threadId === next.threadId &&
    previous.turnId === next.turnId;

  return {
    threadId: next.threadId,
    turnId: next.turnId,
    explanation: next.explanation,
    steps: next.plan,
    deltaText: sameTurn ? previous.deltaText : '',
    updatedAt: new Date().toISOString(),
  };
}

export function renderPlanStatusGlyph(status: TurnPlanStep['status']): string {
  if (status === 'completed') {
    return '✔';
  }
  if (status === 'inProgress') {
    return '□';
  }
  return '□';
}

export function toTurnPlanUpdate(
  value: unknown,
  fallbackThreadId: string | null = null
): {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: TurnPlanStep[];
} | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const threadId = readString(record.threadId) ?? fallbackThreadId;
  const turnId = readString(record.turnId);
  if (!threadId || !turnId) {
    return null;
  }

  const rawPlan = Array.isArray(record.plan) ? record.plan : [];
  const plan: TurnPlanStep[] = rawPlan
    .map((item) => {
      const itemRecord = toRecord(item);
      if (!itemRecord) {
        return null;
      }

      const step = readString(itemRecord.step);
      const status = readString(itemRecord.status);
      if (
        !step ||
        (status !== 'pending' && status !== 'inProgress' && status !== 'completed')
      ) {
        return null;
      }

      return {
        step,
        status,
      } satisfies TurnPlanStep;
    })
    .filter((item): item is TurnPlanStep => item !== null);

  return {
    threadId,
    turnId,
    explanation: readString(record.explanation),
    plan,
  };
}

export function resolveCodexPlanTurnId(
  value: Record<string, unknown> | null,
  fallbackTurnId: string | null = null
): string {
  return (
    readString(value?.turnId) ??
    readString(value?.turn_id) ??
    fallbackTurnId ??
    'unknown-turn'
  );
}

export function toCodexTurnPlanUpdate(
  value: Record<string, unknown> | null,
  threadId: string,
  fallbackTurnId: string | null = null
): {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: TurnPlanStep[];
} | null {
  if (!value) {
    return null;
  }

  return toTurnPlanUpdate(
    {
      ...value,
      threadId,
      turnId: resolveCodexPlanTurnId(value, fallbackTurnId),
    },
    threadId
  );
}

export function toPendingUserInputRequest(value: unknown): PendingUserInputRequest | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const id = readString(record.id);
  const threadId = readString(record.threadId);
  const turnId = readString(record.turnId);
  const itemId = readString(record.itemId);
  const requestedAt = readString(record.requestedAt);
  const rawQuestions = Array.isArray(record.questions) ? record.questions : [];
  if (!id || !threadId || !turnId || !itemId || !requestedAt || rawQuestions.length === 0) {
    return null;
  }

  const questions = rawQuestions
    .map((item) => {
      const itemRecord = toRecord(item);
      if (!itemRecord) {
        return null;
      }

      const questionId = readString(itemRecord.id);
      const header = readString(itemRecord.header);
      const question = readString(itemRecord.question);
      if (!questionId || !header || !question) {
        return null;
      }

      const parsedInlineOptions = parseInlineOptionsFromQuestionText(question);

      const parsedOptions = Array.isArray(itemRecord.options)
        ? itemRecord.options
            .map((option) => {
              const optionRecord = toRecord(option);
              if (!optionRecord) {
                return null;
              }

              const label =
                readString(optionRecord.label) ??
                readString(optionRecord.title) ??
                readString(optionRecord.value) ??
                readString(optionRecord.text);
              const description =
                readString(optionRecord.description) ??
                readString(optionRecord.detail) ??
                '';
              if (!label) {
                return null;
              }
              return {
                label,
                description,
              };
            })
            .filter(
              (option): option is { label: string; description: string } => option !== null
            )
        : null;
      const options =
        parsedOptions && parsedOptions.length > 0
          ? parsedOptions
          : parsedInlineOptions.options;

      return {
        id: questionId,
        header,
        question: parsedInlineOptions.question,
        isOther: readBoolean(itemRecord.isOther) ?? false,
        isSecret: readBoolean(itemRecord.isSecret) ?? false,
        options,
      } satisfies PendingUserInputRequest['questions'][number];
    })
    .filter(
      (question): question is PendingUserInputRequest['questions'][number] =>
        question !== null
    );

  if (questions.length === 0) {
    return null;
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

export function buildUserInputDrafts(request: PendingUserInputRequest): Record<string, string> {
  const drafts: Record<string, string> = {};
  for (const question of request.questions) {
    drafts[question.id] = '';
  }
  return drafts;
}

export function toBridgeUiSurface(value: unknown): BridgeUiSurface | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const id = readString(record.id);
  const threadId = readString(record.threadId);
  const presentation = readString(record.presentation);
  const title = readString(record.title);
  if (
    !id ||
    !threadId ||
    !title ||
    (presentation !== 'workflowCard' && presentation !== 'modal' && presentation !== 'banner')
  ) {
    return null;
  }

  const blocks = parseBridgeUiBlocks(record.blocks);
  const bodyMarkdown = readString(record.bodyMarkdown) ?? null;
  const rawActions = Array.isArray(record.actions) ? record.actions : [];
  const actions = rawActions
    .map(toBridgeUiAction)
    .filter((action): action is BridgeUiAction => action !== null);
  const tone = readString(record.tone);

  return {
    id,
    threadId,
    turnId: readString(record.turnId) ?? null,
    kind: readString(record.kind) ?? null,
    presentation,
    tone:
      tone === 'info' ||
      tone === 'success' ||
      tone === 'warning' ||
      tone === 'error' ||
      tone === 'neutral'
        ? tone
        : undefined,
    title,
    subtitle: readString(record.subtitle) ?? null,
    bodyMarkdown,
    blocks,
    actions,
    dismissible: readBoolean(record.dismissible) ?? true,
    createdAt: readString(record.createdAt) ?? null,
    updatedAt: readString(record.updatedAt) ?? null,
  };
}

export function parseGoalSlashObjective(input: string): string | null {
  const parsed = parseSlashCommand(input);
  if (!parsed || parsed.name !== 'goal') {
    return null;
  }

  const objective = parsed.args.trim();
  return objective.length > 0 ? objective : null;
}

export function buildOptimisticGoalBridgeUiSurface(
  threadId: string,
  objective: string,
  updatedAt: string
): BridgeUiSurface | null {
  const normalizedThreadId = threadId.trim();
  const normalizedObjective = objective.trim();
  if (!normalizedThreadId || !normalizedObjective) {
    return null;
  }

  return {
    id: `goal-${normalizedThreadId}`,
    threadId: normalizedThreadId,
    turnId: null,
    kind: 'goal',
    presentation: 'workflowCard',
    tone: 'info',
    title: 'Goal',
    subtitle: 'Starting',
    bodyMarkdown: normalizedObjective,
    blocks: [
      {
        type: 'keyValue',
        items: [{ label: 'Status', value: 'Starting' }],
      },
    ],
    actions: [{ id: 'dismiss', label: 'Dismiss', style: 'secondary' }],
    dismissible: true,
    createdAt: updatedAt,
    updatedAt,
  };
}

function toBridgeUiAction(value: unknown): BridgeUiAction | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const id = readString(record.id);
  const label = readString(record.label);
  if (!id || !label) {
    return null;
  }

  const style = readString(record.style);
  return {
    id,
    label,
    style:
      style === 'primary' || style === 'secondary' || style === 'destructive'
        ? style
        : undefined,
    dismissesSurface: readBoolean(record.dismissesSurface) ?? true,
  };
}

function parseBridgeUiBlocks(value: unknown): BridgeUiBlock[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(toBridgeUiBlock)
    .filter((block): block is BridgeUiBlock => block !== null);
}

function toBridgeUiBlock(value: unknown): BridgeUiBlock | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const type = readString(record.type);
  if (type === 'text') {
    const text = readString(record.text);
    return text ? { type, text } : null;
  }

  if (type === 'markdown') {
    const markdown = readString(record.markdown);
    return markdown ? { type, markdown } : null;
  }

  if (type === 'checklist') {
    const items: BridgeUiChecklistItem[] = Array.isArray(record.items)
      ? record.items
          .map((item) => {
            const itemRecord = toRecord(item);
            if (!itemRecord) {
              return null;
            }
            const label = readString(itemRecord.label);
            const status = readString(itemRecord.status);
            if (!label) {
              return null;
            }
            const normalizedStatus =
              status === 'pending' || status === 'inProgress' || status === 'completed'
                ? status
                : undefined;
            return {
              label,
              status: normalizedStatus,
              detail: readString(itemRecord.detail) ?? undefined,
            } satisfies BridgeUiChecklistItem;
          })
          .filter((item): item is NonNullable<typeof item> => item !== null)
      : [];
    return items.length > 0 ? { type, items } : null;
  }

  if (type === 'keyValue') {
    const items = Array.isArray(record.items)
      ? record.items
          .map((item) => {
            const itemRecord = toRecord(item);
            if (!itemRecord) {
              return null;
            }
            const label = readString(itemRecord.label);
            const itemValue = readString(itemRecord.value);
            return label && itemValue ? { label, value: itemValue } : null;
          })
          .filter((item): item is NonNullable<typeof item> => item !== null)
      : [];
    return items.length > 0 ? { type, items } : null;
  }

  if (type === 'code') {
    const text = readString(record.text);
    return text
      ? {
          type,
          text,
          language: readString(record.language) ?? null,
        }
      : null;
  }

  if (type === 'progress') {
    const label = readString(record.label);
    const progressValue = readNumber(record.value);
    const max = readNumber(record.max);
    if (!label || progressValue === null || max === null || max <= 0) {
      return null;
    }
    return {
      type,
      label,
      value: progressValue,
      max,
      detail: readString(record.detail) ?? null,
    };
  }

  return null;
}

export function upsertBridgeUiSurfaceList(
  surfaces: BridgeUiSurface[],
  surface: BridgeUiSurface
): BridgeUiSurface[] {
  const existingIndex = surfaces.findIndex((entry) => entry.id === surface.id);
  if (existingIndex === -1) {
    return [...surfaces, surface];
  }

  const next = surfaces.slice();
  next[existingIndex] = surface;
  return next;
}

export function removeBridgeUiSurfaceFromList(
  surfaces: BridgeUiSurface[],
  surfaceId: string
): BridgeUiSurface[] {
  return surfaces.filter((surface) => surface.id !== surfaceId);
}

export function normalizeQuestionAnswers(value: string): string[] {
  return value
    .split('\n')
    .flatMap((line) => line.split(','))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function findInlineChoiceSet(messages: ChatTranscriptMessage[]): {
  messageId: string;
  options: Array<{ label: string; description: string }>;
} | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') {
      continue;
    }

    if (message.content.length > 1200) {
      continue;
    }

    const parsed = parseInlineOptionsFromQuestionText(message.content);
    if (!parsed.options || parsed.options.length < 2 || parsed.options.length > 5) {
      continue;
    }

    const cueSource = parsed.question.trim();
    const hasCue =
      cueSource.includes('?') ||
      INLINE_CHOICE_CUE_PATTERNS.some((pattern) => pattern.test(cueSource));
    if (!hasCue) {
      continue;
    }

    return {
      messageId: message.id,
      options: parsed.options,
    };
  }

  return null;
}

export function stripOptionText(value: string): string {
  return value
    .replace(/^[`*_~]+/g, '')
    .replace(/[`*_~]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitOptionLine(value: string): { label: string; description: string } {
  const normalized = value.replace(/^[-*+\u2022]\s+/, '').trim();
  if (!normalized) {
    return {
      label: '',
      description: '',
    };
  }

  const separators = [' \u2014 ', ' - ', ': '];
  for (const separator of separators) {
    const separatorIndex = normalized.indexOf(separator);
    if (separatorIndex <= 0 || separatorIndex >= normalized.length - separator.length) {
      continue;
    }

    const label = stripOptionText(normalized.slice(0, separatorIndex));
    const description = stripOptionText(
      normalized.slice(separatorIndex + separator.length)
    );
    if (!label) {
      continue;
    }

    return {
      label,
      description,
    };
  }

  return {
    label: stripOptionText(normalized),
    description: '',
  };
}

export function isLikelyOptionContinuationLine(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  return (
    /^[-*+\u2022]\s+/.test(trimmed) ||
    /^(impact|trade[- ]?off|reason|because|benefit|cost|why)\b/i.test(trimmed)
  );
}

export function parseInlineOptionsFromQuestionText(value: string): {
  question: string;
  options: Array<{ label: string; description: string }> | null;
} {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return {
      question: value,
      options: null,
    };
  }

  const promptLines: string[] = [];
  const options: Array<{ label: string; description: string }> = [];
  let hasMatchedOptionLine = false;

  for (const line of lines) {
    const optionMatch = line.match(INLINE_OPTION_LINE_PATTERN);
    if (optionMatch) {
      const parsed = splitOptionLine(optionMatch[1] ?? '');
      if (parsed.label) {
        options.push(parsed);
        hasMatchedOptionLine = true;
        continue;
      }
    }

    if (hasMatchedOptionLine && options.length > 0 && isLikelyOptionContinuationLine(line)) {
      const continuation = stripOptionText(line.replace(/^[-*+\u2022]\s+/, ''));
      if (continuation) {
        const lastOption = options[options.length - 1];
        lastOption.description = lastOption.description
          ? `${lastOption.description} ${continuation}`
          : continuation;
      }
      continue;
    }

    promptLines.push(line);
  }

  if (options.length < 2) {
    return {
      question: value,
      options: null,
    };
  }

  const question = promptLines.length > 0 ? promptLines.join('\n') : 'Select one option.';

  return {
    question,
    options,
  };
}

export function normalizeWorkspacePath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getWorkspaceBrowseCacheKey(path: string | null): string {
  return path ?? '__bridge_default__';
}

export function normalizeAttachmentPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeCloneDirectoryName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') {
    return null;
  }
  if (/[\\/]/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

export function deriveCloneDirectoryName(url: string | null | undefined): string | null {
  if (typeof url !== 'string') {
    return null;
  }

  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return null;
  }

  const lastSlash = trimmed.lastIndexOf('/');
  const lastColon = trimmed.lastIndexOf(':');
  const splitIndex = Math.max(lastSlash, lastColon);
  const candidate = (splitIndex >= 0 ? trimmed.slice(splitIndex + 1) : trimmed).replace(
    /\.git$/i,
    ''
  );

  return normalizeCloneDirectoryName(candidate);
}

export function formatGitCloneFailureMessage(
  result: {
    code: number | null;
    stdout: string;
    stderr: string;
    cloned: boolean;
  },
  fallbackLabel = 'repository'
): string | null {
  if (result.cloned && (result.code === null || result.code === 0)) {
    return null;
  }

  const detail = (result.stderr || result.stdout).trim();
  return detail.length > 0 ? detail : `Git clone failed for ${fallbackLabel}.`;
}

export function joinWorkspacePath(parentPath: string, child: string): string {
  const separator =
    parentPath.includes('\\') && !parentPath.includes('/') ? '\\' : '/';
  if (parentPath.endsWith('/') || parentPath.endsWith('\\')) {
    return `${parentPath}${child}`;
  }
  return `${parentPath}${separator}${child}`;
}

export function isAbsoluteWorkspacePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

export function resolveMentionPath(path: string, workspace: string | null | undefined): string {
  const normalizedPath = normalizeAttachmentPath(path);
  if (!normalizedPath) {
    return path;
  }
  if (isAbsoluteWorkspacePath(normalizedPath)) {
    return normalizedPath;
  }

  const normalizedWorkspace = normalizeWorkspacePath(workspace);
  if (!normalizedWorkspace) {
    return normalizedPath;
  }

  return joinWorkspacePath(normalizedWorkspace, normalizedPath);
}

export function toMentionInput(path: string, workspace?: string | null): MentionInput {
  const resolvedPath = resolveMentionPath(path, workspace);
  const segments = resolvedPath.split(/[\\/]/).filter(Boolean);
  const name = segments[segments.length - 1] ?? resolvedPath;
  return {
    path: resolvedPath,
    name,
  };
}

export function toOptimisticUserContent(
  content: string,
  mentions: MentionInput[],
  localImages: LocalImageInput[]
): string {
  if (mentions.length === 0 && localImages.length === 0) {
    return content;
  }

  const mentionLines = mentions.map((mention) => `[file: ${mention.path}]`);
  const localImageLines = localImages.map((image) => `[local image: ${image.path}]`);
  return [content, ...mentionLines, ...localImageLines].join('\n');
}

export function countUserMessages(messages: ChatTranscriptMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role === 'user') {
      count += 1;
    }
  }
  return count;
}

export function normalizeChatMessageMatchContent(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !isSyntheticUserAttachmentLine(line))
    .join('\n')
    .trim();
}

export function isSyntheticUserAttachmentLine(value: string): boolean {
  return (
    /^\[file:\s*(.+?)\]$/i.test(value) ||
    /^\[local image:\s*(.+?)\]$/i.test(value) ||
    /^\[image:\s*(.+?)\]$/i.test(value)
  );
}

export function reconcileChatWithPendingOptimisticMessages(
  chat: Chat,
  pendingMessages: PendingOptimisticUserMessage[]
): {
  chat: Chat;
  remainingPendingMessages: PendingOptimisticUserMessage[];
} {
  if (pendingMessages.length === 0) {
    return {
      chat,
      remainingPendingMessages: [],
    };
  }

  const userMessages = chat.messages.filter((message) => message.role === 'user');
  const remainingPendingMessages = pendingMessages.filter((entry) => {
    const pendingContent = normalizeChatMessageMatchContent(entry.message.content);
    const matchedUserMessage = userMessages[entry.userOrdinal - 1];

    if (!matchedUserMessage) {
      return true;
    }

    return normalizeChatMessageMatchContent(matchedUserMessage.content) !== pendingContent;
  });

  if (remainingPendingMessages.length === 0) {
    return {
      chat,
      remainingPendingMessages,
    };
  }

  const lastPendingMessage = remainingPendingMessages[remainingPendingMessages.length - 1]?.message;
  return {
    chat: {
      ...chat,
      lastMessagePreview:
        normalizeChatMessageMatchContent(lastPendingMessage?.content ?? '').slice(0, 120) ||
        chat.lastMessagePreview,
      messages: [
        ...chat.messages,
        ...remainingPendingMessages.map((entry) => entry.message),
      ],
    },
    remainingPendingMessages,
  };
}

export function toPathBasename(path: string): string {
  const normalized = path.trim();
  if (!normalized) {
    return 'image';
  }

  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
}

export function toAttachmentPathSuggestions(
  candidates: string[],
  query: string,
  pendingMentionPaths: string[]
): string[] {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return [];
  }

  const normalizedQuery = query.trim().toLowerCase();
  const selectedSet = new Set(pendingMentionPaths.map((path) => path.trim().toLowerCase()));
  const exactBasenameMatches: string[] = [];
  const basenamePrefixMatches: string[] = [];
  const basenameContainsMatches: string[] = [];
  const pathPrefixMatches: string[] = [];
  const pathContainsMatches: string[] = [];

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }

    const lowered = trimmed.toLowerCase();
    if (selectedSet.has(lowered)) {
      continue;
    }

    if (!normalizedQuery) {
      pathPrefixMatches.push(trimmed);
      if (pathPrefixMatches.length >= 8) {
        break;
      }
      continue;
    }

    const basename = toPathBasename(trimmed).toLowerCase();

    if (basename === normalizedQuery) {
      exactBasenameMatches.push(trimmed);
      continue;
    }

    if (basename.startsWith(normalizedQuery)) {
      basenamePrefixMatches.push(trimmed);
      continue;
    }

    if (lowered.startsWith(normalizedQuery)) {
      pathPrefixMatches.push(trimmed);
      continue;
    }

    if (basename.includes(normalizedQuery)) {
      basenameContainsMatches.push(trimmed);
      continue;
    }

    if (lowered.includes(`/${normalizedQuery}`) || lowered.includes(normalizedQuery)) {
      pathContainsMatches.push(trimmed);
    }
  }

  return [
    ...exactBasenameMatches,
    ...basenamePrefixMatches,
    ...pathPrefixMatches,
    ...basenameContainsMatches,
    ...pathContainsMatches,
  ].slice(0, 8);
}

export function parseMentionQuery(input: string): string | null {
  const normalized = input.replace(/\r\n/g, '\n');
  const match = normalized.match(/(?:^|[\s(])@([^\s()]*)$/);
  if (!match) {
    return null;
  }

  return match[1] ?? '';
}

export function replaceActiveMentionQueryWithSelection(input: string, label: string): string {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) {
    return input;
  }

  return input
    .replace(/(^|[\s(])@[^\s()]*$/, (_match, prefix: string) => {
      return `${prefix}@${trimmedLabel} `;
    })
    .replace(/[ \t]{2,}/g, ' ');
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function draftContainsMentionLabel(draft: string, label: string): boolean {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) {
    return false;
  }

  const pattern = new RegExp(`(^|[^\\w])@${escapeRegex(trimmedLabel)}(?=$|[^\\w])`, 'i');
  return pattern.test(draft);
}

export function mergeChatEngines(
  engines: readonly ChatEngine[],
  ...extraEngines: Array<ChatEngine | null | undefined>
): ChatEngine[] {
  const merged: ChatEngine[] = [];
  for (const engine of [...engines, ...extraEngines]) {
    if (
      (engine === 'codex' || engine === 'opencode' || engine === 'cursor') &&
      !merged.includes(engine)
    ) {
      merged.push(engine);
    }
  }

  return merged.length > 0 ? merged : ['codex'];
}

export function normalizeModelId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeReasoningEffort(
  effort: string | null | undefined
): ReasoningEffort | null {
  if (typeof effort !== 'string') {
    return null;
  }

  const normalized = effort.trim().toLowerCase();
  if (
    normalized === 'none' ||
    normalized === 'minimal' ||
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'xhigh'
  ) {
    return normalized;
  }

  return null;
}

export function normalizeServiceTier(
  serviceTier: string | null | undefined
): ServiceTier | null {
  if (typeof serviceTier !== 'string') {
    return null;
  }

  const normalized = serviceTier.trim().toLowerCase();
  if (normalized === 'flex' || normalized === 'fast') {
    return normalized;
  }

  return null;
}

export function toSelectedServiceTier(
  serviceTier: ServiceTier | null | undefined
): ServiceTier | null {
  return serviceTier === 'fast' ? 'fast' : null;
}

export function resolveSelectedServiceTier(
  selectedServiceTier: SelectedServiceTier,
  defaultServiceTier: ServiceTier | null | undefined
): ServiceTier | null {
  if (selectedServiceTier !== undefined) {
    return toSelectedServiceTier(selectedServiceTier);
  }

  return toSelectedServiceTier(defaultServiceTier);
}

export function toApprovalPolicyForMode(mode: ApprovalMode | null | undefined): ApprovalPolicy {
  return mode === 'yolo' ? 'never' : 'untrusted';
}

export function getChatModelPreferencesPath(): string | null {
  const base = FileSystem.documentDirectory;
  if (typeof base !== 'string' || base.trim().length === 0) {
    return null;
  }

  return `${base}${CHAT_MODEL_PREFERENCES_FILE}`;
}

export function getChatDraftsPath(): string | null {
  const base = FileSystem.documentDirectory;
  if (typeof base !== 'string' || base.trim().length === 0) {
    return null;
  }

  return `${base}${CHAT_DRAFTS_FILE}`;
}

export function getChatPlanSnapshotsPath(): string | null {
  const base = FileSystem.documentDirectory;
  if (typeof base !== 'string' || base.trim().length === 0) {
    return null;
  }

  return `${base}${CHAT_PLAN_SNAPSHOTS_FILE}`;
}

export function getChatBridgeUiSurfacesPath(): string | null {
  const base = FileSystem.documentDirectory;
  if (typeof base !== 'string' || base.trim().length === 0) {
    return null;
  }

  return `${base}${CHAT_BRIDGE_UI_SURFACES_FILE}`;
}

export function getWorkspaceFavoritesPath(): string | null {
  const base = FileSystem.documentDirectory;
  if (typeof base !== 'string' || base.trim().length === 0) {
    return null;
  }

  return `${base}${WORKSPACE_FAVORITES_FILE}`;
}

export function parseWorkspaceFavoritePaths(raw: string): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    const parsedRecord = toRecord(parsed);
    if (!parsedRecord || parsedRecord.version !== WORKSPACE_FAVORITES_VERSION) {
      return [];
    }

    const paths = Array.isArray(parsedRecord.paths) ? parsedRecord.paths : [];
    const normalizedPaths: string[] = [];
    for (const path of paths) {
      const normalizedPath = normalizeWorkspacePath(path);
      if (!normalizedPath || normalizedPaths.includes(normalizedPath)) {
        continue;
      }
      normalizedPaths.push(normalizedPath);
      if (normalizedPaths.length >= WORKSPACE_FAVORITES_LIMIT) {
        break;
      }
    }
    return normalizedPaths;
  } catch {
    return [];
  }
}

export function parseChatDrafts(raw: string): Record<string, string> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    const parsedRecord = toRecord(parsed);
    if (!parsedRecord || parsedRecord.version !== CHAT_DRAFTS_VERSION) {
      return {};
    }

    const entries = toRecord(parsedRecord.entries);
    if (!entries) {
      return {};
    }

    const result: Record<string, string> = {};
    for (const [rawKey, value] of Object.entries(entries)) {
      const normalizedKey = getDraftScopeKey(rawKey);
      const text = readString(value)?.replace(/\r\n/g, '\n');
      if (!text || text.length === 0) {
        continue;
      }
      result[normalizedKey] = text;
    }

    return result;
  } catch {
    return {};
  }
}

export function parseBridgeThreadQueueState(value: unknown): BridgeThreadQueueState | null {
  const record = toRecord(value);
  const threadId = readString(record?.threadId)?.trim();
  if (!record || !threadId) {
    return null;
  }

  const items = Array.isArray(record.items)
    ? record.items
        .map((item) => {
          const entry = toRecord(item);
          const id = readString(entry?.id)?.trim();
          const createdAt = readString(entry?.createdAt)?.trim();
          const content = readString(entry?.content)?.replace(/\r\n/g, '\n');
          if (!id || !createdAt || !content) {
            return null;
          }

          return {
            id,
            createdAt,
            content,
          } satisfies BridgeQueuedMessage;
        })
        .filter((item): item is BridgeQueuedMessage => item !== null)
    : [];

  const lastErrorRecord = toRecord(record.lastError);
  const lastErrorMessage = readString(lastErrorRecord?.message)?.trim();
  const lastErrorOperation = readString(lastErrorRecord?.operation)?.trim();
  const lastErrorAt = readString(lastErrorRecord?.at)?.trim();
  const lastError =
    lastErrorMessage && lastErrorOperation && lastErrorAt
      ? ({
          message: lastErrorMessage,
          operation: lastErrorOperation,
          at: lastErrorAt,
          itemId: readString(lastErrorRecord?.itemId)?.trim() ?? null,
        } satisfies BridgeThreadQueueError)
      : null;

  return {
    threadId,
    items,
    lastError,
  };
}

export function getDraftScopeKey(threadId: string | null | undefined): string {
  const normalized = threadId?.trim();
  return normalized && normalized.length > 0 ? normalized : CHAT_NEW_DRAFT_KEY;
}

export function parseChatModelPreferences(raw: string): Record<string, ChatModelPreference> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    const parsedRecord = toRecord(parsed);
    if (!parsedRecord || parsedRecord.version !== CHAT_MODEL_PREFERENCES_VERSION) {
      return {};
    }

    const entries = toRecord(parsedRecord.entries);
    if (!entries) {
      return {};
    }

    const result: Record<string, ChatModelPreference> = {};
    for (const [chatId, value] of Object.entries(entries)) {
      const entry = toRecord(value);
      if (!entry) {
        continue;
      }

      const normalizedChatId = chatId.trim();
      if (!normalizedChatId) {
        continue;
      }

      result[normalizedChatId] = {
        modelId: normalizeModelId(readString(entry.modelId)),
        effort: normalizeReasoningEffort(readString(entry.effort)),
        serviceTier: toSelectedServiceTier(
          normalizeServiceTier(readString(entry.serviceTier))
        ),
        updatedAt: readString(entry.updatedAt) ?? new Date(0).toISOString(),
      };
    }

    return result;
  } catch {
    return {};
  }
}

export function parseChatPlanSnapshots(raw: string): Record<string, ActivePlanState> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    const parsedRecord = toRecord(parsed);
    if (!parsedRecord || parsedRecord.version !== CHAT_PLAN_SNAPSHOTS_VERSION) {
      return {};
    }

    const entries = toRecord(parsedRecord.entries);
    if (!entries) {
      return {};
    }

    const result: Record<string, ActivePlanState> = {};
    for (const [chatId, value] of Object.entries(entries)) {
      const entry = toRecord(value);
      if (!entry) {
        continue;
      }

      const normalizedChatId = chatId.trim();
      const threadId = readString(entry.threadId) ?? normalizedChatId;
      const turnId = readString(entry.turnId);
      if (!normalizedChatId || !threadId || !turnId) {
        continue;
      }

      const rawSteps = Array.isArray(entry.steps) ? entry.steps : [];
      const steps: TurnPlanStep[] = rawSteps
        .map((item) => {
          const itemRecord = toRecord(item);
          if (!itemRecord) {
            return null;
          }

          const step = readString(itemRecord.step);
          const status = readString(itemRecord.status);
          if (
            !step ||
            (status !== 'pending' && status !== 'inProgress' && status !== 'completed')
          ) {
            return null;
          }

          return {
            step,
            status,
          } satisfies TurnPlanStep;
        })
        .filter((item): item is TurnPlanStep => item !== null);

      result[normalizedChatId] = {
        threadId,
        turnId,
        explanation: readString(entry.explanation),
        steps,
        deltaText: readString(entry.deltaText) ?? '',
        updatedAt: readString(entry.updatedAt) ?? new Date(0).toISOString(),
      };
    }

    return result;
  } catch {
    return {};
  }
}

export function parseChatBridgeUiSurfaces(raw: string): Record<string, BridgeUiSurface[]> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    const parsedRecord = toRecord(parsed);
    if (!parsedRecord || parsedRecord.version !== CHAT_BRIDGE_UI_SURFACES_VERSION) {
      return {};
    }

    const entries = toRecord(parsedRecord.entries);
    if (!entries) {
      return {};
    }

    const result: Record<string, BridgeUiSurface[]> = {};
    for (const [chatId, value] of Object.entries(entries)) {
      const normalizedChatId = chatId.trim();
      if (!normalizedChatId || !Array.isArray(value)) {
        continue;
      }

      const surfaces = value
        .map(toBridgeUiSurface)
        .filter(
          (surface): surface is BridgeUiSurface =>
            surface !== null && surface.threadId === normalizedChatId
        );
      if (surfaces.length > 0) {
        result[normalizedChatId] = surfaces;
      }
    }

    return result;
  } catch {
    return {};
  }
}

export function formatCollaborationModeLabel(mode: CollaborationMode): string {
  if (mode === 'plan') {
    return 'Plan mode';
  }
  if (mode === 'ask') {
    return 'Ask mode';
  }
  return 'Default mode';
}

export function isBridgeConnectionErrorMessage(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return (
    normalized.includes('bridge websocket') ||
    normalized.includes('unable to connect to bridge websocket')
  );
}

export function buildRateLimitAlertFromMessages(
  messages: Array<string | null | undefined>
): ComposerUsageLimitAlertModel | null {
  return findRateLimitReachedMessage(messages)
    ? {
        title: 'Rate limit reached',
        body: 'Your Codex usage limit has been reached. Try again after it resets.',
        status: null,
      }
    : null;
}

export function findRateLimitReachedMessage(
  messages: Array<string | null | undefined>
): string | null {
  for (const message of messages) {
    if (isRateLimitReachedMessage(message)) {
      return message?.trim() ?? null;
    }
  }
  return null;
}

export function isRateLimitReachedMessage(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes('rate limit') ||
    normalized.includes('usage limit') ||
    normalized.includes('quota exceeded') ||
    normalized.includes('too many requests') ||
    /\b429\b/.test(normalized)
  );
}

export function isBridgeRecoveryActivity(activity: ActivityState | null | undefined): boolean {
  if (!activity) {
    return false;
  }

  const normalizedTitle = activity.title.trim().toLowerCase();
  if (normalizedTitle === 'disconnected' || normalizedTitle === 'bridge disconnected') {
    return true;
  }

  return (
    isBridgeConnectionErrorMessage(activity.title) ||
    isBridgeConnectionErrorMessage(activity.detail)
  );
}

export function getInitialVisibleMessageStartIndex(totalMessageCount: number): number {
  if (totalMessageCount <= LARGE_CHAT_MESSAGE_COUNT_THRESHOLD) {
    return 0;
  }

  return Math.max(0, totalMessageCount - CHAT_INITIAL_VISIBLE_MESSAGE_WINDOW);
}

export function resolveSnapshotCollaborationMode(
  snapshot: ThreadRuntimeSnapshot | null | undefined
): CollaborationMode {
  if (!snapshot) {
    return 'default';
  }

  const hasActivePlanSnapshot =
    Boolean(snapshot.plan) &&
    (Boolean(snapshot.activeTurnId) || snapshot.activity?.title === 'Planning');
  return snapshot.pendingUserInputRequest || hasActivePlanSnapshot ? 'plan' : 'default';
}

export function resolveDisplayedThreadPlan(
  snapshotPlan: ActivePlanState | null,
  persistedPlan: ActivePlanState | null,
  snapshot: ThreadRuntimeSnapshot | null | undefined
): ActivePlanState | null {
  if (!persistedPlan) {
    return snapshotPlan;
  }

  if (!snapshotPlan) {
    return persistedPlan;
  }

  if (snapshotPlan.turnId === persistedPlan.turnId) {
    return {
      ...snapshotPlan,
      explanation: snapshotPlan.explanation ?? persistedPlan.explanation,
      steps: snapshotPlan.steps.length > 0 ? snapshotPlan.steps : persistedPlan.steps,
      updatedAt:
        snapshotPlan.updatedAt > persistedPlan.updatedAt
          ? snapshotPlan.updatedAt
          : persistedPlan.updatedAt,
    };
  }

  const hasActivePlanningSnapshot =
    Boolean(snapshot?.activeTurnId) || snapshot?.activity?.title === 'Planning';
  return hasActivePlanningSnapshot ? snapshotPlan : persistedPlan;
}

export function toPersistedActivePlanState(
  plan: Chat['latestPlan'],
  fallbackUpdatedAt: string | null | undefined
): ActivePlanState | null {
  if (!plan) {
    return null;
  }

  return {
    threadId: plan.threadId,
    turnId: plan.turnId,
    explanation: plan.explanation,
    steps: plan.steps,
    deltaText: '',
    updatedAt: fallbackUpdatedAt ?? new Date(0).toISOString(),
  };
}

export function resolveUndismissedPlanImplementationPrompt(
  prompt: PendingPlanImplementationPrompt | null | undefined,
  dismissedTurnId: string | null | undefined
): PendingPlanImplementationPrompt | null {
  if (!prompt) {
    return null;
  }

  return dismissedTurnId && dismissedTurnId === prompt.turnId ? null : prompt;
}

export function resolvePersistedPlanImplementationPrompt(
  chat: Chat | null | undefined,
  dismissedTurnId: string | null | undefined
): PendingPlanImplementationPrompt | null {
  if (!chat?.latestTurnPlan) {
    return null;
  }

  if (dismissedTurnId && dismissedTurnId === chat.latestTurnPlan.turnId) {
    return null;
  }

  return isCompletedPlanTurnStatus(chat.latestTurnStatus)
    ? {
        threadId: chat.id,
        turnId: chat.latestTurnPlan.turnId,
      }
    : null;
}

export function normalizePlanTurnStatus(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized.length > 0 ? normalized : null;
}

export function isCompletedPlanTurnStatus(value: string | null | undefined): boolean {
  const normalized = normalizePlanTurnStatus(value);
  return (
    normalized === 'completed' ||
    normalized === 'complete' ||
    normalized === 'success' ||
    normalized === 'succeeded'
  );
}

export function formatReasoningEffort(effort: ReasoningEffort): string {
  if (effort === 'xhigh') {
    return 'X-High';
  }

  if (effort === 'none') {
    return 'None';
  }

  if (effort === 'minimal') {
    return 'Minimal';
  }

  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function shouldAutoEnablePlanModeFromChat(chat: Chat): boolean {
  if (chat.latestTurnPlan) {
    return true;
  }

  const latestAssistantMessage = [...chat.messages]
    .reverse()
    .find((message) => message.role === 'assistant');
  if (!latestAssistantMessage) {
    return false;
  }

  const normalized = latestAssistantMessage.content.toLowerCase();
  return (
    normalized.includes('request_user_input is unavailable in default mode') ||
    (normalized.includes('request_user_input') &&
      normalized.includes('default mode') &&
      normalized.includes('plan mode') &&
      normalized.includes('unavailable'))
  );
}

export function parseSlashCommand(input: string): { name: string; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  if (trimmed === '/') {
    return {
      name: 'help',
      args: '',
    };
  }

  const match = trimmed.match(/^\/([a-zA-Z0-9_-]+)\s*(.*)$/);
  if (!match) {
    return null;
  }

  return {
    name: match[1].toLowerCase(),
    args: match[2] ?? '',
  };
}

export function parseSlashQuery(input: string): string | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  if (trimmed === '/') {
    return '';
  }

  const afterSlash = trimmed.slice(1);
  const token = afterSlash.split(/\s+/)[0] ?? '';
  return token.toLowerCase();
}

export function findSlashCommandDefinition(name: string): SlashCommandDefinition | null {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  return (
    SLASH_COMMANDS.find((command) => {
      if (command.name.toLowerCase() === normalized) {
        return true;
      }

      return (
        command.aliases?.some((alias) => alias.toLowerCase() === normalized) ?? false
      );
    }) ?? null
  );
}

export function filterSlashCommands(query: string): SlashCommandDefinition[] {
  const normalized = query.trim().toLowerCase();
  const dedupedCommands = dedupeSlashCommandsByName(SLASH_COMMANDS);
  if (!normalized) {
    return dedupedCommands;
  }

  return dedupedCommands.filter((command) => {
    const byName = command.name.toLowerCase().includes(normalized);
    const bySummary = command.summary.toLowerCase().includes(normalized);
    const byAlias =
      command.aliases?.some((alias) => alias.toLowerCase().includes(normalized)) ?? false;
    return byName || bySummary || byAlias;
  });
}

export function dedupeSlashCommandsByName(
  commands: SlashCommandDefinition[]
): SlashCommandDefinition[] {
  const seen = new Set<string>();
  const result: SlashCommandDefinition[] = [];

  for (const command of commands) {
    const key = command.name.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(command);
  }

  return result;
}

export function formatAgentThreadOptionTitle(
  chat: ChatSummary,
  rootThreadId: string | null,
  ordinal: number | null
): string {
  const trimmedTitle = chat.title.trim();
  if (rootThreadId && chat.id === rootThreadId) {
    return trimmedTitle || 'Main thread';
  }
  const nickname = chat.agentNickname?.trim();
  if (nickname) {
    return nickname;
  }
  if (ordinal !== null) {
    return `Sub-agent ${String(ordinal)}`;
  }
  return 'Sub-agent';
}

export function iconForAgentThread(
  chat: ChatSummary,
  rootThreadId: string | null
): ComponentProps<typeof Ionicons>['name'] {
  if (rootThreadId && chat.id === rootThreadId) {
    return 'chatbubble-ellipses-outline';
  }

  switch (chat.sourceKind) {
    case 'subAgentReview':
      return 'shield-checkmark-outline';
    case 'subAgentCompact':
      return 'layers-outline';
    default:
      return chat.status === 'running' ? 'sparkles-outline' : 'git-branch-outline';
  }
}

export function stripMarkdownInline(value: string): string {
  return value
    .replace(/(^|\n)\s{0,3}#{1,6}\s*/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[_~]/g, '');
}

export function toTickerSnippet(
  value: string | null | undefined,
  maxLength = 72
): string | null {
  if (!value) {
    return null;
  }

  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return null;
  }

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  return `${cleaned.slice(0, Math.max(1, maxLength - 1))}…`;
}

export function mergeStreamingDelta(previous: string | null, delta: string): string {
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

  // Some transports send cumulative snapshots instead of token deltas.
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

export function formatLiveReasoningMessage(text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return '• Reasoning';
  }

  const lines = normalized
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return '• Reasoning';
  }

  const [first, ...rest] = lines;
  return ['• Reasoning', `  └ ${first}`, ...rest.map((line) => `    ${line}`)].join('\n');
}

export function formatLiveCursorToolMessage(item: Record<string, unknown> | null): string | null {
  const tool = readString(item?.tool) ?? readString(item?.name) ?? 'unknown';
  const status = normalizeCursorToolStatus(readString(item?.status));
  const title =
    status === 'error'
      ? `• Tool failed \`${tool}\``
      : status === 'running'
        ? `• Calling tool \`${tool}\``
        : `• Called tool \`${tool}\``;
  const argsPreview = toLiveCursorToolArgsPreview(item);
  const resultPreview = toLiveCursorToolResultPreview(item?.result);
  const details = [
    argsPreview ? `Input: ${argsPreview}` : null,
    resultPreview,
  ].filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);

  return formatTimelineSystemMessage(title, details);
}

export function normalizeCursorToolStatus(value: string | null): 'running' | 'complete' | 'error' {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'error' || normalized === 'failed') {
    return 'error';
  }
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'finished') {
    return 'complete';
  }
  return 'running';
}

export function toLiveCursorToolArgsPreview(item: Record<string, unknown> | null): string | null {
  const args = toRecord(item?.args);
  if (!args) {
    return stringifyLiveCursorPreview(item?.args, 320);
  }

  return (
    toTickerSnippet(readString(args.path), 180) ??
    toTickerSnippet(readString(args.filePath), 180) ??
    toTickerSnippet(readString(args.file_path), 180) ??
    toTickerSnippet(readString(args.globPattern), 180) ??
    toTickerSnippet(readString(args.glob_pattern), 180) ??
    toTickerSnippet(readString(args.command), 220) ??
    stringifyLiveCursorPreview(args, 320)
  );
}

export function toLiveCursorToolResultPreview(value: unknown): string | null {
  const record = toRecord(value);
  const branchPreview = toLiveCursorGitBranchPreview(record);
  if (branchPreview) {
    return branchPreview;
  }

  const status = readString(record?.status)?.trim().toLowerCase();
  const error =
    status === 'error' || status === 'failed'
      ? toTickerSnippet(
          readString(record?.error) ?? readString(toRecord(record?.error)?.message),
          600
        )
      : null;
  if (error) {
    return `Error: ${error}`;
  }

  return stringifyLiveCursorPreview(record?.value ?? record?.result ?? value, 600);
}

export function toLiveCursorGitBranchPreview(record: Record<string, unknown> | null): string | null {
  const branches = Array.isArray(record?.branches) ? record.branches : [];
  if (branches.length === 0) {
    return null;
  }

  const lines = branches
    .map((entry) => {
      const branch = toRecord(entry);
      if (!branch) {
        return null;
      }
      return [
        readString(branch.branch) ? `Branch: ${readString(branch.branch)}` : null,
        readString(branch.prUrl) || readString(branch.pr_url)
          ? `PR: ${readString(branch.prUrl) ?? readString(branch.pr_url)}`
          : null,
        readString(branch.repoUrl) || readString(branch.repo_url)
          ? `Repo: ${readString(branch.repoUrl) ?? readString(branch.repo_url)}`
          : null,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .filter((line): line is string => Boolean(line));

  return lines.length > 0 ? lines.join('\n') : null;
}

export function stringifyLiveCursorPreview(value: unknown, maxLength: number): string | null {
  if (value == null) {
    return null;
  }
  if (typeof value === 'string') {
    return toTickerSnippet(value, maxLength);
  }

  try {
    return toTickerSnippet(JSON.stringify(value), maxLength);
  } catch {
    return null;
  }
}

export function formatTimelineSystemMessage(title: string, details: string[]): string {
  const normalizedDetails = details
    .flatMap((detail) => detail.split('\n'))
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const [first, ...rest] = normalizedDetails;
  if (!first) {
    return title;
  }
  return [title, `  └ ${first}`, ...rest.map((line) => `    ${line}`)].join('\n');
}

export function filterReasoningMessagesForEngine(
  messages: ChatTranscriptMessage[],
  engine: Chat['engine'] | undefined
): ChatTranscriptMessage[] {
  if (engine !== 'codex') {
    return messages;
  }

  return messages.filter((message) => message.systemKind !== 'reasoning');
}

export function describeStartedToolEvent(
  item: Record<string, unknown> | null
): { eventType: string; detail: string } | null {
  const itemType = readString(item?.type);
  if (itemType === 'commandExecution') {
    const command = toTickerSnippet(readString(item?.command), 80) ?? 'Command';
    return {
      eventType: 'command.running',
      detail: buildToolEventDetail(command, 'running'),
    };
  }

  if (itemType === 'fileChange') {
    return {
      eventType: 'file_change.running',
      detail: buildToolEventDetail('Applying file changes', 'running'),
    };
  }

  if (itemType === 'mcpToolCall') {
    const detail = [readString(item?.server), readString(item?.tool)]
      .filter(Boolean)
      .join(' / ') || 'Tool call';
    return {
      eventType: 'tool.running',
      detail: buildToolEventDetail(detail, 'running'),
    };
  }

  if (itemType === 'toolCall') {
    const detail = readString(item?.tool) ?? readString(item?.name) ?? 'Tool call';
    return {
      eventType: 'tool.running',
      detail: buildToolEventDetail(detail, 'running'),
    };
  }

  return null;
}

export function describeCompletedToolEvent(
  item: Record<string, unknown> | null
): { eventType: string; detail: string } | null {
  const itemType = readString(item?.type);
  const rawStatus = readString(item?.status);
  const status: 'complete' | 'error' =
    rawStatus === 'failed' || rawStatus === 'error' ? 'error' : 'complete';

  if (itemType === 'commandExecution') {
    const command = toTickerSnippet(readString(item?.command), 80) ?? 'Command';
    return {
      eventType: 'command.completed',
      detail: buildToolEventDetail(command, status),
    };
  }

  if (itemType === 'fileChange') {
    const changedPaths = readCompletedFileChangePaths(item);
    const changedFileLabel =
      changedPaths.length === 0
        ? 'File changes'
        : changedPaths.length === 1
          ? `File changes: ${toTickerSnippet(toFileChangeTargetLabel(changedPaths[0]), 48) ?? 'file'}`
          : `File changes: ${toTickerSnippet(toFileChangeTargetLabel(changedPaths[0]), 40) ?? 'file'} +${String(changedPaths.length - 1)}`;
    return {
      eventType: 'file_change.completed',
      detail: buildToolEventDetail(changedFileLabel, status),
    };
  }

  if (itemType === 'mcpToolCall') {
    const detail = [readString(item?.server), readString(item?.tool)]
      .filter(Boolean)
      .join(' / ') || 'Tool call';
    return {
      eventType: 'tool.completed',
      detail: buildToolEventDetail(detail, status),
    };
  }

  if (itemType === 'toolCall') {
    const detail = readString(item?.tool) ?? readString(item?.name) ?? 'Tool call';
    return {
      eventType: 'tool.completed',
      detail: buildToolEventDetail(detail, status),
    };
  }

  return null;
}

export function describeWebSearchToolEvent(
  msg: Record<string, unknown> | null
): { eventType: string; detail: string } | null {
  const query = toTickerSnippet(readString(msg?.query), 80);
  return {
    eventType: 'web_search.running',
    detail: buildToolEventDetail(query ? `Web search: ${query}` : 'Web search', 'running'),
  };
}

export function buildToolEventDetail(
  label: string,
  status: 'running' | 'complete' | 'error'
): string {
  return `${label} | ${status}`;
}

export function readCompletedFileChangePaths(item: Record<string, unknown> | null): string[] {
  const rawChanges = Array.isArray(item?.changes) ? item.changes : [];
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const change of rawChanges) {
    const changeRecord = toRecord(change);
    const path =
      readString(change)?.trim() ??
      readString(changeRecord?.path)?.trim() ??
      readString(changeRecord?.filePath)?.trim() ??
      readString(changeRecord?.file_path)?.trim();
    if (!path) {
      continue;
    }
    const normalized = path.replace(/\\/g, '/');
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    paths.push(normalized);
  }

  return paths;
}

export function toFileChangeTargetLabel(path: string): string {
  const normalized = path.trim().replace(/\\/g, '/');
  if (!normalized) {
    return 'file';
  }

  const basename = normalized.split('/').filter(Boolean).pop();
  return basename && basename.length > 0 ? basename : normalized;
}

export function appendRunEventHistory(
  previous: RunEvent[],
  threadId: string,
  eventType: string,
  detail: string
): RunEvent[] {
  const last = previous[previous.length - 1];
  if (last && last.eventType === eventType && last.detail === detail) {
    return previous;
  }

  const next: RunEvent = {
    id: `re-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    threadId,
    eventType,
    at: new Date().toISOString(),
    detail,
  };

  return [...previous, next].slice(-MAX_ACTIVE_COMMANDS);
}

export function normalizeCodexEventType(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized.length > 0 ? normalized : null;
}

function readErrorMessageCandidate(value: unknown, depth = 0): string | null {
  if (depth > 3) {
    return null;
  }

  const direct = readString(value)?.trim();
  if (direct) {
    return direct;
  }

  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const fields = [
    record.message,
    record.errorMessage,
    record.error_message,
    record.detail,
    record.details,
    record.reason,
    record.description,
    record.stderr,
    record.error,
  ];

  for (const field of fields) {
    const message = readErrorMessageCandidate(field, depth + 1);
    if (message) {
      return message;
    }
  }

  return null;
}

export function extractCodexFailureMessage(
  params: Record<string, unknown> | null,
  msgArg?: Record<string, unknown> | null
): string | null {
  const msg = msgArg ?? toRecord(params?.msg);
  const turnRecord = toRecord(params?.turn) ?? toRecord(msg?.turn);
  const statusRecord = toRecord(params?.status) ?? toRecord(msg?.status);
  const candidates = [
    msg?.error,
    params?.error,
    turnRecord?.error,
    msg?.message,
    params?.message,
    msg?.errorMessage,
    params?.errorMessage,
    msg?.error_message,
    params?.error_message,
    msg?.detail,
    params?.detail,
    msg?.details,
    params?.details,
    msg?.reason,
    params?.reason,
    msg?.description,
    params?.description,
    msg?.stderr,
    params?.stderr,
    statusRecord?.message,
    statusRecord?.error,
  ];

  for (const candidate of candidates) {
    const message = readErrorMessageCandidate(candidate);
    if (message) {
      return message;
    }
  }

  return null;
}

export function isCodexRunHeartbeatEvent(codexEventType: string): boolean {
  return CODEX_RUN_HEARTBEAT_EVENT_TYPES.has(codexEventType);
}

export function normalizeExternalStatusHint(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized.length > 0 ? normalized : null;
}

export function extractNotificationThreadId(
  params: Record<string, unknown> | null,
  msgArg?: Record<string, unknown> | null
): string | null {
  if (!params && !msgArg) {
    return null;
  }

  const msg = msgArg ?? toRecord(params?.msg);
  const threadRecord =
    toRecord(params?.thread) ??
    toRecord(params?.threadState) ??
    toRecord(params?.thread_state) ??
    toRecord(msg?.thread);
  const threadSourceRecord = toRecord(threadRecord?.source);
  const turnRecord = toRecord(params?.turn) ?? toRecord(msg?.turn);
  const sourceRecord = toRecord(params?.source) ?? toRecord(msg?.source);
  const subagentThreadSpawnRecord = toRecord(
    toRecord(sourceRecord?.subagent ?? sourceRecord?.subAgent)?.thread_spawn
  );
  const threadSubagentThreadSpawnRecord = toRecord(
    toRecord(threadSourceRecord?.subagent ?? threadSourceRecord?.subAgent)?.thread_spawn
  );

  return (
    readString(msg?.thread_id) ??
    readString(msg?.threadId) ??
    readString(msg?.conversation_id) ??
    readString(msg?.conversationId) ??
    readString(params?.thread_id) ??
    readString(params?.threadId) ??
    readString(params?.conversation_id) ??
    readString(params?.conversationId) ??
    readString(threadRecord?.id) ??
    readString(threadRecord?.thread_id) ??
    readString(threadRecord?.threadId) ??
    readString(threadRecord?.conversation_id) ??
    readString(threadRecord?.conversationId) ??
    readString(turnRecord?.thread_id) ??
    readString(turnRecord?.threadId) ??
    readString(sourceRecord?.thread_id) ??
    readString(sourceRecord?.threadId) ??
    readString(sourceRecord?.conversation_id) ??
    readString(sourceRecord?.conversationId) ??
    readString(sourceRecord?.parent_thread_id) ??
    readString(sourceRecord?.parentThreadId) ??
    readString(subagentThreadSpawnRecord?.parent_thread_id) ??
    readString(subagentThreadSpawnRecord?.parentThreadId) ??
    readString(threadSourceRecord?.parent_thread_id) ??
    readString(threadSourceRecord?.parentThreadId) ??
    readString(threadSubagentThreadSpawnRecord?.parent_thread_id) ??
    readString(threadSubagentThreadSpawnRecord?.parentThreadId) ??
    null
  );
}

export function extractNotificationParentThreadId(
  params: Record<string, unknown> | null,
  msgArg?: Record<string, unknown> | null
): string | null {
  if (!params && !msgArg) {
    return null;
  }

  const msg = msgArg ?? toRecord(params?.msg);
  const threadRecord =
    toRecord(params?.thread) ??
    toRecord(params?.threadState) ??
    toRecord(params?.thread_state) ??
    toRecord(msg?.thread);
  const threadSourceRecord = toRecord(threadRecord?.source);
  const sourceRecord = toRecord(params?.source) ?? toRecord(msg?.source);
  const subagentThreadSpawnRecord = toRecord(
    toRecord(sourceRecord?.subagent ?? sourceRecord?.subAgent)?.thread_spawn
  );
  const threadSubagentThreadSpawnRecord = toRecord(
    toRecord(threadSourceRecord?.subagent ?? threadSourceRecord?.subAgent)?.thread_spawn
  );

  return (
    readString(sourceRecord?.parent_thread_id) ??
    readString(sourceRecord?.parentThreadId) ??
    readString(subagentThreadSpawnRecord?.parent_thread_id) ??
    readString(subagentThreadSpawnRecord?.parentThreadId) ??
    readString(threadSourceRecord?.parent_thread_id) ??
    readString(threadSourceRecord?.parentThreadId) ??
    readString(threadSubagentThreadSpawnRecord?.parent_thread_id) ??
    readString(threadSubagentThreadSpawnRecord?.parentThreadId) ??
    null
  );
}

export function extractExternalStatusHint(
  params: Record<string, unknown> | null
): string | null {
  if (!params) {
    return null;
  }

  const directCandidates: unknown[] = [
    params.status,
    params.threadStatus,
    params.thread_status,
    params.state,
    params.phase,
  ];
  for (const candidate of directCandidates) {
    const direct = normalizeExternalStatusHint(readString(candidate));
    if (direct) {
      return direct;
    }

    const candidateRecord = toRecord(candidate);
    const typed = normalizeExternalStatusHint(
      readString(candidateRecord?.type) ??
        readString(candidateRecord?.status) ??
        readString(candidateRecord?.state) ??
        readString(candidateRecord?.phase)
    );
    if (typed) {
      return typed;
    }
  }

  const threadRecord =
    toRecord(params.thread) ?? toRecord(params.threadState) ?? toRecord(params.thread_state);
  if (!threadRecord) {
    return null;
  }

  const nestedThreadStatus = normalizeExternalStatusHint(
    readString(threadRecord.status) ??
      readString(toRecord(threadRecord.status)?.type) ??
      readString(threadRecord.state) ??
      readString(threadRecord.phase) ??
      readString(toRecord(threadRecord.lifecycle)?.status)
  );
  return nestedThreadStatus;
}

export function isChatSummaryLikelyRunning(chat: ChatSummary): boolean {
  return chat.status === 'running';
}

export function isChatLikelyRunning(chat: Chat): boolean {
  if (chat.status === 'running') {
    return true;
  }

  // Trust definitive server statuses — don't second-guess them with heuristics.
  if (chat.status === 'error' || chat.status === 'complete' || chat.status === 'idle') {
    return false;
  }

  const lastMessage = chat.messages[chat.messages.length - 1];
  if (!lastMessage || lastMessage.role !== 'user') {
    return false;
  }

  const updatedAtMs = Date.parse(chat.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return false;
  }

  return Date.now() - updatedAtMs < LIKELY_RUNNING_RECENT_UPDATE_MS;
}

export function hasRecentUnansweredUserTurn(chat: Chat): boolean {
  let lastUserIndex = -1;
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    if (chat.messages[index].role === 'user') {
      lastUserIndex = index;
      break;
    }
  }

  if (lastUserIndex < 0) {
    return false;
  }

  for (let index = lastUserIndex + 1; index < chat.messages.length; index += 1) {
    if (chat.messages[index].role === 'assistant') {
      return false;
    }
  }

  const lastUser = chat.messages[lastUserIndex];
  const userCreatedAtMs = Date.parse(lastUser.createdAt);
  if (!Number.isFinite(userCreatedAtMs)) {
    return false;
  }

  return Date.now() - userCreatedAtMs < UNANSWERED_USER_RUNNING_TTL_MS;
}

export function didAssistantMessageProgress(previous: Chat | null, next: Chat): boolean {
  if (!previous || previous.id !== next.id) {
    return false;
  }

  const previousLatestAssistant = latestAssistantMessage(previous.messages);
  const nextLatestAssistant = latestAssistantMessage(next.messages);

  if (!nextLatestAssistant) {
    return false;
  }

  if (!previousLatestAssistant) {
    return nextLatestAssistant.content.trim().length > 0;
  }

  if (nextLatestAssistant.id === previousLatestAssistant.id) {
    return nextLatestAssistant.content.length > previousLatestAssistant.content.length;
  }

  return (
    next.messages.length > previous.messages.length &&
    nextLatestAssistant.content.trim().length > 0
  );
}

export function latestAssistantMessage(messages: ChatTranscriptMessage[]): ChatTranscriptMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant') {
      return message;
    }
  }
  return null;
}

export function extractFirstBoldSnippet(
  value: string | null | undefined,
  maxLength = 56
): string | null {
  if (!value) {
    return null;
  }

  const match = value.match(/\*\*([^*]+)\*\*/);
  if (!match) {
    return null;
  }

  return toTickerSnippet(match[1], maxLength);
}

export function toReasoningActivityDetail(
  value: string | null | undefined,
  heading: string | null | undefined,
  maxLength = 64
): string | undefined {
  if (!value) {
    return undefined;
  }

  let cleaned = stripMarkdownInline(value).replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return undefined;
  }

  if (heading) {
    const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    cleaned = cleaned
      .replace(new RegExp(`^${escapedHeading}(?:\\s*[:\\-.–—]\\s*|\\s+)`, 'i'), '')
      .trim();
    if (!cleaned || cleaned.toLowerCase() === heading.toLowerCase()) {
      return undefined;
    }
  }

  return toTickerSnippet(cleaned, maxLength) ?? undefined;
}

export function toPendingApproval(value: unknown): PendingApproval | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const id = readString(record.id);
  const kind = readString(record.kind);
  const threadId = readString(record.threadId);
  const turnId = readString(record.turnId);
  const itemId = readString(record.itemId);
  const requestedAt = readString(record.requestedAt);

  if (
    !id ||
    !kind ||
    !threadId ||
    !turnId ||
    !itemId ||
    !requestedAt ||
    (kind !== 'commandExecution' && kind !== 'fileChange')
  ) {
    return null;
  }

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
    proposedExecpolicyAmendment: readStringArray(record.proposedExecpolicyAmendment) ?? undefined,
  };
}
