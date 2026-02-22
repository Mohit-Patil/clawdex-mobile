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
