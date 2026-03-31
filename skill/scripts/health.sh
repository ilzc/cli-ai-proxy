#!/usr/bin/env bash
set -euo pipefail

# Health check — outputs JSON from the /health endpoint.
# Exit code 0 if healthy, 1 if unreachable.

INSTALL_DIR="${UNI_AI_PROXY_DIR:-$HOME/.local/share/uni-ai-proxy}"
CLI="$INSTALL_DIR/dist/cli.js"

if [[ ! -f "$CLI" ]]; then
  echo '{"status":"not_installed","error":"uni-ai-proxy not found"}'
  exit 1
fi

exec node "$CLI" health
