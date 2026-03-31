import type { Message, MessageContent } from "./types.js";

export interface SerializedMessages {
  systemPrompt: string | null;
  prompt: string;
}

/**
 * 从 MessageContent 中提取纯文本。
 * 支持 string、ContentPart[]、null 三种格式。
 */
export function extractText(content: MessageContent): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  // ContentPart[]
  return content
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("\n");
}

/**
 * 将 OpenAI messages 数组序列化为 CLI 可接受的纯文本。
 * system message 单独提取（Claude Code 通过 --system-prompt 传递）。
 *
 * 单条 user 消息不加角色标记，直接返回内容。
 * 多轮对话加角色标记以保留上下文结构。
 */
export function serializeMessages(messages: Message[]): SerializedMessages {
  let systemPrompt: string | null = null;
  const nonSystemMessages: Message[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = extractText(msg.content);
      systemPrompt = systemPrompt
        ? systemPrompt + "\n" + text
        : text;
    } else {
      nonSystemMessages.push(msg);
    }
  }

  // 单条非 system 消息：直接返回内容，不加角色标记
  if (nonSystemMessages.length === 1) {
    return {
      systemPrompt,
      prompt: extractText(nonSystemMessages[0]!.content),
    };
  }

  // 多轮对话：加角色标记
  const lines: string[] = [];
  for (const msg of nonSystemMessages) {
    lines.push(`[${msg.role}]`);
    lines.push(extractText(msg.content));
    lines.push("");
  }

  return {
    systemPrompt,
    prompt: lines.join("\n").trim(),
  };
}

/**
 * Gemini CLI 版本：system prompt 编入 prompt 头部。
 */
export function serializeForGemini(messages: Message[]): string {
  const { systemPrompt, prompt } = serializeMessages(messages);

  const nonSystemCount = messages.filter((m) => m.role !== "system").length;

  // 单条 user 消息且无 system prompt：直接发送内容
  if (nonSystemCount === 1 && !systemPrompt) {
    return prompt; // serializeMessages 已经返回纯内容
  }

  const parts: string[] = [];
  if (systemPrompt) {
    parts.push(`[system]\n${systemPrompt}\n`);
  }

  // 多轮对话中 prompt 已含角色标记
  parts.push(prompt);

  if (nonSystemCount > 1) {
    return (
      "以下是对话历史，请基于最后一条用户消息继续对话。\n\n" +
      parts.join("\n")
    );
  }

  return parts.join("\n");
}
