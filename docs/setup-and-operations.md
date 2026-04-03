# Setup and Operations

This guide is the detailed companion to the top-level `README.md`.

## Choosing Harnesses

The setup wizard now lets you choose which harnesses the phone should control.

If you want both Codex and OpenCode:

```bash
clawdex init --engines codex,opencode
```

From a source checkout, the equivalent command is:

```bash
npm run setup:wizard -- --engines codex,opencode
```

That writes `BRIDGE_ENABLED_ENGINES=codex,opencode` into `.env.secure`, so the bridge starts both backends and the mobile app can control both from one UI.

If you want only one harness, use `--engine codex` or `--engine opencode`.

## Onboarding Output Cues

After `clawdex init`, expected sequence:

1. Secure config is written or reused
2. The bridge starts in the background
3. The wizard prints the bridge URL, token, and pairing QR for mobile onboarding
4. Bridge logs are written to `.bridge.log`

Published npm releases bundle prebuilt bridge binaries for `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `linux-armv7l`, and `win32-x64`. On those hosts, normal bridge startup does not require a Rust compile.

`clawdex init` does not run a project-local `npm install` for the published CLI path. The only required npm install there is `npm install -g clawdex-mobile@latest`.

Published CLI installs are bridge-only. They do not include the Expo workspace or mobile app source files.

## Manual Secure Setup (No Wizard)

### 1) Install dependencies

```bash
npm install
```

### 2) Generate secure runtime config

```bash
npm run secure:setup
```

To generate OpenCode-first config instead:

```bash
BRIDGE_ENABLED_ENGINES=codex,opencode npm run secure:setup
```

Creates/updates:

- `.env.secure` (bridge runtime config + token)
- `apps/mobile/.env` (repo checkout only, for local mobile dev builds)

### 3) Start bridge

```bash
npm run secure:bridge
```

If you want a one-off OpenCode launch without rewriting `.env.secure`:

```bash
BRIDGE_ENABLED_ENGINES=codex,opencode npm run secure:bridge
```

When both CLIs are selected, the bridge starts both backends and merges chat lists while still routing each thread by engine.

### 4) Pair from the mobile app

Open the installed mobile app on your phone, then scan the bridge QR. If needed, enter the bridge URL manually (for example `http://100.x.y.z:8787` or `http://192.168.x.y:8787`). The chosen bridge URL is stored on-device and can be changed later in Settings.

### In-app Bridge Maintenance

For secure-launcher installs, the mobile Settings screen can trigger bridge maintenance safely.

- Open `Settings > Bridge Maintenance`
- Tap `Restart bridge safely` to stop the current bridge and relaunch it through `scripts/start-bridge-secure.js`
- The app will disconnect briefly while the detached helper waits for bridge health to recover

Published `clawdex-mobile` CLI installs also expose `Update bridge`.

- `Update bridge` stops the current bridge, runs `npm install -g clawdex-mobile@latest`, and starts the bridge again
- If the upgrade step fails, the helper attempts to restart the previous bridge automatically

Source checkouts expose only the restart action because repo-specific update logic is not safe to automate generically from mobile.

## Local Mobile Development Only

If you are developing the mobile app from this repo, start Expo separately:

```bash
npm run mobile
```

`npm run mobile` uses `scripts/start-expo.sh`, which sets `REACT_NATIVE_PACKAGER_HOSTNAME` from your secure config so QR resolution is predictable.

## Advanced Knobs

Optional environment variables:

- `CLAWDEX_SETUP_VERBOSE=true` — show full installer output
- `CLAWDEX_BRIDGE_FORCE_SOURCE_BUILD=true` — ignore a bundled bridge binary and build from local Rust sources instead
- `EXPO_AUTO_REPAIR=true` — auto-repair React Native runtime on `npm run mobile`
- `EXPO_CLEAR_CACHE=true` — force `expo start --clear` via `npm run mobile`

## Local Browser Preview

The mobile app includes a `Browser` screen that can open loopback-only web apps from the bridge
machine inside the app itself.

Typical examples:

- `localhost:3000`
- `127.0.0.1:5173`
- `3000`

How it works:

- The app creates a short-lived preview session through the bridge RPC API
- The bridge serves a dedicated preview origin on a separate port
- HTTP requests, subresources, cookies, and WebSocket/HMR traffic are proxied from the phone to
  the bridge host's loopback target
- Browser runtime calls to other loopback origins on the host are also rewritten through the
  preview origin for `fetch`, XHR, `EventSource`, `WebSocket`, and form submissions

