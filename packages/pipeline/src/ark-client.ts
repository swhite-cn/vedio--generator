import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { VideoForgeError } from "@videoforge/shared";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * 读取响应文本并把非 2xx 统一映射为 ADAPTER_FAILED；错误信息不携带请求头与密钥。
 */
async function ensureOk(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  throw new VideoForgeError(
    "ADAPTER_FAILED",
    `Ark ${action} 失败：HTTP ${response.status} ${body.slice(0, 300)}`,
  );
}

/**
 * 调用 Ark chat completions（OpenAI 兼容），返回首条消息文本。
 */
export async function arkChatCompletion(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
}): Promise<string> {
  const response = await fetch(`${options.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: options.model, messages: options.messages }),
  });
  await ensureOk(response, "chat completions");
  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new VideoForgeError("ADAPTER_FAILED", "Ark chat completions 返回为空");
  }
  return content;
}

/**
 * 调用 Ark images/generations，强制 b64_json 返回，解码为 Buffer。
 */
export async function arkGenerateImage(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  size: string;
}): Promise<Buffer> {
  const response = await fetch(`${options.baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      prompt: options.prompt,
      size: options.size,
      response_format: "b64_json",
    }),
  });
  await ensureOk(response, "images/generations");
  const json = (await response.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) {
    throw new VideoForgeError("ADAPTER_FAILED", "Ark images/generations 未返回 b64_json");
  }
  return Buffer.from(b64, "base64");
}

/**
 * 调用 openspeech TTS（Agent Plan 单向流式），逐行解析 NDJSON 中的 base64 音频块，
 * 拼接后写入 outputPath；无音频块时抛 ADAPTER_FAILED。
 */
export async function arkTtsToFile(options: {
  ttsBaseUrl: string;
  apiKey: string;
  resourceId: string;
  text: string;
  speaker: string;
  outputPath: string;
}): Promise<string> {
  const response = await fetch(options.ttsBaseUrl, {
    method: "POST",
    headers: {
      "X-Api-Key": options.apiKey,
      "X-Api-Resource-Id": options.resourceId,
      "X-Api-Request-Id": randomUUID(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      req_params: {
        text: options.text,
        speaker: options.speaker,
        audio_params: { format: "mp3", sample_rate: 24000 },
      },
    }),
  });
  await ensureOk(response, "tts");
  const raw = await response.text();
  const chunks: Buffer[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: { data?: string };
    try {
      parsed = JSON.parse(trimmed) as { data?: string };
    } catch {
      throw new VideoForgeError("ADAPTER_FAILED", "TTS 响应包含无法解析的 NDJSON 行");
    }
    if (parsed.data) chunks.push(Buffer.from(parsed.data, "base64"));
  }
  if (chunks.length === 0) {
    throw new VideoForgeError("ADAPTER_FAILED", "TTS 响应不含音频数据");
  }
  mkdirSync(dirname(options.outputPath), { recursive: true });
  writeFileSync(options.outputPath, Buffer.concat(chunks));
  return options.outputPath;
}
