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

is_ipv4() {
  local ip="$1"
  local part=""
  local -a octets=()

  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  IFS='.' read -r -a octets <<<"$ip"
  if [[ "${#octets[@]}" -ne 4 ]]; then
    return 1
  fi

  for part in "${octets[@]}"; do
    if (( part < 0 || part > 255 )); then
      return 1
    fi
  done

  return 0
}

is_non_loopback_ipv4() {
  local ip="$1"
  if ! is_ipv4 "$ip"; then
    return 1
  fi
  [[ "$ip" != 127.* ]]
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

current_local_ipv4() {
  local candidate=""
  local iface=""

  if [[ "$(uname -s)" == "Darwin" ]] && command -v ipconfig >/dev/null 2>&1; then
    for iface in en0 en1; do
      candidate="$(ipconfig getifaddr "$iface" 2>/dev/null | tr -d '[:space:]' || true)"
      if is_non_loopback_ipv4 "$candidate"; then
        printf '%s' "$candidate"
        return 0
      fi
    done
  fi

  if command -v hostname >/dev/null 2>&1; then
    while IFS= read -r candidate; do
      candidate="$(printf '%s' "$candidate" | tr -d '[:space:]')"
      if is_non_loopback_ipv4 "$candidate"; then
        printf '%s' "$candidate"
        return 0
      fi
    done < <(hostname -I 2>/dev/null | tr ' ' '\n' || true)
  fi

  if command -v ip >/dev/null 2>&1; then
    candidate="$(ip route get 1.1.1.1 2>/dev/null | awk '{ for (i=1; i<=NF; i++) if ($i=="src") { print $(i+1); exit } }')"
    candidate="$(printf '%s' "$candidate" | tr -d '[:space:]')"
    if is_non_loopback_ipv4 "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  fi

  if command -v ifconfig >/dev/null 2>&1; then
    while IFS= read -r candidate; do
      candidate="$(printf '%s' "$candidate" | tr -d '[:space:]')"
      if is_non_loopback_ipv4 "$candidate"; then
        printf '%s' "$candidate"
        return 0
      fi
    done < <(ifconfig 2>/dev/null | awk '/inet /{print $2}' || true)
  fi

  return 1
}

resolve_local_ipv4() {
  local ip=""
  ip="$(current_local_ipv4 || true)"

  if [[ -n "$ip" ]]; then
    printf '%s' "$ip"
    return 0
  fi

  echo "No active local/LAN IPv4 found automatically."
  if ! confirm_prompt "Enter bridge host IP manually?"; then
    echo "error: unable to resolve LAN IPv4. Connect to LAN and retry." >&2
    return 1
  fi

  read -r -p "Bridge host IP: " ip
  ip="$(printf '%s' "$ip" | tr -d '[:space:]')"
  if ! is_non_loopback_ipv4 "$ip"; then
    echo "error: invalid IPv4 '$ip'." >&2
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
BRIDGE_NETWORK_MODE="${BRIDGE_NETWORK_MODE:-tailscale}"

case "$BRIDGE_NETWORK_MODE" in
  tailscale|local)
    ;;
  *)
    echo "error: BRIDGE_NETWORK_MODE must be 'tailscale' or 'local'." >&2
    exit 1
    ;;
esac

if [[ -n "$BRIDGE_HOST" ]]; then
  HOST_SOURCE="override"
else
  if [[ "$BRIDGE_NETWORK_MODE" == "tailscale" ]]; then
    ensure_tailscale_cli
    BRIDGE_HOST="$(resolve_tailscale_ipv4)"
    HOST_SOURCE="tailscale"
  else
    BRIDGE_HOST="$(resolve_local_ipv4)"
    HOST_SOURCE="local"
  fi
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
BRIDGE_NETWORK_MODE=$BRIDGE_NETWORK_MODE
BRIDGE_HOST=$BRIDGE_HOST
BRIDGE_PORT=$BRIDGE_PORT
BRIDGE_AUTH_TOKEN=$BRIDGE_TOKEN
BRIDGE_ALLOW_QUERY_TOKEN_AUTH=false
CODEX_CLI_BIN=codex
BRIDGE_WORKDIR=$ROOT_DIR
EOT

chmod 600 "$SECURE_ENV_FILE"

upsert_env_key "$MOBILE_ENV_FILE" "EXPO_PUBLIC_HOST_BRIDGE_TOKEN" "$BRIDGE_TOKEN"
# Backward compatibility for older app builds that still read MAC_BRIDGE token key.
upsert_env_key "$MOBILE_ENV_FILE" "EXPO_PUBLIC_MAC_BRIDGE_TOKEN" "$BRIDGE_TOKEN"
upsert_env_key "$MOBILE_ENV_FILE" "EXPO_PUBLIC_ALLOW_QUERY_TOKEN_AUTH" "false"
upsert_env_key "$MOBILE_ENV_FILE" "EXPO_PUBLIC_ALLOW_INSECURE_REMOTE_BRIDGE" "true"

echo "Secure dev setup complete."
echo ""
echo "Bridge network mode: $BRIDGE_NETWORK_MODE"
echo "Bridge host: $BRIDGE_HOST ($HOST_SOURCE)"
echo "Bridge port: $BRIDGE_PORT"
echo "Token source: $SECURE_ENV_FILE"
echo "Mobile env updated: $MOBILE_ENV_FILE"
echo ""
echo "Next steps:"
echo "  1) npm run secure:bridge"
echo "  2) npm run mobile"
