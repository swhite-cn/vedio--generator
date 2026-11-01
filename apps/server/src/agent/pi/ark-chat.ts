import { getArkApiKey, loadSystemConfig } from "@videoforge/pipeline";
import { VideoForgeError, type VideoForgeErrorCode } from "@videoforge/shared";

/**
 * 自实现的 Ark 对话 HTTP 客户端（见设计文档 §5.3）。
 *
 * 设计要点：
 * - OpenAI Chat Completions 兼容协议，使用全局 `fetch`，不引入 HTTP 库；
 * - `base_url` 一律取自 `config.engines.endpoints.ark.base_url`（严禁硬编码为 `/api/v3`）；
 * - API Key 只从环境变量 `ARK_API_KEY` 读取，且绝不写入请求体、返回值或日志；
 * - 网络 / HTTP 失败不抛出，返回 `ok:false` + 稳定错误码，供上层 `trace.recordLlmCall` 全文留痕。
 */

/** `config/default.yaml` 中 chat_model 的占位值；若未被本机配置替换则拒绝发起请求。 */
export const ARK_PLACEHOLDER_CHAT_MODEL = "PLEASE_FILL_CHAT_MODEL_ID";

/** OpenAI Chat Completions 风格的单条消息（`tool` 角色携带 `tool_call_id`）。 */
export interface ArkChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** 正文文本；仅有工具调用时为 null。 */
  content: string | null;
  /** 助手消息中的工具调用（OpenAI function calling 形态）。 */
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  /** `tool` 角色消息对应的工具调用 ID。 */
  tool_call_id?: string;
}

/** 一次工具调用的聚合结果（按流式分片拼接后的完整参数文本）。 */
export interface ArkChatToolCall {
  id: string;
  name: string;
  /** 未解析的原始 JSON 参数文本。 */
  arguments: string;
}

/** `callArkChat` 的入参。 */
export interface CallArkChatOptions {
  /** 仓库根目录（用于 `loadLocalEnv` 与 `loadSystemConfig`）。 */
  rootDir: string;
  /** OpenAI 风格对话消息。 */
  messages: ArkChatMessage[];
  /** OpenAI 风格工具声明（可选）。 */
  tools?: unknown[];
  /** 工具选择策略（可选）。 */
  toolChoice?: "auto" | "none";
  /** 透传给 fetch 的中断信号。 */
  signal?: AbortSignal;
  /** 采样温度（可选）。 */
  temperature?: number;
  /** 最大生成 token 数（可选）。 */
  maxTokens?: number;
  /** 请求体构造完成、发送前回调（对应 Pi 的 `onPayload` 钩子）。 */
  onPayload?: (payload: unknown) => void;
  /** 收到 HTTP 响应头后回调（对应 Pi 的 `onResponse` 钩子）。 */
  onResponse?: (response: { status: number; headers: Record<string, string> }) => void;
  /** 自定义 fetch 实现（测试注入用）；缺省使用全局 `fetch`。 */
  fetchImpl?: typeof fetch;
}

/** `callArkChat` 的统一返回值，字段可直接喂给 `trace.recordLlmCall`。 */
export interface ArkChatResult {
  /** 正文文本。 */
  content: string;
  /** 聚合后的工具调用列表。 */
  toolCalls: ArkChatToolCall[];
  /** 原始 finish_reason（如 `stop` / `length` / `tool_calls`）。 */
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
  /** 实际 POST 的请求体（含 messages 全文，**不含** apiKey）。 */
  requestJson: unknown;
  /** 归一化响应：`{ content, toolCalls, finishReason, usage }`。 */
  responseJson: unknown;
  durationMs: number;
  ok: boolean;
  errorCode: string | null;
}

/** SSE 解析后的中间结果。 */
interface ParsedSse {
  content: string;
  toolCalls: ArkChatToolCall[];
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
}

/** 把 fetch 的 `Headers` 规整为普通对象（用于 `onResponse` 与错误留痕）。 */
function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

/**
 * 解析 OpenAI 兼容的 SSE 响应文本并聚合为最终结果。
 * 逐行读取 `data:` 载荷，`[DONE]` 结束；累积 `delta.content` 文本，
 * 按 `delta.tool_calls[].index` 聚合 id / name / arguments，并读取 finish_reason 与 usage。
 * @param raw 完整的响应体文本
 * @returns 聚合结果
 * @throws VideoForgeError(`ADAPTER_PROTOCOL_INVALID`) 响应不是合法 SSE / 分片不是合法 JSON / 不含任何数据行
 */
function parseSse(raw: string): ParsedSse {
  const contentParts: string[] = [];
  const toolCallMap = new Map<number, ArkChatToolCall>();
  let finishReason: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let sawDataChunk = false;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data) continue;
    if (data === "[DONE]") break;

    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      throw new VideoForgeError(
        "ADAPTER_PROTOCOL_INVALID",
        `Ark SSE 分片不是合法 JSON：${data.slice(0, 120)}`,
      );
    }
    sawDataChunk = true;

    // usage 可能出现在任意分片上（常见于末尾带空 choices 的分片）
    if (chunk?.usage && typeof chunk.usage === "object") {
      if (typeof chunk.usage.prompt_tokens === "number") promptTokens = chunk.usage.prompt_tokens;
      if (typeof chunk.usage.completion_tokens === "number") {
        completionTokens = chunk.usage.completion_tokens;
      }
    }

    const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined;
    if (!choice) continue;

    const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {};
    if (typeof delta.content === "string") contentParts.push(delta.content);

    for (const rawToolCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = typeof rawToolCall.index === "number" ? rawToolCall.index : 0;
      const entry = toolCallMap.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof rawToolCall.id === "string" && rawToolCall.id) entry.id = rawToolCall.id;
      if (typeof rawToolCall.function?.name === "string") entry.name += rawToolCall.function.name;
      if (typeof rawToolCall.function?.arguments === "string") {
        entry.arguments += rawToolCall.function.arguments;
      }
      toolCallMap.set(index, entry);
    }

    if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
  }

  if (!sawDataChunk) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      "Ark 响应不是 SSE 流（未发现 data 分片）",
    );
  }

  return {
    content: contentParts.join(""),
    toolCalls: [...toolCallMap.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value),
    finishReason,
    promptTokens,
    completionTokens,
  };
}

