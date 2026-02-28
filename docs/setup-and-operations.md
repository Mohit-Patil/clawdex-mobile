# Setup and Operations

This guide is the detailed companion to the top-level `README.md`.

## Onboarding Output Cues

After `clawdex init`, expected sequence:

1. Bridge health passes (`Bridge health check passed.`)
2. Expo starts (`Starting Expo (mobile) in background...`)
3. You may briefly see a spinner (`Waiting for Expo output - ...`)
4. Expo output begins (`expo start --host lan`, QR block, `Metro waiting on exp://...`)
5. Press Enter to detach onboarding while Expo + bridge keep running

## Manual Secure Setup (No Wizard)

### 1) Install dependencies

```bash
npm install
```

### 2) Generate secure runtime config

```bash
npm run secure:setup
```

Creates/updates:

- `.env.secure` (bridge runtime config + token)
- `apps/mobile/.env` (mobile token + optional runtime knobs)

### 3) Start bridge

```bash
npm run secure:bridge
```

### 4) Start Expo

```bash
npm run mobile
```

`npm run mobile` uses `scripts/start-expo.sh`, which sets `REACT_NATIVE_PACKAGER_HOSTNAME` from your secure config so QR resolution is predictable.

On first app launch, onboarding will ask for your bridge URL (for example `http://100.x.y.z:8787` or `http://192.168.x.y:8787`). This URL is stored on-device and can be changed later in Settings.

## Advanced Knobs

Optional environment variables:

- `CLAWDEX_SETUP_VERBOSE=true` — show full installer output
- `BRIDGE_HEALTH_WAIT_SECS=300` — max wait for bridge `/health`
- `EXPO_OUTPUT_WAIT_SECS=90` — spinner timeout before streaming Expo logs
- `EXPO_AUTO_REPAIR=true` — auto-repair React Native runtime on `npm run mobile`
- `EXPO_CLEAR_CACHE=true` — force `expo start --clear` via `npm run mobile`

## Teardown / Cleanup

```bash
npm run teardown
```

Can:

- stop Expo + bridge
- remove generated artifacts (`.env.secure`, `.bridge.log`, `.expo.log`, pid files)
- optionally reset `apps/mobile/.env` from `.env.example`
- optionally run `tailscale down`

Non-interactive mode:

```bash
npm run teardown -- --yes
```

## Environment Reference

### Bridge runtime (`.env.secure`, generated)

| Variable | Purpose |
|---|---|
| `BRIDGE_HOST` | bind host for rust bridge |
| `BRIDGE_PORT` | bridge port (default `8787`) |
| `BRIDGE_AUTH_TOKEN` | required auth token |
| `BRIDGE_ALLOW_QUERY_TOKEN_AUTH` | query-token auth fallback |
| `CODEX_CLI_BIN` | codex executable |
| `BRIDGE_WORKDIR` | absolute working directory for terminal/git |
| `BRIDGE_ALLOW_OUTSIDE_ROOT_CWD` | allow terminal/git `cwd` outside `BRIDGE_WORKDIR` |

### Mobile runtime (`apps/mobile/.env`, generated/updated)

| Variable | Purpose |
|---|---|
| `EXPO_PUBLIC_HOST_BRIDGE_TOKEN` | token sent by mobile client |
| `EXPO_PUBLIC_ALLOW_QUERY_TOKEN_AUTH` | web query-token behavior |
| `EXPO_PUBLIC_ALLOW_INSECURE_REMOTE_BRIDGE` | suppress insecure-HTTP warning |
| `EXPO_PUBLIC_PRIVACY_POLICY_URL` | in-app Privacy link |
| `EXPO_PUBLIC_TERMS_OF_SERVICE_URL` | in-app Terms link |

## Production Readiness Checklist

- Keep bridge network-private only (Tailscale/private LAN/VPN + host firewall)
- Require `BRIDGE_AUTH_TOKEN`
- Keep `BRIDGE_ALLOW_QUERY_TOKEN_AUTH=false` unless explicitly needed
- Do not set `BRIDGE_ALLOW_INSECURE_NO_AUTH=true` outside local debugging
- Scope `BRIDGE_WORKDIR` to minimal required root
- Use strict default approvals on mobile
- Treat `Session`/`Allow similar` approval actions as privileged
- Run bridge under a supervisor with restart policy
- Rotate bridge tokens periodically and on device loss
- Keep `codex`, Node deps, Expo SDK, and OS patches updated

## Verifying Setup

### Bridge health

```bash
source .env.secure
curl "http://$BRIDGE_HOST:$BRIDGE_PORT/health"
```

Expected response contains `"status":"ok"`.

### In-app smoke test

1. Open app and verify Settings reports bridge connected
2. Set `Start Directory` from sidebar (optional)
3. Create a chat and send a prompt
4. Switch to Plan mode and send prompt that triggers clarifying options
5. Verify clarification flow can submit
6. Open Git from header and verify status/diff/commit/push behavior
7. Test attachment menu (`+`) with workspace path + phone file/image
8. Run long task and verify stop button interrupts run and transcript logs stop

## Chat Controls (Workspace, Model, Mode, Approvals)

### Choosing Start Directory

1. Open sidebar
2. Under `Start Directory`, pick:
   - `Bridge default workspace`, or
   - a discovered workspace path from existing chats

Behavior:

- Applies to new chats
- Existing chats retain their own workspace unless changed

### Model and Slash Commands

Supported mobile slash commands:

- `/help`
- `/new`
- `/model [model-id]`
- `/plan [on|off|prompt]`
- `/status`
- `/rename <new-name>`
- `/compact`
- `/review`
- `/fork`
- `/diff`

### Plan Mode and Clarifications

- Plan mode is sent through `turn/start` via structured `collaborationMode`
- App can auto-switch to plan mode on plan events or when server requests it
- Structured clarifications open a dedicated modal
- Numbered plain-text options are rendered as tappable fallback choices

### Approval UX

Approval banner actions:

- `Deny`
- `Allow once`
- `Session`
- `Allow similar` (when available)

Approval events are surfaced via `bridge/approval.requested` and `bridge/approval.resolved`.

## NPM Release Automation

Workflow: `.github/workflows/npm-release.yml`

Required repo secret:

- `NPM_TOKEN`

Typical release flow (from `main`):

```bash
npm version patch
git push origin main --follow-tags
```

Automation verifies tag/version consistency and publishes to npm.

## API Summary (Rust Bridge)

### Endpoints

- `GET /health`
- `GET /rpc` (WebSocket JSON-RPC)

### Forwarded methods

- `thread/*`
- `turn/*` (includes `turn/interrupt`)
- `review/start`
- `model/list`
- `skills/list`
- `app/list`

### Bridge RPC methods

- `bridge/health/read`
- `bridge/terminal/exec`
- `bridge/attachments/upload`
- `bridge/voice/transcribe`
- `bridge/git/status`
- `bridge/git/diff`
- `bridge/git/commit`
- `bridge/git/push`
- `bridge/approvals/list`
- `bridge/approvals/resolve`
- `bridge/userInput/resolve`

### Notifications (examples)

- `turn/*`, `item/*`
- `bridge/approval.*`
- `bridge/userInput.*`
- `bridge/terminal/completed`
- `bridge/git/updated`
- `bridge/connection/state`
