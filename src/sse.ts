import type { ServerResponse } from "node:http";
import type { ChatCompletionChunk } from "./types.js";

function canWrite(res: ServerResponse): boolean {
  return !res.writableEnded && !res.destroyed;
}

export function writeSSEHeaders(res: ServerResponse, sessionId?: string): void {
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
  if (sessionId) {
    headers["X-Session-Id"] = sessionId;
  }
  res.writeHead(200, headers);
}

export function sendSSEChunk(
  res: ServerResponse,
  id: string,
  model: string,
  content: string,
): void {
  if (!canWrite(res)) return;
  const chunk: ChatCompletionChunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: null,
      },
    ],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

export function sendSSEFinish(
  res: ServerResponse,
  id: string,
  model: string,
): void {
  if (!canWrite(res)) return;
  const chunk: ChatCompletionChunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

export function sendSSEError(
  res: ServerResponse,
  message: string,
): void {
  if (!canWrite(res)) return;
  res.write(`data: ${JSON.stringify({ error: { message, type: "server_error" } })}\n\n`);
}

export function sendSSEDone(res: ServerResponse): void {
  if (!canWrite(res)) return;
  res.write(`data: [DONE]\n\n`);
}
