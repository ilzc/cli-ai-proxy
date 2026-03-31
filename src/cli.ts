#!/usr/bin/env node

/**
 * cli-ai-proxy CLI — manage the local OpenAI-compatible proxy.
 *
 * Usage:
 *   cli-ai-proxy start   [-p port] [-h host] [-d]
 *   cli-ai-proxy stop
 *   cli-ai-proxy restart  [-p port] [-h host]
 *   cli-ai-proxy status
 *   cli-ai-proxy health
 *   cli-ai-proxy configure-openclaw [--token TOKEN]
 *   cli-ai-proxy help
 */

import { spawn, execSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { get as httpGet } from "node:http";

// ─── Paths ───

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "..");
const PID_FILE = join(PROJECT_ROOT, ".proxy.pid");
const LOG_FILE = join(PROJECT_ROOT, "proxy.log");
const DIST_INDEX = join(PROJECT_ROOT, "dist", "index.js");
const CONFIG_FILE = join(PROJECT_ROOT, "config.yaml");
const CONFIG_EXAMPLE = join(PROJECT_ROOT, "config.example.yaml");

// ─── Helpers ───

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  if (isNaN(pid)) return null;
  try {
    process.kill(pid, 0); // check if alive
    return pid;
  } catch {
    unlinkSync(PID_FILE);
    return null;
  }
}

function writePid(pid: number): void {
  writeFileSync(PID_FILE, String(pid));
}

