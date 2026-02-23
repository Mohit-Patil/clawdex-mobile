# Changelog

All notable changes to this project are documented in this file.

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
