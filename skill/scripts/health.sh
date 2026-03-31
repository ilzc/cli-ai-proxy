#!/usr/bin/env bash
set -euo pipefail

# Health check — outputs JSON from the /health endpoint.
# Exit code 0 if healthy, 1 if unreachable.

INSTALL_DIR="${CLI_AI_PROXY_DIR:-$HOME/.local/share/cli-ai-proxy}"
CLI="$INSTALL_DIR/dist/cli.js"

if [[ ! -f "$CLI" ]]; then
  echo '{"status":"not_installed","error":"cli-ai-proxy not found"}'
  exit 1
fi

exec node "$CLI" health
