#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"
ROOT_DIR="${INIT_CWD:-$(cd "$SCRIPT_DIR/.." && pwd -L)}"
if [[ ! -f "$ROOT_DIR/package.json" ]]; then
  ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -L)"
fi

BRIDGE_PID_FILE="$ROOT_DIR/.bridge.pid"
EXPO_PID_FILE="$ROOT_DIR/.expo.pid"
SECURE_ENV_FILE="$ROOT_DIR/.env.secure"

list_matching_pids() {
  local pattern="$1"
  ps -ax -o pid= -o command= 2>/dev/null | awk -v pattern="$pattern" '
    $0 ~ pattern { print $1 }
  ' || true
}

stop_pid_file_process() {
  local label="$1"
  local pid_file="$2"
  local pid=""

  if [[ ! -f "$pid_file" ]]; then
    return 1
  fi

  pid="$(tr -dc '0-9' <"$pid_file")"
  if [[ -z "$pid" ]]; then
    rm -f "$pid_file"
    return 1
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$pid_file"
    return 1
  fi

  echo "Stopping $label process from pid file: $pid"
  kill -INT "$pid" 2>/dev/null || true
  sleep 1

  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    sleep 1
  fi

  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
    echo "Force stopped $label process: $pid"
  else
    echo "$label stopped."
  fi

  rm -f "$pid_file"
  return 0
}

extract_env_value() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] || return 1

  awk -F= -v key="$key" '
    $1 == key {
      sub(/^[[:space:]]+/, "", $2)
      sub(/[[:space:]]+$/, "", $2)
      print $2
      exit
    }
  ' "$file"
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
stop_pid_file_process "Rust bridge" "$BRIDGE_PID_FILE" || true
stop_process_group "Rust bridge" "$ROOT_DIR/services/rust-bridge|codex-rust-bridge|@codex/rust-bridge"
stop_process_group "Legacy TS bridge" "$ROOT_DIR/services/mac-bridge|@codex/mac-bridge"

if [[ -f "$SECURE_ENV_FILE" ]]; then
  BRIDGE_ENABLED_ENGINES="$(extract_env_value "$SECURE_ENV_FILE" "BRIDGE_ENABLED_ENGINES" || true)"
  BRIDGE_ACTIVE_ENGINE="$(extract_env_value "$SECURE_ENV_FILE" "BRIDGE_ACTIVE_ENGINE" || true)"
  BRIDGE_OPENCODE_PORT="$(extract_env_value "$SECURE_ENV_FILE" "BRIDGE_OPENCODE_PORT" || true)"
  BRIDGE_OPENCODE_PORT="${BRIDGE_OPENCODE_PORT:-4090}"
  if [[ ",$BRIDGE_ENABLED_ENGINES,$BRIDGE_ACTIVE_ENGINE," == *",opencode,"* ]]; then
    stop_process_group "OpenCode server" "opencode serve --hostname .* --port $BRIDGE_OPENCODE_PORT|\\.opencode serve --hostname .* --port $BRIDGE_OPENCODE_PORT"
  fi
fi

rm -f "$BRIDGE_PID_FILE" "$EXPO_PID_FILE"
echo "Done."
