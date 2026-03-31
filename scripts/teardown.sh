#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"
ROOT_DIR="${INIT_CWD:-$(cd "$SCRIPT_DIR/.." && pwd -L)}"
if [[ ! -f "$ROOT_DIR/package.json" ]]; then
  ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -L)"
fi

SECURE_ENV_FILE="$ROOT_DIR/.env.secure"
BRIDGE_LOG_FILE="$ROOT_DIR/.bridge.log"
EXPO_LOG_FILE="$ROOT_DIR/.expo.log"
BRIDGE_PID_FILE="$ROOT_DIR/.bridge.pid"
EXPO_PID_FILE="$ROOT_DIR/.expo.pid"
MOBILE_ENV_FILE="$ROOT_DIR/apps/mobile/.env"
MOBILE_ENV_EXAMPLE="$ROOT_DIR/apps/mobile/.env.example"

confirm_prompt() {
  local prompt="$1"
  local answer

  if [[ ! -t 0 ]]; then
    return 1
  fi

  read -r -p "$prompt [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

print_step() {
  local step="$1"
  echo ""
  echo "==> $step"
}

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
  local pids

  pids="$(list_matching_pids "$pattern")"
  if [[ -z "$pids" ]]; then
    echo "No $label process found."
    return 0
  fi

  echo "Stopping $label processes: $pids"
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    kill -TERM "$pid" 2>/dev/null || true
  done <<< "$pids"

  sleep 1

  local remaining
  remaining=""
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    if kill -0 "$pid" 2>/dev/null; then
      remaining+="$pid "
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done <<< "$pids"

  if [[ -n "${remaining// }" ]]; then
    echo "Force stopped $label processes: $remaining"
  else
    echo "$label stopped."
  fi
}

remove_if_exists() {
  local file="$1"
  if [[ -f "$file" ]]; then
    rm -f "$file"
    echo "Removed: $file"
  else
    echo "Not found: $file"
  fi
}

print_step "Teardown"
echo "Project root: $ROOT_DIR"

auto_yes=false
if [[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]]; then
  auto_yes=true
fi

print_step "Stop running services"
if $auto_yes || confirm_prompt "Stop running bridge and Expo processes for this project?"; then
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
else
  echo "Skipped process shutdown."
fi

print_step "Cleanup generated files"
if $auto_yes || confirm_prompt "Remove generated secure artifacts (.env.secure, .bridge.log, .expo.log, pid files)?"; then
  remove_if_exists "$SECURE_ENV_FILE"
  remove_if_exists "$BRIDGE_LOG_FILE"
  remove_if_exists "$EXPO_LOG_FILE"
  remove_if_exists "$BRIDGE_PID_FILE"
  remove_if_exists "$EXPO_PID_FILE"
else
  echo "Skipped artifact cleanup."
fi

print_step "Mobile env"
if [[ -f "$MOBILE_ENV_FILE" ]] && ($auto_yes || confirm_prompt "Reset apps/mobile/.env back to .env.example values?"); then
  cp "$MOBILE_ENV_EXAMPLE" "$MOBILE_ENV_FILE"
  echo "Reset: $MOBILE_ENV_FILE"
else
  echo "Kept current mobile env."
fi

print_step "Tailscale"
if command -v tailscale >/dev/null 2>&1; then
  if $auto_yes || confirm_prompt "Bring Tailscale interface down on this host machine (tailscale down)?"; then
    tailscale down || true
    echo "Requested tailscale down."
  else
    echo "Kept Tailscale active."
  fi
else
  echo "tailscale CLI not found; skipping."
fi

echo ""
echo "Teardown complete."
