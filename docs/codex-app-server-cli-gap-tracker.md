# Codex App-Server + CLI Gap Tracker

Last updated: February 24, 2026

## Scope
This tracker compares `clawdex-mobile` against current Codex app-server + CLI capabilities and records what still needs to be added.

## Gap 1: App-Server Protocol Parity
Status: In progress (first implementation pass completed)

### Implemented in this pass
- Expanded rust-bridge forwarded app-server client methods to include newer slash/API endpoints.
- Added legacy approval request compatibility for `applyPatchApproval` and `execCommandApproval`.
- Added decision translation between modern and legacy approval response formats.
- Added explicit handling for `item/tool/call` server requests (returns structured unsupported result instead of generic method-not-found).
- Added explicit handling for `account/chatgptAuthTokens/refresh` server requests:
  - Uses `BRIDGE_CHATGPT_ACCESS_TOKEN` + `BRIDGE_CHATGPT_ACCOUNT_ID` when present.
  - Emits descriptive error when not configured.

### Forwarded methods added
- `account/login/cancel`
- `account/login/start`
- `account/logout`
- `account/rateLimits/read`
- `account/read`
- `collaborationMode/list`
- `config/batchWrite`
- `config/mcpServer/reload`
- `config/read`
- `config/value/write`
- `configRequirements/read`
- `experimentalFeature/list`
- `feedback/upload`
- `fuzzyFileSearch/sessionStart`
- `fuzzyFileSearch/sessionStop`
- `fuzzyFileSearch/sessionUpdate`
- `mcpServer/oauth/login`
- `mcpServerStatus/list`
- `mock/experimentalMethod`
- `skills/config/write`
- `skills/remote/export`
- `skills/remote/list`
- `thread/backgroundTerminals/clean`

### Remaining inside Gap 1
- Native execution of dynamic tool calls (`item/tool/call`) is still not implemented in mobile/bridge; currently returns `success: false`.
- Token refresh relies on environment variables; no mobile UI flow exists yet for account token refresh.

## Remaining Gaps (Beyond Gap 1)

### Gap 2: Slash Command Coverage in Mobile
- Many Codex CLI slash commands are not exposed as first-class actions in mobile UX.
- Mobile currently has partial command shortcuts and multiple unsupported command branches.

### Gap 3: Account/Auth UX
- No dedicated mobile flow for login state, logout, account details, or rate limits.
- Auth refresh is still operationally env-driven in bridge, not user-driven in app.

### Gap 4: MCP + Tooling UX
- No end-to-end UI for MCP server status, reload, OAuth login, or remote skills list/export.
- Dynamic tool calls do not execute on mobile yet.

### Gap 5: Collaboration/Plan Mode UX
- `collaborationMode/list` can now be forwarded, but there is no complete plan-mode UX in mobile.
- `request_user_input` has baseline support, but no richer structured workflows.

### Gap 6: Resilience + Reconnect
- WebSocket reconnect/backoff behavior is still limited on mobile.
- Slow/broken client recovery remains a known risk path.

### Gap 7: Security Hardening
- Bridge remains trusted-network oriented with optional no-auth local mode.
- High-risk endpoints (`bridge/terminal/exec`, `bridge/git/*`) need stronger authz controls for wider deployment.

### Gap 8: Contract/Regression Testing
- No automated contract sync against generated app-server schema.
- Missing CI guardrails to detect newly added app-server methods or server-request variants.

### Gap 9: Docs and Operator Runbooks
- Need user-facing docs for new app-server capabilities as they are surfaced in mobile.
- Need operational docs for auth/token refresh and MCP/OAuth troubleshooting.
