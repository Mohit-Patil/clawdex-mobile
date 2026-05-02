# @clawdex/cursor-app-server

App-server shaped JSON-RPC adapter for Cursor agents.

This package is intentionally strict. It does not fall back to Codex, OpenCode,
mock agents, empty model lists, or implicit workspace directories. Missing
Cursor runtime configuration is surfaced as an error.

## Contract

Supported JSON-RPC methods:

- `thread/list`
- `thread/loaded/list`
- `thread/read`
- `thread/start`
- `turn/start`
- `turn/interrupt`
- `model/list`

Emitted notifications:

- `thread/started`
- `thread/status/changed`
- `turn/started`
- `item/agentMessage/delta`
- `item/reasoning/textDelta`
- `item/started`
- `turn/completed`

## Run

```bash
CURSOR_WORKDIR="$PWD" CURSOR_MODEL="cursor-small" CURSOR_API_KEY="..." cursor-app-server
```

`CURSOR_WORKDIR` is required for local agents. `CURSOR_MODEL` is required unless
a request provides an explicit model. `CURSOR_API_KEY` is required for Cursor SDK
operations and model listing.
