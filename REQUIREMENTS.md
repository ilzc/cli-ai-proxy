# CLI AI Proxy - 需求文档

## 项目概述

本地 AI API 统一代理服务。对外暴露 OpenAI 兼容的 REST API（`/v1/chat/completions`），对内通过子进程调用本地已安装的 AI CLI 工具（Gemini CLI、Claude Code 等），使任何支持 OpenAI API 格式的本地程序都能无缝使用各家 AI 模型。

## 背景

- 大量本地工具（IDE 插件、CLI 工具、自动化脚本）只支持 OpenAI API 格式
- 各家 AI 都提供了本地 CLI 工具，认证和会话管理由 CLI 自身处理
- 需要一个轻量级本地代理，将 OpenAI API 请求转换为 CLI 调用，无需管理各家 API Key
- 自主可控，避免供应链风险

## 核心需求

### P0 - 必须实现

1. **OpenAI 兼容 HTTP 服务**
   - 监听本地端口（默认 `127.0.0.1:9090`）
   - 实现 `POST /v1/chat/completions` 端点
   - 实现 `GET /v1/models` 端点（列出可用模型）
   - 请求/响应格式兼容 OpenAI API 规范
   - 响应包含必要的元数据字段（`id`、`created`、`object`、`model`），由代理层生成

2. **Gemini CLI 后端适配**
   - 通过 stdin pipe 传入 prompt（避免命令行参数长度限制）
   - `--output-format json` 获取结构化输出
   - 支持 `--model` 参数指定模型
   - 解析 JSON 输出，转换为 OpenAI 响应格式

3. **Claude Code 后端适配**
   - 通过 stdin pipe 传入 prompt
   - `--output-format json --bare` 获取结构化输出，跳过插件加载
   - 支持 `--model` 参数（sonnet、opus 等）
   - 支持 `--system-prompt` 传递系统提示
   - 解析 JSON 输出，转换为 OpenAI 响应格式

4. **Streaming 支持**
   - 支持 `stream: true` 的 SSE 响应
   - Gemini CLI：流式读取 stdout 输出
   - Claude Code：使用 `--output-format stream-json`，解析 JSONL 事件流中的 `text_delta`
   - 将 CLI 的流式输出转换为 OpenAI delta 格式的 SSE chunk
   - 正确发送 `[DONE]` 结束标记

5. **消息序列化**
   - 将 OpenAI messages 数组转换为 CLI 可接受的 prompt 文本
   - system message 单独提取：Claude Code 用 `--system-prompt` 传递，Gemini 编入 prompt 头部
   - 多轮对话以角色标记拼接完整历史
   - prompt 始终通过 stdin pipe 传入 CLI

6. **Session 管理**
   - 利用 CLI 自身的 session 续接能力（Claude `--resume`、Gemini `--resume`）
   - 客户端通过 `X-Session-Id` 请求头标识同一对话
   - **首次请求**（无 header 或新 session）：完整 messages → CLI，捕获 CLI 返回的 session_id，建立映射
   - **续接请求**（已知 session）：`--resume <cli_session_id>`，只发送最新一条 user message
   - **无 header 时**：退化为无状态模式，每次发送完整 messages
   - 响应中返回 `X-Session-Id` header，便于客户端后续续接
   - 内存中维护映射表：`proxySessionId → { cliSessionId, provider, lastActive }`
   - TTL 过期清理（默认 30 分钟无活动则删除映射）
   - 代理重启后映射丢失，客户端需重新开始对话

7. **配置管理**
   - YAML 配置文件（`config.yaml`）
   - 配置项：
     - 监听地址/端口
     - 各 CLI 工具路径（默认使用 PATH 中的命令）
     - 模型别名映射
     - 默认模型
     - Session TTL
   - 支持环境变量覆盖

### P1 - 高优先级

8. **错误处理**
   - CLI 进程非零退出码 → OpenAI error 格式
   - CLI 启动失败（未安装）→ 503 Service Unavailable
   - CLI 执行超时 → 504 Gateway Timeout（可配置超时时间）
   - stderr 内容记录到日志

9. **多模型路由**
   - 请求中的 `model` 字段映射到对应 CLI 后端
   - 支持模型别名（如 `gpt-4` → Claude opus，`gpt-4o-mini` → Gemini flash）
   - 未指定模型时使用默认模型

10. **日志**
    - 请求/响应摘要日志（model、耗时、prompt 长度）
    - CLI 的 stderr 输出记录
    - 可配置日志级别

### P2 - 后续迭代

11. **Function Calling / Tool Use**
    - 接收 OpenAI tools/functions 定义
    - 将 tool 定义编码到 prompt 中，指示模型以 JSON 格式返回 tool_calls
    - Claude Code 配合 `--json-schema` 约束输出格式
    - 解析模型输出中的 tool_calls 结构
    - 返回 OpenAI 兼容的 tool_calls 响应

12. **OpenClaw 后端适配**
    - 通过 `openclaw agent --local --json --message` 调用
    - 所有输出走 stderr，需从混合日志中提取 JSON
    - 支持 `--session-id` 续接会话
    - 不支持原生 streaming，代理层模拟 SSE 输出
    - 自带工具能力（read/write/exec/web_search 等）

13. **更多后端适配**
    - Ollama CLI（已兼容 OpenAI API，可直接转发）
    - 其他支持 CLI 的 AI 工具

14. **高级功能**
    - API Key 认证（可选，保护本地服务）
    - 并发请求管理（限制同时运行的 CLI 进程数）
    - 简易 Web 管理界面

## API 兼容性策略

- **不支持的参数静默忽略**：`temperature`、`top_p`、`max_tokens`、`stop`、`n`、`presence_penalty`、`frequency_penalty` 等 CLI 无法传递的参数直接丢弃，不报错
- **usage 字段**：如果 CLI 输出包含 token 统计则填充，否则省略或返回 0
- **n > 1**：不支持多路生成，忽略该参数，始终返回 1 个 choice
- **元数据生成**：`id` 用 UUID，`created` 用当前时间戳，`model` 返回实际使用的模型名

## 非功能需求

- **轻量级**：极少依赖，启动快
- **稳定性**：长时间运行不泄漏内存，子进程正确回收
- **安全性**：仅监听 loopback，不在日志中暴露完整 prompt

## 技术约束

- 运行时：Node.js（原生 `http` 模块）
- 不使用第三方 AI SDK
- 通过子进程调用本地 CLI 工具，不直接调用任何 AI REST API
- 最小化外部依赖
