import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig } from "./config.js";
import { initSessionManager, stopSessionManager } from "./session.js";
import { handleModels, handleChatCompletions, handleHealth } from "./router.js";
import { killAllChildren } from "./providers/base.js";
import * as log from "./utils/logger.js";
import { makeError } from "./utils/errors.js";

const config = loadConfig();
initSessionManager(config.session.ttl);

// ─── CORS ───

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Session-Id",
  );
  res.setHeader("Access-Control-Expose-Headers", "X-Session-Id");
}

// ─── Server ───

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  setCors(res);

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method?.toUpperCase();

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (method === "GET" && path === "/v1/models") {
      handleModels(config, req, res);
    } else if (method === "POST" && path === "/v1/chat/completions") {
      await handleChatCompletions(config, req, res);
    } else if (method === "GET" && path === "/health") {
      await handleHealth(config, req, res);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          makeError(
            `Not found: ${method} ${path}`,
            "invalid_request_error",
            "not_found",
          ),
        ),
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Unhandled error: ${message}`);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(makeError("Internal server error", "server_error")),
      );
    }
  }
});

// ─── Graceful shutdown ───

function shutdown(signal: string): void {
  log.info(`Received ${signal}, shutting down...`);

  // 停止接受新连接
  server.close(() => {
    log.info("HTTP server closed");
    stopSessionManager();
    process.exit(0);
  });

  // 杀掉所有活跃子进程
  killAllChildren();

  // 5 秒后强制退出
  setTimeout(() => {
    log.warn("Forced shutdown after timeout");
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Start ───

server.listen(config.server.port, config.server.host, () => {
  log.info(
    `CLI AI Proxy listening on http://${config.server.host}:${config.server.port}`,
  );
  log.info(`Models: ${Object.keys(config.models).join(", ")}`);
  log.info(`Default model: ${config.defaultModel}`);
});
