# CLI AI Proxy

[中文文档](./README.zh-CN.md)

Local OpenAI-compatible API proxy that bridges AI CLI tools (Gemini CLI, Claude Code) to a unified REST API.

Any application that supports the OpenAI API format can reach local AI models through their CLI tools without making direct API calls. **The proxy itself never reads or stores API keys** — authentication (OAuth, API keys, session tokens) is handled entirely by the underlying `gemini` / `claude` CLIs on your machine.

## Why

- Many local tools (IDE plugins, automation scripts) only speak OpenAI API format
- AI vendors ship CLI tools with built-in auth and session management
- This proxy translates between the two: OpenAI API in, CLI subprocess out

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Start (default: 127.0.0.1:9090)
npm start

# Or use the management script
./proxy.sh start
./proxy.sh status
./proxy.sh logs
./proxy.sh stop
```

## Prerequisites

At least one of:
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) — `gemini` in PATH
- [Claude Code](https://github.com/anthropics/claude-code) — `claude` in PATH

Each CLI handles its own authentication (OAuth, API key, etc.).

## API Endpoints

### `POST /v1/chat/completions`

Standard OpenAI chat completions. Supports streaming (`"stream": true`).

```bash
curl http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini","messages":[{"role":"user","content":"hello"}]}'
```

### `GET /v1/models`

List available models.

### `GET /health`

Health check with CLI availability, active process count, and concurrency stats.

## Configuration

Copy `config.example.yaml` to `config.yaml`:

```yaml
server:
  host: "127.0.0.1"
  port: 9090

session:
  ttl: 1800  # seconds, default 30 min

concurrency:
  max: 5        # max concurrent CLI processes
  maxQueued: 50 # queue limit, excess returns 429

timeout: 300000  # CLI process timeout in ms

defaultModel: "gemini"

cli:
  gemini: ""   # leave empty to use PATH
  claude: ""

models:
  gemini:
    provider: "gemini"
    model: "default"          # CLI default model (auto-upgrades)
  claude:
    provider: "claude"
    model: "default"          # CLI default model
  claude-sonnet:
    provider: "claude"
    model: "sonnet"           # explicit alias
  claude-opus:
    provider: "claude"
    model: "opus"             # explicit alias
```

Environment variable overrides: `CLI_AI_HOST`, `CLI_AI_PORT`, `GEMINI_CLI_PATH`, `CLAUDE_CLI_PATH`.

## Sessions

Multi-turn conversations are supported via CLI session resumption:

1. First request returns `X-Session-Id` response header
2. Send it back on subsequent requests to continue the conversation
3. The proxy maps it to the CLI's native `--resume` flag
4. Sessions expire after TTL (default 30 min)

## Using with OpenAI SDKs

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:9090/v1", api_key="any")
r = client.chat.completions.create(
    model="gemini",
    messages=[{"role": "user", "content": "hi"}],
)
print(r.choices[0].message.content)
```

## CLI Tool

The proxy ships a CLI for lifecycle management:

```bash
cli-ai-proxy start                # start the proxy server
cli-ai-proxy stop                 # graceful shutdown
cli-ai-proxy restart              # restart
cli-ai-proxy status               # running status + health
cli-ai-proxy health               # health check (JSON)
cli-ai-proxy configure-openclaw   # auto-configure OpenClaw provider
cli-ai-proxy help                 # show help
```

Install globally: `npm install -g cli-ai-proxy`

## OpenClaw Skill

