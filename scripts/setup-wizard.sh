#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"
ROOT_DIR="${INIT_CWD:-$(cd "$SCRIPT_DIR/.." && pwd -L)}"
if [[ ! -f "$ROOT_DIR/package.json" ]]; then
  ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -L)"
fi

if [[ ! -t 0 ]]; then
  echo "error: setup wizard is interactive. Run it in a terminal." >&2
  exit 1
fi

confirm_prompt() {
  local prompt="$1"
  local answer

  read -r -p "$prompt [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

print_step() {
  local step="$1"
  echo ""
  echo "==> $step"
}

current_tailscale_ip() {
  tailscale ip -4 2>/dev/null | head -n1 | tr -d '[:space:]' || true
}

open_tailscale_app() {
  if ! command -v open >/dev/null 2>&1; then
    return 1
  fi

  open -a Tailscale >/dev/null 2>&1 || true
  return 0
}

open_tailscale_login_flow() {
  local tailscale_output=""
  local login_url=""

  echo "Starting Tailscale login flow..."
  open_tailscale_app || true

  tailscale_output="$(tailscale up 2>&1 || true)"
  if [[ -n "$tailscale_output" ]]; then
    echo "$tailscale_output"
  fi

  login_url="$(printf '%s\n' "$tailscale_output" | awk 'match($0, /https?:\/\/[^ ]+/) { print substr($0, RSTART, RLENGTH); exit }')"
  if [[ -z "$login_url" ]]; then
    login_url="https://login.tailscale.com/start"
  fi

  if command -v open >/dev/null 2>&1; then
    echo "Opening browser: $login_url"
    open "$login_url" || true
  else
    echo "Open this URL to login: $login_url"
  fi
}

print_step "Welcome"
echo "This wizard will help you set up secure mobile + bridge startup step by step."
echo ""

echo "Project root: $ROOT_DIR"

print_step "Check Codex CLI"
while ! command -v codex >/dev/null 2>&1; do
  echo "Codex CLI not found in PATH."
  echo "Install Codex CLI, then come back here."
  if command -v open >/dev/null 2>&1; then
    if confirm_prompt "Open Codex docs in browser now?"; then
      open "https://developers.openai.com/codex"
    fi
  fi

  if ! confirm_prompt "Retry Codex CLI check?"; then
    echo "Aborted. Install Codex CLI and rerun: npm run setup:wizard"
    exit 1
  fi
done

echo "Found codex at: $(command -v codex)"

print_step "Check Tailscale installation"
if ! command -v tailscale >/dev/null 2>&1; then
  echo "Tailscale CLI is not installed."
  if confirm_prompt "Install Tailscale now using Homebrew?"; then
    if ! command -v brew >/dev/null 2>&1; then
      echo "error: Homebrew is not installed."
      echo "Install Homebrew first, then rerun: npm run setup:wizard"
      exit 1
    fi

    brew install --cask tailscale
  else
    echo "Aborted. Tailscale is required for this secure setup flow."
    exit 1
  fi
fi

echo "Found tailscale at: $(command -v tailscale)"
open_tailscale_app || true

print_step "Check Tailscale login / connectivity"
TAILSCALE_IP="$(current_tailscale_ip)"
while [[ -z "$TAILSCALE_IP" ]]; do
  echo "No active Tailscale IPv4 detected."
  echo "You likely need to log in to Tailscale first."

  if confirm_prompt "Open Tailscale login in browser now?"; then
    open_tailscale_login_flow
    read -r -p "After login completes, press Enter to continue..."
  fi

  if ! confirm_prompt "Retry Tailscale connectivity check?"; then
    echo "Aborted. Connect Tailscale, then rerun: npm run setup:wizard"
    exit 1
  fi

  TAILSCALE_IP="$(current_tailscale_ip)"
done

echo "Tailscale IP detected: $TAILSCALE_IP"

print_step "Check Expo Go readiness"
if ! confirm_prompt "Is Expo Go installed on your phone?"; then
  echo "Install Expo Go first:"
  echo "- iOS App Store: https://apps.apple.com/app/expo-go/id982107779"
  echo "- Android Play Store: https://play.google.com/store/apps/details?id=host.exp.exponent"
  read -r -p "Press Enter once Expo Go is installed to continue..."
fi

print_step "Configure secure environment"
BRIDGE_HOST_OVERRIDE="$TAILSCALE_IP" "$SCRIPT_DIR/setup-secure-dev.sh"

print_step "Start services"
if confirm_prompt "Start bridge and Expo in this terminal now (show QR here)?"; then
  BRIDGE_PID=""
  BRIDGE_LOG="$ROOT_DIR/.bridge.log"

  cleanup_bridge() {
    if [[ -n "$BRIDGE_PID" ]] && kill -0 "$BRIDGE_PID" >/dev/null 2>&1; then
      echo ""
      echo "Stopping bridge (pid $BRIDGE_PID)..."
      kill -TERM "$BRIDGE_PID" >/dev/null 2>&1 || true
      pkill -TERM -P "$BRIDGE_PID" >/dev/null 2>&1 || true
      wait "$BRIDGE_PID" 2>/dev/null || true
    fi
  }

  trap cleanup_bridge EXIT INT TERM

  echo "Starting bridge in background..."
  (
    cd "$ROOT_DIR"
    npm run secure:bridge
  ) >"$BRIDGE_LOG" 2>&1 &
  BRIDGE_PID="$!"

  sleep 1
  if ! kill -0 "$BRIDGE_PID" >/dev/null 2>&1; then
    echo "Bridge failed to start. Recent logs:"
    tail -n 80 "$BRIDGE_LOG" || true
    exit 1
  fi

  echo "Bridge is running in background (pid $BRIDGE_PID)."
  echo "Bridge logs: $BRIDGE_LOG"
  echo ""
  echo "Starting Expo now. Scan the QR in this terminal."
  echo "Press Ctrl+C to stop Expo and bridge."
  echo ""
  cd "$ROOT_DIR"
  npm run mobile
  exit $?
fi

echo ""
echo "Done. Start these in separate terminals if needed:"
echo "  1) cd $ROOT_DIR && npm run secure:bridge"
echo "  2) cd $ROOT_DIR && npm run mobile"
