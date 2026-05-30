# Push Notifications

Clawdex can notify you on your phone when an agent turn finishes or when it needs
an approval — even when the app is backgrounded or closed.

## Why the bridge sends them

The mobile app can only run JavaScript (and therefore keep its bridge WebSocket
open) while it is foregrounded. The instant it is backgrounded or killed, the
socket closes, so the **phone can never observe a turn completing**. The bridge,
on the other hand, owns the `codex app-server` connection and stays alive
regardless of whether any phone is connected. So the bridge is the sender:

```
codex app-server ──turn/completed──▶ bridge ──HTTPS POST──▶ Expo push service ──▶ APNs/FCM ──▶ phone
                                       ▲
                       (phone registered its Expo push token here over the authed WS)
```

Waking a backgrounded/killed app is only possible through the OS push transports
(APNs on iOS, FCM on Android). Clawdex reaches them via the **Expo Push
Notification Service**, which the bridge calls with a minimal, content-free
payload.

## What is sent

Payloads carry:

- the event type (`turn_completed` or `approval_requested`)
- the bridge project name (the working directory's folder name)
- the thread id (in `data`, used for deep-linking when the notification is tapped)
- for completed turns, a **short preview of the agent's reply** — the last
  non-empty line, whitespace-collapsed and capped at 140 characters

This means a snippet of the agent's reply text leaves your network (via Expo and
Apple/Google push infrastructure) when notifications are enabled. Full diffs,
prompts, tool output, and the rest of the conversation are never sent. When a
turn produces no reply text, the notification falls back to a generic "Codex
finished working in &lt;project&gt;" message. Approval notifications never include
reply content.

## Bridge side

- New RPC methods (over the existing authenticated WS):
  - `bridge/push/register` `{ token, platform, deviceName, events }`
  - `bridge/push/unregister` `{ token }`
  - `bridge/push/list` → device list (tokens are masked to a short suffix)
- Registrations persist to `.clawdex-push-registry.json` in the bridge working
  directory (gitignored).
- A `PushService` subscribes to the bridge notification stream and, on
  `turn/completed` / `bridge/approval.requested`, POSTs to
  `https://exp.host/--/api/v2/push/send`. Tokens that Expo reports as
  `DeviceNotRegistered` are pruned automatically.
- Optional: set `EXPO_ACCESS_TOKEN` in the bridge environment to send with an
  Expo access token (enhanced security / receipts).

## Mobile side

- **Auto-registration:** notifications are on by default. On the first successful
  bridge connect (after onboarding/pairing), the app shows the OS permission
  dialog once and registers its Expo push token with the bridge — no Settings
  trip required. It re-registers on each connect (tokens rotate) and whenever the
  active bridge changes.
- **Settings → Notifications** is the override: a master switch (opt out / back
  in) plus per-event switches (Turn finished, Approval needed). Opting out
  unregisters the token from the bridge.
- Preferences persist locally in `clawdex-push-settings.json`; `optedOut` records
  an explicit user opt-out so auto-registration stays off until they turn it back
  on.
- The shared registration logic lives in `src/pushController.ts`, used by both
  the auto path (`App.tsx`) and the Settings toggle so they cannot drift.
- **Foreground:** while the app is active the banner is suppressed (you are
  already watching, and the result also streams in over the WebSocket).
- **Backgrounded but not quit / killed:** the OS delivers and displays the push.
- Tapping a notification opens the app and navigates to the relevant thread.
- **Approval notifications carry Approve / Deny action buttons** (iOS notification
  category `approval`). The approval push includes the `approvalId`; tapping a
  button foregrounds the app and resolves that approval over the authenticated
  bridge WebSocket (`bridge/approval.resolve`). The buttons foreground the app on
  purpose: resolving needs the WS, which only runs while the app is active, so a
  fully-background resolve isn't reliable for this transport. The in-app approval
  banner remains as a fallback if the action can't complete.

## Build requirements (standalone apps)

Expo Go handles push credentials for you during development. **Standalone /
store builds need platform credentials configured in EAS:**

- iOS: an APNs key (`eas credentials`, or let EAS manage it).
- Android: an FCM v1 service-account key uploaded to your Expo project.

Push tokens are not available on simulators/emulators — test on a physical
device. The `expo-notifications` config plugin is already declared in
`app.json`.
