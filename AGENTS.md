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
3. Start bridge:
   - `npm run bridge`
4. Start mobile:
   - `npm run mobile`
   - optionally `npm run ios` or `npm run android`

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
