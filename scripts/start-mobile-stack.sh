#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"
ROOT_DIR="${INIT_CWD:-$(cd "$SCRIPT_DIR/.." && pwd -L)}"
if [[ ! -f "$ROOT_DIR/package.json" ]]; then
  ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -L)"
fi

SECURE_ENV_FILE="$ROOT_DIR/.env.secure"
NETWORK_MODE=""
EXPO_MODE="mobile"
SKIP_STOP="false"

info() { echo "info: $*"; }
fail() { echo "error: $*" >&2; }

usage() {
  cat <<'EOF'
Usage: ./scripts/start-mobile-stack.sh --network <tailscale|local> [options]

Starts the bridge and Expo in one flow for mobile development.

Options:
  --network <tailscale|local>  Required network mode for the bridge URL/Expo host.
  --expo <mobile|ios|android> Expo command to run after the bridge is ready.
  --no-stop                   Leave existing bridge/Expo processes alone before starting.
  -h, --help                  Show this help.

Notes:
  - Existing bridge token is preserved.
  - Existing engine selection is preserved.
  - 'local' is the LAN/VLAN path.
EOF
}

extract_env_value() {
  local file="$1"
  local key="$2"

  [[ -f "$file" ]] || return 0

  awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=")+1); exit }' "$file"
}

trim_value() {
  printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

run_secure_setup() {
  local active_engine="$1"
  local enabled_engines="$2"
  local bridge_port="$3"
  local preview_port="$4"
  local bridge_token="$5"
  local opencode_cli_bin="$6"

  info "Refreshing secure config for network mode: $NETWORK_MODE"
  (
    cd "$ROOT_DIR"
    BRIDGE_NETWORK_MODE="$NETWORK_MODE" \
    BRIDGE_ACTIVE_ENGINE="$active_engine" \
    BRIDGE_ENABLED_ENGINES="$enabled_engines" \
    BRIDGE_PORT_OVERRIDE="$bridge_port" \
    BRIDGE_PREVIEW_PORT_OVERRIDE="$preview_port" \
    BRIDGE_AUTH_TOKEN="$bridge_token" \
    OPENCODE_CLI_BIN="$opencode_cli_bin" \
    npm run secure:setup
  )
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network)
      shift
      [[ $# -gt 0 ]] || { fail "--network requires a value"; usage; exit 1; }
      NETWORK_MODE="$1"
      ;;
    --network=*)
      NETWORK_MODE="${1#*=}"
      ;;
    --expo)
      shift
      [[ $# -gt 0 ]] || { fail "--expo requires a value"; usage; exit 1; }
      EXPO_MODE="$1"
      ;;
    --expo=*)
      EXPO_MODE="${1#*=}"
      ;;
    --no-stop)
      SKIP_STOP="true"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      usage
      exit 1
      ;;
  esac
  shift
done

case "$NETWORK_MODE" in
  tailscale|local)
    ;;
  "")
    fail "--network is required"
    usage
    exit 1
    ;;
  *)
    fail "unsupported network mode '$NETWORK_MODE' (expected tailscale or local)"
    exit 1
    ;;
esac

case "$EXPO_MODE" in
  mobile|ios|android)
    ;;
  *)
    fail "unsupported Expo mode '$EXPO_MODE' (expected mobile, ios, or android)"
    exit 1
    ;;
esac

EXISTING_ACTIVE_ENGINE="$(trim_value "$(extract_env_value "$SECURE_ENV_FILE" "BRIDGE_ACTIVE_ENGINE")")"
EXISTING_ENABLED_ENGINES="$(trim_value "$(extract_env_value "$SECURE_ENV_FILE" "BRIDGE_ENABLED_ENGINES")")"
EXISTING_BRIDGE_PORT="$(trim_value "$(extract_env_value "$SECURE_ENV_FILE" "BRIDGE_PORT")")"
EXISTING_PREVIEW_PORT="$(trim_value "$(extract_env_value "$SECURE_ENV_FILE" "BRIDGE_PREVIEW_PORT")")"
EXISTING_TOKEN="$(trim_value "$(extract_env_value "$SECURE_ENV_FILE" "BRIDGE_AUTH_TOKEN")")"
EXISTING_OPENCODE_CLI_BIN="$(trim_value "$(extract_env_value "$SECURE_ENV_FILE" "OPENCODE_CLI_BIN")")"

ACTIVE_ENGINE="${EXISTING_ACTIVE_ENGINE:-codex}"
ENABLED_ENGINES="${EXISTING_ENABLED_ENGINES:-$ACTIVE_ENGINE}"
BRIDGE_PORT="${EXISTING_BRIDGE_PORT:-8787}"
PREVIEW_PORT="${EXISTING_PREVIEW_PORT:-$((BRIDGE_PORT + 1))}"
OPENCODE_CLI_BIN="${EXISTING_OPENCODE_CLI_BIN:-opencode}"

if [[ "$SKIP_STOP" != "true" ]]; then
  info "Stopping existing Clawdex services for a clean restart"
  (
    cd "$ROOT_DIR"
    npm run stop:services
  )
fi

run_secure_setup "$ACTIVE_ENGINE" "$ENABLED_ENGINES" "$BRIDGE_PORT" "$PREVIEW_PORT" "$EXISTING_TOKEN" "$OPENCODE_CLI_BIN"

info "Starting secure bridge in background"
(
  cd "$ROOT_DIR"
  npm run secure:bridge -- --background
)

info "Starting Expo via 'npm run $EXPO_MODE'"
cd "$ROOT_DIR"
exec npm run "$EXPO_MODE"
