# CLI AI Proxy

[English](./README.md)

本地 OpenAI 兼容 API 代理，将 AI CLI 工具（Gemini CLI、Claude Code）桥接为统一的 REST API。

任何支持 OpenAI API 格式的应用都可以通过本代理无缝调用本地 AI 模型 —— 无需管理 API Key，不直接调用任何 AI API。

## 为什么需要它

- 大量本地工具（IDE 插件、自动化脚本）只支持 OpenAI API 格式
- 各家 AI 厂商提供了 CLI 工具，自带认证和会话管理
- 本代理在两者之间做翻译：接收 OpenAI API 请求，通过子进程调用 CLI 完成推理

## 快速开始

```bash
# 安装依赖
npm install

# 构建
npm run build

# 启动（默认 127.0.0.1:9090）
npm start

# 或使用管理脚本
./proxy.sh start
./proxy.sh status
./proxy.sh logs
./proxy.sh stop
```

## 前置条件

至少安装以下 CLI 工具之一：
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) —— `gemini` 在 PATH 中
- [Claude Code](https://github.com/anthropics/claude-code) —— `claude` 在 PATH 中

各 CLI 自行管理认证（OAuth、API Key 等）。

## API 端点

### `POST /v1/chat/completions`

标准 OpenAI 对话补全接口，支持流式响应（`"stream": true`）。

```bash
curl http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini","messages":[{"role":"user","content":"你好"}]}'
```

### `GET /v1/models`

列出所有可用模型。

### `GET /health`

健康检查，返回 CLI 可用性、活跃进程数和并发状态。

## 配置

复制 `config.example.yaml` 为 `config.yaml`：

```yaml
server:
  host: "127.0.0.1"
  port: 9090

session:
  ttl: 1800  # 秒，默认 30 分钟

concurrency:
  max: 5        # 最多同时运行的 CLI 进程数
  maxQueued: 50 # 排队上限，超出返回 429

timeout: 300000  # CLI 进程超时（毫秒）

defaultModel: "gemini"

cli:
  gemini: ""   # 留空则使用 PATH 中的命令
  claude: ""

models:
  gemini:
    provider: "gemini"
    model: "default"          # CLI 默认模型（随 CLI 更新自动升级）
  claude:
    provider: "claude"
    model: "default"          # CLI 默认模型
  claude-sonnet:
    provider: "claude"
    model: "sonnet"           # 明确指定别名
  claude-opus:
    provider: "claude"
    model: "opus"             # 明确指定别名
```

环境变量覆盖：`CLI_AI_HOST`、`CLI_AI_PORT`、`GEMINI_CLI_PATH`、`CLAUDE_CLI_PATH`。

## 会话管理

支持多轮对话，利用 CLI 原生的会话续接能力：

1. 首次请求，响应头返回 `X-Session-Id`
2. 后续请求携带该 header 即可续接对话
3. 代理自动映射为 CLI 的 `--resume` 参数
4. 会话超过 TTL（默认 30 分钟）自动过期

## 与 OpenAI SDK 配合使用

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:9090/v1", api_key="any")
r = client.chat.completions.create(
    model="gemini",
    messages=[{"role": "user", "content": "你好"}],
)
print(r.choices[0].message.content)
```

## CLI 工具

代理提供 CLI 进行生命周期管理：

```bash
cli-ai-proxy start                # 启动代理
cli-ai-proxy stop                 # 优雅关闭
cli-ai-proxy restart              # 重启
cli-ai-proxy status               # 运行状态 + 健康检查
cli-ai-proxy health               # 健康检查（JSON）
cli-ai-proxy configure-openclaw   # 自动配置 OpenClaw provider
cli-ai-proxy help                 # 查看帮助
```

全局安装：`npm install -g cli-ai-proxy`

## OpenClaw Skill

项目包含 [OpenClaw](https://openclaw.com) skill（位于 `skill/` 目录），支持 agent 驱动的代理管理。

Skill 的安装脚本非常薄：仅执行 `npm install -g cli-ai-proxy`，不会 git clone、不会本地编译、不触发任何 postinstall 钩子。详见下方[安全说明](#安全说明)。

### 安装 Skill

```bash
# 复制到 OpenClaw 工作区
cp -r skill ~/.openclaw/workspace/skills/cli-ai-proxy
```

验证：`openclaw skills list` 应显示 `✓ ready | 🔀 cli_ai_proxy`。

### 自动配置 OpenClaw Provider

```bash
cli-ai-proxy configure-openclaw
```

自动将 `cli-ai-proxy` 添加为 `~/.openclaw/openclaw.json` 中的 provider，注册所有可用模型。然后设置默认模型：

```json
{ "agents": { "defaults": { "model": { "primary": "cli-ai-proxy/gemini" } } } }
```

### 手动配置 OpenClaw

在 `~/.openclaw/openclaw.json` 中添加：

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

## 安全说明

Skill 的 `install.sh` 实际做了什么：

- **来源：** 从公共 npm registry 执行 `npm install -g cli-ai-proxy`，不 git clone、不本地编译 TypeScript
- **postinstall 脚本：** 无 —— `package.json` 没有声明任何 `preinstall` / `postinstall` 钩子。可用 `npm view cli-ai-proxy scripts` 验证
- **运行时依赖：** 只有 1 个：`yaml`，无其他传递依赖（Node stdlib 除外）
- **文件写入：**
  - 安装时：写入 npm 全局前缀（可执行文件位置）
  - 运行时：在代理工作目录写入 `config.yaml`、`.proxy.pid`、`proxy.log`，以及每次请求后清理的 `tmp-images/` 临时目录
  - `~/.openclaw/openclaw.json` —— **仅当**显式执行 `cli-ai-proxy configure-openclaw` 时才修改，且修改前会在同目录写入 `.bak` 备份
- **运行时网络：** 默认只监听 `127.0.0.1:9090`。代理本身不发起对外请求；对外流量由用户本机安装的 `gemini` / `claude` CLI 在处理请求时产生
- **凭据：** 不索取、不存储任何凭据，认证完全交给 CLI 工具
- **卸载方式：** `npm uninstall -g cli-ai-proxy`；如果执行过 `configure-openclaw`，用 `.bak` 文件还原 `~/.openclaw/openclaw.json` 即可

## 不支持的 OpenAI 参数

以下参数会被静默忽略：`temperature`、`top_p`、`max_tokens`、`stop`、`n`、`presence_penalty`、`frequency_penalty`、`tools`、`functions`。

## 架构

```
客户端（OpenAI 格式）
  → HTTP 服务器（Node.js 原生 http）
    → 路由（校验请求、解析模型/Provider）
      → 信号量（并发控制）
        → Provider（序列化消息、启动 CLI 子进程、解析输出）
          → Gemini CLI / Claude Code（stdin 管道输入，stdout 流式输出）
```

运行时仅依赖 `yaml` 一个外部包。

## 管理脚本

```bash
./proxy.sh start     # 构建并后台启动
./proxy.sh stop      # 优雅关闭
./proxy.sh restart   # 重启
./proxy.sh status    # 健康检查 + 进程状态
./proxy.sh logs      # 查看最近 50 行日志
./proxy.sh follow    # 实时日志
./proxy.sh build     # 仅编译 TypeScript
./proxy.sh test      # 运行端到端测试
```

## 测试

```bash
# 先启动服务
./proxy.sh start

# 运行端到端测试
./proxy.sh test
```

## 许可证

MIT
