import {
  createAssistantMessageEventStream,
  resolveTranscriptTools,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type Tool,
  type ToolCall,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadSystemConfig } from "@videoforge/pipeline";
import { VideoForgeError } from "@videoforge/shared";
import type { TraceStore } from "../../trace/trace-store.js";
import {
  ARK_PLACEHOLDER_CHAT_MODEL,
  callArkChat,
  type ArkChatMessage,
  type ArkChatResult,
} from "./ark-chat.js";

/**
 * Ark provider：把 pi-coding-agent 的 `ModelRuntime` 指向自实现的 Ark 对话客户端（见设计文档 §5.3、§7.2）。
 * - provider 由我们自实现，因此请求 / 响应天然经过自有代码，LLM 全文留痕在 `streamSimple` 层统一埋点；
 * - `base_url` / `chat_model` 全部取自配置，API Key 只从 `ARK_API_KEY` 读取，绝不写入任何持久化面；
 * - `sessionId` / `runId` / `stageId` 通过**闭包注入**（见 `ArkTraceContext`），不改 `SimpleStreamOptions` 的公共类型。
 */

/** Ark provider 在 `ModelRuntime` 中的注册 ID。 */
export const ARK_PROVIDER_ID = "ark";

/** Ark provider 使用的 API 类型（OpenAI Chat Completions 兼容）。 */
const ARK_API: Api = "openai-completions";

/** provider 模型上下文窗口与最大输出（占位常量，仅用于 Pi 的上下文裁剪判断）。 */
const ARK_CONTEXT_WINDOW = 128000;
const ARK_MAX_OUTPUT_TOKENS = 8192;

/**
 * 留痕上下文：由会话注册表 / 工作流引擎在创建 provider 时注入。
 * 自由对话时只有 `sessionId`，`runId` / `stageId` 留空（见设计文档 §7.1）。
 */
export interface ArkTraceContext {
  sessionId: string;
  runId?: string;
  stageId?: string;
}

/** LLM 留痕目标：会话专属写入器 + 该次请求的 run / 阶段上下文。 */
export interface ArkTraceTarget {
  trace: TraceStore;
  context: ArkTraceContext;
}

/** `createArkStreamSimple` 的入参。 */
export interface CreateArkStreamSimpleOptions {
  /** 仓库根目录（用于加载配置与 `.env.local`）。 */
  rootDir: string;
  /** 三级留痕写入器；缺省时不记录 LLM 调用。 */
  trace?: TraceStore;
  /** 留痕上下文；传入 `trace` 时必填，否则无法落 `llm_calls`。 */
  traceContext?: ArkTraceContext;
  /**
   * 按会话解析留痕目标：`ModelRuntime` 被多个会话共用，单一闭包无法承载「按 sessionId 区分」。
   * Pi 会把它得到的 `sessionId` 放进 `SimpleStreamOptions` 传给 `streamSimple`，
   * 因此可在此按需取到该会话专属的写入器与当前 run / 阶段。
   */
  resolveTraceTarget?: (sessionId?: string) => ArkTraceTarget | undefined;
}

/** `createArkModelRuntime` 的入参。 */
export interface CreateArkModelRuntimeOptions extends CreateArkStreamSimpleOptions {}

/** 把 Pi 消息内容（字符串或内容块数组）摊平为纯文本。 */
function textOf(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

/**
 * 把 Pi 的 `Message[]` 转成 OpenAI Chat Completions 消息数组。
 * - `system` → `{ role:"system", content }`；`user` → `{ role:"user", content }`；
 * - `assistant` → 文本拼接 + `tool_calls`（无文本时 content 为 null）；
 * - `toolResult` → `{ role:"tool", tool_call_id, content }`。
 * @param messages Pi 归一化后的消息列表
 * @returns OpenAI 风格消息数组
 */
function toArkMessages(messages: Message[]): ArkChatMessage[] {
  const output: ArkChatMessage[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        output.push({ role: "system", content: textOf(message.content) });
        break;
      case "user":
        output.push({ role: "user", content: textOf(message.content) });
        break;
      case "assistant": {
        const text = textOf(message.content);
        const toolCalls = message.content
          .filter((part): part is ToolCall => part.type === "toolCall")
          .map((part) => ({
            id: part.id,
            type: "function" as const,
            function: { name: part.name, arguments: JSON.stringify(part.arguments ?? {}) },
          }));
        const entry: ArkChatMessage = { role: "assistant", content: text || null };
        if (toolCalls.length > 0) entry.tool_calls = toolCalls;
        output.push(entry);
        break;
      }
      case "toolResult":
        output.push({
          role: "tool",
          content: textOf(message.content),
          tool_call_id: message.toolCallId,
        });
        break;
    }
  }
  return output;
}

/** 把工具调用参数文本解析为对象；非法 JSON 回退为空对象（失败由上层契约校验处理）。 */
function parseToolArguments(raw: string): ToolCall["arguments"] {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ToolCall["arguments"])
      : {};
  } catch {
    return {};
  }
}

