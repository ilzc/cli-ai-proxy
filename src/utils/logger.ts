type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: number = LEVELS.info;

export function setLevel(level: Level): void {
  minLevel = LEVELS[level] ?? LEVELS.info;
}

export function debug(msg: string, ...args: unknown[]): void {
  if (minLevel <= LEVELS.debug) {
    console.debug(`[${timestamp()}] DEBUG ${msg}`, ...args);
  }
}

export function info(msg: string, ...args: unknown[]): void {
  if (minLevel <= LEVELS.info) {
    console.log(`[${timestamp()}] INFO  ${msg}`, ...args);
  }
}

export function warn(msg: string, ...args: unknown[]): void {
  if (minLevel <= LEVELS.warn) {
    console.warn(`[${timestamp()}] WARN  ${msg}`, ...args);
  }
}

export function error(msg: string, ...args: unknown[]): void {
  if (minLevel <= LEVELS.error) {
    console.error(`[${timestamp()}] ERROR ${msg}`, ...args);
  }
}

function timestamp(): string {
  return new Date().toISOString();
}
