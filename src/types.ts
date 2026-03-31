// OpenAI API 兼容类型定义

// ─── 请求 ───

export interface ChatCompletionRequest {
  model?: string;
  messages: Message[];
  stream?: boolean;
  // 以下参数 CLI 不支持，静默忽略
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  n?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  tools?: Tool[];
  functions?: unknown[];
}

export type MessageContent = string | ContentPart[] | null;

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: MessageContent;
  name?: string;
  tool_call_id?: string;
}

export interface Tool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

// ─── 响应（非 streaming） ───

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Choice[];
  usage?: Usage;
}

export interface Choice {
  index: number;
  message: Message;
  finish_reason: "stop" | "length" | "tool_calls" | null;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// ─── 响应（streaming） ───

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChunkChoice[];
}

export interface ChunkChoice {
  index: number;
  delta: Partial<Message>;
  finish_reason: "stop" | "length" | "tool_calls" | null;
}

// ─── 模型列表 ───

export interface ModelsResponse {
  object: "list";
  data: ModelInfo[];
}

export interface ModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

// ─── OpenAI Error ───

export interface ErrorResponse {
  error: {
    message: string;
    type: string;
    code: string | null;
    param: string | null;
  };
}

// ─── Provider ───

export type ProviderName = "gemini" | "claude";

export interface ProviderResult {
  content: string;
  cliSessionId?: string;
  usage?: Usage;
  finishReason?: "stop" | "length";
}

export interface SessionEntry {
  cliSessionId: string;
  provider: ProviderName;
  model: string;
  lastActive: number;
}

// ─── 配置 ───

export interface ModelMapping {
  provider: ProviderName;
  model: string;
}

export interface Config {
  server: {
    host: string;
    port: number;
  };
  session: {
    ttl: number;
  };
  concurrency: {
    max: number;      // 最多同时运行的 CLI 进程数
    maxQueued: number; // 排队上限，超出直接 429
  };
  defaultModel: string;
  timeout: number; // CLI 进程超时（毫秒）
  cli: Record<ProviderName, string>;
  models: Record<string, ModelMapping>;
}
