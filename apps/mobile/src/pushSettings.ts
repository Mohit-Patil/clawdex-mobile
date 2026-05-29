import * as FileSystem from 'expo-file-system/legacy';

import {
  DEFAULT_PUSH_EVENT_PREFERENCES,
  type PushEventPreferences,
} from './pushNotifications';

/**
 * Persisted push-notification preferences for this device.
 *
 * Kept in its own file-backed store (like the prompt library and store-review
 * state) instead of the main appSettings blob, so the feature stays self
 * contained.
 *
 * Notifications are auto-enabled: the app requests permission on first bridge
 * connect and registers automatically. `optedOut` records that the user has
 * explicitly turned notifications off, which suppresses the auto-registration.
 * `token` is the Expo push token last registered with the bridge — retained so
 * we can unregister it when the user opts out.
 */

export const PUSH_SETTINGS_VERSION = 1;

const PUSH_SETTINGS_FILE = 'clawdex-push-settings.json';

export interface PushSettings {
  optedOut: boolean;
  events: PushEventPreferences;
  token: string | null;
}

export function createDefaultPushSettings(): PushSettings {
  return {
    optedOut: false,
    events: { ...DEFAULT_PUSH_EVENT_PREFERENCES },
    token: null,
  };
}

function normalizeEvents(value: unknown): PushEventPreferences {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_PUSH_EVENT_PREFERENCES };
  }
  const record = value as Record<string, unknown>;
  return {
    turnCompleted:
      typeof record.turnCompleted === 'boolean'
        ? record.turnCompleted
        : DEFAULT_PUSH_EVENT_PREFERENCES.turnCompleted,
    approvalRequested:
      typeof record.approvalRequested === 'boolean'
        ? record.approvalRequested
        : DEFAULT_PUSH_EVENT_PREFERENCES.approvalRequested,
  };
}

export function parsePushSettings(raw: string): PushSettings {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return createDefaultPushSettings();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return createDefaultPushSettings();
    }
    const record = parsed as Record<string, unknown>;
    const token =
      typeof record.token === 'string' && record.token.trim().length > 0
        ? record.token.trim()
        : null;
    return {
      optedOut: typeof record.optedOut === 'boolean' ? record.optedOut : false,
      events: normalizeEvents(record.events),
      token,
    };
  } catch {
    return createDefaultPushSettings();
  }
}

export function serializePushSettings(settings: PushSettings): string {
  return JSON.stringify({
    version: PUSH_SETTINGS_VERSION,
    optedOut: settings.optedOut,
    events: settings.events,
    token: settings.token,
  });
}

function getPushSettingsPath(): string | null {
  const base = FileSystem.documentDirectory;
  if (typeof base !== 'string' || base.trim().length === 0) {
    return null;
  }
  return `${base}${PUSH_SETTINGS_FILE}`;
}

export async function loadPushSettings(): Promise<PushSettings> {
  const path = getPushSettingsPath();
  if (!path) {
    return createDefaultPushSettings();
  }
  try {
    const raw = await FileSystem.readAsStringAsync(path);
    return parsePushSettings(raw);
  } catch {
    return createDefaultPushSettings();
  }
}

export async function savePushSettings(settings: PushSettings): Promise<void> {
  const path = getPushSettingsPath();
  if (!path) {
    return;
  }
  await FileSystem.writeAsStringAsync(path, serializePushSettings(settings));
}
