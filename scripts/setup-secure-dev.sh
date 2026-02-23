#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"
ROOT_DIR="${INIT_CWD:-$(cd "$SCRIPT_DIR/.." && pwd -L)}"
if [[ ! -f "$ROOT_DIR/package.json" ]]; then
  ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -L)"
fi
SECURE_ENV_FILE="$ROOT_DIR/.env.secure"
MOBILE_ENV_FILE="$ROOT_DIR/apps/mobile/.env"
MOBILE_ENV_EXAMPLE="$ROOT_DIR/apps/mobile/.env.example"
RUST_ENV_FILE="$ROOT_DIR/services/rust-bridge/.env"
RUST_ENV_EXAMPLE="$ROOT_DIR/services/rust-bridge/.env.example"

upsert_env_key() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp
  tmp="$(mktemp)"

  awk -v key="$key" -v value="$value" '
    BEGIN { updated = 0 }
    $0 ~ ("^" key "=") {
      print key "=" value
      updated = 1
      next
    }
    { print }
    END {
      if (!updated) {
        print key "=" value
      }
    }
  ' "$file" > "$tmp"

  mv "$tmp" "$file"
}

confirm_prompt() {
  local prompt="$1"
  local answer

  if [[ ! -t 0 ]]; then
    return 1
  fi

  read -r -p "$prompt [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

ensure_tailscale_cli() {
  if command -v tailscale >/dev/null 2>&1; then
    return 0
  fi

  echo "tailscale CLI is not installed."
  if ! confirm_prompt "Install Tailscale now using Homebrew?"; then
    echo "error: Tailscale is required for secure setup." >&2
    echo "Install manually: https://tailscale.com/download" >&2
    return 1
  fi

  if ! command -v brew >/dev/null 2>&1; then
    echo "error: Homebrew is not installed, cannot auto-install Tailscale." >&2
    echo "Install manually: https://tailscale.com/download" >&2
    return 1
  fi

  brew install --cask tailscale

  if ! command -v tailscale >/dev/null 2>&1; then
    echo "error: tailscale install did not complete successfully." >&2
    return 1
  fi

  return 0
}

resolve_tailscale_ipv4() {
  local ip
  ip="$(tailscale ip -4 2>/dev/null | head -n1 | tr -d '[:space:]' || true)"

  if [[ -n "$ip" ]]; then
    printf '%s' "$ip"
    return 0
  fi

  echo "No active Tailscale IPv4 found."
  if confirm_prompt "Run 'tailscale up' now?"; then
    tailscale up || true
    ip="$(tailscale ip -4 2>/dev/null | head -n1 | tr -d '[:space:]' || true)"
  fi

  if [[ -z "$ip" ]]; then
    echo "error: unable to resolve Tailscale IPv4. Connect Tailscale and retry." >&2
    return 1
  fi

  printf '%s' "$ip"
}

if ! command -v openssl >/dev/null 2>&1; then
  echo "error: openssl not found. Install OpenSSL first." >&2
  exit 1
fi

mkdir -p "$(dirname "$MOBILE_ENV_FILE")" "$(dirname "$RUST_ENV_FILE")"

if [[ ! -f "$MOBILE_ENV_FILE" ]]; then
  cp "$MOBILE_ENV_EXAMPLE" "$MOBILE_ENV_FILE"
fi

if [[ ! -f "$RUST_ENV_FILE" ]]; then
  cp "$RUST_ENV_EXAMPLE" "$RUST_ENV_FILE"
fi

BRIDGE_HOST="${BRIDGE_HOST_OVERRIDE:-}"
HOST_SOURCE=""

if [[ -n "$BRIDGE_HOST" ]]; then
  HOST_SOURCE="override"
else
  ensure_tailscale_cli
  BRIDGE_HOST="$(resolve_tailscale_ipv4)"
  HOST_SOURCE="tailscale"
fi

BRIDGE_PORT="${BRIDGE_PORT_OVERRIDE:-8787}"

EXISTING_TOKEN=""
if [[ -f "$SECURE_ENV_FILE" ]]; then
  EXISTING_TOKEN="$(awk -F= '/^BRIDGE_AUTH_TOKEN=/{print substr($0, index($0, "=")+1)}' "$SECURE_ENV_FILE" | head -n1)"
fi

BRIDGE_TOKEN="${BRIDGE_AUTH_TOKEN:-$EXISTING_TOKEN}"
if [[ -z "$BRIDGE_TOKEN" ]]; then
  BRIDGE_TOKEN="$(openssl rand -hex 24)"
fi

cat > "$SECURE_ENV_FILE" <<EOT
BRIDGE_HOST=$BRIDGE_HOST
BRIDGE_PORT=$BRIDGE_PORT
BRIDGE_AUTH_TOKEN=$BRIDGE_TOKEN
BRIDGE_ALLOW_QUERY_TOKEN_AUTH=false
CODEX_CLI_BIN=codex
BRIDGE_WORKDIR=$ROOT_DIR
EOT

chmod 600 "$SECURE_ENV_FILE"

upsert_env_key "$MOBILE_ENV_FILE" "EXPO_PUBLIC_HOST_BRIDGE_URL" "http://$BRIDGE_HOST:$BRIDGE_PORT"
upsert_env_key "$MOBILE_ENV_FILE" "EXPO_PUBLIC_HOST_BRIDGE_TOKEN" "$BRIDGE_TOKEN"
# Backward compatibility for older app builds that still read MAC_BRIDGE keys.
upsert_env_key "$MOBILE_ENV_FILE" "EXPO_PUBLIC_MAC_BRIDGE_URL" "http://$BRIDGE_HOST:$BRIDGE_PORT"
upsert_env_key "$MOBILE_ENV_FILE" "EXPO_PUBLIC_MAC_BRIDGE_TOKEN" "$BRIDGE_TOKEN"
upsert_env_key "$MOBILE_ENV_FILE" "EXPO_PUBLIC_ALLOW_QUERY_TOKEN_AUTH" "false"
upsert_env_key "$MOBILE_ENV_FILE" "EXPO_PUBLIC_ALLOW_INSECURE_REMOTE_BRIDGE" "true"

echo "Secure dev setup complete."
echo ""
echo "Bridge host: $BRIDGE_HOST ($HOST_SOURCE)"
echo "Bridge port: $BRIDGE_PORT"
echo "Token source: $SECURE_ENV_FILE"
echo "Mobile env updated: $MOBILE_ENV_FILE"
echo ""
echo "Next steps:"
echo "  1) npm run secure:bridge"
echo "  2) npm run mobile"
