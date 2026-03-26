# App Review Notes (Template)

Use this file as the source for App Store Connect "Notes for Review" and internal submission prep.

Related engineering reference:

- `docs/realtime-streaming-limitations.md`

## Submission Snapshot

- App name: Clawdex
- Version / build: [fill in]
- Date prepared: [fill in]
- Primary reviewer contact: [name + email + phone]
- Time zone for live support: [time zone]

## What The App Does

Clawdex is a companion app for a bridge running on infrastructure the user controls.
The iPhone and iPad app connects to that bridge and lets the user:

- Start new Codex runs and continue existing threads
- Monitor run progress and respond to clarifications
- Review approvals, Git status, and diffs
- Create Git commits on the connected host
- Execute allowed terminal commands on the connected host
- Attach files or images from the workspace or device

The app does not provide a public multi-tenant shell service.

## Test Setup For Review

Reviewer should use a dedicated review bridge.

- Provide a publicly reachable bridge URL and token directly in App Store Connect review notes.
- Keep that bridge online during App Review hours.
- Do not submit with placeholder or expired host details.

Optional fallback if App Review specifically asks for self-host setup:

```bash
npm install -g clawdex-mobile@latest
clawdex init
```

Then:

- Start the bridge on a machine you control.
- Use the generated bridge URL and token.
- Pair from the app by scanning the bridge QR code or by entering the URL and token manually.

## Reviewer Walkthrough

1. Launch the app on iPhone or iPad.
2. On `Connect Your Bridge`, scan the bridge QR code or enter the provided bridge URL and token.
3. Tap `Test Connection`, then continue.
4. Start a new run or open an existing thread.
5. Send a prompt and confirm that a response is received.
6. Open the Git screen and verify status / diff rendering.
7. If prompted, review and approve an action.
8. To attach an image, use the add action in the composer and choose an image from the device.

## Security And Privacy Notes For Review

- Bridge auth token is required by default.
- The app is intended for trusted private networking such as LAN, VPN, or Tailscale.
- Any remote execution happens only on infrastructure controlled by the user or review account owner.
- Terminal commands are constrained by server-side allowlist controls and can be disabled entirely.
- In-app Privacy and Terms screens remain accessible from Settings.

## Guideline Positioning Notes

- The app is for access to user-controlled infrastructure, not a shared cloud shell.
- The bridge dependency is disclosed during onboarding and in review notes.
- Reviewers do not need to create an external account when a review bridge URL and token are supplied.

## What To Provide In App Store Connect

- Privacy Policy URL: [required final URL]
- Support URL: [required final URL]
- Review bridge URL: [final public URL]
- Review bridge token: [final token]
- Review host availability window: [time range + time zone]
- Support contact reachable during review: [contact details]

## Open Source License Requirements

- Ensure release/app-review artifacts follow `docs/open-source-license-requirements.md`.
- Keep third-party notices available for review/legal requests.

## Final Pre-Submit Checklist

- [ ] Privacy Policy URL is live and matches the in-app link.
- [ ] Support URL is live and matches the listing.
- [ ] Review bridge is reachable from the public internet and returns a healthy response.
- [ ] Review bridge token has been tested in the current App Store build.
- [ ] Review notes in App Store Connect were refreshed for the current version.
- [ ] Build is attached to the App Store version.
- [ ] `asc validate` returns no blocking errors.
