import type { ComponentProps } from 'react';
import type { Ionicons } from '@expo/vector-icons';

import type { ChatSummary } from '../api/types';
import type { ActivityTone } from '../components/ActivityBar';
import { colors } from '../theme';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

const AGENT_ACCENT_PALETTE = [
  '#F5A524',
  '#4CC9F0',
  '#7ED957',
  '#FF8A65',
  '#F472B6',
  '#8BD3DD',
] as const;

const RUNNING_STATUS_COLOR = '#7EE787';
const WAITING_STATUS_COLOR = '#F5A524';
const COMPLETE_STATUS_COLOR = '#93C5FD';

export interface AgentThreadRuntimeSnapshotLike {
  activity?: {
    tone: ActivityTone;
    title: string;
    detail?: string;
  };
  activeCommands?: unknown[];
  pendingApproval?: unknown | null;
  pendingUserInputRequest?: unknown | null;
  activeTurnId?: string | null;
  runWatchdogUntil?: number;
  updatedAtMs?: number;
}

export interface AgentThreadDisplayState {
  icon: IoniconName;
  label: string;
  detail: string | null;
  tone: ActivityTone;
  accentColor: string;
  statusColor: string;
  statusSurfaceColor: string;
  statusBorderColor: string;
  isActive: boolean;
}

export function buildAgentThreadDisplayState(
  chat: ChatSummary,
  snapshot: AgentThreadRuntimeSnapshotLike | null | undefined,
  nowMs = Date.now()
): AgentThreadDisplayState {
  const accentColor = getAgentThreadAccentColor(chat.id);
  const status = resolveAgentRuntimeStatus(chat, snapshot, nowMs);

  return {
    ...status,
    accentColor,
  };
}

export function getAgentThreadAccentColor(threadId: string): string {
  let hash = 0;
  for (let index = 0; index < threadId.length; index += 1) {
    hash = (hash * 33 + threadId.charCodeAt(index)) >>> 0;
  }

  return AGENT_ACCENT_PALETTE[hash % AGENT_ACCENT_PALETTE.length];
}

function resolveAgentRuntimeStatus(
  chat: ChatSummary,
  snapshot: AgentThreadRuntimeSnapshotLike | null | undefined,
  nowMs: number
): Omit<AgentThreadDisplayState, 'accentColor'> {
  const activity = snapshot?.activity;
  const activityTitle = normalizeValue(activity?.title);
  const activityDetail = normalizeValue(activity?.detail);
  const hasActiveTurn = Boolean(snapshot?.activeTurnId);
  const watchdogActive =
    typeof snapshot?.runWatchdogUntil === 'number' && snapshot.runWatchdogUntil > nowMs;
  const hasActiveCommands = (snapshot?.activeCommands?.length ?? 0) > 0;
  const needsApproval = snapshot?.pendingApproval != null;
  const needsInput = snapshot?.pendingUserInputRequest != null;

  if (chat.status === 'error' || activity?.tone === 'error') {
    return {
      icon: 'alert-circle-outline',
      label: 'Error',
      detail:
        activityDetail ??
        normalizeErrorActivityTitle(activityTitle) ??
        normalizeValue(chat.lastError) ??
        null,
      tone: 'error',
      statusColor: colors.statusError,
      statusSurfaceColor: 'rgba(239, 68, 68, 0.16)',
      statusBorderColor: 'rgba(239, 68, 68, 0.42)',
      isActive: false,
    };
  }

  if (needsApproval) {
    return {
      icon: 'hand-left-outline',
      label: 'Needs approval',
      detail: activityDetail ?? normalizeRunningDetail(activityTitle),
      tone: 'running',
      statusColor: WAITING_STATUS_COLOR,
      statusSurfaceColor: 'rgba(245, 165, 36, 0.16)',
      statusBorderColor: 'rgba(245, 165, 36, 0.4)',
      isActive: true,
    };
  }

  if (needsInput) {
    return {
      icon: 'help-circle-outline',
      label: 'Needs input',
      detail: activityDetail ?? normalizeRunningDetail(activityTitle),
      tone: 'running',
      statusColor: WAITING_STATUS_COLOR,
      statusSurfaceColor: 'rgba(245, 165, 36, 0.16)',
      statusBorderColor: 'rgba(245, 165, 36, 0.4)',
      isActive: true,
    };
  }

  if (
    activity?.tone === 'running' ||
    chat.status === 'running' ||
    hasActiveTurn ||
    watchdogActive ||
    hasActiveCommands
  ) {
    const label = normalizeRunningLabel(activityTitle);
    return {
      icon: runningIconForLabel(label),
      label,
      detail: activityDetail,
      tone: 'running',
      statusColor: RUNNING_STATUS_COLOR,
      statusSurfaceColor: 'rgba(126, 231, 135, 0.14)',
      statusBorderColor: 'rgba(126, 231, 135, 0.34)',
      isActive: true,
    };
  }

  if (chat.status === 'complete' || activity?.tone === 'complete') {
    return {
      icon: 'checkmark-circle-outline',
      label: 'Complete',
      detail:
        activityDetail ??
        normalizeCompleteActivityTitle(activityTitle) ??
        null,
      tone: 'complete',
      statusColor: COMPLETE_STATUS_COLOR,
      statusSurfaceColor: 'rgba(147, 197, 253, 0.15)',
      statusBorderColor: 'rgba(147, 197, 253, 0.34)',
      isActive: false,
    };
  }

  return {
    icon: 'ellipse-outline',
    label: 'Idle',
    detail: null,
    tone: 'idle',
    statusColor: colors.statusIdle,
    statusSurfaceColor: 'rgba(180, 188, 203, 0.12)',
    statusBorderColor: 'rgba(180, 188, 203, 0.24)',
    isActive: false,
  };
}

function normalizeRunningLabel(activityTitle: string | null): string {
  const normalized = activityTitle?.trim().toLowerCase();
  if (!normalized || normalized === 'turn started' || normalized === 'ready') {
    return 'Working';
  }

  if (normalized === 'working') {
    return 'Working';
  }
  if (normalized === 'reasoning') {
    return 'Reasoning';
  }
  if (normalized === 'planning') {
    return 'Planning';
  }

  return activityTitle ?? 'Working';
}

function normalizeRunningDetail(activityTitle: string | null): string | null {
  if (!activityTitle) {
    return null;
  }

  const normalized = activityTitle.trim().toLowerCase();
  if (
    normalized === 'working' ||
    normalized === 'reasoning' ||
    normalized === 'planning' ||
    normalized === 'turn started' ||
    normalized === 'ready'
  ) {
    return null;
  }

  return activityTitle;
}

function normalizeCompleteActivityTitle(activityTitle: string | null): string | null {
  if (!activityTitle) {
    return null;
  }

  const normalized = activityTitle.trim().toLowerCase();
  if (normalized === 'turn completed' || normalized === 'ready') {
    return null;
  }

  return activityTitle;
}

function normalizeErrorActivityTitle(activityTitle: string | null): string | null {
  if (!activityTitle) {
    return null;
  }

  const normalized = activityTitle.trim().toLowerCase();
  if (
    normalized === 'turn failed' ||
    normalized === 'turn interrupted' ||
    normalized === 'error'
  ) {
    return null;
  }

  return activityTitle;
}

function runningIconForLabel(label: string): IoniconName {
  const normalized = label.trim().toLowerCase();
  if (normalized === 'planning') {
    return 'map-outline';
  }
  if (normalized === 'reasoning') {
    return 'sparkles-outline';
  }

  return 'sync-outline';
}

function normalizeValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
