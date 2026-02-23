#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"
ROOT_DIR="${INIT_CWD:-$(cd "$SCRIPT_DIR/.." && pwd -L)}"
if [[ ! -f "$ROOT_DIR/package.json" ]]; then
  ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -L)"
fi

MODE="${1:-mobile}"
SECURE_ENV_FILE="$ROOT_DIR/.env.secure"
MOBILE_WORKSPACE="apps/mobile"
AUTO_REPAIR="${EXPO_AUTO_REPAIR:-true}"
CLEAR_CACHE="${EXPO_CLEAR_CACHE:-false}"
RUNTIME_REPAIRED="false"
EXPO_SETUP_VERBOSE="${CLAWDEX_SETUP_VERBOSE:-false}"

info() { echo "info: $*"; }
warn() { echo "warn: $*" >&2; }
fail() { echo "error: $*" >&2; }

run_quiet_command() {
  local label="$1"
  shift
  local log_file=""

  if [[ "$EXPO_SETUP_VERBOSE" == "true" ]]; then
    "$@"
    return $?
  fi

  log_file="$(mktemp "${TMPDIR:-/tmp}/clawdex-expo-setup.XXXXXX.log")"
  if "$@" >"$log_file" 2>&1; then
    rm -f "$log_file"
    return 0
  fi

  fail "$label failed."
  warn "Last 40 lines from installer output:"
  tail -n 40 "$log_file" >&2 || true
  warn "Full installer log: $log_file"
  return 1
}

extract_env_value() {
  local file="$1"
  local key="$2"

  if [[ ! -f "$file" ]]; then
    return 0
  fi

  awk -F= -v key="$key" '$1 == key { print substr($0, index($0, "=")+1); exit }' "$file"
}

resolve_expo_host() {
  local host=""

  if [[ -f "$SECURE_ENV_FILE" ]]; then
    host="$(extract_env_value "$SECURE_ENV_FILE" "BRIDGE_HOST" | tr -d '[:space:]')"
    if [[ -n "$host" ]]; then
      printf '%s' "$host"
      return 0
    fi
  fi

  if command -v tailscale >/dev/null 2>&1; then
    host="$(tailscale ip -4 2>/dev/null | head -n1 | tr -d '[:space:]' || true)"
    if [[ -n "$host" ]]; then
      printf '%s' "$host"
      return 0
    fi
  fi

  echo "error: cannot resolve Expo host IP for QR." >&2
  echo "Run: npm run setup:wizard  (or npm run secure:setup) first." >&2
  return 1
}

has_expo_dependency() {
  [[ -d "$ROOT_DIR/node_modules/expo" ]] || [[ -d "$ROOT_DIR/$MOBILE_WORKSPACE/node_modules/expo" ]]
}

has_typescript_dependency() {
  node -e "require.resolve('typescript/package.json', { paths: ['$ROOT_DIR/$MOBILE_WORKSPACE', '$ROOT_DIR'] })" >/dev/null 2>&1
}

has_mobile_react_native_runtime() {
  local root_touchable="$ROOT_DIR/node_modules/react-native/Libraries/Components/Touchable/BoundingDimensions.js"
  local workspace_touchable="$ROOT_DIR/$MOBILE_WORKSPACE/node_modules/react-native/Libraries/Components/Touchable/BoundingDimensions.js"
  local root_devtools="$ROOT_DIR/node_modules/react-native/src/private/devsupport/rndevtools/specs/NativeReactDevToolsRuntimeSettingsModule.js"
  local workspace_devtools="$ROOT_DIR/$MOBILE_WORKSPACE/node_modules/react-native/src/private/devsupport/rndevtools/specs/NativeReactDevToolsRuntimeSettingsModule.js"

  local touchable_ok="false"
  local devtools_ok="false"

  if [[ -f "$root_touchable" ]] || [[ -f "$workspace_touchable" ]]; then
    touchable_ok="true"
  fi

  if [[ -f "$root_devtools" ]] || [[ -f "$workspace_devtools" ]]; then
    devtools_ok="true"
  fi

  [[ "$touchable_ok" == "true" ]] && [[ "$devtools_ok" == "true" ]]
}

install_mobile_dependencies() {
  info "Installing project dependencies (one-time setup for Expo runtime)..."
  run_quiet_command "Project dependency install" bash -lc "cd \"$ROOT_DIR\" && npm install --include=dev && npm dedupe"
}

repair_mobile_runtime_dependencies() {
  warn "Detected incomplete React Native runtime. Running dependency repair..."
  run_quiet_command "React Native dependency repair" bash -lc "cd \"$ROOT_DIR\" && npm install --include=dev --force && npm install --include=dev --force -w \"$MOBILE_WORKSPACE\" && npm dedupe"
  RUNTIME_REPAIRED="true"
}

ensure_mobile_runtime() {
  if has_expo_dependency && has_typescript_dependency && has_mobile_react_native_runtime; then
    return 0
  fi

  install_mobile_dependencies

  if has_expo_dependency && has_typescript_dependency && has_mobile_react_native_runtime; then
    return 0
  fi

  if [[ "$AUTO_REPAIR" != "true" ]]; then
    fail "mobile runtime is incomplete. Re-run with EXPO_AUTO_REPAIR=true or run npm install --include=dev --force"
    return 1
  fi

  repair_mobile_runtime_dependencies

  if ! has_expo_dependency || ! has_typescript_dependency || ! has_mobile_react_native_runtime; then
    fail "mobile runtime is still incomplete after repair."
    fail "Try: npm install --include=dev --force && npm install --include=dev --force -w $MOBILE_WORKSPACE"
    return 1
  fi
}

run_expo() {
  local -a cmd
  local -a extra_args=(--host lan)

  if [[ "$CLEAR_CACHE" == "true" ]] || [[ "$RUNTIME_REPAIRED" == "true" ]]; then
    extra_args+=(--clear)
  fi

  case "$MODE" in
    mobile)
      cmd=(npm run -w "$MOBILE_WORKSPACE" start -- "${extra_args[@]}")
      ;;
    ios)
      cmd=(npm run -w "$MOBILE_WORKSPACE" ios -- "${extra_args[@]}")
      ;;
    android)
      cmd=(npm run -w "$MOBILE_WORKSPACE" android -- "${extra_args[@]}")
      ;;
    *)
      echo "error: unknown mode '$MODE' (expected: mobile|ios|android)" >&2
      exit 1
      ;;
  esac

  "${cmd[@]}"
}

cd "$ROOT_DIR"
ensure_mobile_runtime
EXPO_HOST="$(resolve_expo_host)"
export REACT_NATIVE_PACKAGER_HOSTNAME="$EXPO_HOST"
echo "Starting Expo with host: $EXPO_HOST (QR will use this IP)"
run_expo
