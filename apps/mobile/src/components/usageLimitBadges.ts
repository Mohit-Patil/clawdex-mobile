import type { AccountRateLimitSnapshot, AccountRateLimitWindow } from '../api/types';

export type ComposerUsageLimitTone = 'neutral' | 'warning' | 'critical';

export interface ComposerUsageLimitBadgeModel {
  id: 'primary' | 'secondary';
  label: string;
  remainingPercent: number;
  tone: ComposerUsageLimitTone;
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
