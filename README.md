# Clawdex Mobile

<p align="center">
  <img src="https://raw.githubusercontent.com/Mohit-Patil/clawdex-mobile/main/apps/mobile/assets/brand/app-icon.png" alt="Clawdex app icon" width="112" />
</p>

Control Clawdex from your phone using an Expo React Native app (`apps/mobile`) and a Rust bridge (`services/rust-bridge`) running on your host machine.

This project is intended for trusted/private networking (Tailscale or local LAN). Do not expose the bridge publicly.

## What You Get

- Mobile chat with Clawdex
- Voice-to-text transcription (push-to-talk)
- Live run/activity updates over WebSocket
- Plan/default collaboration mode support
- Clarification and approval flows in-app
- File/image attachments from workspace and phone
- Chat-scoped Git actions (status/diff/commit/push)
- Bridge-backed terminal execution

## Quick Start

### Option A: Published CLI (recommended)

```bash
npm install -g clawdex-mobile@latest
clawdex init
```

This is the primary starting point.

`clawdex init` guides you through:

1. bridge mode selection: `Local (LAN)` or `Tailscale`
2. secure bridge config generation (`.env.secure`)
3. phone readiness checks for selected mode
4. optional bridge launch in the foreground (release build)

When the bridge starts, it prints a pairing QR:

- preferred: QR contains both `bridgeUrl + bridgeToken` (one-scan onboarding)
- fallback: token-only QR if host is not a phone-connectable address

Typical lifecycle:

```bash
# install/update once
npm install -g clawdex-mobile@latest

# onboarding + start bridge
clawdex init

# stop services later
clawdex stop
```

### Option B: Monorepo checkout

```bash
npm install
npm run setup:wizard
```

Use `npm run setup:wizard -- --no-start` to configure only (no bridge start).

## Project Layout

- `apps/mobile`: Expo client (UI + API client)
- `services/rust-bridge`: primary bridge (WebSocket JSON-RPC + `codex app-server` adapter)
- `services/mac-bridge`: legacy TypeScript bridge (reference only)
- `scripts/`: onboarding/runtime helper scripts
- `docs/`: setup, troubleshooting, architecture notes

## Prerequisites

- macOS or Linux
- Node.js 20+
- npm 10+
- `codex` CLI in `PATH`
- `git` in `PATH`
- iOS app installed (TestFlight/App Store/dev build)
- Tailscale on host + phone (recommended for remote/private networking)

Optional for simulators/emulators:

- Xcode + iOS Simulator
- Android Studio + Android Emulator

## Day-to-Day Commands

From repo root:

- `npm run setup:wizard` — guided secure setup + optional bridge start
- `npm run stop:services` — stop running bridge (and Expo if running)
- `npm run secure:setup` — generate/update secure env
- `npm run secure:bridge` — start rust bridge from `.env.secure` (release profile)
- `npm run secure:bridge:dev` — start rust bridge in dev profile
- `npm run mobile` — start Expo
- `npm run ios` — start Expo (iOS target)
- `npm run android` — start Expo (Android target)
- `npm run teardown` — interactive cleanup
- `npm run lint` / `npm run typecheck` / `npm run build`

Published CLI:

- `clawdex init`
- `clawdex stop`
- `clawdex upgrade` / `clawdex update`
- `clawdex version`

## Onboarding In App

On first launch (or after reset):

1. choose mode (`Local` or `Tailscale`)
2. scan bridge QR to autofill URL + token
3. use `Test Connection` (health + authenticated RPC check)
4. tap `Continue`

## EAS Builds (Short)

Run EAS commands from `apps/mobile` (that is where `app.json` and `eas.json` live):

```bash
cd apps/mobile
eas build --platform ios --profile preview
eas build --platform android --profile preview
```

For complete build/submit guidance, see [`docs/eas-builds.md`](docs/eas-builds.md).

## Documentation Map

- Setup + operations: [`docs/setup-and-operations.md`](docs/setup-and-operations.md)
- Troubleshooting: [`docs/troubleshooting.md`](docs/troubleshooting.md)
- Realtime sync limits/mitigations: [`docs/realtime-streaming-limitations.md`](docs/realtime-streaming-limitations.md)
- Voice transcription internals: [`docs/voice-transcription.md`](docs/voice-transcription.md)
- Open-source license obligations: [`docs/open-source-license-requirements.md`](docs/open-source-license-requirements.md)
- App review template: [`docs/app-review-notes.md`](docs/app-review-notes.md)
- App-server/CLI gap tracking: [`docs/codex-app-server-cli-gap-tracker.md`](docs/codex-app-server-cli-gap-tracker.md)

## Open Source License Requirements

Follow project requirements in:

- `LICENSE`
- `docs/open-source-license-requirements.md`

## Development Checks

From repo root:

```bash
npm run lint
npm run typecheck
npm run build
npm run test
```
