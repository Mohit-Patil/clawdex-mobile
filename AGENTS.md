# AGENTS

## Project Purpose
- Monorepo for controlling Codex from mobile:
  - `apps/mobile`: Expo React Native client (Threads, Terminal, Git, Settings).
  - `services/mac-bridge`: Fastify + WebSocket service wrapping `codex app-server`, git, and terminal execution.

## Repo Layout
- `apps/mobile`: UI and API client code.
  - API layer: `src/api/*`
  - Screens: `src/screens/*`
- `services/mac-bridge`: backend bridge service.
  - HTTP/WS server: `src/server.ts`, `src/index.ts`
  - Service adapters: `src/services/*`
  - Shared protocol types: `src/types.ts`
- Root `package.json`: npm workspaces + common scripts.

## Setup
1. Install deps:
   - `npm install`
2. Copy env examples:
   - `cp apps/mobile/.env.example apps/mobile/.env`
   - `cp services/mac-bridge/.env.example services/mac-bridge/.env`

### Starting the Bridge

The bridge does **not** auto-load `.env` files. All environment variables must be passed inline.

```bash
BRIDGE_HOST=0.0.0.0 \
BRIDGE_PORT=8787 \
BRIDGE_ALLOW_INSECURE_NO_AUTH=true \
CODEX_CLI_BIN=codex \
BRIDGE_WORKDIR="$(pwd)" \
npm run -w @codex/mac-bridge dev
```

- `BRIDGE_HOST=0.0.0.0` binds to all interfaces so the phone on the same LAN can reach it. Without this it defaults to `127.0.0.1` (localhost only).
- `BRIDGE_ALLOW_INSECURE_NO_AUTH=true` disables auth for local development. Without it the bridge will throw `BRIDGE_AUTH_TOKEN is required`.
- `CODEX_CLI_BIN=codex` tells the bridge which Codex binary to use. Make sure `codex` is in your PATH.
- `BRIDGE_WORKDIR` sets the root directory for git/terminal operations.

The shorthand `npm run bridge` only sets `BRIDGE_WORKDIR` — it will fail unless the other vars are already exported in your shell.

### Starting Expo

```bash
npm run mobile
```

This runs `expo start` in the `apps/mobile` workspace. It loads `apps/mobile/.env` automatically.

Make sure `EXPO_PUBLIC_MAC_BRIDGE_URL` in `apps/mobile/.env` points to your Mac's LAN IP and the bridge port:
```
EXPO_PUBLIC_MAC_BRIDGE_URL=http://<YOUR_LAN_IP>:8787
```

Find your LAN IP with `ifconfig en0 | grep inet` (macOS). The phone and the Mac must be on the same network.

Optionally run on a specific platform:
- `npm run ios`
- `npm run android`

## Core Commands
- `npm run lint` (all workspaces)
- `npm run typecheck` (all workspaces)
- `npm run build` (all workspaces)
- `npm run -w @codex/mac-bridge dev` (bridge watch mode)
- `npm run -w @codex/mobile start` (Expo dev server)

## Architecture Notes
- Mobile app creates one `MacBridgeApiClient` and one `MacBridgeWsClient` in `App.tsx` and passes them to screen components.
- Threads, Terminal, and Git screens keep local `useState` and call typed API helpers in `apps/mobile/src/api/client.ts`.
- Bridge exposes:
  - REST: health, threads, terminal exec, git status/diff/commit
  - WS: run/thread/terminal/git events
- `CodexCliAdapter` manages thread cache and run events; `CodexAppServerClient` manages the `codex app-server` child process.

## Coding Conventions
- Keep changes in `src/` only; do not manually edit build artifacts.
- Preserve strong typing across bridge contracts (`services/mac-bridge/src/types.ts`, `apps/mobile/src/api/types.ts`).
- Use Zod validation for new bridge request bodies.
- Prefer small service-layer additions over bloating route handlers.
- For mobile, keep API requests in `src/api/client.ts` and UI logic in screen files.

## Security Guardrails
- Treat bridge as trusted-network only until auth is added:
  - CORS is permissive.
  - `/terminal/exec` executes shell commands.
  - Git endpoints can mutate repository state.
- Never expose `services/mac-bridge` directly to the public internet in current form.
- If adding new execution endpoints, enforce authentication/authorization first.

## Known Risks
- WebSocket broadcast path has limited resilience for slow/broken clients.
- Thread/run cache updates can race under concurrent writes.
- Mobile WS client currently lacks robust reconnect/backoff behavior.
- npm audit still reports high vulnerabilities from Expo’s transitive toolchain (`minimatch` path) even on latest stable Expo.

## Testing Expectations
- Current safety net is lint + typecheck + manual smoke tests.
- Minimum pre-merge checks:
  - `npm run lint`
  - `npm run typecheck`
  - exercise bridge endpoints and WS flow
  - open mobile app and verify Threads + Terminal + Git screens
- Add tests for new API behavior when feasible (no test harness is currently configured).

## Common Pitfalls
- Bridge requires accessible `codex` CLI and `git` binaries in runtime PATH.
- On real devices, use LAN host for bridge URL instead of localhost.
- Endpoint changes must be mirrored in mobile `src/api/types.ts` + client methods.
- Keep environment handling explicit; avoid relying on implicit cwd assumptions.
- If Expo Go shows a Worklets JS/native mismatch, align Expo-compatible versions (`react-native-reanimated@4.1.1` with `react-native-worklets@0.5.1`) and reinstall cleanly.
- If Expo shows `Failed to create a worklet`, ensure `apps/mobile/babel.config.js` includes `plugins: ['react-native-reanimated/plugin']` and restart with `expo start --clear`.
