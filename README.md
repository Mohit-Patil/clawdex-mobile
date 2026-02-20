# Codex Mobile Control (Expo + mac-bridge)

V1 scaffold for remotely controlling Codex running on a Mac from a cross-platform Expo app.

## Repo layout

- `apps/mobile`: Expo (iOS + Android) TypeScript app with tabs for Threads, Terminal, Git, Settings.
- `services/mac-bridge`: Node.js TypeScript service (Fastify + WebSocket) that exposes REST/WS APIs and a clean Codex adapter layer.
  - Thread/session history is sourced from `codex app-server` (persisted Codex sessions), so mobile can load and continue existing sessions.

## Prerequisites

- Node.js 20+
- npm 10+
- Xcode + iOS Simulator (for iOS)
- Android Studio + Android Emulator (for Android)
- A Mac machine reachable from the mobile device/emulator for bridge API calls

## Setup

1. Install dependencies from repo root:

```bash
npm install
```

2. Configure env files:

```bash
cp apps/mobile/.env.example apps/mobile/.env
cp services/mac-bridge/.env.example services/mac-bridge/.env
```

Bridge env notes:
- `BRIDGE_WORKDIR`: absolute path to the repo/directory where Codex CLI should run.
  - `npm run bridge` now sets this automatically to the repo root (`$(pwd)`), so Codex edits your project files instead of the `services/mac-bridge` subfolder.
- `CODEX_CLI_BIN`: Codex CLI executable path/name (defaults to `codex`).
- `BRIDGE_AUTH_TOKEN`: bearer token for bridge REST/WS auth. If unset, bridge runs without auth (not recommended).

3. Start mac-bridge:

```bash
npm run bridge
```

## Run mobile app

From repo root:

```bash
npm run mobile
```

Then launch with:

```bash
npm run ios
npm run android
```

Note: for physical devices, set `EXPO_PUBLIC_MAC_BRIDGE_URL` to your Mac's LAN IP (for example `http://192.168.1.10:8787`) instead of `localhost`.
If bridge auth is enabled, set `EXPO_PUBLIC_MAC_BRIDGE_TOKEN` to match `BRIDGE_AUTH_TOKEN`.

## Scripts

- `npm run mobile`: Start Expo dev server
- `npm run ios`: Open iOS simulator via Expo
- `npm run android`: Open Android emulator via Expo
- `npm run bridge`: Start mac-bridge in watch mode
- `npm run lint`: Run lint in all workspaces
- `npm run typecheck`: Run typecheck in all workspaces
- `npm run build`: Build all workspaces

## API summary (mac-bridge)

- `GET /health`
- `GET /threads`
- `POST /threads`
- `GET /threads/:id`
- `POST /threads/:id/message`
- `GET /approvals`
- `POST /approvals/:id/decision`
- `POST /terminal/exec`
- `GET /git/status`
- `GET /git/diff`
- `POST /git/commit`
- `GET /ws` (WebSocket events)

Thread execution events stream over `GET /ws` while Codex is running, including thread status transitions and assistant message deltas.
