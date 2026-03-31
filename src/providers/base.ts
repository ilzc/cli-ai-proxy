import type { ChildProcess } from "node:child_process";
import type { ServerResponse } from "node:http";
import type { Message, ProviderResult } from "../types.js";

export interface ProviderOptions {
  model: string;
  messages: Message[];
  cliPath: string;
  cliSessionId?: string;
  timeoutMs: number;
}

export interface Provider {
  readonly name: string;

  /** 非 streaming 调用，返回完整结果 */
  complete(options: ProviderOptions): Promise<ProviderResult>;

  /** streaming 调用，逐 chunk 写入 HTTP response */
  stream(options: ProviderOptions, res: ServerResponse): Promise<{
    cliSessionId?: string;
  }>;
}

// 跟踪活跃子进程，用于 graceful shutdown
const activeChildren = new Set<ChildProcess>();

export function trackChild(child: ChildProcess): void {
  activeChildren.add(child);
  child.on("close", () => activeChildren.delete(child));
  child.on("error", () => activeChildren.delete(child));
}

export function killAllChildren(): void {
  for (const child of activeChildren) {
    child.kill("SIGTERM");
  }
  activeChildren.clear();
}

export function activeChildCount(): number {
  return activeChildren.size;
}
