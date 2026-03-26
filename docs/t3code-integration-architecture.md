# T3 Code Integration Architecture

Date: March 26, 2026

## Goal

Add `t3code` support without teaching the mobile app a second remote-control protocol.

The target architecture remains:

1. Mobile talks to one Clawdex bridge websocket.
2. The Rust bridge stays the live event authority for reconnect, replay, approvals, and user input.
3. Backend-specific protocols are translated behind the bridge into the existing mobile contract.

## Upstream Findings

Research was based on the public `pingdotgg/t3code` repository at commit
`9403429a7af114a1b96a79c96ecda218f9e0c0b2`.

Important observations:

- `t3code` is a server/orchestrator product, not just a provider CLI.
- Its public remote-control surface is its own HTTP + WebSocket API.
- WebSocket auth currently uses a `?token=` query parameter.
- The public protocol is not JSON-RPC 2.0 and it is not Codex app-server compatible.
- The main remote surfaces are:
  - `orchestration.getSnapshot`
  - `orchestration.dispatchCommand`
  - `orchestration.replayEvents`
  - `server.getConfig`
  - push channels such as `orchestration.domainEvent`
- T3 already has snapshot + replay semantics, which makes it a good bridge backend candidate.

Implication:

- Treat `t3code` as another bridge backend like `opencode`.
- Do not try to bolt it directly into the mobile client.
- Do not treat it as a new model provider inside the existing Codex/OpenCode adapters.

## Current Repo Gaps

The current repo already has the right high-level seam, but it is not generalized enough yet.

- `services/rust-bridge/src/main.rs` still hard-codes a dual-engine runtime.
- `apps/mobile/src/api/types.ts` and multiple UI helpers still hard-code a 2-engine union.
- `bridge/capabilities/read` is bridge-global and reflects the preferred engine, not per-thread or per-engine capabilities.
- Several mobile surfaces still branch on `engine === "opencode"` instead of using capability checks.

## Recommended Integration Path

### Phase 1: Foundation

- Generalize engine metadata and settings on mobile.
- Remove binary `codex` vs `opencode` UI copy from new-chat/settings surfaces.
- Add a dedicated architecture doc for the T3 backend path.
- Do not expose a selectable `t3code` runtime until the bridge adapter exists.

### Phase 2: Bridge Backend Adapter

Add `T3CodeBackend` under `services/rust-bridge`.

Recommended initial config:

- `BRIDGE_T3CODE_URL`
- `BRIDGE_T3CODE_AUTH_TOKEN`
- optional `BRIDGE_T3CODE_CONNECT_TIMEOUT_MS`

Start with "connect to an already running T3 server".
Do not make the bridge responsible for spawning `t3code` in the first slice.

### Phase 3: Read + Sync

Implement:

- `thread/list` from `orchestration.getSnapshot`
- `thread/read` from cached snapshot/projected thread data
- event replay from `orchestration.replayEvents`
- live push subscription to `orchestration.domainEvent`

Normalize T3 thread ids as bridge-qualified ids:

- `t3code:<thread-id>`

### Phase 4: Write Path

Implement bridge translations:

- `thread/start`
  - find or create a T3 project for the requested `cwd`
  - dispatch `thread.create`
- `turn/start`
  - dispatch `thread.turn.start`
- `turn/interrupt`
  - dispatch `thread.turn.interrupt`
- `model/list`
  - flatten `server.getConfig().providers[*].models`

### Phase 5: Human-in-the-Loop + Capability Gating

Map T3 domain events into existing bridge-native events:

- approval requested/resolved
- structured user input requested/resolved
- turn started/completed/failed/interrupted
- assistant text delta
- reasoning/plan/tool progress where possible

Then replace mobile engine-name checks with capability checks.

## Mapping Notes

T3 is already normalized internally around:

- projects
- threads
- messages
- activities
- checkpoints
- provider runtime events

That is a better fit for Clawdex than scraping terminal output.

Recommended outward bridge projection:

- T3 thread -> Clawdex thread/chat
- T3 assistant message delta -> `item/agentMessage/delta`
- T3 plan updates -> `turn/plan/updated` when available
- T3 activity/tool events -> `item/started`, `item/completed`, progress events, or bridge activity summaries
- T3 approval/user-input events -> existing `bridge/*` events

## Risks

- T3 owns project/worktree/session state, so bridge projections must preserve `cwd`, project identity, and active worktree context.
- T3’s WebSocket contract appears implementation-defined rather than a formally versioned public SDK surface.
- The current T3 web/desktop stack assumes query-token auth for the socket; mobile bridge connectivity must support that cleanly.

## Immediate Next Steps

1. Refactor `RuntimeBackend` into an engine registry instead of dedicated `codex`/`opencode` fields.
2. Introduce per-engine capability reporting from the bridge.
3. Implement a read-only `T3CodeBackend` that can list/read threads and subscribe to replay/live events.
4. Follow with write-path support and capability-gated UI behavior.
