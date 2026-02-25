#!/usr/bin/env bash
set -euo pipefail

# Demo launcher for a patched Codex TUI build that live-syncs rollout updates.
# It replaces the old tmux restart workaround.

DEFAULT_CODEX_SRC="/tmp/openai-codex-latest/codex-rs"
CODEX_SRC="${CODEX_SRC:-$DEFAULT_CODEX_SRC}"
PATCHED_APP_RS="${PATCHED_APP_RS:-$CODEX_SRC/tui/src/app.rs}"
PATCHED_TUI_BIN="${PATCHED_TUI_BIN:-$CODEX_SRC/target/debug/codex-tui}"

usage() {
  cat <<'EOF'
Usage:
  scripts/codex-live-demo.sh [codex-tui args...]

Environment overrides:
  CODEX_SRC                  (default: /tmp/openai-codex-latest/codex-rs)
  PATCHED_APP_RS             (default: $CODEX_SRC/tui/src/app.rs)
  PATCHED_TUI_BIN            (default: $CODEX_SRC/target/debug/codex-tui)

Notes:
  - This starts the patched TUI binary directly.
  - Bridge/app-server can continue using stock codex:
      CODEX_CLI_BIN=/opt/homebrew/bin/codex
  - If PATCHED_TUI_BIN is missing, the script will build it via:
      cargo test -p codex-tui
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required" >&2
  exit 1
fi

if [[ ! -f "$PATCHED_APP_RS" ]]; then
  echo "patched source file not found: $PATCHED_APP_RS" >&2
  echo "set CODEX_SRC or PATCHED_APP_RS to your patched codex-rs checkout" >&2
  exit 1
fi

if ! command -v rg >/dev/null 2>&1 || ! rg -q 'ROLLOUT_LIVE_SYNC_INTERVAL' "$PATCHED_APP_RS"; then
  echo "warning: patch marker not found in $PATCHED_APP_RS" >&2
  echo "continuing anyway; verify your checkout includes rollout live sync changes" >&2
fi

if [[ ! -x "$PATCHED_TUI_BIN" ]]; then
  echo "building patched codex-tui at: $CODEX_SRC"
  (cd "$CODEX_SRC" && cargo test -p codex-tui >/dev/null)
fi

if [[ ! -x "$PATCHED_TUI_BIN" ]]; then
  echo "patched codex-tui binary not found after build: $PATCHED_TUI_BIN" >&2
  exit 1
fi

echo "launching patched Codex TUI:"
echo "  $PATCHED_TUI_BIN $*"
echo
echo "for bridge/app-server, keep stock codex binary configured:"
echo "  CODEX_CLI_BIN=/opt/homebrew/bin/codex"
echo

exec "$PATCHED_TUI_BIN" "$@"