function getConfig(): { host: string; port: number } {
  const defaults = { host: "127.0.0.1", port: 9090 };
  if (!existsSync(CONFIG_FILE)) return defaults;
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const hostMatch = raw.match(/host:\s*["']?([^"'\s]+)/);
    const portMatch = raw.match(/port:\s*(\d+)/);
    return {
      host: hostMatch?.[1] ?? defaults.host,
      port: portMatch ? parseInt(portMatch[1]!, 10) : defaults.port,
    };
  } catch {
    return defaults;
  }
}

function fetchJson(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, { timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`Invalid JSON from ${url}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
  });
}

function ensureBuilt(): void {
  if (!existsSync(DIST_INDEX)) {
    console.log("Building...");
    execSync("npm run build", { cwd: PROJECT_ROOT, stdio: "inherit" });
  }
}

function ensureConfig(): void {
  if (!existsSync(CONFIG_FILE) && existsSync(CONFIG_EXAMPLE)) {
    writeFileSync(CONFIG_FILE, readFileSync(CONFIG_EXAMPLE));
    console.log(`Created config.yaml from config.example.yaml`);
  }
}

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--") && i + 1 < args.length) {
      result[arg.slice(2)] = args[++i]!;
    } else if (arg === "-p" && i + 1 < args.length) {
      result["port"] = args[++i]!;
    } else if (arg === "-h" && i + 1 < args.length) {
      result["host"] = args[++i]!;
    } else if (arg === "-d") {
      result["detach"] = "true";
    }
  }
  return result;
}

// ─── Commands ───

async function cmdStart(args: string[]): Promise<void> {
  const pid = readPid();
  if (pid) {
    console.log(`Already running (PID: ${pid})`);
    return;
  }

  ensureBuilt();
  ensureConfig();

  const opts = parseArgs(args);
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  if (opts["port"]) env["CLI_AI_PORT"] = opts["port"];
  if (opts["host"]) env["CLI_AI_HOST"] = opts["host"];

  const child = spawn("node", [DIST_INDEX], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  // Write logs
  const logStream = (await import("node:fs")).createWriteStream(LOG_FILE, {
    flags: "a",
  });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);
  child.unref();

  writePid(child.pid!);
  console.log(`Started (PID: ${child.pid})`);
  console.log(`Log: ${LOG_FILE}`);

  // Wait a moment and verify
  await new Promise((r) => setTimeout(r, 1000));
  const { host, port } = getConfig();
  const effectivePort = opts["port"] ?? String(port);
  const effectiveHost = opts["host"] ?? host;
  try {
    await fetchJson(`http://${effectiveHost}:${effectivePort}/health`);
    console.log(`Listening on http://${effectiveHost}:${effectivePort}`);
  } catch {
    console.log(`Server starting on http://${effectiveHost}:${effectivePort} (may take a moment)`);
  }
}

function cmdStop(): void {
  const pid = readPid();
  if (!pid) {
    console.log("Not running");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    unlinkSync(PID_FILE);
    console.log(`Stopped (PID: ${pid})`);
  } catch (err) {
    console.error(`Failed to stop PID ${pid}:`, err);
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  }
}

async function cmdRestart(args: string[]): Promise<void> {
  cmdStop();
  await new Promise((r) => setTimeout(r, 500));
  await cmdStart(args);
}

async function cmdStatus(): Promise<void> {
  const pid = readPid();
  if (!pid) {
    console.log("Status: stopped");
    return;
  }

  console.log(`Status: running (PID: ${pid})`);
  const { host, port } = getConfig();
  try {
    const data = await fetchJson(`http://${host}:${port}/health`);
    console.log(`Health: ${JSON.stringify(data, null, 2)}`);
  } catch {
    console.log(`Health: unreachable at http://${host}:${port}`);
  }
}

async function cmdHealth(): Promise<void> {
  const { host, port } = getConfig();
  try {
    const data = await fetchJson(`http://${host}:${port}/health`);
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Proxy not reachable at http://${host}:${port}`);
    process.exit(1);
  }
}

function cmdConfigureOpenclaw(args: string[]): void {
  const opts = parseArgs(args);
  const { host, port } = getConfig();
  const openclawConfig = join(
    process.env["HOME"] ?? "~",
    ".openclaw",
    "openclaw.json",
  );

  if (!existsSync(openclawConfig)) {
    console.error(`OpenClaw config not found: ${openclawConfig}`);
    console.error("Is OpenClaw installed? Run: openclaw onboard");
    process.exit(1);
  }

  const raw = readFileSync(openclawConfig, "utf-8");
  const config = JSON.parse(raw);

  // Backup
  writeFileSync(openclawConfig + ".bak", raw);

  // Add cli-ai-proxy provider
  if (!config.models) config.models = {};
  config.models.mode = config.models.mode ?? "merge";
  if (!config.models.providers) config.models.providers = {};

  config.models.providers["cli-ai-proxy"] = {
    baseUrl: `http://${host}:${port}/v1`,
    apiKey: "no-key-needed",
    api: "openai-completions",
    models: [
      {
        id: "gemini",
        name: "Gemini (CLI default model)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 8192,
      },
      {
        id: "claude",
        name: "Claude (CLI default model)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
      {
        id: "claude-sonnet",
        name: "Claude Sonnet (via CLI)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
      {
        id: "claude-opus",
        name: "Claude Opus (via CLI)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  };

  // Register models in agent defaults
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  if (!config.agents.defaults.models) config.agents.defaults.models = {};

  const proxyModels = [
    "cli-ai-proxy/gemini",
    "cli-ai-proxy/claude",
    "cli-ai-proxy/claude-sonnet",
    "cli-ai-proxy/claude-opus",
  ];
  for (const m of proxyModels) {
    if (!config.agents.defaults.models[m]) {
      config.agents.defaults.models[m] = {};
    }
  }

  writeFileSync(openclawConfig, JSON.stringify(config, null, 2) + "\n");
  console.log("OpenClaw configured:");
  console.log(`  Provider: cli-ai-proxy → http://${host}:${port}/v1`);
  console.log(`  Models: ${proxyModels.join(", ")}`);
  console.log(`  Backup: ${openclawConfig}.bak`);
  console.log("");
  console.log("To set as default model:");
  console.log(
    '  Set agents.defaults.model.primary to "cli-ai-proxy/gemini" in openclaw.json',
  );
}

function cmdHelp(): void {
  console.log(`cli-ai-proxy — Local OpenAI-compatible proxy for AI CLI tools

Usage:
  cli-ai-proxy start   [-p port] [-h host]   Start the proxy server
  cli-ai-proxy stop                           Stop the proxy server
  cli-ai-proxy restart  [-p port] [-h host]   Restart the proxy server
  cli-ai-proxy status                         Show running status and health
  cli-ai-proxy health                         Show health check (JSON)
  cli-ai-proxy configure-openclaw             Auto-configure OpenClaw provider
  cli-ai-proxy help                           Show this help

Environment:
  CLI_AI_HOST        Override listen host
  CLI_AI_PORT        Override listen port
  GEMINI_CLI_PATH    Path to gemini CLI binary
  CLAUDE_CLI_PATH    Path to claude CLI binary

Config: ${CONFIG_FILE}
Logs:   ${LOG_FILE}`);
}

// ─── Main ───

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "start":
    await cmdStart(args);
    break;
  case "stop":
    cmdStop();
    break;
  case "restart":
    await cmdRestart(args);
    break;
  case "status":
    await cmdStatus();
    break;
  case "health":
    await cmdHealth();
    break;
  case "configure-openclaw":
    cmdConfigureOpenclaw(args);
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    cmdHelp();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    cmdHelp();
    process.exit(1);
}
