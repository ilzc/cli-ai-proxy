import { writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { get as httpsGet } from "node:https";
import { get as httpGet } from "node:http";
import type { Message, ContentPart, MessageContent } from "./types.js";
import * as log from "./utils/logger.js";

const TEMP_DIR = join(process.cwd(), "tmp-images");

/** 确保临时目录存在 */
function ensureTempDir(): void {
  if (!existsSync(TEMP_DIR)) {
    mkdirSync(TEMP_DIR, { recursive: true });
  }
}

/** 从 data URL 中提取 MIME 和二进制数据 */
function parseDataUrl(dataUrl: string): { ext: string; buffer: Buffer } | null {
  const match = dataUrl.match(
    /^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/,
  );
  if (!match) return null;
  const ext = match[1] === "jpg" ? "jpeg" : match[1]!;
  return { ext, buffer: Buffer.from(match[2]!, "base64") };
}

/** 下载远程图片 */
function downloadImage(url: string): Promise<Buffer> {
  const getter = url.startsWith("https") ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    const req = getter(url, { timeout: 30_000 }, (res) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        // Follow redirect
        downloadImage(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`Failed to download image: HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Image download timed out"));
    });
  });
}

/** 从 URL 推断扩展名 */
function extFromUrl(url: string): string {
  const match = url.match(/\.(png|jpe?g|gif|webp)(\?|$)/i);
  if (match) return match[1]!.toLowerCase().replace("jpg", "jpeg");
  return "png"; // fallback
}

export interface ImageFile {
  /** 相对于 CWD 的路径（Gemini @引用用） */
  relativePath: string;
  /** 绝对路径（Claude 引用用） */
  absolutePath: string;
}

/**
 * 保存单个图片到临时文件。
 * 支持 base64 data URL 和远程 http(s) URL。
 */
export async function saveImage(url: string): Promise<ImageFile> {
  ensureTempDir();
  const id = randomUUID().slice(0, 8);

  if (url.startsWith("data:")) {
    const parsed = parseDataUrl(url);
    if (!parsed) throw new Error("Invalid image data URL format");
    const filename = `img-${id}.${parsed.ext}`;
    const absPath = join(TEMP_DIR, filename);
    writeFileSync(absPath, parsed.buffer);
    return { relativePath: `tmp-images/${filename}`, absolutePath: absPath };
  }

  // Remote URL
  const buffer = await downloadImage(url);
  const ext = extFromUrl(url);
  const filename = `img-${id}.${ext}`;
  const absPath = join(TEMP_DIR, filename);
  writeFileSync(absPath, buffer);
  return { relativePath: `tmp-images/${filename}`, absolutePath: absPath };
}

/** 清理临时图片文件 */
export function cleanupImages(files: ImageFile[]): void {
  for (const f of files) {
    try {
      if (existsSync(f.absolutePath)) unlinkSync(f.absolutePath);
    } catch (err) {
      log.warn(`Failed to cleanup temp image: ${f.absolutePath}`);
    }
  }
}

/**
 * 判断 messages 中是否包含图片 content part
 */
export function hasImageContent(messages: Message[]): boolean {
  return messages.some((msg) => {
    if (!Array.isArray(msg.content)) return false;
    return (msg.content as ContentPart[]).some(
      (p) => p.type === "image_url" && p.image_url?.url,
    );
  });
}

/**
 * 提取并保存 messages 中所有图片，返回保存的文件列表。
 * 同时将 messages 中的 image_url parts 替换为文本引用。
 *
 * @param provider - "gemini" 使用 @相对路径，"claude" 使用绝对路径
 */
export async function processImages(
  messages: Message[],
  provider: "gemini" | "claude",
): Promise<{ messages: Message[]; imageFiles: ImageFile[] }> {
  const imageFiles: ImageFile[] = [];
  const processed: Message[] = [];

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      processed.push(msg);
      continue;
    }

    const parts = msg.content as ContentPart[];
    const hasImages = parts.some(
      (p) => p.type === "image_url" && p.image_url?.url,
    );

    if (!hasImages) {
      processed.push(msg);
      continue;
    }

    // 将图片保存并替换为文本引用
    const textParts: string[] = [];
    for (const part of parts) {
      if (part.type === "text" && part.text) {
        textParts.push(part.text);
      } else if (part.type === "image_url" && part.image_url?.url) {
        try {
          const file = await saveImage(part.image_url.url);
          imageFiles.push(file);
          if (provider === "gemini") {
            textParts.push(`[Use read_file tool to view image: ${file.relativePath}]`);
          } else {
            textParts.push(`[Use Read tool to view image: ${file.absolutePath}]`);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.warn(`Failed to save image: ${errMsg}`);
          textParts.push("[image: failed to load]");
        }
      }
    }

    processed.push({
      ...msg,
      content: textParts.join("\n"),
    });
  }

  return { messages: processed, imageFiles };
}
