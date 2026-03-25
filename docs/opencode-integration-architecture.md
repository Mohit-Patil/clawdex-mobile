# Opencode Integration Architecture

Date: March 24, 2026

## Current Status

The bridge now supports a dual-engine runtime in one process:

- Codex remains the default/preferred engine.
- `opencode` can run alongside Codex when the binary is available.
- `thread/list` and `thread/loaded/list` are merged across both engines.
- per-thread operations stay routed by engine-qualified ids such as `codex:thr_123` and `opencode:ses_456`.

Implemented in this slice:

- `opencode serve` bootstrap from the Rust bridge
- health probe against `/global/health`
- global SSE subscription to `/global/event`
- minimal RPC translation for:
  - `thread/list`
  - `thread/loaded/list`
  - `thread/read`
  - `thread/start`
  - `thread/name/set`
  - `thread/fork`
  - `thread/resume` as a no-op compatibility response
  - `turn/start`
  - `turn/interrupt`
  - `model/list` as an empty compatibility response
- bridge-native normalization for:
  - engine-qualified thread ids
  - `session.status` -> `thread/status/changed` and `turn/*`
  - `message.part.delta` -> `item/agentMessage/delta` and `item/reasoning/textDelta`
  - `permission.*` and `question.*` -> existing `bridge/*` approval/user-input events
- dual-engine aggregation for:
  - `thread/list`
  - `thread/loaded/list`
  - bridge-global approvals across both backends

Not implemented yet:

- `review/start`
- `turn/steer`
- command-output delta parity
- full tool/item projection parity with Codex

Current limitation:

- `bridge/capabilities/read` is bridge-global. `supports.*` still reflects the preferred engine, not per-chat capabilities.

## Goal

Add support for `opencode` without breaking the current Codex mobile flow.

The integration must preserve these current invariants:

1. Mobile still talks to one bridge websocket at `/rpc`.
2. Mobile still consumes the existing bridge notification contract.
3. The Rust bridge remains the single live event authority for reconnect, replay, approvals, and user input.
4. The current Codex app-server path remains the default and must continue to work unchanged.

## Current Clawdex Constraints

The current app is tightly coupled to one normalized bridge protocol:

- `apps/mobile/App.tsx` constructs one `HostBridgeWsClient` and one `HostBridgeApiClient`.
- `apps/mobile/src/api/ws.ts` expects replayable notifications with `eventId`.
- `apps/mobile/src/api/client.ts` expects app-server-like methods such as `thread/list`, `thread/read`, `thread/start`, `turn/start`, `turn/interrupt`, `model/list`, `review/start`, and bridge-native methods for approvals, git, terminal, attachments, and voice.
- `apps/mobile/src/screens/MainScreen.tsx` and `apps/mobile/src/navigation/DrawerContent.tsx` consume the existing `thread/*`, `turn/*`, `item/*`, `bridge/*`, and `codex/event/*` vocabulary.

Because of this, the lowest-risk path is to preserve the mobile contract and add `opencode` behind the bridge.

## Unified UI Direction

A unified chat list for Codex and `opencode` is the right product direction.

However, "merged UI" should mean:

1. one drawer/chat browser that can show conversations from both engines
2. one chat screen component that can render normalized conversations from either engine
3. a visible engine indicator so the user knows which runtime owns the conversation

It should not mean:

1. mobile receives raw engine-specific event vocabularies
2. chat identity is still keyed only by raw thread or session id
3. messages from different engines are interleaved into one shared conversation timeline

The current app assumes chat identity is globally keyed by `chat.id` in many places:

- drawer dedupe
- selection state
- runtime snapshot caches
- thread tree parent-child relations
- pending approval and user-input caches

Therefore, if both engines are shown in one UI, the bridge must provide engine-qualified identities.

Recommended shape:

- outward `chat.id`: stable bridge id such as `codex:thr_123` or `opencode:ses_456`
- new chat metadata field: `engine: "codex" | "opencode"`
- optional raw id field for bridge-internal use only

This keeps the mobile app simple while preventing collisions and wrong-engine routing.

## Opencode Runtime Model

`opencode` already exposes a reusable headless server. The TUI is a client of that server, not the only runtime.