/** 依据 Ark 的 finish_reason 映射 Pi 的结束原因。 */
function mapStopReason(
  finishReason: string | null,
): Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse"> {
  if (finishReason === "tool_calls") return "toolUse";
  if (finishReason === "length") return "length";
  return "stop";
}

/**
 * 从 Pi 转录中解析当前工具声明，并转换为 Ark（OpenAI Chat Completions）的 `tools` 参数。
 *
 * Pi 的 `TranscriptContext` 只携带 messages，工具声明以 system 消息的 `toolsAdded` 形式存在；
 * `resolveTranscriptTools(messages, "none")` 会把当前工具全集归并到 `requestTools`。
 * 不传 tools 时模型只能输出纯文本、永远不会调用阶段工具（曾导致 copy 阶段连续 3 次失败）。
 * @param messages Pi 归一化后的消息列表
 * @returns OpenAI function 声明数组（无工具时为空数组）
 */
function toArkTools(messages: Message[]): unknown[] {
  const { requestTools } = resolveTranscriptTools(messages, "none");
  return requestTools.map((tool: Tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/** 构造助手消息的 usage（Ark 只回传 prompt / completion，缓存与成本字段置 0）。 */
function buildUsage(promptTokens: number, completionTokens: number): Usage {
  return {
    input: promptTokens,
    output: completionTokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: promptTokens + completionTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** 构造一条助手消息骨架，供事件流的 `partial` / 错误事件复用。 */
function buildAssistantMessage(
  model: Model<Api>,
  usage: Usage,
  stopReason: AssistantMessage["stopReason"],
  timestamp: number,
  durationMs?: number,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: ARK_API,
    provider: ARK_PROVIDER_ID,
    model: model.id,
    usage,
    stopReason,
    timestamp,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

/** `runStream` 的执行参数。 */
interface RunStreamArgs {
  rootDir: string;
  trace?: TraceStore;
  traceContext?: ArkTraceContext;
  resolveTraceTarget?: (sessionId?: string) => ArkTraceTarget | undefined;
  stream: AssistantMessageEventStream;
  model: Model<Api>;
  context: TranscriptContext;
  streamOptions?: SimpleStreamOptions;
}

/**
 * 把一次 Ark 调用结果回放为 `AssistantMessageEventStream` 事件序列：
 * `start` → 文本 `text_start/text_delta/text_end` → 工具调用 `toolcall_start/toolcall_delta/toolcall_end`
 * → 成功 `done` / 失败 `error`。事件中的 `partial` 为同一可变对象（即"到目前为止的响应"）。
 * @param args 执行参数
 * @returns 无（事件与最终结果通过 `stream` 输出）
 */
function replayResult(args: RunStreamArgs, result: ArkChatResult, startedAt: number): void {
  const { stream, model } = args;
  const usage = buildUsage(result.promptTokens, result.completionTokens);
  const partial = buildAssistantMessage(
    model,
    usage,
    result.ok ? mapStopReason(result.finishReason) : "error",
    startedAt,
    result.durationMs,
  );
  stream.push({ type: "start", partial });

  if (result.content) {
    const contentIndex = partial.content.length;
    partial.content.push({ type: "text", text: "" });
    stream.push({ type: "text_start", contentIndex, partial });
    partial.content[contentIndex] = { type: "text", text: result.content };
    stream.push({ type: "text_delta", contentIndex, delta: result.content, partial });
    stream.push({ type: "text_end", contentIndex, content: result.content, partial });
  }

  for (const toolCall of result.toolCalls) {
    const contentIndex = partial.content.length;
    partial.content.push({ type: "toolCall", id: toolCall.id, name: toolCall.name, arguments: {} });
    stream.push({ type: "toolcall_start", contentIndex, partial });
    stream.push({ type: "toolcall_delta", contentIndex, delta: toolCall.arguments, partial });
    const finalized: ToolCall = {
      type: "toolCall",
      id: toolCall.id,
      name: toolCall.name,
      arguments: parseToolArguments(toolCall.arguments),
    };
    partial.content[contentIndex] = finalized;
    stream.push({ type: "toolcall_end", contentIndex, toolCall: finalized, partial });
  }

  if (result.ok) {
    stream.push({ type: "done", reason: mapStopReason(result.finishReason), message: partial });
    stream.end(partial);
  } else {
    partial.stopReason = "error";
    partial.errorMessage = result.errorCode ?? "error";
    stream.push({ type: "error", reason: "error", error: partial });
    stream.end(partial);
  }
}

/**
 * 执行一次流式请求：转换消息 → 调用 `callArkChat` → 留痕 → 回放事件。
 * 配置类错误（占位模型 / 缺密钥）不产生 LLM 调用，直接以 `error` 事件收尾。
 * @param args 执行参数
 */
async function runStream(args: RunStreamArgs): Promise<void> {
  const {
    rootDir,
    trace,
    traceContext,
    resolveTraceTarget,
    stream,
    model,
    context,
    streamOptions,
  } = args;
  const messages = toArkMessages(context.messages);
  const tools = toArkTools(context.messages);
  const startedAt = Date.now();

  let result: ArkChatResult;
  try {
    result = await callArkChat({
      rootDir,
      messages,
      tools,
      // 有工具时才显式指定 auto；无工具时保持服务端默认，避免个别兼容网关拒绝空 tool_choice
      ...(tools.length > 0 ? { toolChoice: "auto" as const } : {}),
      signal: streamOptions?.signal,
      temperature: streamOptions?.temperature,
      maxTokens: streamOptions?.maxTokens,
      // 满足 SPIKE 要求：把请求体与响应头钩子透传给调用方（Pi 的 onPayload / onResponse）
      onPayload: (payload) => {
        void streamOptions?.onPayload?.(payload, model);
      },
      onResponse: (response) => {
        void streamOptions?.onResponse?.(response, model);
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = buildAssistantMessage(model, buildUsage(0, 0), "error", startedAt);
    failure.errorMessage = message;
    console.error(`[ark-provider] 调用前置失败：${message}`);
    stream.push({ type: "error", reason: "error", error: failure });
    stream.end(failure);
    return;
  }

  // 每次请求结束（成功或失败）都留痕；脱敏由 trace-store 统一负责，此处不做二次处理。
  // 优先用显式注入的 (trace, traceContext)；共享运行时下改用按 sessionId 解析的目标。
  const target: ArkTraceTarget | undefined =
    trace && traceContext
      ? { trace, context: traceContext }
      : resolveTraceTarget?.(streamOptions?.sessionId);
  if (target) {
    try {
      target.trace.recordLlmCall({
        sessionId: target.context.sessionId,
        runId: target.context.runId ?? null,
        stageId: target.context.stageId ?? null,
        model: model.id,
        request: result.requestJson,
        response: result.responseJson,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        durationMs: result.durationMs,
        ok: result.ok,
        errorCode: result.errorCode,
      });
    } catch (error) {
      console.error(
        `[ark-provider] LLM 留痕写入失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  replayResult(args, result, startedAt);
}

/**
 * 自实现 Pi 的 `streamSimple`：把 `TranscriptContext` 转成 OpenAI 消息 → 调用 `callArkChat`
 * → 把聚合结果回放为 `AssistantMessageEventStream`，并对每次请求做 LLM 全文留痕。
 *
 * `trace` / `traceContext` 通过闭包注入（`SimpleStreamOptions` 允许附加自定义字段但类型不安全）。
 * @param options 闭包注入的依赖（rootDir / trace / traceContext）
 * @returns 与 Pi `StreamFunction` 兼容的 streamSimple 实现
 */
export function createArkStreamSimple(
  options: CreateArkStreamSimpleOptions,
): (
  model: Model<Api>,
  context: TranscriptContext,
  streamOptions?: SimpleStreamOptions,
) => AssistantMessageEventStream {
  const { rootDir, trace, traceContext, resolveTraceTarget } = options;
  return (model, context, streamOptions) => {
    const stream = createAssistantMessageEventStream();
    void runStream({
      rootDir,
      trace,
      traceContext,
      resolveTraceTarget,
      stream,
      model,
      context,
      streamOptions,
    });
    return stream;
  };
}

/**
 * 创建并配置 Ark provider 的 `ModelRuntime`：
 * 注册 `ark` provider（OpenAI 兼容、自实现 `streamSimple`、模型来自 `chat_model`），
 * 并以 `$ARK_API_KEY` 环境插值提供凭证（密钥不落入任何持久化面）。
 * @param options 依赖项（rootDir / trace / traceContext）
 * @returns 已注册好 Ark provider 的 `ModelRuntime`
 * @throws VideoForgeError(`CONFIG_INVALID`) `chat_model` 仍为占位值
 */
export async function createArkModelRuntime(
  options: CreateArkModelRuntimeOptions,
): Promise<ModelRuntime> {
  const config = loadSystemConfig({ rootDir: options.rootDir });
  const { base_url: baseUrl, chat_model: chatModel } = config.engines.endpoints.ark;

  if (chatModel === ARK_PLACEHOLDER_CHAT_MODEL) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `Ark 语言模型 ID 仍为占位值 ${ARK_PLACEHOLDER_CHAT_MODEL}，请在 config/system.local.yaml 填写真实 chat_model`,
    );
  }

  const runtime = await ModelRuntime.create();
  runtime.registerProvider(ARK_PROVIDER_ID, {
    name: "Ark Agent Plan",
    baseUrl,
    api: ARK_API,
    // 环境插值：key 只存在运行时环境变量中，不写入任何持久化面
    apiKey: "$ARK_API_KEY",
    models: [
      {
        type: "chat",
        id: chatModel,
        name: chatModel,
        api: ARK_API,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: ARK_CONTEXT_WINDOW,
        maxTokens: ARK_MAX_OUTPUT_TOKENS,
        reasoning: false,
      },
    ],
    streamSimple: createArkStreamSimple({
      rootDir: options.rootDir,
      trace: options.trace,
      traceContext: options.traceContext,
      resolveTraceTarget: options.resolveTraceTarget,
    }),
  });
  console.info(`[ark-provider] 已注册 provider=${ARK_PROVIDER_ID} model=${chatModel}`);
  return runtime;
}
