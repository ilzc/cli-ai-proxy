#!/usr/bin/env bash
set -euo pipefail

# Show cli-ai-proxy status and health information.

INSTALL_DIR="${CLI_AI_PROXY_DIR:-$HOME/.local/share/cli-ai-proxy}"
CLI="$INSTALL_DIR/dist/cli.js"

if [[ ! -f "$CLI" ]]; then
  echo "Status: not installed"
  echo "Install with: {baseDir}/scripts/install.sh"
  exit 0
fi

exec node "$CLI" status
