#!/usr/bin/env bash
set -euo pipefail

# Show uni-ai-proxy status and health information.

INSTALL_DIR="${UNI_AI_PROXY_DIR:-$HOME/.local/share/uni-ai-proxy}"
CLI="$INSTALL_DIR/dist/cli.js"

if [[ ! -f "$CLI" ]]; then
  echo "Status: not installed"
  echo "Install with: {baseDir}/scripts/install.sh"
  exit 0
fi

exec node "$CLI" status
