# App Review Notes (Template)

Use this file as the source for App Store Connect "Notes for Review" and internal submission prep.

Related engineering reference:

- `docs/realtime-streaming-limitations.md`

## Submission Snapshot

- App name: Codex Mobile Control
- Build: [fill in build/version]
- Date prepared: February 21, 2026
- Primary reviewer contact: [name + email + phone]
- Time zone for live support: [time zone]

## What The App Does

Codex Mobile Control is a client for a user-owned Mac host.
The iOS app connects to a bridge service running on the user's own machine and lets the user:

- View and continue Codex threads
- Review Git status and diffs
- Create Git commits
- Execute approved terminal commands on the user-owned host

The app does not provide a public multi-tenant cloud shell.

## Test Setup For Review

Reviewer can use either of the following:

1. Dedicated review host (recommended for first submission)

- We provide a reachable test Mac bridge URL and token directly to App Review.
- This host stays online during review hours.

2. Local host setup (fallback)

- Start bridge service on a Mac:

```bash
npm install
cp apps/mobile/.env.example apps/mobile/.env
cp services/mac-bridge/.env.example services/mac-bridge/.env
npm run bridge
```

- In `services/mac-bridge/.env`, set:

```env
BRIDGE_AUTH_TOKEN=<review-token>
BRIDGE_HOST=0.0.0.0
BRIDGE_CORS_ORIGINS=http://localhost:19006,http://localhost:8081
```

- In `apps/mobile/.env`, set:

```env
EXPO_PUBLIC_MAC_BRIDGE_URL=http://<mac-lan-ip>:8787
EXPO_PUBLIC_MAC_BRIDGE_TOKEN=<review-token>
EXPO_PUBLIC_PRIVACY_POLICY_URL=https://<your-policy-url>
EXPO_PUBLIC_TERMS_OF_SERVICE_URL=https://<your-terms-url>
```

## Reviewer Walkthrough

1. Launch app.
2. Open Drawer and choose "Settings" to confirm bridge health is "OK".
3. Open Drawer and choose "Privacy" to view in-app privacy details and policy URL.
4. Open Drawer and choose "Terms" to view in-app terms information and terms URL.
5. Open Drawer and choose "Terminal". Run `pwd` to confirm command execution flow.
6. Open Drawer and choose "Git". Verify status/diff render and commit action path.
7. Open a thread in Main and send a message to validate thread streaming behavior.

## Security And Privacy Notes For Review

- Bridge auth token is required by default.
- WebSocket auth uses Authorization header (query-token fallback is opt-in only).
- Bridge can be run localhost-only; LAN mode is user-configured.
- Terminal commands are constrained by server-side allowlist and can be fully disabled.
- Requested command working directory is constrained within configured bridge root.
- In-app Privacy and Terms screens are available at all times from Drawer and Settings.

## Guideline Positioning Notes

- The app is intended for access to user-owned host infrastructure, not a shared cloud shell.
- Any remote execution happens on infrastructure controlled by the user or review account owner.
- App requires host setup details disclosed above and does not hide companion dependency.

## What To Provide In App Store Connect

- Privacy Policy URL: [required final URL]
- Terms of Service URL: [recommended final URL]
- Demo host details for review: [URL + token + availability window]
- Support contact reachable during review: [contact details]
- Any temporary review credentials: [if applicable]

## Open Source License Requirements

- Ensure release/app-review artifacts follow `docs/open-source-license-requirements.md`.
- Keep third-party notices available for review/legal requests.

## Final Pre-Submit Checklist

- [ ] Privacy Policy URL is live and matches in-app link.
- [ ] Terms URL is live and matches in-app link.
- [ ] Review host is reachable from external network used by App Review.
- [ ] BRIDGE_AUTH_TOKEN set and validated.
- [ ] Terminal allowlist reviewed for least privilege.
- [ ] Notes for Review copied from this document and updated placeholders removed.
