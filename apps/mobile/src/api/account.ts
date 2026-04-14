import { readString, toRecord } from './chatMapping';
import type { AccountLoginStartResponse, AccountSnapshot, PlanType } from './types';

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

export function readAccountSnapshot(value: unknown): AccountSnapshot {
  const record = toRecord(value);
  const accountRecord = toRecord(record?.account);
  const accountType = readAccountType(accountRecord?.type);

  return {
    type: accountType,
    email: accountType === 'chatgpt' ? readString(accountRecord?.email) : null,
    planType:
      accountType === 'chatgpt'
        ? readPlanType(accountRecord?.planType ?? accountRecord?.plan_type)
        : null,
    requiresOpenaiAuth:
      record?.requiresOpenaiAuth === true || record?.requires_openai_auth === true,
  };
}

export function readAccountLoginStartResponse(value: unknown): AccountLoginStartResponse {
  const record = toRecord(value);
  const type = readString(record?.type);

  if (type === 'apiKey') {
    return { type };
  }

  if (type === 'chatgptAuthTokens') {
    return { type };
  }

  if (type === 'chatgpt') {
    const loginId = readString(record?.loginId);
    const authUrl = readString(record?.authUrl);
    if (!loginId || !authUrl) {
      throw new Error('account/login/start returned an incomplete ChatGPT login response');
    }
    return {
      type,
      loginId,
      authUrl,
    };
  }

  throw new Error('account/login/start returned an unsupported login response');
}

function readAccountType(value: unknown): AccountSnapshot['type'] {
  if (value === 'apiKey' || value === 'chatgpt') {
    return value;
  }

  return null;
}

function readPlanType(value: unknown): PlanType | null {
  if (typeof value !== 'string') {
    return null;
  }

  return PLAN_TYPES.has(value as PlanType) ? (value as PlanType) : null;
}