Relevant upstream surfaces:

- `opencode serve` launches an HTTP server.
- `GET /global/event` exposes a cross-instance SSE stream.
- `GET /event` exposes an instance-scoped SSE stream.
- `POST /session`, `GET /session`, `GET /session/:id`, `PATCH /session/:id`, `POST /session/:id/fork`, `POST /session/:id/abort`, `GET /session/:id/message`, `POST /session/:id/prompt_async`, `POST /session/:id/summarize`, and related routes expose the control plane.
- `GET /permission`, `POST /permission/:requestID/reply`, `GET /question`, `POST /question/:requestID/reply`, and `POST /question/:requestID/reject` expose approval and question handling.

The server is directory-aware through `x-opencode-directory` and workspace-aware through `x-opencode-workspace`.

## How Opencode Emits Events

`opencode` uses typed in-process events defined with `BusEvent.define(...)`.

Publishing flow:

1. Runtime code publishes typed events to the instance-local `Bus`.
2. `Bus.publish(...)` fans out to local subscribers.
3. The same event is mirrored onto `GlobalBus` as `{ directory, payload }`.
4. SSE routes expose the bus externally.

Important consequence:

- The event system is already externalizable.
- We do not need to scrape the TUI.
- We should consume the supported HTTP + SSE boundary.

Important event families:

- Session lifecycle:
  - `session.created`
  - `session.updated`
  - `session.deleted`
  - `session.diff`
  - `session.error`
  - `session.status`
- Message lifecycle:
  - `message.updated`
  - `message.removed`
  - `message.part.updated`
  - `message.part.delta`
  - `message.part.removed`
- Human-in-the-loop:
  - `permission.asked`
  - `permission.replied`
  - `question.asked`
  - `question.replied`
  - `question.rejected`
- Connection/meta:
  - `server.connected`
  - `server.heartbeat`
  - `server.instance.disposed`

Important streaming detail:

- `POST /session/:id/message` is not the live delta stream. It returns once the prompt finishes.
- Live UI updates come from SSE plus state reads.
- `POST /session/:id/prompt_async` is the safer write path for bridge-driven streaming.

## Key Mismatch With Clawdex

`opencode` is native `session/message/part`.

Clawdex mobile is native `thread/turn/item`.

That means the bridge must normalize and project `opencode` state into the current mobile model.

This should not be pushed into:

- `MainScreen.tsx`
- `DrawerContent.tsx`
- `HostBridgeWsClient`
- `HostBridgeApiClient`

Those layers should remain unaware of raw `opencode` event names.

They can, however, safely become aware of normalized engine metadata for presentation.

## Recommended Bridge Architecture

Add an engine abstraction inside `services/rust-bridge`.

### 1. Engine Factory

Introduce a bridge-internal backend registry with a preferred/default runtime:

- `CodexAppServerAdapter`
- `OpencodeAdapter`

The Codex adapter should wrap the current stdio app-server path unchanged. When both backends are available, the bridge should aggregate only list-style methods and keep all per-thread methods routed by engine-qualified id.

### 2. Engine Method Adapter

Expose the same outward bridge/app-server-compatible RPC surface to mobile, but translate internally.

For a unified UI, every outward thread identifier must already be engine-qualified before it reaches mobile. The bridge is responsible for:

1. decoding composite ids on inbound requests
2. routing the request to the correct engine adapter
3. re-encoding all returned ids and parent ids

For `opencode`, map current outward methods approximately as follows:

- `thread/list` -> `GET /session`
- `thread/read` -> `GET /session/:id` + `GET /session/:id/message`
- `thread/start` -> `POST /session`
- `thread/name/set` -> `PATCH /session/:id`
- `thread/fork` -> `POST /session/:id/fork`
- `thread/compact/start` -> `POST /session/:id/summarize`
- `turn/start` -> `POST /session/:id/prompt_async`
- `turn/interrupt` -> `POST /session/:id/abort`
- `bridge/approvals/list` -> `GET /permission`
- `bridge/approvals/resolve` -> `POST /permission/:requestID/reply`
- `bridge/userInput/resolve` -> `POST /question/:requestID/reply` or `POST /question/:requestID/reject`

