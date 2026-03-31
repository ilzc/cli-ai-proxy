import { spawn, type ChildProcess } from "node:child_process";
import type { ServerResponse } from "node:http";
import type { Provider, ProviderOptions } from "./base.js";
import { trackChild } from "./base.js";
import type { ProviderResult } from "../types.js";
import { serializeForGemini, extractText } from "../messages.js";
import { CliError, CliNotFoundError, CliTimeoutError } from "../utils/errors.js";
import * as log from "../utils/logger.js";
import { sendSSEChunk, sendSSEDone, sendSSEError, sendSSEFinish, writeSSEHeaders } from "../sse.js";

export class GeminiProvider implements Provider {
  readonly name = "gemini";

  async complete(options: ProviderOptions): Promise<ProviderResult> {
    const prompt = options.cliSessionId
      ? extractText(options.messages[options.messages.length - 1]?.content ?? "")
      : serializeForGemini(options.messages);

    // 使用 stream-json 而非 json，以便捕获 session_id
    const args = buildArgs(options, "stream-json");
    const { stdout, stderr, exitCode } = await runCli(
      options.cliPath,
      args,
      prompt,
      options.timeoutMs,
    );

    if (stderr) log.debug("Gemini stderr:", stderr.trim());

    if (exitCode !== 0) {
      throw new CliError(
        `Gemini CLI exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
        exitCode,
        stderr,
      );
    }

    // stream-json 输出为 JSONL，逐行解析提取内容和 session_id
    let content = "";
    let cliSessionId: string | undefined;
    let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);

        if (event.type === "init" && event.session_id) {
          cliSessionId = event.session_id;
        }
        if (event.type === "result" && event.session_id) {
          cliSessionId = event.session_id;
        }

        // 提取 assistant 文本内容（跳过 user 回显）
        if (event.type === "message" && event.role !== "user") {
          if (typeof event.content === "string") content += event.content;
          if (typeof event.text === "string") content += event.text;
        }

        // result 事件通常包含完整 response
        if (event.type === "result" && typeof event.response === "string") {
          content = event.response;
        }

        // 提取 usage
        if (event.type === "result") {
          usage = extractUsageFromResult(event);
        }

        // 错误检查
        if (event.type === "error" || event.error) {
          const errMsg = event.error?.message ?? event.message ?? JSON.stringify(event);
          throw new CliError(`Gemini error: ${errMsg}`, 1, errMsg);
        }
      } catch (e) {
        if (e instanceof CliError) throw e;
        // 非 JSON 行，当作文本内容
        content += trimmed + "\n";
      }
    }

    content = content.trim();
    if (!content) {
      throw new CliError("Gemini CLI returned empty output", 0, stderr);
    }

    return { content, cliSessionId, usage, finishReason: "stop" };
  }

  async stream(
    options: ProviderOptions,
    res: ServerResponse,
  ): Promise<{ cliSessionId?: string }> {
    const prompt = options.cliSessionId
      ? extractText(options.messages[options.messages.length - 1]?.content ?? "")
      : serializeForGemini(options.messages);

    const args = buildArgs(options, "stream-json");
    const id = `chatcmpl-${Date.now()}`;
    const model = options.model;

    // 先尝试 spawn，如果失败可以在 headers 发送前抛错
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

    // 等一个 tick 看 spawn 是否立即失败
    await new Promise((r) => setTimeout(r, 10));
    if (spawnFailed) {
      return spawnErrorPromise as never;
    }

    // spawn 成功，现在可以安全地发送 SSE headers
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

            if ((event.type === "init" || event.type === "result") && event.session_id) {
              cliSessionId = event.session_id;
            }
            if (event.type === "message" && event.role !== "user") {
              if (typeof event.content === "string") sendSSEChunk(res, id, model, event.content);
              if (typeof event.text === "string") sendSSEChunk(res, id, model, event.text);
            }
          } catch {
            // 非 JSON 行，当作纯文本 stream
            if (trimmed) sendSSEChunk(res, id, model, trimmed);
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
            if (event.session_id) cliSessionId = event.session_id;
          } catch {
            sendSSEChunk(res, id, model, buffer.trim());
          }
        }

        if (stderrBuf) log.debug("Gemini stderr:", stderrBuf.trim());

        sendSSEFinish(res, id, model);
        sendSSEDone(res);
        if (!res.writableEnded) res.end();
        resolve({ cliSessionId });
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        log.error("Gemini spawn error:", err.message);
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
}

function buildArgs(options: ProviderOptions, outputFormat: string): string[] {
  const args: string[] = [];

  if (options.cliSessionId) {
    args.push("--resume", options.cliSessionId);
  }

  args.push("--output-format", outputFormat);
  if (options.model && options.model !== "default") {
    args.push("--model", options.model);
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

function extractUsageFromResult(
  event: Record<string, unknown>,
): { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined {
  const stats = event.stats as Record<string, unknown> | undefined;
  if (stats?.models && typeof stats.models === "object") {
    const models = stats.models as Record<string, Record<string, unknown>>;
    const firstModel = Object.values(models)[0];
    if (firstModel?.tokens && typeof firstModel.tokens === "object") {
      const t = firstModel.tokens as Record<string, number>;
      return {
        prompt_tokens: t.prompt ?? 0,
        completion_tokens: t.candidates ?? 0,
        total_tokens: t.total ?? (t.prompt ?? 0) + (t.candidates ?? 0),
      };
    }
  }
  return undefined;
}
