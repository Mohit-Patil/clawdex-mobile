import type { AccountRateLimitSnapshot, AccountRateLimitWindow } from '../api/types';

export type ComposerUsageLimitTone = 'neutral' | 'warning' | 'critical';

export interface ComposerUsageLimitBadgeModel {
  id: 'primary' | 'secondary';
  label: string;
  remainingPercent: number;
  resetsAt: number | null;
  tone: ComposerUsageLimitTone;
}

export interface ComposerUsageLimitAlertModel {
  title: string;
  body: string;
  status: string | null;
}

export function buildComposerUsageLimitBadges(
  snapshot: AccountRateLimitSnapshot | null
): ComposerUsageLimitBadgeModel[] {
  if (!snapshot) {
    return [];
  }

  const badges: ComposerUsageLimitBadgeModel[] = [];
  const primary = toComposerUsageLimitBadge('primary', snapshot.primary, snapshot);
  if (primary) {
    badges.push(primary);
  }

  const secondary = toComposerUsageLimitBadge('secondary', snapshot.secondary, snapshot);
  if (secondary) {
    badges.push(secondary);
  }

  return badges;
}

export function buildComposerUsageLimitAlert(
  snapshot: AccountRateLimitSnapshot | null
): ComposerUsageLimitAlertModel | null {
  const exhaustedBadges = buildComposerUsageLimitBadges(snapshot).filter(
    (badge) => badge.remainingPercent <= 0
  );
  if (exhaustedBadges.length === 0) {
    return null;
  }

  const specificLabels = uniqueLabels(
    exhaustedBadges
      .map((badge) => badge.label.trim())
      .filter((label) => label.length > 0 && label !== 'limit')
  );
  const body =
    specificLabels.length === 0
      ? 'Your Codex usage limit has been reached. Try again after it resets.'
      : `Your ${formatUsageLimitLabelList(specificLabels)} Codex ${
          specificLabels.length === 1 ? 'limit has' : 'limits have'
        } been reached. Try again after the reset.`;
  const resetTimes = uniqueResetTimes(exhaustedBadges);
  const status =
    resetTimes.length === 1
      ? `Resets ${formatComposerUsageLimitResetAt(resetTimes[0])}.`
      : resetTimes.length > 1
        ? `Next reset ${formatComposerUsageLimitResetAt(resetTimes[0])}.`
        : null;

  return {
    title: 'Rate limit reached',
    body,
    status,
  };
}

export function formatComposerUsageLimitLabel(windowDurationMins: number | null): string {
  if (windowDurationMins === null || windowDurationMins <= 0) {
    return 'limit';
  }

  if (windowDurationMins === 300) {
    return '5h';
  }

  if (windowDurationMins === 10_080) {
    return 'weekly';
  }

  if (windowDurationMins < 60) {
    return `${String(windowDurationMins)}m`;
  }

  if (windowDurationMins < 1_440) {
    return `${String(Math.round(windowDurationMins / 60))}h`;
  }

  return `${String(Math.round(windowDurationMins / 1_440))}d`;
}

export function formatComposerUsageLimitResetAt(
  resetsAt: number | null,
  options?: {
    locale?: string;
    timeZone?: string;
  }
): string {
  if (resetsAt === null || !Number.isFinite(resetsAt)) {
    return 'Unknown';
  }

  const resetDate = new Date(resetsAt * 1000);
  if (Number.isNaN(resetDate.getTime())) {
    return 'Unknown';
  }

  return new Intl.DateTimeFormat(options?.locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(options?.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(resetDate);
}

function toComposerUsageLimitBadge(
  id: ComposerUsageLimitBadgeModel['id'],
  window: AccountRateLimitWindow | null,
  snapshot: AccountRateLimitSnapshot
): ComposerUsageLimitBadgeModel | null {
  if (!window) {
    return null;
  }

  const remainingPercent = clampPercent(100 - window.usedPercent);
  return {
    id,
    label: resolveComposerUsageLimitLabel(id, window.windowDurationMins, snapshot),
    remainingPercent,
    resetsAt: window.resetsAt,
    tone:
      remainingPercent <= 10
        ? 'critical'
        : remainingPercent <= 25
          ? 'warning'
          : 'neutral',
  };
}

function resolveComposerUsageLimitLabel(
  id: ComposerUsageLimitBadgeModel['id'],
  windowDurationMins: number | null,
  snapshot: AccountRateLimitSnapshot
): string {
  const explicitLabel = formatComposerUsageLimitLabel(windowDurationMins);
  if (explicitLabel !== 'limit') {
    return explicitLabel;
  }

  const normalizedLimitId = snapshot.limitId?.trim().toLowerCase() ?? null;
  const hasPrimary = Boolean(snapshot.primary);
  const hasSecondary = Boolean(snapshot.secondary);
  const looksLikeDefaultCodexPair =
    hasPrimary && hasSecondary && (!normalizedLimitId || normalizedLimitId === 'codex');

  if (looksLikeDefaultCodexPair) {
    return id === 'primary' ? '5h' : 'weekly';
  }

  return 'limit';
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

function uniqueLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const label of labels) {
    const key = label.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(label);
  }
  return result;
}

function uniqueResetTimes(badges: ComposerUsageLimitBadgeModel[]): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const badge of badges) {
    if (badge.resetsAt === null || !Number.isFinite(badge.resetsAt)) {
      continue;
    }
    if (seen.has(badge.resetsAt)) {
      continue;
    }
    seen.add(badge.resetsAt);
    result.push(badge.resetsAt);
  }
  return result.sort((a, b) => a - b);
}

function formatUsageLimitLabelList(labels: string[]): string {
  if (labels.length <= 1) {
    return labels[0] ?? 'usage';
  }

  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }

  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}
