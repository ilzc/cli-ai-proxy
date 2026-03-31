import { randomUUID } from "node:crypto";
import type { ProviderName, SessionEntry } from "./types.js";

const sessions = new Map<string, SessionEntry>();
let cleanupTimer: NodeJS.Timeout | null = null;

let sessionTtlMs = 30 * 60 * 1000; // 默认 30 分钟

export function initSessionManager(ttlSeconds: number): void {
  if (ttlSeconds <= 0) ttlSeconds = 1800; // fallback to 30 min
  sessionTtlMs = ttlSeconds * 1000;
  // 每分钟清理过期 session
  cleanupTimer = setInterval(cleanupExpired, 60_000);
  cleanupTimer.unref(); // 不阻止进程退出
}

export function stopSessionManager(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

export function createSession(
  provider: ProviderName,
  model: string,
  cliSessionId: string,
): string {
  const proxySessionId = randomUUID();
  sessions.set(proxySessionId, {
    cliSessionId,
    provider,
    model,
    lastActive: Date.now(),
  });
  return proxySessionId;
}

export function getSession(proxySessionId: string): SessionEntry | undefined {
  const entry = sessions.get(proxySessionId);
  if (entry) {
    entry.lastActive = Date.now();
  }
  return entry;
}

function cleanupExpired(): void {
  const now = Date.now();
  for (const [id, entry] of sessions) {
    if (now - entry.lastActive > sessionTtlMs) {
      sessions.delete(id);
    }
  }
}
