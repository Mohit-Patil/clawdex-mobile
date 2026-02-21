# Clawdex Mobile (Codex Mobile Control)

<img src="apps/mobile/assets/brand/app-icon.png" alt="Clawdex app icon" width="112" />

Control Codex from your phone using an Expo React Native app (`apps/mobile`) and a Rust bridge (`services/rust-bridge`) running on your Mac.

This project is intended for trusted/private networking (Tailscale or local LAN). Do not expose the bridge publicly.

## What You Get

- Chat with Codex from mobile
- Choose a default start directory for new chats (from existing chat workspaces)
- Chat-scoped Git controls (status, commit, push)
- Terminal command execution through bridge
- Live thread/run updates over WebSocket
- Guided setup wizard for first-time onboarding

## Project Layout

- `apps/mobile`: Expo client (UI + API client)
- `services/rust-bridge`: primary bridge (WebSocket JSON-RPC + `codex app-server` adapter)
- `services/mac-bridge`: legacy TypeScript bridge (reference only)
- `scripts/`: onboarding and runtime helper scripts

## Open Source License Requirements

Follow the project-wide requirements in:

- `docs/open-source-license-requirements.md`

## Branding Assets

Brand files now live in:

- `apps/mobile/assets/brand/app-icon.png` (Expo app icon)
- `apps/mobile/assets/brand/adaptive-icon.png` (Android adaptive foreground)
- `apps/mobile/assets/brand/splash-icon.png` (launch image)
- `apps/mobile/assets/brand/favicon.png` (web favicon)
- `apps/mobile/assets/brand/mark.png` (in-app logo mark)

Expo config wiring is in `apps/mobile/app.json`.
In-app brand mark component is `apps/mobile/src/components/BrandMark.tsx`.

## Prerequisites

- macOS
- Node.js 20+
- npm 10+
- `codex` CLI installed and available in `PATH`
- `git` installed and available in `PATH`
- Tailscale on Mac + phone (recommended)
- Expo Go on phone (for non-standalone flow)

Optional for local simulator/emulator workflows:

- Xcode + iOS Simulator
- Android Studio + Android Emulator

## Fastest Start (Recommended)

```bash
npm install
npm run setup:wizard
```

`setup:wizard` walks through:

1. codex CLI check
2. Tailscale install check (offers Homebrew install)
3. Tailscale login/connectivity check (opens browser flow if needed)
4. Expo Go readiness check
5. Secure env generation
6. Optional one-terminal run (bridge in background + Expo QR in foreground)

## Manual Secure Setup (No Wizard)

### 1) Install dependencies

```bash
npm install
```

### 2) Generate secure runtime config

```bash
npm run secure:setup
```

This creates/updates:

- `.env.secure` (bridge runtime config + token)
- `apps/mobile/.env` (bridge URL/token for mobile app)

### 3) Start bridge

```bash
npm run secure:bridge
```

### 4) Start Expo

```bash
npm run mobile
```

`npm run mobile` uses `scripts/start-expo.sh`, which sets `REACT_NATIVE_PACKAGER_HOSTNAME` to your configured secure host (from `.env.secure`), so QR resolves predictably.

## Day-to-Day Commands

From repo root:

- `npm run setup:wizard` — guided setup + optional one-terminal launch
- `npm run secure:setup` — generate/update secure env
- `npm run secure:bridge` — start rust bridge from `.env.secure`
- `npm run mobile` — start Expo using configured host
- `npm run ios` — start Expo for iOS target (same host strategy)
- `npm run android` — start Expo for Android target (same host strategy)
- `npm run teardown` — interactive teardown (stop processes + cleanup)
- `npm run lint` — lint all workspaces
- `npm run typecheck` — typecheck all workspaces
- `npm run build` — build all workspaces

## Teardown / Cleanup

Use:

```bash
npm run teardown
```

Teardown can:

- stop running Expo + bridge processes
- remove generated artifacts (`.env.secure`, `.bridge.log`)
- optionally reset `apps/mobile/.env` from `.env.example`
- optionally run `tailscale down`

Non-interactive mode:

```bash
npm run teardown -- --yes
```

## Environment Reference

### Bridge runtime (`.env.secure`, generated)

| Variable | Purpose |
|---|---|
| `BRIDGE_HOST` | bind host for rust bridge |
| `BRIDGE_PORT` | bridge port (default `8787`) |
| `BRIDGE_AUTH_TOKEN` | required auth token |
| `BRIDGE_ALLOW_QUERY_TOKEN_AUTH` | query token auth fallback |
| `CODEX_CLI_BIN` | codex executable |
| `BRIDGE_WORKDIR` | working directory for terminal/git |

### Mobile runtime (`apps/mobile/.env`, generated/updated)

| Variable | Purpose |
|---|---|
| `EXPO_PUBLIC_MAC_BRIDGE_URL` | bridge base URL |
| `EXPO_PUBLIC_MAC_BRIDGE_TOKEN` | token sent by mobile client |
| `EXPO_PUBLIC_ALLOW_QUERY_TOKEN_AUTH` | web query-token behavior |
| `EXPO_PUBLIC_ALLOW_INSECURE_REMOTE_BRIDGE` | suppress insecure-HTTP warning |
| `EXPO_PUBLIC_PRIVACY_POLICY_URL` | in-app Privacy link |
| `EXPO_PUBLIC_TERMS_OF_SERVICE_URL` | in-app Terms link |

