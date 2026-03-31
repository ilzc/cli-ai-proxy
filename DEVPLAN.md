# CLI AI Proxy - 开发计划

## 技术选型

| 项目 | 选择 | 理由 |
|------|------|------|
| 语言 | TypeScript (Node.js) | 本机已有 Node 环境，原生 `http` 模块零框架依赖 |
| HTTP 框架 | Node.js 原生 `http.createServer` | 零依赖、支持 streaming 响应 |
| 子进程 | Node.js `child_process.spawn` | 调用本地 CLI 工具，支持 stdin pipe + stdout 流式读取 |
| 配置 | YAML | 可读性好，用 `yaml` 包解析 |
| 测试 | Node.js 内置 test runner | 无需额外依赖 |

## 项目结构

```
cli-ai-proxy/
├── .gitignore
├── config.yaml              # 用户配置（gitignore）
├── config.example.yaml      # 配置模板
├── package.json
├── tsconfig.json
├── REQUIREMENTS.md
├── DEVPLAN.md
├── src/
│   ├── index.ts             # 入口：启动 HTTP server
│   ├── config.ts            # 配置加载（YAML + 环境变量）
│   ├── router.ts            # 路由：/v1/chat/completions, /v1/models
│   ├── types.ts             # 类型定义（OpenAI 请求/响应格式）
│   ├── messages.ts          # OpenAI messages → prompt 文本序列化
│   ├── session.ts           # Session 管理（映射表 + TTL 清理）
│   ├── providers/
│   │   ├── base.ts          # Provider 抽象接口
│   │   ├── gemini.ts        # Gemini CLI 适配器
│   │   ├── claude.ts        # Claude Code 适配器
│   │   └── openclaw.ts      # OpenClaw 适配器（agent --local）
│   └── utils/
│       ├── logger.ts        # 日志
│       └── errors.ts        # 错误处理与映射
└── test/
    ├── messages.test.ts     # 消息序列化测试
    ├── session.test.ts      # Session 管理测试
    ├── providers.test.ts    # Provider 测试（mock CLI）
    └── e2e.test.ts          # 端到端测试
```

## CLI 调用方式

### 通用规则

- **prompt 始终通过 stdin pipe 传入**，不使用 `-p` 参数，避免命令行长度限制
- 不支持的 OpenAI 参数（temperature、top_p、max_tokens、stop、n 等）静默忽略

### Gemini CLI

```bash
# 非 streaming — prompt 通过 stdin 传入
echo "prompt text" | gemini --output-format json --model gemini-2.5-flash

# streaming — 读取 stdout 流式输出
echo "prompt text" | gemini --model gemini-2.5-flash

# session 续接
echo "new message" | gemini --resume <session_id> --output-format json
```

- 认证：CLI 自身管理（OAuth 登录态或 GEMINI_API_KEY）
- 输出解析：JSON 模式返回结构化结果，text 模式直接读 stdout 流

### Claude Code

```bash
# 非 streaming — prompt 通过 stdin pipe 传入
echo "prompt text" | claude --output-format json --model sonnet --bare

# streaming
echo "prompt text" | claude --output-format stream-json --model sonnet --bare --verbose

# 带 system prompt
echo "prompt text" | claude --system-prompt "You are a helpful assistant" --output-format json --model sonnet --bare

# session 续接
echo "new message" | claude --resume <session_id> --output-format json --bare
```

- `--bare` 跳过插件/MCP/memory 加载，加速启动
- 认证：CLI 自身管理（`claude auth login` 或 ANTHROPIC_API_KEY）
- streaming 解析：JSONL 格式，过滤 `type == "stream_event"` 中的 `text_delta`

### OpenClaw

```bash
# 非 streaming — 通过 --message 传入
openclaw agent --local --agent main --json --message "prompt text"

# session 续接
openclaw agent --local --agent main --json --session-id <session_id> --message "new message"
```

- 认证：OpenClaw 自身管理（API Key 存在 `~/.openclaw/agents/main/agent/auth-profiles.json`）
- **输出特殊性**：所有输出（包括 JSON 结果）走 stderr，stdout 始终为空
- stderr 中 JSON 与 `[plugins]` 日志混合，需提取 `{"payloads": ...}` JSON 块
- 不支持原生 streaming，代理层用非流式调用 + 模拟 SSE 输出
- 默认模型由 OpenClaw 配置决定（当前为 `gemini-3.1-pro-preview`）
- 自带工具能力（read/write/exec/web_search 等），可作为 agent 使用

## 消息序列化策略

将 OpenAI messages 数组转换为 CLI 可接受的纯文本 prompt，通过 stdin 传入：

```
输入：
[
  {"role": "system", "content": "You are a translator"},
  {"role": "user", "content": "Hello"},
  {"role": "assistant", "content": "你好"},
  {"role": "user", "content": "How are you?"}
]

Gemini CLI：system 编入 prompt 头部，所有 messages 拼接
Claude Code：system 通过 --system-prompt 传递，其余拼接为 prompt
```

**Session 续接时**：只发送最新一条 user message（CLI 自身保有历史上下文）。

## Session 管理设计

