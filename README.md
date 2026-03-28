# Clawdex Mobile

<p align="center">
  <img src="https://raw.githubusercontent.com/Mohit-Patil/clawdex-mobile/main/screenshots/social/clawdex-social-poster-1200x675.png" alt="Clawdex social banner" width="100%" />
</p>

Run Codex, OpenCode, or T3 Code from your phone. `clawdex-mobile` ships the bridge CLI plus bundled Rust bridge binaries for supported hosts, and the mobile app pairs to that bridge over Tailscale or local LAN.

This project is for trusted/private networking only. Do not expose the bridge publicly.

## What You Get

- Mobile chat for Codex, OpenCode, and T3 Code
- Live run updates over WebSocket
- Approval and clarification flows in-app
- Voice-to-text, attachments, terminal, and Git actions
- One mobile shell backed by a private host bridge

## Quick Start

Before you start:

- Node.js 20+
- npm 10+
- `git`
- `codex` in `PATH` for the default Codex flow
- `opencode` in `PATH` if you want the OpenCode flow
- `t3` in `PATH` if you want the T3 Code flow

Install the mobile app:

- Android APK: <https://github.com/Mohit-Patil/clawdex-mobile/releases/latest>
- iOS: <https://apple.co/4rNAHRF>

Install the CLI and start the bridge:

```bash
npm install -g clawdex-mobile@latest
clawdex init
```

Then open the mobile app and scan the pairing QR.

During `clawdex init`, the wizard asks which runtimes Clawdex should manage locally:

- Codex via `codex`
- OpenCode via `opencode` when selected
- T3 Code via a managed local `t3` server when selected

The managed-runtime step uses checkbox-style choices. That checklist is the only runtime-selection UI. Only the runtimes you selected are validated and started, and the preferred engine is derived from the checked runtimes.

The npm package is bridge-only. It does not install Expo or the mobile source tree. On supported macOS, Linux, and Windows hosts it uses bundled bridge binaries, so normal startup does not compile Rust.
The current interactive setup helpers are still macOS/Linux-oriented.

Typical operator flow:

```bash
npm install -g clawdex-mobile@latest
clawdex init
clawdex stop
```

## OpenCode Setup

OpenCode is supported directly from the CLI now.

```bash
npm install -g opencode-ai
npm install -g clawdex-mobile@latest
clawdex init --engine opencode
```

That writes `BRIDGE_ACTIVE_ENGINE=opencode` to `.env.secure` and uses OpenCode as the preferred runtime when the bridge starts.

Notes:

- `clawdex init` without `--engine` still defaults to Codex.
- `clawdex init` now asks which runtimes Clawdex should manage locally. You can enable one or several.
- When multiple runtimes are checked, Clawdex keeps the existing preferred engine if it is still selected; otherwise it falls back to the first checked runtime.
- If both CLIs are installed, the bridge can surface chats from both engines in the mobile app.
- To switch later, rerun `clawdex init` and change the managed-runtime checkboxes, or rerun `clawdex init --engine codex` / `clawdex init --engine opencode` / `clawdex init --engine t3code` to bias the preferred engine before writing `.env.secure`.

## T3 Code Setup

T3 Code runs as a Clawdex-managed local `t3` server when you enable `t3code` in `clawdex init`.

```bash
clawdex init --engine t3code
```

The wizard will only require the T3 CLI if you actually select `t3code` as one of the managed runtimes.

Notes:

- `clawdex init --engine t3code` writes `BRIDGE_ACTIVE_ENGINE=t3code`.
- Enabling `t3code` also writes `BRIDGE_ENABLED_ENGINES=...` so only the selected runtimes are started.
- Clawdex does not attach to a separately running T3 desktop/server instance.
- To switch later, rerun `clawdex init --engine codex`, `clawdex init --engine opencode`, or `clawdex init --engine t3code`.

## Monorepo Development

If you are working from source:

```bash
npm install
npm run setup:wizard
npm run mobile
```

For an OpenCode-first repo checkout:

```bash
npm run setup:wizard -- --engine opencode
```

For a T3 Code-first repo checkout:

```bash
npm run setup:wizard -- --engine t3code
```

Use `npm run setup:wizard -- --no-start` if you only want to write config.

## Main Commands

- `clawdex init [--engine codex|opencode|t3code] [--no-start]`
- `clawdex stop`
- `clawdex upgrade` / `clawdex update`
- `clawdex version`
- `npm run setup:wizard`
- `npm run secure:bridge`
- `npm run mobile`
- `npm run ios`
- `npm run android`
- `npm run stop:services`
- `npm run teardown`

## Docs

- Setup + operations: <https://github.com/Mohit-Patil/clawdex-mobile/blob/main/docs/setup-and-operations.md>
- Troubleshooting: <https://github.com/Mohit-Patil/clawdex-mobile/blob/main/docs/troubleshooting.md>
- Realtime sync limits/mitigations: <https://github.com/Mohit-Patil/clawdex-mobile/blob/main/docs/realtime-streaming-limitations.md>
- Voice transcription internals: <https://github.com/Mohit-Patil/clawdex-mobile/blob/main/docs/voice-transcription.md>
- EAS builds: <https://github.com/Mohit-Patil/clawdex-mobile/blob/main/docs/eas-builds.md>
- Open-source/license notes: <https://github.com/Mohit-Patil/clawdex-mobile/blob/main/docs/open-source-license-requirements.md>
