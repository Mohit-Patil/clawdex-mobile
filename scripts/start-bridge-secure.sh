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

set -a
# shellcheck disable=SC1090
source "$SECURE_ENV_FILE"
set +a

cd "$ROOT_DIR"
exec npm run -w @codex/rust-bridge dev
