# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added
- Prompt library in the mobile composer: save reusable prompt templates and insert them into the chat input with one tap. Includes search, inline add/edit/delete, first-run example prompts, and local persistence. A bookmark button next to the attach control opens the library.
- Push notifications for turn completion and approval requests. Because the app's WebSocket closes when backgrounded, the always-on bridge is the sender: devices register an Expo push token (`bridge/push/register`/`unregister`/`list`) and the bridge POSTs a minimal, content-free payload to the Expo push service on `turn/completed` and approval requests. Auto-enabled — the app prompts for permission and registers on first bridge connect (no Settings trip); Settings → Notifications is the override (opt out + per-event switches). Banners are suppressed while foregrounded; backgrounded/killed apps receive the alert; tapping deep-links to the thread. Completed-turn notifications include a short preview of the agent's reply (last line, capped at 140 chars; a snippet of reply text therefore transits Expo/Apple when enabled). Approval notifications carry Approve/Deny action buttons that resolve the approval over the bridge WebSocket. See `docs/push-notifications.md`.

## 5.2.0 - 2026-05-18

### Added
- Cursor support alongside Codex and OpenCode.
- Bundled `cursor-app-server` in the published `clawdex-mobile` package.
- Bridge-driven mobile UI payload support for richer runtime details.

### Improved
- `clawdex init` now gives clearer Cursor API key setup guidance.
- Published-package setup now avoids source-checkout workspace assumptions.
- Bridge onboarding waits longer for first-start readiness.

### Fixed
- Cursor setup now fails visibly when the API key or app-server path is missing instead of falling through silently.

## 5.1.2 - 2026-04-07

### Added
- Local preview browser workflow with desktop and overview shells for mobile web inspection.
- App-wide font preference support in the mobile client.

### Improved
- Chat transcript tool-call UX now supports grouped tool-call inspection, per-call output expansion, and file-change labels that include changed filenames.
- Drawer, sheet, and chat header interactions feel smoother and more consistent across open/close, reconnect, and navigation flows.
- Composer and transcript responsiveness were tightened with lower rerender churn, more stable activity indicators, and cleaner compaction presentation.
- Browser preview controls, address handling, and preview session stability were refined for everyday use.
- Manual npm release runs can now build every packaged bridge target without publishing to npm.

### Fixed
- Bridge restart cleanup and maintenance behavior are more reliable during repeated local development cycles.
- Queued thread messages now use guaranteed-unique bridge queue item IDs during blocked-turn queuing.
- Bridge self-update now reports shutdown failures cleanly while still preserving status updates and `.env.secure` backup cleanup.
- Browser preview and mobile UI regressions caught during review and CI were resolved before release.

## 1.1.0 - 2026-02-23

### Added
- Full Git diff experience in mobile Git screen with unified diff parsing and per-file tabs.
- Diff summary with file count plus added/removed line totals.
- Per-file stage/unstage actions and bulk `Stage all` / `Unstage all` controls.
- Improved diff coverage for staged, unstaged, and untracked files in rust bridge.

### Improved
- File selection flow in diff viewer with loading feedback while switching files.
- Long file path display in Git screen now wraps onto multiple lines instead of truncating.

### Changed
- Commit behavior now commits staged changes only (no implicit `git add -A` before commit).
