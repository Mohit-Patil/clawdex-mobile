# Project Status & Assessment

> Last reviewed: 2026-02-20

## Verdict

The foundation is solid. The Codex integration protocol, the bridge architecture, and the real-time streaming pipeline are all correctly implemented. What we have is a working prototype that needs hardening and polish to become production-ready.

## Architecture

```
Mobile App (Expo/RN)  ──HTTP REST + WS──▶  mac-bridge (Fastify)  ──JSON-RPC 2.0 over stdio──▶  codex app-server
```

Two-layer design — the phone talks to the bridge over the network, and the bridge speaks the Codex `app-server` protocol.

## What's Working

- **Full end-to-end loop** — list threads, create threads, send messages, stream responses via WebSocket deltas
- **Codex `app-server` integration** — proper JSON-RPC 2.0 handshake, request correlation, notification dispatch, approval auto-accept
- **Real-time streaming** — `thread.message.delta` events flow from Codex → bridge → WS → mobile UI
- **4 functional screens** — Threads, Terminal, Git, Settings with state management, loading states, error handling
- **Zod validation** on the bridge API, proper error codes (409 for busy threads), typed clients on both sides
- **Thread management** — list, create, open, reply, status tracking (idle/running/error/complete), run event log
- **Terminal** — execute shell commands, view stdout/stderr/exit code/duration
- **Git** — view branch, status, diff, commit with custom message
- **Settings** — health check, live WS connection indicator

## Tech Stack

| Component | Stack |
|-----------|-------|
| Mobile | Expo 54, React Native 0.81, React 19, React Navigation v7 |
| Bridge | Fastify v5, @fastify/websocket v11, Zod v3, tsx |
| Codex IPC | JSON-RPC 2.0 over stdio (`codex app-server --listen stdio://`) |
| Monorepo | npm workspaces |
| Language | TypeScript (ES2022) throughout |

## What Needs Work (priority order)

### P0 — Security

- [ ] **No auth on the bridge** — anyone on the LAN can execute arbitrary shell commands via `/terminal/exec` and write files via Codex. Add at minimum a shared secret/bearer token before using on any network.

### P1 — Reliability

- [ ] **No WebSocket reconnection** — if the WS drops, it stays dead. Add auto-reconnect with exponential backoff in `MacBridgeWsClient`.
- [ ] **No Codex process recovery** — if `codex app-server` crashes, the bridge is stuck. Add auto-restart with a health check loop.
- [ ] **No error recovery** — the bridge doesn't handle the Codex process dying mid-turn.

### P2 — Functionality Gaps

- [ ] **Git staging missing** — `GitService.commit()` only runs `git commit -m`, not `git add` first. No staging area management. Users will get "nothing to commit" errors.
- [ ] **No markdown rendering** — assistant messages are plain `Text` blocks. Codex responses are markdown-heavy.
- [ ] **No dedicated thread detail view** — message content is inline in the thread list; will get cramped with longer conversations.
- [ ] **No push notifications** — can't be alerted when a long-running Codex task finishes.

### P3 — Polish & Production

- [ ] **No tests** — zero test coverage (unit, integration, e2e).
- [ ] **No EAS build configuration** — needed for distributing to real devices.
- [ ] **No CI/CD pipeline** — no GitHub Actions or equivalent.
- [ ] **Bleeding-edge dependencies** — Expo 54 + RN 0.81 + React 19 may have ecosystem compat issues.

## Design Decisions Worth Noting

- **Auto-accept all Codex approvals** — the bridge uses `approvalPolicy: 'never'` and `sandbox: 'workspace-write'`, auto-accepting all command execution and file change requests. Codex has full write access to `BRIDGE_WORKDIR`. This is intentional for a remote-control use case but should be documented/configurable.
- **In-memory thread cache** — the `CodexCliAdapter` caches threads in a `Map`. If the bridge restarts, it re-fetches from Codex's persisted sessions on next access.
- **Bridge binds to 0.0.0.0** — accessible from the LAN by default, which is required for physical device testing but is a security concern without auth.

## File Map

```
apps/mobile/
  App.tsx                          Root — navigation + tab setup
  src/
    config.ts                      Bridge URL from env
    api/
      client.ts                    MacBridgeApiClient (REST)
      ws.ts                        MacBridgeWsClient (WebSocket)
      types.ts                     Shared TypeScript types
    screens/
      ThreadsScreen.tsx            Chat UI — list + create + reply + streaming
      TerminalScreen.tsx           Command execution UI
      GitScreen.tsx                Git status/diff/commit
      SettingsScreen.tsx           Health + connection status

services/mac-bridge/
  src/
    index.ts                       Entry — port/host config, buildServer()
    server.ts                      Fastify routes + dependency wiring
    types.ts                       Shared types
    services/
      codexAppServerClient.ts      JSON-RPC over stdio client
      codexCliAdapter.ts           High-level Codex adapter
      realtimeHub.ts               WS broadcast hub
      terminalService.ts           Shell execution via spawn
      gitService.ts                Git ops via terminalService
```
