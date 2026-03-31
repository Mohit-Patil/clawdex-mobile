import * as FileSystem from 'expo-file-system/legacy';
import * as StoreReview from 'expo-store-review';
import { Linking, Platform } from 'react-native';

export const AUTO_STORE_REVIEW_THRESHOLD_MS = 10 * 60 * 1000;

const STORE_REVIEW_STATE_FILE = 'clawdex-store-review.json';
const IOS_APP_STORE_ITEM_ID = '6759833757';
const IOS_APP_STORE_WRITE_REVIEW_WEB_URL = `https://apps.apple.com/app/id${IOS_APP_STORE_ITEM_ID}?action=write-review`;
const IOS_APP_STORE_WRITE_REVIEW_DEEP_LINK = `itms-apps://itunes.apple.com/app/viewContentsUserReviews/id${IOS_APP_STORE_ITEM_ID}?action=write-review`;

export type AutoStoreReviewState = {
  accumulatedForegroundMs: number;
  automaticRequestAt: string | null;
};

export function createDefaultAutoStoreReviewState(): AutoStoreReviewState {
  return {
    accumulatedForegroundMs: 0,
    automaticRequestAt: null,
  };
}

export function parseAutoStoreReviewState(raw: string): AutoStoreReviewState {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return createDefaultAutoStoreReviewState();
  }

  try {
    const parsed = JSON.parse(raw) as {
      accumulatedForegroundMs?: unknown;
      automaticRequestAt?: unknown;
    };
    return {
      accumulatedForegroundMs: normalizeAccumulatedForegroundMs(parsed.accumulatedForegroundMs),
      automaticRequestAt: normalizeIsoTimestamp(parsed.automaticRequestAt),
    };
  } catch {
    return createDefaultAutoStoreReviewState();
  }
}

export async function loadAutoStoreReviewState(): Promise<AutoStoreReviewState> {
  const path = getAutoStoreReviewStatePath();
  if (!path) {
    return createDefaultAutoStoreReviewState();
  }

  try {
    const raw = await FileSystem.readAsStringAsync(path);
    return parseAutoStoreReviewState(raw);
  } catch {
    return createDefaultAutoStoreReviewState();
  }
}

export async function saveAutoStoreReviewState(
  state: AutoStoreReviewState
): Promise<void> {
  const path = getAutoStoreReviewStatePath();
  if (!path) {
    return;
  }

  await FileSystem.writeAsStringAsync(path, JSON.stringify(state));
}

export function isAutoStoreReviewEligible(state: AutoStoreReviewState): boolean {
  return (
    state.automaticRequestAt === null &&
    state.accumulatedForegroundMs >= AUTO_STORE_REVIEW_THRESHOLD_MS
  );
}

export async function requestNativeStoreReview(): Promise<boolean> {
  if (Platform.OS !== 'ios') {
    return false;
  }

  const available = await StoreReview.isAvailableAsync();
  if (!available) {
    return false;
  }

  await StoreReview.requestReview();
  return true;
}

export function canOpenAppStoreWriteReviewPage(): boolean {
  return Platform.OS === 'ios';
}

export async function openAppStoreWriteReviewPage(): Promise<boolean> {
  if (!canOpenAppStoreWriteReviewPage()) {
    return false;
  }

  try {
    await Linking.openURL(IOS_APP_STORE_WRITE_REVIEW_DEEP_LINK);
    return true;
  } catch {
    await Linking.openURL(IOS_APP_STORE_WRITE_REVIEW_WEB_URL);
    return true;
  }
}

function getAutoStoreReviewStatePath(): string | null {
  const base = FileSystem.documentDirectory;
  if (typeof base !== 'string' || base.trim().length === 0) {
    return null;
  }

  return `${base}${STORE_REVIEW_STATE_FILE}`;
}

function normalizeAccumulatedForegroundMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