```
┌─────────┐     X-Session-Id     ┌───────────┐    --resume     ┌──────────┐
│  Client  │ ──────────────────→  │   Proxy   │ ────────────→   │  CLI     │
│          │ ←────────────────── │ (session   │ ←──────────── │  Process  │
│          │  X-Session-Id resp  │  map)      │   response     │          │
└─────────┘                      └───────────┘                 └──────────┘
```

**Session 映射表**（内存 Map）：

| Key (proxySessionId) | Value |
|---|---|
| `uuid-abc-123` | `{ cliSessionId: "sess_xxx", provider: "claude", lastActive: 1711500000 }` |

**生命周期**：
1. 首次请求：完整 messages → CLI → 获取 cli_session_id → 存入映射 → 响应带 `X-Session-Id`
2. 续接请求：查映射 → `--resume` + 最新 message → 更新 lastActive
3. 过期清理：定时器每分钟扫描，删除超过 TTL（默认 30 分钟）的映射
4. 代理重启：映射丢失，客户端下次请求自动创建新 session

## API 兼容性

| OpenAI 参数 | 处理方式 |
|---|---|
| `model` | 路由到对应 CLI 后端 + 传递给 `--model` |
| `messages` | 序列化为 prompt 文本 |
| `stream` | 控制 CLI 输出格式和响应方式 |
| `temperature`, `top_p`, `max_tokens` | 静默忽略 |
| `stop`, `n`, `presence_penalty` | 静默忽略 |
| `tools` / `functions` | P2 实现 |

**响应元数据生成**：
- `id`：`chatcmpl-` + UUID
- `created`：当前 Unix 时间戳
- `model`：实际使用的模型名（如 `gemini-2.5-flash`）
- `object`：`chat.completion` 或 `chat.completion.chunk`
- `usage`：如 CLI 输出包含则填充，否则省略

## 开发阶段

### Phase 1：MVP

**目标**：Gemini CLI + Claude Code 文本对话 + streaming + session 续接

**步骤**：

1. **项目初始化**
   - `git init`、`.gitignore`
   - `package.json`、`tsconfig.json`
   - 安装依赖：`typescript`、`yaml`、`@types/node`
   - `config.example.yaml`

2. **类型定义** (`src/types.ts`)
   - OpenAI ChatCompletion 请求/响应类型
   - OpenAI streaming chunk 类型
   - Provider 抽象接口
   - Session 映射类型

3. **消息序列化** (`src/messages.ts`)
   - OpenAI messages → 纯文本 prompt
   - system message 提取

4. **Session 管理** (`src/session.ts`)
   - Session Map CRUD
   - TTL 过期清理定时器
   - CLI session_id 捕获

5. **配置模块** (`src/config.ts`)
   - 加载 config.yaml
   - 环境变量覆盖
   - 模型别名映射

6. **Provider 实现**
   - `src/providers/base.ts` — 抽象接口（含 session 支持）
   - `src/providers/gemini.ts` — spawn `gemini` 进程，stdin pipe，解析输出
   - `src/providers/claude.ts` — spawn `claude` 进程，stdin pipe，解析输出
   - 非 streaming + streaming 两种模式
   - session 续接：检测 X-Session-Id → `--resume`

7. **HTTP Server + 路由**
   - `GET /v1/models` — 返回配置的模型列表
   - `POST /v1/chat/completions` — 核心代理逻辑
   - model 字段路由到对应 provider
   - streaming / 非 streaming 分支
   - X-Session-Id 处理

8. **测试与验证**

**产出**：`npx tsc && node dist/index.js` 启动，curl 调通

---

### Phase 2：生产可用

9. **错误处理** — CLI 退出码映射、超时处理、未安装检测
10. **模型路由与别名** — config.yaml 配置映射
11. **日志** — 请求摘要、stderr 记录

---

### Phase 3：高级功能（按需）

12. **Function Calling**（prompt 工程方案）
    - 将 OpenAI tools 定义注入 prompt
    - Claude Code 配合 `--json-schema` 约束输出格式
    - 解析模型输出中的 tool_calls
13. 更多 CLI 后端（Ollama 等）
14. 本地认证、速率限制
15. 并发请求管理

## 验证标准

```bash
# 1. 编译 & 启动
npx tsc && node dist/index.js

# 2. 模型列表
curl http://localhost:9090/v1/models

# 3. Gemini 非 streaming
curl http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini","messages":[{"role":"user","content":"hello"}]}'

# 4. Claude streaming
curl http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude","messages":[{"role":"user","content":"hello"}],"stream":true}'

# 5. Session 续接测试
# 首次请求，获取 session id
curl -v http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude","messages":[{"role":"user","content":"My name is Alice"}]}'
# 响应头中获取 X-Session-Id: <id>

# 续接请求
curl http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: <id>" \
  -d '{"model":"claude","messages":[{"role":"user","content":"What is my name?"}]}'

# 6. 错误场景
curl http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"nonexistent","messages":[{"role":"user","content":"hello"}]}'

# 7. Python 客户端验证
python3 -c "
from openai import OpenAI
client = OpenAI(base_url='http://localhost:9090/v1', api_key='any')
r = client.chat.completions.create(model='gemini', messages=[{'role':'user','content':'hi'}])
print(r.choices[0].message.content)
"
```
