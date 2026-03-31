#!/usr/bin/env bash
set -euo pipefail

# Stop the uni-ai-proxy server.

INSTALL_DIR="${UNI_AI_PROXY_DIR:-$HOME/.local/share/uni-ai-proxy}"
CLI="$INSTALL_DIR/dist/cli.js"

if [[ ! -f "$CLI" ]]; then
  echo "ERROR: uni-ai-proxy not found at $INSTALL_DIR"
  exit 1
fi

exec node "$CLI" stop