Current scope:

- Supports `http://` and `https://` loopback targets only
- Intended for local web dev servers such as Next.js, Vite, CRA, or simple static servers
- Separate local frontend/backend ports can work together inside the preview as long as the app
  reaches the backend through normal browser APIs or form posts
- Hard-coded absolute localhost asset URLs outside those browser APIs may still need a same-origin
  dev proxy in the app itself
- Does not preview native React Native simulator/device UI directly

For a concise list of supported cases and known limitations, see
`docs/browser-preview-limitations.md`.

## Teardown / Cleanup

```bash
npm run teardown
```

Can:

- stop the bridge
- also stop local Expo if you started it from this repo
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
| `BRIDGE_PREVIEW_PORT` | browser preview port for proxied localhost web apps (default `BRIDGE_PORT + 1`) |
| `BRIDGE_AUTH_TOKEN` | required auth token |
| `BRIDGE_ALLOW_QUERY_TOKEN_AUTH` | query-token auth fallback |
| `CODEX_CLI_BIN` | codex executable |
| `BRIDGE_ACTIVE_ENGINE` | internal preferred routing backend used when multiple harnesses are enabled |
| `BRIDGE_ENABLED_ENGINES` | selected harnesses to expose (`codex`, `opencode`, or both) |
| `OPENCODE_CLI_BIN` | opencode executable for dual-engine startup |
| `BRIDGE_OPENCODE_HOST` | loopback host for spawned opencode server |
| `BRIDGE_OPENCODE_PORT` | loopback port for spawned opencode server |
| `BRIDGE_OPENCODE_SERVER_USERNAME` | basic-auth username passed to opencode server |
| `BRIDGE_OPENCODE_SERVER_PASSWORD` | basic-auth password passed to opencode server |
| `BRIDGE_WORKDIR` | absolute working directory for terminal/git |
| `BRIDGE_ALLOW_OUTSIDE_ROOT_CWD` | allow terminal/git `cwd` outside `BRIDGE_WORKDIR` |

### Mobile runtime (`apps/mobile/.env`, generated/updated)

| Variable | Purpose |
|---|---|
| `EXPO_PUBLIC_HOST_BRIDGE_TOKEN` | token used by local mobile dev builds |
| `EXPO_PUBLIC_ALLOW_QUERY_TOKEN_AUTH` | query-token behavior for WebSocket auth fallback |
| `EXPO_PUBLIC_ALLOW_INSECURE_REMOTE_BRIDGE` | suppress insecure-HTTP warning |
| `EXPO_PUBLIC_PRIVACY_POLICY_URL` | in-app Privacy link |
| `EXPO_PUBLIC_TERMS_OF_SERVICE_URL` | in-app Terms link |
| `EXPO_PUBLIC_REVENUECAT_IOS_API_KEY` | RevenueCat public SDK key for iOS tip purchases |
| `EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY` | RevenueCat public SDK key for Android tip purchases |
| `EXPO_PUBLIC_REVENUECAT_TEST_STORE_API_KEY` | RevenueCat Test Store public SDK key for Expo Go / Store Client tip testing |
| `EXPO_PUBLIC_REVENUECAT_TIPS_OFFERING_ID` | optional RevenueCat offering identifier for the tip jar (`current` if omitted) |

If you enable the optional tip jar:

- Configure 4–5 non-subscription products in RevenueCat and attach them to a dedicated Offering
- Use consumables for repeatable “tip” tiers
- Enable In-App Purchase for the app’s Apple bundle identifier in App Store Connect / Apple Developer
- Use the RevenueCat Test Store SDK key in Expo Go; use the real iOS SDK key only in native builds/TestFlight/App Store builds
- Rebuild the native app after adding `react-native-purchases`

## Production Readiness Checklist

- Keep bridge network-private only (Tailscale/private LAN/VPN + host firewall)
- Require `BRIDGE_AUTH_TOKEN`
- Keep `BRIDGE_ALLOW_QUERY_TOKEN_AUTH=true` only on private networks (required for Android WS auth fallback)
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
9. Open `Browser`, enter `localhost:3000` or another active loopback dev port, and verify the page loads inside the app

## Chat Controls (Workspace, Model, Mode, Approvals)

### Choosing Start Directory

1. Open sidebar
2. Under `Start Directory`, pick either:
   - `Bridge default workspace`
   - a discovered workspace path from existing Codex chats
   - any folder on the bridge host via the built-in folder browser or manual path entry

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
