import { readString, toRecord } from './chatMapping';
import type {
  AccountCreditsSnapshot,
  AccountRateLimitSnapshot,
  AccountRateLimitWindow,
  PlanType,
} from './types';

const PLAN_TYPES = new Set<PlanType>([
  'free',
  'go',
  'plus',
  'pro',
  'team',
  'business',
  'enterprise',
  'edu',
  'unknown',
]);

export function readAccountRateLimits(value: unknown): AccountRateLimitSnapshot | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const byLimitId =
    toRecord(record.rateLimitsByLimitId) ?? toRecord(record.rate_limits_by_limit_id);

  if (byLimitId) {
    const preferred = readAccountRateLimitSnapshot(byLimitId.codex);
    if (preferred) {
      return preferred;
    }

    for (const candidate of Object.values(byLimitId)) {
      const snapshot = readAccountRateLimitSnapshot(candidate);
      if (snapshot) {
        return snapshot;
      }
    }
  }

  return readAccountRateLimitSnapshot(record.rateLimits ?? record.rate_limits);
}

export function readAccountRateLimitSnapshot(
  value: unknown
): AccountRateLimitSnapshot | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const primary = readAccountRateLimitWindow(record.primary);
  const secondary = readAccountRateLimitWindow(record.secondary);
  if (!primary && !secondary) {
    return null;
  }

  return {
    limitId: readString(record.limitId) ?? readString(record.limit_id),
    limitName: readString(record.limitName) ?? readString(record.limit_name),
    primary,
    secondary,
    credits: readAccountCreditsSnapshot(record.credits),
    planType: readPlanType(record.planType ?? record.plan_type),
  };
}

function readAccountRateLimitWindow(value: unknown): AccountRateLimitWindow | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const usedPercent = readNumberLike(record.usedPercent) ?? readNumberLike(record.used_percent);
  if (usedPercent === null) {
    return null;
  }

  return {
    usedPercent,
    windowDurationMins:
      readIntegerLike(record.windowDurationMins) ??
      readIntegerLike(record.window_duration_mins),
    resetsAt: readIntegerLike(record.resetsAt) ?? readIntegerLike(record.resets_at),
  };
}

function readAccountCreditsSnapshot(value: unknown): AccountCreditsSnapshot | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }

  const hasCredits = readBoolean(record.hasCredits) ?? readBoolean(record.has_credits);
  const unlimited = readBoolean(record.unlimited);
  if (hasCredits === null && unlimited === null && !readString(record.balance)) {
    return null;
  }

  return {
    hasCredits: hasCredits ?? false,
    unlimited: unlimited ?? false,
    balance: readString(record.balance),
  };
}

function readPlanType(value: unknown): PlanType | null {
  if (typeof value !== 'string') {
    return null;
  }

  return PLAN_TYPES.has(value as PlanType) ? (value as PlanType) : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readNumberLike(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const stringValue = readString(value)?.trim();
  if (!stringValue) {
    return null;
  }

  const parsed = Number(stringValue);
  return Number.isFinite(parsed) ? parsed : null;
}

function readIntegerLike(value: unknown): number | null {
  const numericValue = readNumberLike(value);
  if (numericValue === null) {
    return null;
  }

  return Math.max(0, Math.floor(numericValue));
}
