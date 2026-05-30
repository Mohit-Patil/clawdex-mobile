import type { HostBridgeApiClient } from './api/client';
import { requestPushRegistration } from './pushNotifications';
import {
  loadPushSettings,
  savePushSettings,
  type PushSettings,
} from './pushSettings';

/**
 * Shared push registration logic used by both the automatic on-connect path
 * (App.tsx) and the manual Settings toggle. Keeping it in one place avoids the
 * two callers drifting out of sync over the file-backed {@link PushSettings}.
 */

export type PushSyncResult =
  | { status: 'registered'; token: string }
  | { status: 'optedOut' }
  | { status: 'unavailable' };

/**
 * Register this device's Expo push token with the bridge unless the user has
 * opted out. Safe to call on every connect: permission is only prompted the
 * first time, and re-registering refreshes a rotated token. Persists the latest
 * token back to {@link PushSettings}.
 */
export async function syncPushRegistration(
  api: HostBridgeApiClient
): Promise<PushSyncResult> {
  const settings = await loadPushSettings();
  if (settings.optedOut) {
    return { status: 'optedOut' };
  }

  const registration = await requestPushRegistration();
  if (!registration) {
    // Permission denied, running on a simulator, or push isn't configured.
    return { status: 'unavailable' };
  }

  await api.registerPushDevice({
    token: registration.token,
    platform: registration.platform,
    deviceName: registration.deviceName,
    events: settings.events,
  });

  if (registration.token !== settings.token) {
    await savePushSettings({ ...settings, token: registration.token });
  }
  return { status: 'registered', token: registration.token };
}

/** Turn notifications back on (clears the opt-out) and register immediately. */
export async function enablePush(api: HostBridgeApiClient): Promise<PushSyncResult> {
  const settings = await loadPushSettings();
  if (settings.optedOut) {
    await savePushSettings({ ...settings, optedOut: false });
  }
  return syncPushRegistration(api);
}

/** Opt out, unregister the current token from the bridge, and persist. */
export async function disablePush(api: HostBridgeApiClient): Promise<void> {
  const settings = await loadPushSettings();
  if (settings.token) {
    try {
      await api.unregisterPushDevice(settings.token);
    } catch {
      // Best-effort: still record the opt-out locally.
    }
  }
  await savePushSettings({ ...settings, optedOut: true, token: null });
}

/** Persist updated per-event preferences, re-registering when still opted in. */
export async function updatePushEvents(
  api: HostBridgeApiClient,
  events: PushSettings['events']
): Promise<PushSettings> {
  const settings = await loadPushSettings();
  const next: PushSettings = { ...settings, events };
  await savePushSettings(next);
  if (!next.optedOut) {
    try {
      const result = await syncPushRegistration(api);
      if (result.status === 'registered') {
        next.token = result.token;
      }
    } catch {
      // Non-fatal; the preference is still saved locally.
    }
  }
  return next;
}
