# Changelog

All notable changes to this project are documented in this file.

## 5.1.2 - 2026-04-07

### Added
- Local preview browser workflow with desktop and overview shells for mobile web inspection.
- App-wide font preference support in the mobile client.

### Improved
- Chat transcript tool-call UX now supports grouped tool-call inspection, per-call output expansion, and file-change labels that include changed filenames.
- Drawer, sheet, and chat header interactions feel smoother and more consistent across open/close, reconnect, and navigation flows.
- Composer and transcript responsiveness were tightened with lower rerender churn, more stable activity indicators, and cleaner compaction presentation.
- Browser preview controls, address handling, and preview session stability were refined for everyday use.

### Fixed
- Bridge restart cleanup and maintenance behavior are more reliable during repeated local development cycles.
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