Methods without clean parity should remain Codex-only behind capabilities:

- `review/start`
- `turn/steer`
- Codex-specific approval policy semantics

### 3. Engine Event Normalizer

Subscribe once to `GET /global/event`.

Normalize `opencode` payloads into the existing bridge notification vocabulary before sending to mobile.

Recommended mappings:

- `session.created` -> `thread/started`
- `session.updated` -> `thread/name/updated` or thread metadata refresh event
- `session.status` -> `thread/status/changed`
- `message.part.delta` for text parts -> `item/agentMessage/delta`
- `message.part.delta` for reasoning parts -> `item/reasoning/textDelta`
- tool part `pending` / `running` -> `item/started`
- tool part `completed` / `error` -> `item/completed`
- `permission.asked` -> `bridge/approval.requested`
- `permission.replied` -> `bridge/approval.resolved`
- `question.asked` -> `bridge/userInput.requested`
- `question.replied` / `question.rejected` -> `bridge/userInput.resolved`
- `session.status` to `idle` after an active turn -> synthetic `turn/completed`

### 4. Thread Projection Store

Build and maintain a bridge-local projection from:

- session info
- session status
- messages
- parts
- pending permissions
- pending questions

This projection should materialize the app-server-like thread shape expected by existing mobile mapping code.

That allows `chatMapping.ts` and current `thread/read` consumers to remain stable.

For unified Codex + `opencode` browsing, the projection store should additionally:

1. stamp every projected chat with normalized `engine` metadata
2. encode `id` and `parentThreadId` using bridge-qualified ids
3. ensure cross-thread tree logic only links parent-child threads within the same engine namespace

## Replay Strategy

`opencode` SSE does not provide replay IDs or resume cursors.

Therefore:

1. The Rust bridge must remain the replay authority.
2. The bridge should continue assigning its own `eventId`.
3. The existing `bridge/events/replay` path should be reused unchanged.

This is one of the main reasons the mobile app should not connect to `opencode` directly.

## Capabilities And Safe Rollout

Add a bridge capability read method so the mobile app can hide unsupported runtime features instead of failing at call time.

Recommended response shape:

- active engine id
- available engines
- supported write methods
- supported live telemetry families
- review support
- steering support
- command-output delta support

If unified browsing is enabled, capabilities should also declare whether cross-engine listing is available.

Initial `opencode` capability caveats:

- command output delta parity may be weaker than current Codex telemetry
- review is not a first-class HTTP route
- Codex-specific resume/steer semantics do not map 1:1

## Phased Implementation Plan

### Phase 1

Introduce bridge-internal abstractions only:

- engine factory
- engine trait
- capability endpoint
- engine-qualified thread id helpers
- no behavior change for current Codex path

### Phase 2

Implement `OpencodeAdapter` bootstrap:

- spawn `opencode serve`
- health check
- subscribe to `/global/event`
- basic session listing and thread projection
- projected engine metadata for unified UI badges

### Phase 3

Implement safe write flows:

- create thread
- read thread
- start turn via `prompt_async`
- interrupt turn
- rename thread
- fork
- summarize
- permissions/questions

### Phase 4

Close parity gaps selectively:

- review shim if acceptable
- richer tool progress mapping
- better subagent and turn synthesis

## No-Regression Rules

1. Do not change mobile raw event handling to understand `opencode` names.
2. Do not remove the current Codex app-server adapter while adding `opencode`.
3. Do not change websocket replay semantics.
4. Keep bridge-native terminal, git, voice, attachment, and local-image flows unchanged.
5. Guard non-parity features behind capabilities instead of partial emulation.
6. Do not use raw engine-local ids directly in mobile once unified browsing is enabled.
7. Do not allow parent-child thread linkage across engines unless explicitly normalized by the bridge.

## Recommended First Code Change

The first implementation step should be Rust-only:

1. extract the current app-server integration behind an engine trait
2. add `bridge/capabilities/read`
3. keep the current Codex flow as the default adapter
4. add tests proving the Codex path is unchanged

That creates the safe seam needed for `opencode` without risking existing functionality.
