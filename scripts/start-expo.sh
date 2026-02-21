#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"
ROOT_DIR="${INIT_CWD:-$(cd "$SCRIPT_DIR/.." && pwd -L)}"
if [[ ! -f "$ROOT_DIR/package.json" ]]; then
  ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -L)"
fi

MODE="${1:-mobile}"
SECURE_ENV_FILE="$ROOT_DIR/.env.secure"

resolve_expo_host() {
  local host=""

  if [[ -f "$SECURE_ENV_FILE" ]]; then
    host="$(awk -F= '/^BRIDGE_HOST=/{print substr($0, index($0, "=")+1)}' "$SECURE_ENV_FILE" | head -n1 | tr -d '[:space:]')"
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

run_expo() {
  local -a cmd

  case "$MODE" in
    mobile)
      cmd=(npm run -w clawdex-mobile start -- --host lan)
      ;;
    ios)
      cmd=(npm run -w clawdex-mobile ios -- --host lan)
      ;;
    android)
      cmd=(npm run -w clawdex-mobile android -- --host lan)
      ;;
    *)
      echo "error: unknown mode '$MODE' (expected: mobile|ios|android)" >&2
      exit 1
      ;;
  esac

  "${cmd[@]}"
}

cd "$ROOT_DIR"
EXPO_HOST="$(resolve_expo_host)"
export REACT_NATIVE_PACKAGER_HOSTNAME="$EXPO_HOST"
echo "Starting Expo with host: $EXPO_HOST (QR will use this IP)"
run_expo
