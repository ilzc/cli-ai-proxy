#!/usr/bin/env bash
set -euo pipefail

# Start the cli-ai-proxy server.
# Usage: start.sh [-p port] [-h host]

INSTALL_DIR="${CLI_AI_PROXY_DIR:-$HOME/.local/share/cli-ai-proxy}"
CLI="$INSTALL_DIR/dist/cli.js"

if [[ ! -f "$CLI" ]]; then
  echo "ERROR: cli-ai-proxy not found at $INSTALL_DIR"
  echo "Run the install script first: {baseDir}/scripts/install.sh"
  exit 1
fi

exec node "$CLI" start "$@"
