import { mapResponseAction, parsePushNavigationTarget } from '../pushNotifications';
import {
  createDefaultPushSettings,
  parsePushSettings,
  serializePushSettings,
} from '../pushSettings';

describe('pushSettings', () => {
  it('defaults to auto-enabled (not opted out) with both events enabled', () => {
    const defaults = createDefaultPushSettings();
    expect(defaults.optedOut).toBe(false);
    expect(defaults.events).toEqual({ turnCompleted: true, approvalRequested: true });
    expect(defaults.token).toBeNull();
  });

  it('returns defaults for blank or malformed input', () => {
    expect(parsePushSettings('')).toEqual(createDefaultPushSettings());
    expect(parsePushSettings('not json')).toEqual(createDefaultPushSettings());
    expect(parsePushSettings('[]')).toEqual(createDefaultPushSettings());
  });

  it('round-trips through serialize/parse', () => {
    const settings = {
      optedOut: true,
      events: { turnCompleted: false, approvalRequested: true },
      token: 'ExponentPushToken[abc]',
    };
    expect(parsePushSettings(serializePushSettings(settings))).toEqual(settings);
  });

  it('drops a blank token and fills missing event prefs', () => {
    const parsed = parsePushSettings(
      JSON.stringify({ optedOut: true, token: '   ', events: { turnCompleted: false } })
    );
    expect(parsed.optedOut).toBe(true);
    expect(parsed.token).toBeNull();
    expect(parsed.events).toEqual({ turnCompleted: false, approvalRequested: true });
  });
});

describe('parsePushNavigationTarget', () => {
  it('maps known event types and thread ids', () => {
    expect(parsePushNavigationTarget({ type: 'turn_completed', threadId: 't1' })).toEqual({
      type: 'turnCompleted',
      threadId: 't1',
      approvalId: null,
    });
    expect(
      parsePushNavigationTarget({
        type: 'approval_requested',
        threadId: 't2',
        approvalId: 'apr_9',
      })
    ).toEqual({
      type: 'approvalRequested',
      threadId: 't2',
      approvalId: 'apr_9',
    });
  });

  it('returns null for unknown or malformed payloads', () => {
    expect(parsePushNavigationTarget(null)).toBeNull();
    expect(parsePushNavigationTarget({ type: 'something_else' })).toBeNull();
    expect(parsePushNavigationTarget('nope')).toBeNull();
  });
});

describe('mapResponseAction', () => {
  it('maps action identifiers to approve/deny, default otherwise', () => {
    expect(mapResponseAction('approve')).toBe('approve');
    expect(mapResponseAction('deny')).toBe('deny');
    expect(mapResponseAction('expo.modules.notifications.actions.DEFAULT')).toBe('default');
    expect(mapResponseAction('whatever')).toBe('default');
  });
});
