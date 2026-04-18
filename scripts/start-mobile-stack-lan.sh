#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"
exec "$SCRIPT_DIR/start-mobile-stack.sh" --network local "$@"
