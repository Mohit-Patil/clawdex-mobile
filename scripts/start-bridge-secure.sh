#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"
exec node "$SCRIPT_DIR/start-bridge-secure.js" "$@"
