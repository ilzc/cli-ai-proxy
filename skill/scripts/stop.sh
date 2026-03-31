#!/usr/bin/env bash
set -euo pipefail

# Stop the cli-ai-proxy server.

INSTALL_DIR="${CLI_AI_PROXY_DIR:-$HOME/.local/share/cli-ai-proxy}"
CLI="$INSTALL_DIR/dist/cli.js"

if [[ ! -f "$CLI" ]]; then
  echo "ERROR: cli-ai-proxy not found at $INSTALL_DIR"
  exit 1
fi

exec node "$CLI" stop
