import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';

/**
 * Push notifications.
 *
 * The mobile app can only keep its bridge WebSocket open while foregrounded, so
 * it can never observe a turn completing once backgrounded. Instead the bridge
 * (always alive) sends a push when a turn finishes or an approval is needed. This
 * module owns the device-side half: requesting permission, obtaining the Expo
 * push token to hand to the bridge, foreground suppression, and deep-link routing
 * from a tapped notification.
 */

export type PushEventKey = 'turnCompleted' | 'approvalRequested';

export interface PushEventPreferences {
  turnCompleted: boolean;
  approvalRequested: boolean;
}

export interface PushRegistrationInfo {
  token: string;
  platform: string;
  deviceName: string;
}

/** Where a tapped notification should take the user. */
export interface PushNavigationTarget {
  type: PushEventKey;
  threadId: string | null;
  approvalId: string | null;
}

/** iOS notification category that renders the Approve/Deny action buttons. */
export const APPROVAL_CATEGORY_ID = 'approval';
export const APPROVE_ACTION_ID = 'approve';
export const DENY_ACTION_ID = 'deny';

/** A notification response: a plain tap, or an Approve/Deny action button. */
export type PushResponseAction = 'default' | 'approve' | 'deny';

export interface PushResponseEvent {
  action: PushResponseAction;
  target: PushNavigationTarget;
}

/**
 * Register the approval notification category so iOS shows Approve/Deny buttons
 * on approval pushes. Both buttons foreground the app: resolving an approval
 * needs the authenticated bridge WebSocket, which only runs while the app is
 * active, so a true background resolve isn't reliable for this transport.
 */
export async function registerNotificationCategories(): Promise<void> {
  try {
    await Notifications.setNotificationCategoryAsync(APPROVAL_CATEGORY_ID, [
      {
        identifier: APPROVE_ACTION_ID,
        buttonTitle: 'Approve',
        options: { opensAppToForeground: true },
      },
      {
        identifier: DENY_ACTION_ID,
        buttonTitle: 'Deny',
        options: { opensAppToForeground: true, isDestructive: true },
      },
    ]);
  } catch {
    // Non-fatal: notifications still arrive, just without action buttons.
  }
}

/** Map an Expo action identifier to our action enum. */
export function mapResponseAction(actionIdentifier: string): PushResponseAction {
  if (actionIdentifier === APPROVE_ACTION_ID) {
    return 'approve';
  }
  if (actionIdentifier === DENY_ACTION_ID) {
    return 'deny';
  }
  return 'default';
}

export const DEFAULT_PUSH_EVENT_PREFERENCES: PushEventPreferences = {
  turnCompleted: true,
  approvalRequested: true,
};

/**
 * While the app is foregrounded the user is already watching, so we suppress the
 * banner. When backgrounded the OS renders the push directly without consulting
 * this handler, so completion/approval alerts still arrive.
 */
export function setupNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => {
      const active = AppState.currentState === 'active';
      return {
        shouldShowBanner: !active,
        shouldShowList: true,
        shouldPlaySound: !active,
        shouldSetBadge: false,
      };
    },
  });
}

function resolveProjectId(): string | null {
  const fromExtra = (
    Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined
  )?.eas?.projectId;
  if (typeof fromExtra === 'string' && fromExtra.trim().length > 0) {
    return fromExtra.trim();
  }
  const fromEasConfig = (Constants as { easConfig?: { projectId?: unknown } }).easConfig
    ?.projectId;
  if (typeof fromEasConfig === 'string' && fromEasConfig.trim().length > 0) {
    return fromEasConfig.trim();
  }
  return null;
}

function resolveDeviceName(): string {
  const name = Device.deviceName;
  if (typeof name === 'string' && name.trim().length > 0) {
    return name.trim();
  }
  return Platform.OS === 'ios' ? 'iPhone' : 'Android device';
}

/**
 * Request notification permission (if needed) and return the Expo push token to
 * register with the bridge. Returns null when the user declines, when running on
 * a simulator/emulator (no push token available), or when the project is not
 * configured for push.
 */
export async function requestPushRegistration(): Promise<PushRegistrationInfo | null> {
  if (!Device.isDevice) {
    return null;
  }

  if (Platform.OS === 'android') {
    try {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.HIGH,
      });
    } catch {
      // Channel setup is best-effort; token retrieval below is what matters.
    }
  }

  const existing = await Notifications.getPermissionsAsync();
  let granted = existing.granted;
  if (!granted && existing.canAskAgain) {
    const requested = await Notifications.requestPermissionsAsync();
    granted = requested.granted;
  }
  if (!granted) {
    return null;
  }

  const projectId = resolveProjectId();
  try {
    const tokenResponse = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );
    const token = tokenResponse.data;
    if (typeof token !== 'string' || token.trim().length === 0) {
      return null;
    }
    return {
      token: token.trim(),
      platform: Platform.OS,
      deviceName: resolveDeviceName(),
    };
  } catch {
    return null;
  }
}

export function addNotificationResponseListener(
  handler: (event: PushResponseEvent) => void
): { remove: () => void } {
  return Notifications.addNotificationResponseReceivedListener((response) => {
    const event = parsePushResponse(response);
    if (event) {
      handler(event);
    }
  });
}

export async function getInitialNotificationResponse(): Promise<PushResponseEvent | null> {
  const response = await Notifications.getLastNotificationResponseAsync();
  if (!response) {
    return null;
  }
  return parsePushResponse(response);
}

function parsePushResponse(
  response: Notifications.NotificationResponse
): PushResponseEvent | null {
  const target = parsePushNavigationTarget(
    response.notification.request.content.data as unknown
  );
  if (!target) {
    return null;
  }
  return { action: mapResponseAction(response.actionIdentifier), target };
}

/** Pure: map a notification's `data` payload to a navigation target. */
export function parsePushNavigationTarget(data: unknown): PushNavigationTarget | null {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const record = data as Record<string, unknown>;
  const rawType = typeof record.type === 'string' ? record.type : '';
  const type: PushEventKey | null =
    rawType === 'turn_completed'
      ? 'turnCompleted'
      : rawType === 'approval_requested'
        ? 'approvalRequested'
        : null;
  if (!type) {
    return null;
  }
  const threadIdValue = record.threadId;
  const threadId =
    typeof threadIdValue === 'string' && threadIdValue.trim().length > 0
      ? threadIdValue.trim()
      : null;
  const approvalIdValue = record.approvalId;
  const approvalId =
    typeof approvalIdValue === 'string' && approvalIdValue.trim().length > 0
      ? approvalIdValue.trim()
      : null;
  return { type, threadId, approvalId };
}
