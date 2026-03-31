import { spawn, type ChildProcess } from "node:child_process";
import type { ServerResponse } from "node:http";
import type { Provider, ProviderOptions } from "./base.js";
import { trackChild } from "./base.js";
import type { ProviderResult } from "../types.js";
import { serializeMessages, extractText } from "../messages.js";
import { CliError, CliNotFoundError, CliTimeoutError } from "../utils/errors.js";
import * as log from "../utils/logger.js";
import { sendSSEChunk, sendSSEDone, sendSSEError, sendSSEFinish, writeSSEHeaders } from "../sse.js";

export class ClaudeProvider implements Provider {
  readonly name = "claude";

  async complete(options: ProviderOptions): Promise<ProviderResult> {
    const { systemPrompt, prompt } = this.buildPrompt(options);
    const args = buildArgs(options, "json", systemPrompt);

    const { stdout, stderr, exitCode } = await runCli(
      options.cliPath,
      args,
      prompt,
      options.timeoutMs,
    );

    if (stderr) log.debug("Claude stderr:", stderr.trim());

    if (exitCode !== 0) {
      throw new CliError(
        `Claude CLI exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
        exitCode,
        stderr,
      );
    }

    try {
      const parsed = JSON.parse(stdout);

      if (parsed.is_error) {
        throw new CliError(
          `Claude error: ${parsed.result ?? "unknown error"}`,
          1,
          parsed.result ?? "",
        );
      }

      return {
        content: typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed),
        cliSessionId: parsed.session_id,
        usage: extractUsage(parsed),
        finishReason: "stop",
      };
    } catch (e) {
      if (e instanceof CliError) throw e;
      log.warn("Claude JSON parse failed, falling back to plaintext");
      if (!stdout.trim()) {
        throw new CliError("Claude CLI returned empty output", 0, stderr);
      }
      return { content: stdout.trim(), finishReason: "stop" };
    }
  }

  async stream(
    options: ProviderOptions,
    res: ServerResponse,
  ): Promise<{ cliSessionId?: string }> {
    const { systemPrompt, prompt } = this.buildPrompt(options);
    const args = buildArgs(options, "stream-json", systemPrompt);
    args.push("--verbose");

    const id = `chatcmpl-${Date.now()}`;
    const model = options.model;

    // 先尝试 spawn，如果立即失败可以在 headers 发送前抛错
    let child: ChildProcess;
    try {
      child = spawn(options.cliPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      throw new CliNotFoundError(options.cliPath);
    }
    trackChild(child);

    // spawn 成功但可能异步 ENOENT，用 flag 跟踪
    let spawnFailed = false;
    const spawnErrorPromise = new Promise<void>((_, reject) => {
      child.on("error", (err) => {
        spawnFailed = true;
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new CliNotFoundError(options.cliPath));
        } else {
          reject(err);
        }
      });
    });

    // 等一个 tick 看 spawn 是否立即失败（ENOENT 在下一个 tick 触发）
    await new Promise((r) => setTimeout(r, 10));
    if (spawnFailed) {
      return spawnErrorPromise as never;
    }

    // spawn 成功，现在安全地发送 SSE headers
    writeSSEHeaders(res);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        sendSSEError(res, "Request timed out");
        sendSSEDone(res);
        if (!res.writableEnded) res.end();
        reject(new CliTimeoutError(options.timeoutMs));
      }, options.timeoutMs);

      child.stdin!.write(prompt);
      child.stdin!.end();

      let stderrBuf = "";
      let buffer = "";
      let cliSessionId: string | undefined;

      res.on("close", () => {
        clearTimeout(timeout);
        if (!child.killed) child.kill("SIGTERM");
      });

      child.stdout!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const event = JSON.parse(trimmed);

            if (event.session_id) {
              cliSessionId = event.session_id;
            }

            // Claude stream-json text_delta 事件
            if (
              event.type === "stream_event" &&
              event.event?.delta?.type === "text_delta"
            ) {
              const text = event.event.delta.text;
              if (text) sendSSEChunk(res, id, model, text);
            }

            // content_block_delta 格式
            if (event.type === "content_block_delta" && event.delta?.text) {
              sendSSEChunk(res, id, model, event.delta.text);
            }
          } catch {
            // 非 JSON 行忽略
          }
        }
      });

      child.stderr!.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });

      child.on("close", () => {
        clearTimeout(timeout);

        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer.trim());
            if (event.session_id) {
              cliSessionId = event.session_id;
            }
          } catch {
            // ignore
          }
        }

        if (stderrBuf) log.debug("Claude stderr:", stderrBuf.trim());

        sendSSEFinish(res, id, model);
        sendSSEDone(res);
        if (!res.writableEnded) res.end();
        resolve({ cliSessionId });
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        log.error("Claude spawn error:", err.message);
        sendSSEError(res, `CLI error: ${err.message}`);
        sendSSEDone(res);
        if (!res.writableEnded) res.end();
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new CliNotFoundError(options.cliPath));
        } else {
          reject(err);
        }
      });
    });
  }

  private buildPrompt(options: ProviderOptions): {
    systemPrompt: string | null;
    prompt: string;
  } {
    if (options.cliSessionId) {
      const lastMsg = extractText(
        options.messages[options.messages.length - 1]?.content ?? "",
      );
      return { systemPrompt: null, prompt: lastMsg };
    }
    return serializeMessages(options.messages);
  }
}

function buildArgs(
  options: ProviderOptions,
  outputFormat: string,
  systemPrompt: string | null,
): string[] {
  // Claude Code 必须带 -p flag 才能进入非交互模式
  // stdin pipe 的内容作为 prompt
  // 不使用 --bare：它会跳过 keychain/OAuth 认证读取导致 "Not logged in"
  const args: string[] = ["-p"];

  if (options.cliSessionId) {
    args.push("--resume", options.cliSessionId);
  }

  args.push("--output-format", outputFormat);
  args.push("--model", options.model);

  if (systemPrompt && !options.cliSessionId) {
    args.push("--system-prompt", systemPrompt);
  }

  return args;
}

function runCli(
  cliPath: string,
  args: string[],
  stdinData: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    trackChild(child);

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new CliTimeoutError(timeoutMs));
    }, timeoutMs);

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdin.write(stdinData);
    child.stdin.end();

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new CliNotFoundError(cliPath));
      } else {
        reject(err);
      }
    });
  });
}

function extractUsage(
  parsed: Record<string, unknown>,
): { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined {
  const usage = parsed.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, number>;
  const prompt = u.input_tokens ?? 0;
  const completion = u.output_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}
