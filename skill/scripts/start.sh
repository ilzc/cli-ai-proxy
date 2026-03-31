#!/usr/bin/env bash
set -euo pipefail

# Start the uni-ai-proxy server.
# Usage: start.sh [-p port] [-h host]

INSTALL_DIR="${UNI_AI_PROXY_DIR:-$HOME/.local/share/uni-ai-proxy}"
CLI="$INSTALL_DIR/dist/cli.js"

if [[ ! -f "$CLI" ]]; then
  echo "ERROR: uni-ai-proxy not found at $INSTALL_DIR"
  echo "Run the install script first: {baseDir}/scripts/install.sh"
  exit 1
fi

exec node "$CLI" start "$@"
