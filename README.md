# Clawdex Mobile

<p align="center">
  <img src="https://raw.githubusercontent.com/Mohit-Patil/clawdex-mobile/main/screenshots/social/clawdex-social-poster-1200x675.png" alt="Clawdex social banner" width="100%" />
</p>

Run Codex or OpenCode from your phone. `clawdex-mobile` ships the bridge CLI plus bundled Rust bridge binaries for supported hosts, and the mobile app pairs to that bridge over Tailscale, local LAN, or GitHub Codespaces forwarded HTTPS URLs.

This project is for trusted/private networking by default. GitHub Codespaces is supported as an internet-reachable exception: keep bridge auth enabled, use only repos you trust, and remember forwarded public ports reset to private when a codespace restarts.

## What You Get

- Mobile chat for Codex and OpenCode
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

Install the mobile app:

- Android APK: <https://github.com/Mohit-Patil/clawdex-mobile/releases/latest>
- iOS: <https://apple.co/4rNAHRF>

Install the CLI and start the bridge:

```bash
npm install -g clawdex-mobile@latest
clawdex init
```

Then open the mobile app and connect using the printed bridge URL/token or pairing QR.
`clawdex init` now writes config, starts the bridge in the background, and returns you to the shell. Bridge logs go to `.bridge.log`.

The npm package is bridge-only. It does not install Expo or the mobile source tree. On supported macOS, Linux, and Windows hosts it uses bundled bridge binaries, so normal startup does not compile Rust.
The current interactive setup helpers are still macOS/Linux-oriented.

Typical operator flow:

```bash
npm install -g clawdex-mobile@latest
clawdex init
clawdex stop
```

## GitHub Codespaces

You can run the bridge inside a GitHub Codespace instead of keeping a laptop or server online.

From a repo checkout inside Codespaces:

```bash
npm run setup:wizard
```

Pick `GitHub Codespaces` as the network mode. The setup flow writes forwarded HTTPS bridge URLs into `.env.secure`, and bridge startup will try to mark both bridge ports public automatically.

Notes:

- The mobile app should pair to the printed `https://<codespace>-8787.app.github.dev` URL, not `127.0.0.1`.
- Browser preview uses a second forwarded port (`8788` by default), so both ports need public visibility.
- GitHub resets public forwarded ports back to private when a codespace restarts. Restarting the bridge reruns the visibility step.
- If automatic visibility setup fails, run `gh codespace ports visibility 8787:public 8788:public`.
- If the mobile app is built with `EXPO_PUBLIC_GITHUB_APP_CLIENT_ID`, `EXPO_PUBLIC_GITHUB_APP_SLUG`, and `EXPO_PUBLIC_GITHUB_APP_AUTH_BASE_URL`, users can now tap `Use GitHub Codespaces` in onboarding/settings, complete one in-app GitHub App install/auth flow, pick a Codespace, and connect without manually copying the bridge token.
- The tiny auth backend for that flow lives in `services/github-app-auth-worker`. Point the GitHub App callback URL at `https://<your-domain>/github/callback` and enable `Request user authorization (OAuth) during installation`.
- The app can also create a new repo-backed Codespace directly. It prefers `<signed-in-user>/<EXPO_PUBLIC_GITHUB_CODESPACES_REPO_NAME>` first. If that repo does not exist, it automatically forks `EXPO_PUBLIC_GITHUB_CODESPACES_SOURCE_OWNER/<EXPO_PUBLIC_GITHUB_CODESPACES_REPO_NAME>` into the signed-in user account, then creates the Codespace there.

This repo now also includes a Codespaces bootstrap flow. On Codespace start/resume, `.devcontainer/devcontainer.json` runs:

```bash
npm run codespaces:bootstrap
```

During initial Codespace creation, the devcontainer also runs:

```bash
npm run codespaces:bootstrap -- --prepare-only
```

That pre-installs Codex and prebuilds the Rust bridge binary so the later startup path is faster. The normal bootstrap command rewrites `.env.secure` for Codespaces with `codex` as the only enabled engine and starts the bridge in the background. You can rerun either command manually any time.

The published npm package now includes that bootstrap script too, so a minimal Codespaces template repo can install `clawdex-mobile@latest` in `postCreateCommand` and call the packaged bootstrap without vendoring bridge source into the template itself.

In Codespaces mode, the bootstrap also enables bridge-side GitHub bearer auth for the current `CODESPACE_NAME`, so the mobile app can authenticate with the same GitHub App user token it used to discover and start the Codespace.

## OpenCode Setup

OpenCode is supported directly from the CLI now.

```bash
npm install -g opencode-ai
npm install -g clawdex-mobile@latest
clawdex init --engines codex,opencode
```

That writes `BRIDGE_ENABLED_ENGINES=codex,opencode` to `.env.secure`, so the mobile app can control both harnesses from one bridge.

Notes:

- `clawdex init` without flags now lets you multi-select harnesses in the wizard with Space, then Enter to continue.
- Use `clawdex init --engine codex` or `clawdex init --engine opencode` if you want a single-harness setup.
- Use `clawdex init --engines codex,opencode` if you want both non-interactively.

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

Use `npm run setup:wizard -- --no-start` if you only want to write config.

## Main Commands

- `clawdex init [--engine codex|opencode] [--engines codex,opencode] [--no-start]`
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
