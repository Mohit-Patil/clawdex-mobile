# Contributing to Clawdex Mobile

Thanks for contributing.

## Before You Start

- Read [README.md](README.md) for the product and operator flow.
- Use [docs/setup-and-operations.md](docs/setup-and-operations.md) for setup and smoke-test steps.
- Use [docs/troubleshooting.md](docs/troubleshooting.md) before opening a bug for setup or local environment issues.

## Project Shape

Primary paths:

- `apps/mobile`: Expo React Native client
- `services/rust-bridge`: active backend bridge
- `bin/clawdex.js` and `scripts/*`: CLI and local automation

Reference/legacy path:

- `services/mac-bridge`: older TypeScript bridge, useful as reference but not the primary runtime

## Development Setup

From repo root:

```bash
npm install
npm run setup:wizard
npm run mobile
```

Useful commands:

```bash
npm run ios
npm run android
npm run secure:bridge
npm run lint
npm run typecheck
npm run test
```

## Contribution Guidelines

- Keep changes scoped to the problem being solved.
- Prefer edits in active source paths under `apps/mobile/src` and `services/rust-bridge/src`.
- Do not edit generated or vendored paths such as `node_modules`, `.expo`, or `Pods`.
- Do not expose the bridge publicly. This project is designed for trusted/private networks only.
- If you change bridge contracts, update the corresponding mobile client types and docs.
- If you change setup, runtime, or release flow behavior, update the relevant files in `docs/`.

## Pull Requests

Please:

- describe the user-facing problem
- explain the approach and tradeoffs
- call out any security or operational impact
- include screenshots or recordings for UI changes when helpful
- list the validation you ran

Before opening a PR, run the relevant checks:

```bash
npm run lint
npm run typecheck
npm run test
```

If your change only touches one area, run the focused checks for that workspace too.

## Issues

When filing a bug, include:

- what you expected
- what happened instead
- reproduction steps
- platform and environment details
- logs, screenshots, or screen recordings when relevant

## Security Reports

Do not open public issues for sensitive security problems.
Use [SECURITY.md](SECURITY.md) for reporting guidance.