An [OpenClaw](https://openclaw.com) skill is included in `skill/` for agent-driven proxy management.

The skill's install script is thin: it runs `npm install -g cli-ai-proxy` and nothing else — no git clone, no local build, no postinstall hooks. See the [Security](#security) section below for details.

### Install the skill

```bash
# Copy into OpenClaw workspace
cp -r skill ~/.openclaw/workspace/skills/cli-ai-proxy
```

Verify: `openclaw skills list` should show `✓ ready | 🔀 cli_ai_proxy`.

### Auto-configure OpenClaw provider

```bash
cli-ai-proxy configure-openclaw
```

This adds `cli-ai-proxy` as a provider in `~/.openclaw/openclaw.json` with all available models. Then set the default model:

```json
{ "agents": { "defaults": { "model": { "primary": "cli-ai-proxy/gemini" } } } }
```

### Manual OpenClaw configuration

Add to `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "cli-ai-proxy": {
        "baseUrl": "http://127.0.0.1:9090/v1",
        "apiKey": "no-key-needed",
        "api": "openai-completions",
        "models": [
          {
            "id": "gemini",
            "name": "Gemini 2.5 Flash (via CLI)",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 1048576,
            "maxTokens": 8192
          }
        ]
      }
    }
  }
}
```

## Security

What the skill's `install.sh` actually does:

- **Source:** `npm install -g cli-ai-proxy` from the public npm registry. No git clone, no local TypeScript build.
- **Postinstall scripts:** none — `package.json` declares no `preinstall` / `postinstall` hooks. You can verify with `npm view cli-ai-proxy scripts`.
- **Runtime dependencies:** one — `yaml`. No transitive deps beyond Node stdlib.
- **Filesystem writes:**
  - npm global prefix (the binary), during install
  - the proxy's working directory: `config.yaml`, `.proxy.pid`, `proxy.log`, and a `tmp-images/` scratch directory cleaned up per request
  - `~/.openclaw/openclaw.json` — **only** if you explicitly run `cli-ai-proxy configure-openclaw`. That command writes a `.bak` backup next to the original before modifying.
- **Network at runtime:** binds to `127.0.0.1:9090` by default. The proxy itself makes no outbound calls — any network traffic is generated by the user's installed `gemini` / `claude` CLIs when handling a request.
- **Credentials:** none requested or stored. Auth is delegated entirely to the installed CLIs.

### ⚠️ Don't expose the proxy externally

The proxy is designed for **loopback use only**. Two settings can take it off `127.0.0.1` and should stay at their defaults unless you know what you're doing:

- `server.host` / env `CLI_AI_HOST` — keep at `127.0.0.1`. Setting it to `0.0.0.0` exposes the proxy to your LAN (and potentially the public internet, depending on your firewall), and there is **no authentication** on the proxy itself.
- CORS response headers — the proxy currently returns `Access-Control-Allow-Origin: *` so any webpage in your browser can call it. This is fine on loopback; it is **not fine** if you also set host to `0.0.0.0`. If you must expose the proxy, put it behind a reverse proxy that enforces auth and a narrow CORS origin.

### Verify the npm package yourself

You don't have to trust this README. Run these before the global install:

```bash
# Confirm no pre/postinstall hooks on the published package:
npm view cli-ai-proxy scripts
# Expected output: { build: 'tsc', start: 'node dist/index.js', dev: '...' }
# (no preinstall / postinstall / prepare entries)

# See the full list of files that will land on your machine:
npm view cli-ai-proxy dist.tarball
npm pack cli-ai-proxy --dry-run
```

If provenance matters to you, the npm page shows a green "Provenance" badge linking to the exact GitHub Actions run and commit that built the tarball.

### To uninstall

```bash
npm uninstall -g cli-ai-proxy
# If you ran `configure-openclaw`, restore your OpenClaw config:
mv ~/.openclaw/openclaw.json.bak ~/.openclaw/openclaw.json
```

## Unsupported OpenAI Parameters

These are silently ignored: `temperature`, `top_p`, `max_tokens`, `stop`, `n`, `presence_penalty`, `frequency_penalty`, `tools`, `functions`.

## Architecture

```
Client (OpenAI format)
  → HTTP Server (Node.js native http)
    → Router (validate, resolve model/provider)
      → Semaphore (concurrency control)
        → Provider (serialize messages, spawn CLI, parse output)
          → Gemini CLI / Claude Code (stdin pipe, stdout stream)
```

Zero external runtime dependencies beyond `yaml` for config parsing.

## Management Script

```bash
./proxy.sh start     # build + start with nohup
./proxy.sh stop      # graceful shutdown
./proxy.sh restart   # stop + start
./proxy.sh status    # health check + process info
./proxy.sh logs      # tail last 50 lines
./proxy.sh follow    # live log tail
./proxy.sh build     # TypeScript compilation only
./proxy.sh test      # run e2e tests
```

## Testing

```bash
# Start the server first
./proxy.sh start

# Run end-to-end tests
./proxy.sh test
```

## License

MIT
