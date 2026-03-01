# Realtime Streaming Limitations And Mitigations

Date: February 22, 2026

## Context

This project has three relevant runtime paths:

1. Mobile app connects to bridge WebSocket (`/rpc`).
2. Rust bridge spawns `codex app-server --listen stdio://` as a child process.
3. Codex CLI interactive (`codex` TUI) can run independently from the bridge path.

Because of this, shared history and shared live stream are not the same thing.

## Current Architecture Facts

1. Bridge -> app-server transport is `stdio://` (process pipes), not network WebSocket.
2. Mobile receives events that the bridge app-server instance emits.
3. CLI interactive runs can happen in a separate process/session pipeline.
4. Persisted thread data is written under the same `CODEX_HOME` (default `~/.codex` when unset).

## Why Main Messages Appear But Some Live Details Do Not

When a turn is started outside the bridge pipeline (for example from standalone Codex CLI), mobile can still show the final/main message because it periodically reads persisted thread history:

1. Mobile calls `thread/read` (with `includeTurns`) through API client.
2. Persisted `agentMessage` / `userMessage` items are mapped into chat messages.
3. So the main output appears after persistence.

However, item-level realtime notifications (reasoning deltas, tool call progress, activity transitions, approval prompts) are stream-bound and may not be available unless that turn is on the same live app-server stream the mobile bridge is subscribed to.

## Limitation (Known)

For CLI-originated turns outside the bridge-owned live stream:

1. Main conversation output is usually visible (via persisted history read).
2. Full realtime telemetry is not guaranteed:
   - activity bar transitions
   - reasoning deltas
   - tool call begin/progress/completion events
   - approval/user-input request timing parity

This is an architectural boundary, not just a UI rendering bug.

## How We Are Overcoming It Today

Current mitigation strategy is hybrid: live events when available + snapshot sync fallback.

1. Live forwarding
   - Bridge forwards app-server notifications to all WebSocket clients.
2. Event replay
   - Bridge stores replayable notifications with `eventId`.
   - Mobile can request missed events (`bridge/events/replay`) after reconnect.
3. Running-state hints
   - `thread/status/changed` is used as a lightweight signal for externally-observed activity.
4. Fast/idle polling fallback
   - Active chat sync interval and idle sync interval keep UI consistent even when deltas are missed.
5. Debounced full sync on external status changes
   - Prevents noisy expensive reload loops while still converging to latest persisted state.
6. Read-only open behavior for past chats
   - Opening history uses read/snapshot flow and avoids accidentally starting/resuming old sessions.

## Practical Guidance

1. If full realtime detail is required, start turns through mobile/bridge flow.
2. For standalone CLI-originated turns, expect eventual consistency in mobile (main output first-class, detailed live telemetry best-effort).
3. Keep all clients on the same user + same `CODEX_HOME` to preserve shared persisted history continuity.
4. Use `bridge/events/replay` for reconnect gaps.

## Future Improvement Direction

To get strict realtime parity across CLI and mobile, move to a single live event authority:

1. Route all turn execution through one shared bridge/app-server pipeline, or
2. Make clients attach to the exact same running app-server stream/session boundary.

Without this architectural change, the hybrid model remains the pragmatic and low-risk approach.

## Incident Note: February 28, 2026 Live-Sync Regression

### Symptom
Mobile chat showed persisted messages, but did not show live activity/reasoning updates (`codex/event/*`, `thread/status/changed`) for CLI-origin turns.

### Root Cause
Rust bridge rollout discovery scheduler used a modulo condition that could never become true when the discovery interval was `1`.

- Previous behavior: discovery did not run for that interval value.
- Effect: rollout files were not tracked, so no CLI live-tail notifications were emitted.

### Fix Applied
Live-sync discovery scheduling was hardened so it is valid for all interval values and always runs on first tick.

Operational result:

1. Rollout files are discovered consistently.
2. CLI-origin event lines are tailed and converted into bridge notifications.
3. Mobile receives activity/reasoning status in realtime again.

## Optimization Backlog (Live-Sync Observability + Reliability)

### 1) Add `bridge/liveSync/status` RPC (recommended next)

Goal: make rollout tailing state visible from mobile/Postman without guessing.

Suggested response payload:

1. Sessions root currently in use (`CODEX_HOME` resolved path).
2. Discovery config (`pollIntervalMs`, `discoveryIntervalTicks`, `maxTrackedFiles`).
3. Tracked files list:
   - file path
   - thread id
   - originator
   - include/exclude flag
   - include/exclude reason
   - current offset
   - last seen timestamp
4. Summary counters:
   - files discovered
   - files included
   - lines parsed
   - lines dropped (invalid JSON / filtered / duplicate)
   - notifications emitted by method bucket
5. Last error (if any) in discovery/poll loop.

Why this helps:

1. Explains "why no live updates" immediately.
2. Reduces debugging time for CLI vs mobile parity issues.
3. Enables lightweight health checks and QA verification.

### 2) Add discovery/poll loop metrics

Expose counters for:

1. discovery runs
2. poll runs
3. per-file parse errors
4. event mapping misses
5. replay buffer writes/drops

These can be returned by the status RPC and optionally logged to stderr in dev mode.

### 3) Add dedup + mapping diagnostics for dropped events

Track bounded recent reasons for dropped lines:

1. duplicate hash
2. unsupported rollout record type
3. missing thread id
4. originator filtered

This will clarify whether events are not emitted due to filtering or malformed source lines.

### 4) Add a short runbook for operators

When live updates are missing, check in this order:

1. `bridge/events/replay` contains recent `codex/event/*` or not.
2. `bridge/liveSync/status` include/exclude reason for newest rollout file.
3. newest rollout file `session_meta.originator` and resolved thread id fields.
4. mobile selected thread id matches emitted thread id.
