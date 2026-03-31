#!/usr/bin/env bash
set -euo pipefail

# Install cli-ai-proxy: clone, build, and optionally configure OpenClaw.
# Usage: install.sh [--configure-openclaw]

REPO_URL="https://github.com/ilzc/cli-ai-proxy.git"
INSTALL_DIR="${CLI_AI_PROXY_DIR:-$HOME/.local/share/cli-ai-proxy}"

echo "=== cli-ai-proxy installer ==="

# ─── Prerequisites ───

command -v node >/dev/null 2>&1 || { echo "ERROR: node not found. Install Node.js first."; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "ERROR: npm not found. Install Node.js first."; exit 1; }

HAS_GEMINI=false
HAS_CLAUDE=false
command -v gemini >/dev/null 2>&1 && HAS_GEMINI=true
command -v claude >/dev/null 2>&1 && HAS_CLAUDE=true

if [[ "$HAS_GEMINI" == false && "$HAS_CLAUDE" == false ]]; then
  echo "WARNING: Neither gemini nor claude CLI found in PATH."
  echo "  Install at least one:"
  echo "    Gemini CLI: npm install -g @anthropic-ai/gemini-cli"
  echo "    Claude Code: npm install -g @anthropic-ai/claude-code"
  echo ""
fi

# ─── Install / Update ───

if [[ -d "$INSTALL_DIR" ]]; then
  echo "Updating existing installation at $INSTALL_DIR..."
  cd "$INSTALL_DIR"
  if [[ -d .git ]]; then
    git pull --ff-only 2>/dev/null || echo "WARNING: git pull failed, using existing code"
  fi
else
  echo "Installing to $INSTALL_DIR..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if command -v git >/dev/null 2>&1; then
    git clone "$REPO_URL" "$INSTALL_DIR" 2>/dev/null || {
      echo "Git clone failed. Creating from scratch..."
      mkdir -p "$INSTALL_DIR"
    }
  else
    mkdir -p "$INSTALL_DIR"
  fi
  cd "$INSTALL_DIR"
fi

# ─── Dependencies & Build ───

echo "Installing dependencies..."
npm install --production=false 2>&1 | tail -1

echo "Building..."
npm run build 2>&1 | tail -1

# ─── Config ───

if [[ ! -f config.yaml && -f config.example.yaml ]]; then
  cp config.example.yaml config.yaml
  echo "Created config.yaml from template"

  # Auto-detect CLI paths
  GEMINI_PATH=$(command -v gemini 2>/dev/null || echo "")
  CLAUDE_PATH=$(command -v claude 2>/dev/null || echo "")

  if [[ -n "$GEMINI_PATH" ]]; then
    sed -i.bak "s|gemini: \"\"|gemini: \"$GEMINI_PATH\"|" config.yaml 2>/dev/null || true
  fi
  if [[ -n "$CLAUDE_PATH" ]]; then
    sed -i.bak "s|claude: \"\"|claude: \"$CLAUDE_PATH\"|" config.yaml 2>/dev/null || true
  fi
  rm -f config.yaml.bak
fi

# ─── Verify ───

echo ""
echo "=== Installation complete ==="
echo "  Location: $INSTALL_DIR"
echo "  CLI tools:"
$HAS_GEMINI && echo "    ✓ gemini ($(gemini --version 2>/dev/null | head -1))"
$HAS_CLAUDE && echo "    ✓ claude ($(claude --version 2>/dev/null | head -1))"
$HAS_GEMINI || echo "    ✗ gemini (not installed)"
$HAS_CLAUDE || echo "    ✗ claude (not installed)"
echo ""
echo "Next steps:"
echo "  Start:  node $INSTALL_DIR/dist/cli.js start"
echo "  Status: node $INSTALL_DIR/dist/cli.js status"

# ─── Optional: Configure OpenClaw ───

if [[ "${1:-}" == "--configure-openclaw" ]]; then
  echo ""
  echo "Configuring OpenClaw..."
  node "$INSTALL_DIR/dist/cli.js" configure-openclaw
fi
