#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"
ROOT_DIR="${INIT_CWD:-$(cd "$SCRIPT_DIR/.." && pwd -L)}"
if [[ ! -f "$ROOT_DIR/package.json" ]]; then
  ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -L)"
fi
SECURE_ENV_FILE="$ROOT_DIR/.env.secure"

if [[ ! -f "$SECURE_ENV_FILE" ]]; then
  echo "error: $SECURE_ENV_FILE not found. Run: npm run secure:setup" >&2
  exit 1
fi

if ! command -v cc >/dev/null 2>&1; then
  echo "error: missing system C compiler/linker ('cc'). Rust bridge cannot compile without it." >&2
  if command -v apt-get >/dev/null 2>&1; then
    echo "Install on Ubuntu/Debian: sudo apt-get update && sudo apt-get install -y build-essential" >&2
  elif command -v dnf >/dev/null 2>&1; then
    echo "Install on Fedora/RHEL: sudo dnf install -y gcc gcc-c++ make" >&2
  elif command -v yum >/dev/null 2>&1; then
    echo "Install on CentOS/RHEL: sudo yum install -y gcc gcc-c++ make" >&2
  elif command -v apk >/dev/null 2>&1; then
    echo "Install on Alpine: sudo apk add build-base" >&2
  elif command -v xcode-select >/dev/null 2>&1; then
    echo "Install on macOS: xcode-select --install" >&2
  fi
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$SECURE_ENV_FILE"
set +a

cd "$ROOT_DIR"
exec npm run -w @codex/rust-bridge dev