## Verifying Setup

### Bridge health

```bash
curl "$(awk -F= '/^EXPO_PUBLIC_MAC_BRIDGE_URL=/{print $2}' apps/mobile/.env)/health"
```

Expected: JSON containing `"status":"ok"`.

### In-app smoke test

1. Open app, check `Settings` shows bridge connected.
2. Open the sidebar and set `Start Directory` (optional).
3. Create a chat and send a prompt.
4. Open Git from chat header:
   - changed files visible
   - commit works
   - push button appears when branch is ahead

## Choosing Start Directory (Home/Sidebar)

You can control where new chats start from directly in the mobile app:

1. Open the left sidebar.
2. Under `Start Directory`, tap the directory row.
3. Pick one of:
   - `Bridge default workspace`
   - any workspace path discovered from your existing chats

Behavior:

- This selection is used when creating a new chat.
- Existing chats keep their own workspace unless you change them from chat Git/workspace controls.
- If you choose `Bridge default workspace`, chat creation falls back to bridge-level `BRIDGE_WORKDIR`.

## Standalone App Install (Without Expo Go)

Yes, this is supported.

### Option A: EAS Cloud Builds (Recommended)

This is the most reliable path for standalone installs.

#### Step 1: Install and login EAS CLI

```bash
npm install -g eas-cli
npx eas login
```

#### Step 2: Configure Expo/EAS in app workspace

```bash
cd apps/mobile
npx eas build:configure
```

This will create `eas.json` if missing.

#### Step 3: Set app identifiers in `apps/mobile/app.json`

Add unique IDs:

```json
{
  "expo": {
    "ios": {
      "bundleIdentifier": "com.yourorg.clawdexmobile"
    },
    "android": {
      "package": "com.yourorg.clawdexmobile"
    }
  }
}
```

#### Step 4: Build standalone binaries

From `apps/mobile`:

```bash
# Android internal distribution
npx eas build -p android --profile preview

# iOS internal distribution (device allowlist required)
npx eas build -p ios --profile preview
```

Notes:

- iOS internal builds require Apple Developer account + device provisioning.
- For iOS device registration flows, use `npx eas device:create`.
- No App Store submission is required for internal distribution.

### Option B: Local Native Builds (No EAS Cloud)

From `apps/mobile`:

```bash
npx expo run:ios --device
npx expo run:android --device
```

Use this only if your local native toolchains/signing are already configured.

## iOS Distribution Reality (Important)

iOS does not allow arbitrary sideloading like Android. Without public App Store release, your practical paths are:

1. Development/Internal (device allowlist via provisioning)
2. TestFlight private testing

So yes, cloud builds without App Store listing are possible, but still require Apple signing/provisioning.

## API Summary (Rust Bridge)

### Endpoints

- `GET /health`
- `GET /rpc` (WebSocket JSON-RPC)

### Forwarded methods

- `thread/*`
- `turn/*`
- `review/start`
- `model/list`
- `skills/list`
- `app/list`

### Bridge RPC methods

- `bridge/health/read`
- `bridge/terminal/exec`
- `bridge/git/status`
- `bridge/git/diff`
- `bridge/git/commit`
- `bridge/git/push`
- `bridge/approvals/list`
- `bridge/approvals/resolve`

### Notifications (examples)

- `turn/*`, `item/*`
- `bridge/approval.*`
- `bridge/terminal/completed`
- `bridge/git/updated`
- `bridge/connection/state`

## Troubleshooting

### Expo starts but QR/network is wrong

- Re-run `npm run secure:setup`
- Confirm `.env.secure` has the correct `BRIDGE_HOST`
- Restart `npm run mobile`

### Bridge auth errors (`401`, invalid token)

- Ensure `BRIDGE_AUTH_TOKEN` in `.env.secure` matches `EXPO_PUBLIC_MAC_BRIDGE_TOKEN` in `apps/mobile/.env`
- Restart bridge and Expo after token changes

### Tailscale issues

- Verify both Mac and phone are on the same tailnet
- Run `tailscale ip -4` and verify host in `apps/mobile/.env`

### `codex` not found

- Ensure `codex` is in `PATH`, or set `CODEX_CLI_BIN` accordingly

### Git operations fail

- Verify chat workspace path points to a valid git repo
- Verify git auth/remote access for push

### Worklets/Reanimated mismatch

- Keep pinned versions aligned (`react-native-reanimated@4.1.1`, `react-native-worklets@0.5.1`)
- Clear Expo cache:

```bash
npm run -w clawdex-mobile start -- --clear
```

## Legacy TypeScript Bridge

`services/mac-bridge` remains available for reference only.
Primary path is `services/rust-bridge`.

## Development Checks

From repo root:

```bash
npm run lint
npm run typecheck
npm run build
npm run test
```
