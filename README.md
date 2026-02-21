# Codex Mobile Control (Expo + Rust Bridge)

V1 scaffold for remotely controlling Codex running on a Mac from a cross-platform Expo app.

## Repo layout

- `apps/mobile`: Expo (iOS + Android) TypeScript app with tabs for Threads, Terminal, Git, Settings.
- `services/rust-bridge`: Rust WebSocket JSON-RPC service that proxies `codex app-server` and exposes terminal/git helpers.
- `services/mac-bridge`: legacy Node.js TypeScript bridge kept for reference.

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
cp services/rust-bridge/.env.example services/rust-bridge/.env
```

Bridge env notes:
- `BRIDGE_WORKDIR`: absolute path to the repo/directory where Codex CLI should run.
  - `npm run bridge` now sets this automatically to the repo root (`$(pwd)`), so Codex edits your project files instead of the `services/mac-bridge` subfolder.
- `CODEX_CLI_BIN`: Codex CLI executable path/name (defaults to `codex`).
- `BRIDGE_AUTH_TOKEN`: bearer token for bridge WS auth. Required by default.
- `BRIDGE_ALLOW_INSECURE_NO_AUTH=true`: local-dev-only escape hatch to run bridge without auth.
- `BRIDGE_ALLOW_QUERY_TOKEN_AUTH=true`: optional fallback for browser WebSocket clients that cannot set `Authorization` headers.
- `BRIDGE_CORS_ORIGINS`: comma-separated origin allowlist for browser access. If unset, CORS response headers are disabled.
- `BRIDGE_TERMINAL_ALLOWED_COMMANDS`: comma-separated allowlist for `bridge/terminal/exec` (default: `pwd,ls,cat,git`).
- `BRIDGE_DISABLE_TERMINAL_EXEC=true`: disable terminal execution entirely.

3. Start Rust bridge:

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
Always set `EXPO_PUBLIC_MAC_BRIDGE_TOKEN` to match `BRIDGE_AUTH_TOKEN`.
For non-local deployments, prefer `https://` bridge URLs and `wss://` websockets.
Set `EXPO_PUBLIC_ALLOW_QUERY_TOKEN_AUTH=true` only when you explicitly need browser WebSocket auth fallback.
`EXPO_PUBLIC_ALLOW_INSECURE_REMOTE_BRIDGE=true` suppresses the mobile warning for non-local `http://` URLs.
Set `EXPO_PUBLIC_PRIVACY_POLICY_URL` to populate the in-app Privacy screen policy link.
Set `EXPO_PUBLIC_TERMS_OF_SERVICE_URL` to populate the in-app Terms screen link.

## Scripts

- `npm run mobile`: Start Expo dev server
- `npm run ios`: Open iOS simulator via Expo
- `npm run android`: Open Android emulator via Expo
- `npm run bridge`: Start Rust bridge
- `npm run bridge:ts`: Start legacy TypeScript bridge
- `npm run lint`: Run lint in all workspaces
- `npm run typecheck`: Run typecheck in all workspaces
- `npm run build`: Build all workspaces

## API summary (rust-bridge)

- `GET /health`
- `GET /rpc` (WebSocket JSON-RPC)
- Forwarded app-server methods: `thread/*`, `turn/*`, `review/start`, `model/list`, `skills/list`, `app/list`
- Bridge methods:
  - `bridge/health/read`
  - `bridge/terminal/exec`
  - `bridge/git/status`
  - `bridge/git/diff`
  - `bridge/git/commit`
  - `bridge/approvals/list`
  - `bridge/approvals/resolve`

Thread execution events stream through JSON-RPC notifications (`turn/*`, `item/*`) plus bridge notifications (`bridge/approval.*`, `bridge/terminal/completed`, `bridge/git/updated`).
