import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Config } from "./types.js";
import * as log from "./utils/logger.js";

const DEFAULT_CONFIG: Config = {
  server: {
    host: "127.0.0.1",
    port: 9090,
  },
  session: {
    ttl: 1800,
  },
  concurrency: {
    max: 5,
    maxQueued: 50,
  },
  defaultModel: "gemini",
  timeout: 300_000, // 5 分钟
  cli: {
    gemini: "gemini",
    claude: "claude",
  },
  models: {
    gemini: { provider: "gemini", model: "gemini-2.5-flash" },
    "gemini-pro": { provider: "gemini", model: "gemini-2.5-pro" },
    claude: { provider: "claude", model: "sonnet" },
    "claude-opus": { provider: "claude", model: "opus" },
  },
};

export function loadConfig(configPath = "config.yaml"): Config {
  let fileConfig: Record<string, unknown> = {};

  const absPath = resolve(configPath);
  if (existsSync(absPath)) {
    const raw = readFileSync(absPath, "utf-8");
    fileConfig = (parseYaml(raw) as Record<string, unknown>) ?? {};
    log.info(`Loaded config from ${absPath}`);
  } else {
    log.info(`No config file found at ${absPath}, using defaults`);
  }

  const fc = fileConfig as Partial<Config>;

  const config: Config = {
    server: {
      host:
        process.env["UNI_AI_HOST"] ??
        fc.server?.host ??
        DEFAULT_CONFIG.server.host,
      port: process.env["UNI_AI_PORT"]
        ? parseInt(process.env["UNI_AI_PORT"], 10)
        : fc.server?.port ?? DEFAULT_CONFIG.server.port,
    },
    session: {
      ttl: fc.session?.ttl ?? DEFAULT_CONFIG.session.ttl,
    },
    concurrency: {
      max: fc.concurrency?.max ?? DEFAULT_CONFIG.concurrency.max,
      maxQueued: fc.concurrency?.maxQueued ?? DEFAULT_CONFIG.concurrency.maxQueued,
    },
    defaultModel: fc.defaultModel ?? DEFAULT_CONFIG.defaultModel,
    timeout: (fc.timeout ?? DEFAULT_CONFIG.timeout),
    cli: {
      gemini:
        process.env["GEMINI_CLI_PATH"] ??
        (fc.cli?.gemini || DEFAULT_CONFIG.cli.gemini),
      claude:
        process.env["CLAUDE_CLI_PATH"] ??
        (fc.cli?.claude || DEFAULT_CONFIG.cli.claude),
    },
    models: {
      ...DEFAULT_CONFIG.models,
      ...fc.models,
    },
  };

  return config;
}
