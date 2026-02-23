#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"
ROOT_DIR="${INIT_CWD:-$(cd "$SCRIPT_DIR/.." && pwd -L)}"
if [[ ! -f "$ROOT_DIR/package.json" ]]; then
  ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -L)"
fi

BRIDGE_PID_FILE="$ROOT_DIR/.bridge.pid"
EXPO_PID_FILE="$ROOT_DIR/.expo.pid"

list_matching_pids() {
  local pattern="$1"
  pgrep -f "$pattern" 2>/dev/null || true
}

stop_process_group() {
  local label="$1"
  local pattern="$2"
  local pids=""
  local remaining=""
  local pid=""

  pids="$(list_matching_pids "$pattern")"
  if [[ -z "$pids" ]]; then
    echo "No $label process found."
    return 0
  fi

  echo "Stopping $label processes: $pids"
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    kill -TERM "$pid" 2>/dev/null || true
  done <<<"$pids"

  sleep 1

  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    if kill -0 "$pid" 2>/dev/null; then
      remaining+="$pid "
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done <<<"$pids"

  if [[ -n "${remaining// }" ]]; then
    echo "Force stopped $label processes: $remaining"
  else
    echo "$label stopped."
  fi
}

echo "Stopping Clawdex services for project: $ROOT_DIR"

stop_process_group "Expo" "$ROOT_DIR/.*/expo start|$ROOT_DIR/node_modules/.bin/expo start"
stop_process_group "Rust bridge" "$ROOT_DIR/services/rust-bridge|codex-rust-bridge|@codex/rust-bridge"
stop_process_group "Legacy TS bridge" "$ROOT_DIR/services/mac-bridge|@codex/mac-bridge"

rm -f "$BRIDGE_PID_FILE" "$EXPO_PID_FILE"
echo "Done."
