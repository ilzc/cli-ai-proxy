import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  Config,
  ModelsResponse,
  ProviderName,
} from "./types.js";
import type { Provider } from "./providers/base.js";
import { activeChildCount } from "./providers/base.js";
import { GeminiProvider } from "./providers/gemini.js";
import { ClaudeProvider } from "./providers/claude.js";
import { createSession, getSession } from "./session.js";
import { Semaphore, QueueFullError } from "./concurrency.js";
import { makeError, CliError, CliNotFoundError, CliTimeoutError } from "./utils/errors.js";
import * as log from "./utils/logger.js";
import { execFile } from "node:child_process";
import type { SessionEntry } from "./types.js";

const providers: Record<string, Provider> = {
  gemini: new GeminiProvider(),
  claude: new ClaudeProvider(),
};

let semaphore: Semaphore | null = null;

function getSemaphore(config: Config): Semaphore {
  if (!semaphore) {
    semaphore = new Semaphore(config.concurrency.max, config.concurrency.maxQueued);
    log.info(`Concurrency limit: max=${config.concurrency.max}, maxQueued=${config.concurrency.maxQueued}`);
  }
  return semaphore;
}

// ─── /v1/models ───

export function handleModels(
  config: Config,
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  const now = Math.floor(Date.now() / 1000);
  const response: ModelsResponse = {
    object: "list",
    data: Object.entries(config.models).map(([id, mapping]) => ({
      id,
      object: "model" as const,
      created: now,
      owned_by: mapping.provider,
    })),
  };
  sendJson(res, 200, response);
}

// ─── /v1/chat/completions ───

export async function handleChatCompletions(
  config: Config,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  let request: ChatCompletionRequest;
  try {
    request = JSON.parse(body);
  } catch {
    sendJson(res, 400, makeError("Invalid JSON in request body"));
    return;
  }

  // 请求校验
  if (
    !request.messages ||
    !Array.isArray(request.messages) ||
    request.messages.length === 0
  ) {
    sendJson(
      res,
      400,
      makeError("messages is required and must be a non-empty array"),
    );
    return;
  }

  const validRoles = new Set(["system", "user", "assistant", "tool"]);
  for (const msg of request.messages) {
    if (!msg.role) {
      sendJson(res, 400, makeError("Each message must have a 'role'"));
      return;
    }
    // content 可以是 string、ContentPart[] 或 null
    const ct = msg.content;
    if (ct !== null && ct !== undefined && typeof ct !== "string" && !Array.isArray(ct)) {
      sendJson(res, 400, makeError("Message content must be a string, array, or null"));
      return;
    }
    if (!validRoles.has(msg.role)) {
      sendJson(
        res,
        400,
        makeError(
          `Invalid message role: '${msg.role}'. Must be one of: ${[...validRoles].join(", ")}`,
        ),
      );
      return;
    }
  }

  // 解析模型
  const modelName = request.model ?? config.defaultModel;
  const modelMapping = config.models[modelName];
  if (!modelMapping) {
    sendJson(
      res,
      400,
      makeError(
        `Unknown model: ${modelName}. Available: ${Object.keys(config.models).join(", ")}`,
        "invalid_request_error",
        "model_not_found",
      ),
    );
    return;
  }

  const provider = providers[modelMapping.provider];
  if (!provider) {
    sendJson(
      res,
      500,
      makeError(`No provider for: ${modelMapping.provider}`, "server_error"),
    );
    return;
  }

  const cliPath = config.cli[modelMapping.provider];

  // Session 处理
  const sessionId = req.headers["x-session-id"] as string | undefined;
  const session = sessionId ? getSession(sessionId) : undefined;
  const cliSessionId = session?.cliSessionId;

  // Session 存在但 provider 不匹配时警告
  if (session && session.provider !== modelMapping.provider) {
    log.warn(
      `Session ${sessionId} provider mismatch: ${session.provider} vs ${modelMapping.provider}, starting new session`,
    );
  }

  const effectiveCliSessionId =
    session && session.provider === modelMapping.provider
      ? cliSessionId
      : undefined;

  const startTime = Date.now();
  const sem = getSemaphore(config);

  try {
    await sem.acquire();
  } catch (err) {
    if (err instanceof QueueFullError) {
      sendJson(res, 429, makeError(err.message, "server_error", "rate_limit_exceeded"));
      return;
    }
    throw err;
  }

  try {
    if (request.stream) {
      await handleStream(
        config,
        provider,
        modelMapping,
        request,
        cliPath,
        effectiveCliSessionId,
        sessionId,
        session,
        res,
        modelName,
        startTime,
      );
    } else {
      await handleNonStream(
        config,
        provider,
        modelMapping,
        request,
        cliPath,
        effectiveCliSessionId,
        sessionId,
        session,
        res,
        modelName,
        startTime,
      );
    }
  } catch (err) {
    handleProviderError(err, cliPath, res);
  } finally {
    sem.release();
  }
}

