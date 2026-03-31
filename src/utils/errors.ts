import type { ErrorResponse } from "../types.js";

export function makeError(
  message: string,
  type = "invalid_request_error",
  code: string | null = null,
): ErrorResponse {
  return {
    error: {
      message,
      type,
      code,
      param: null,
    },
  };
}

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export class CliTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`CLI process timed out after ${timeoutMs}ms`);
    this.name = "CliTimeoutError";
  }
}

export class CliNotFoundError extends Error {
  constructor(public readonly cliPath: string) {
    super(`CLI tool not found: ${cliPath}`);
    this.name = "CliNotFoundError";
  }
}