/**
 * 构造失败结果（网络 / HTTP / 协议失败统一走此出口，保证字段齐全）。
 * @param requestJson 实际请求体
 * @param responseJson 归一化响应或诊断信息
 * @param durationMs 耗时（毫秒）
 * @param errorCode 稳定错误码
 * @returns 失败形态的 `ArkChatResult`
 */
function failedResult(
  requestJson: unknown,
  responseJson: unknown,
  durationMs: number,
  errorCode: VideoForgeErrorCode,
): ArkChatResult {
  return {
    content: "",
    toolCalls: [],
    finishReason: null,
    promptTokens: 0,
    completionTokens: 0,
    requestJson,
    responseJson,
    durationMs,
    ok: false,
    errorCode,
  };
}

/**
 * 调用 Ark 对话接口（OpenAI Chat Completions 兼容，SSE 流式），聚合为单条结果。
 *
 * 配置类问题（模型仍为占位值、缺少 `ARK_API_KEY`）会抛 `CONFIG_INVALID`；
 * 网络与 HTTP 失败返回 `ok:false` + `TOOL_UNAVAILABLE`，协议不符返回 `ADAPTER_PROTOCOL_INVALID`，均不抛出。
 * @param options 调用参数
 * @returns 聚合后的调用结果（含请求 / 响应全文，供留痕使用）
 */
export async function callArkChat(options: CallArkChatOptions): Promise<ArkChatResult> {
  const config = loadSystemConfig({ rootDir: options.rootDir });
  const { base_url: baseUrl, chat_model: chatModel } = config.engines.endpoints.ark;

  if (chatModel === ARK_PLACEHOLDER_CHAT_MODEL) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `Ark 语言模型 ID 仍为占位值 ${ARK_PLACEHOLDER_CHAT_MODEL}，请在 config/system.local.yaml 填写真实 chat_model`,
    );
  }
  // API Key 只从环境变量读取；缺失时抛 CONFIG_INVALID，且不进入任何日志 / 返回字段
  const apiKey = getArkApiKey(options.rootDir);

  const body: Record<string, unknown> = {
    model: chatModel,
    messages: options.messages,
    stream: true,
  };
  if (options.tools && options.tools.length > 0) body.tools = options.tools;
  if (options.toolChoice) body.tool_choice = options.toolChoice;
  if (typeof options.temperature === "number") body.temperature = options.temperature;
  if (typeof options.maxTokens === "number") body.max_tokens = options.maxTokens;

  // 请求体构造完成即回调（对应 Pi 的 onPayload）；此处仅做通知，不替换 payload
  options.onPayload?.(body);

  // 深拷贝为留痕快照，确保不含 Authorization 等凭据
  const requestJson: unknown = JSON.parse(JSON.stringify(body));
  const url = `${baseUrl}/chat/completions`;
  const startedAt = Date.now();
  const doFetch = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ark-chat] 请求失败（网络层）：${message}`);
    return failedResult(requestJson, null, durationMs, "TOOL_UNAVAILABLE");
  }

  options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const durationMs = Date.now() - startedAt;
    console.error(`[ark-chat] 请求失败：HTTP ${response.status} ${text.slice(0, 200)}`);
    return failedResult(
      requestJson,
      { status: response.status, body: text.slice(0, 500) },
      durationMs,
      "TOOL_UNAVAILABLE",
    );
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ark-chat] 读取响应体失败：${message}`);
    return failedResult(requestJson, null, durationMs, "TOOL_UNAVAILABLE");
  }

  try {
    const parsed = parseSse(raw);
    const durationMs = Date.now() - startedAt;
    const responseJson = {
      content: parsed.content,
      toolCalls: parsed.toolCalls,
      finishReason: parsed.finishReason,
      usage: { prompt_tokens: parsed.promptTokens, completion_tokens: parsed.completionTokens },
    };
    console.info(
      `[ark-chat] 完成 model=${chatModel} 耗时=${durationMs}ms prompt=${parsed.promptTokens} completion=${parsed.completionTokens}`,
    );
    return {
      content: parsed.content,
      toolCalls: parsed.toolCalls,
      finishReason: parsed.finishReason,
      promptTokens: parsed.promptTokens,
      completionTokens: parsed.completionTokens,
      requestJson,
      responseJson,
      durationMs,
      ok: true,
      errorCode: null,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ark-chat] 响应解析失败：${message}`);
    return failedResult(
      requestJson,
      { raw: raw.slice(0, 1000) },
      durationMs,
      "ADAPTER_PROTOCOL_INVALID",
    );
  }
}