async function handleNonStream(
  config: Config,
  provider: Provider,
  modelMapping: { provider: ProviderName; model: string },
  request: ChatCompletionRequest,
  cliPath: string,
  cliSessionId: string | undefined,
  sessionId: string | undefined,
  session: SessionEntry | undefined,
  res: ServerResponse,
  modelName: string,
  startTime: number,
): Promise<void> {
  const result = await provider.complete({
    model: modelMapping.model,
    messages: request.messages,
    cliPath,
    cliSessionId,
    timeoutMs: config.timeout ?? 300_000,
  });

  // Session 管理
  let responseSessionId = sessionId;
  if (result.cliSessionId) {
    if (sessionId && session) {
      session.cliSessionId = result.cliSessionId;
    } else {
      responseSessionId = createSession(
        modelMapping.provider,
        modelMapping.model,
        result.cliSessionId,
      );
    }
  }

  const response: ChatCompletionResponse = {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelMapping.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.content },
        finish_reason: result.finishReason ?? "stop",
      },
    ],
    usage: result.usage,
  };

  const headers: Record<string, string> = {};
  if (responseSessionId) {
    headers["X-Session-Id"] = responseSessionId;
  }

  sendJson(res, 200, response, headers);

  log.info(
    `model=${modelName} duration=${Date.now() - startTime}ms tokens=${result.usage?.total_tokens ?? "-"}`,
  );
}

async function handleStream(
  config: Config,
  provider: Provider,
  modelMapping: { provider: ProviderName; model: string },
  request: ChatCompletionRequest,
  cliPath: string,
  cliSessionId: string | undefined,
  sessionId: string | undefined,
  session: SessionEntry | undefined,
  res: ServerResponse,
  modelName: string,
  startTime: number,
): Promise<void> {
  // Streaming 模式下，先设置 X-Session-Id（如果有）
  if (sessionId && session) {
    res.setHeader("X-Session-Id", sessionId);
  }

  const result = await provider.stream(
    {
      model: modelMapping.model,
      messages: request.messages,
      cliPath,
      cliSessionId,
      timeoutMs: config.timeout ?? 300_000,
    },
    res,
  );

  // 更新或创建 session
  if (result.cliSessionId) {
    if (sessionId && session) {
      session.cliSessionId = result.cliSessionId;
    } else {
      const newSessionId = createSession(
        modelMapping.provider,
        modelMapping.model,
        result.cliSessionId,
      );
      log.info(`New session: ${newSessionId}`);
    }
  }

  log.info(
    `[stream] model=${modelName} duration=${Date.now() - startTime}ms`,
  );
}

function handleProviderError(
  err: unknown,
  cliPath: string,
  res: ServerResponse,
): void {
  if (res.headersSent) {
    // Streaming 已经开始发送，只能记录日志
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Provider error (headers sent): ${msg}`);
    if (!res.destroyed) res.end();
    return;
  }

  if (err instanceof CliNotFoundError) {
    sendJson(
      res,
      503,
      makeError(
        `CLI tool not available: ${err.cliPath}. Please install it first.`,
        "server_error",
        "cli_not_found",
      ),
    );
  } else if (err instanceof CliTimeoutError) {
    sendJson(
      res,
      504,
      makeError(
        `Request timed out after ${err.timeoutMs}ms`,
        "server_error",
        "timeout",
      ),
    );
  } else if (err instanceof CliError) {
    sendJson(
      res,
      502,
      makeError(err.message, "server_error", "cli_error"),
    );
  } else {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Provider error: ${message}`);
    sendJson(res, 500, makeError(message, "server_error"));
  }
}

// ─── /health ───

export async function handleHealth(
  config: Config,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const checks: Record<string, { available: boolean; version?: string }> = {};

  for (const [name, cliPath] of Object.entries(config.cli)) {
    try {
      const version = await getCliVersion(cliPath);
      checks[name] = { available: true, version };
    } catch {
      checks[name] = { available: false };
    }
  }

  const anyAvailable = Object.values(checks).some((c) => c.available);
  const statusCode = anyAvailable ? 200 : 503;
  const status = anyAvailable ? "ok" : "degraded";

  const sem = getSemaphore(config);
  sendJson(res, statusCode, {
    status,
    activeProcesses: activeChildCount(),
    concurrency: {
      active: sem.active,
      pending: sem.pending,
      max: config.concurrency.max,
      maxQueued: config.concurrency.maxQueued,
    },
    providers: checks,
  });
}

function getCliVersion(cliPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cliPath, ["--version"], { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim().split("\n")[0] ?? "unknown");
    });
  });
}

// ─── Utils ───

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  data: unknown,
  extraHeaders?: Record<string, string>,
): void {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    ...extraHeaders,
  });
  res.end(body);
}
