#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"
ROOT_DIR="${INIT_CWD:-$(cd "$SCRIPT_DIR/.." && pwd -L)}"
if [[ ! -f "$ROOT_DIR/package.json" ]]; then
  ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -L)"
fi

SECURE_ENV_FILE="$ROOT_DIR/.env.secure"
BRIDGE_LOG_FILE="$ROOT_DIR/.bridge.log"
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
  pgrep -f "$pattern" 2>/dev/null || true
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
  stop_process_group "Rust bridge" "$ROOT_DIR/services/rust-bridge|codex-rust-bridge|@codex/rust-bridge"
  stop_process_group "Legacy TS bridge" "$ROOT_DIR/services/mac-bridge|@codex/mac-bridge"
else
  echo "Skipped process shutdown."
fi

print_step "Cleanup generated files"
if $auto_yes || confirm_prompt "Remove generated secure artifacts (.env.secure, .bridge.log)?"; then
  remove_if_exists "$SECURE_ENV_FILE"
  remove_if_exists "$BRIDGE_LOG_FILE"
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
  if $auto_yes || confirm_prompt "Bring Tailscale interface down on this Mac (tailscale down)?"; then
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
