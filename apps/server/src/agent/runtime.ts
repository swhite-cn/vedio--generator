import type { AgentSessionEvent, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { loadSystemConfig, type SystemConfig } from "@videoforge/pipeline";
import { VideoForgeError, type Actor } from "@videoforge/shared";
import type { TraceStore } from "../trace/trace-store.js";
import { ARK_PROVIDER_ID, createArkModelRuntime } from "./pi/provider.js";
import {
  createSessionRegistry,
  type AgentSdkPort,
  type AgentSessionRegistry,
} from "./session-registry.js";

/**
 * agent 运行时组合根（见设计文档 §5）。
 *
 * 把「Ark provider + 模型解析 + 会话注册表」三件事按依赖顺序拼起来，供上层
 * （P9 的 HTTP/SSE 编排层）一次性拿到可用的运行时句柄。此处只做组装，不含业务编排。
 */

/** 组合根构造入参。 */
export interface CreateAgentRuntimeOptions {
  rootDir: string;
  storageRoot: string;
  db: any;
  config: SystemConfig;
  trace?: TraceStore;
  /** 按 actor 解析留痕写入器（TraceStore 绑定单个 actor，不能跨用户复用）；优先于 `trace`，透传给会话注册表。 */
  traceForActor?: (actor: Actor) => TraceStore;
  /** 会话事件出口（阶段执行与自由对话共用）；透传给会话注册表。 */
  onSessionEvent?: (sessionId: string, event: AgentSessionEvent) => void;
  /** 覆盖 SDK 端口（测试用）；透传给会话注册表。 */
  port?: AgentSdkPort;
  idleTimeoutMs?: number;
  now?: () => number;
}

/** agent 运行时句柄。 */
export interface AgentRuntime {
  /** 已注册 Ark provider 的模型运行时。 */
  modelRuntime: ModelRuntime;
  /** 当前使用的模型（provider=ark，id=config.engines.endpoints.ark.chat_model）。 */
  model: Model<Api>;
  /** 会话注册表。 */
  sessions: AgentSessionRegistry;
}

/**
 * 组装 agent 运行时：模型运行时（Ark provider + LLM 全文留痕）→ 模型解析 → 会话注册表。
 *
 * LLM 留痕按会话解析：`ModelRuntime` 被多个会话共用，provider 的 `streamSimple` 从
 * `streamOptions.sessionId` 反查会话注册表，取该会话专属的 trace store 与当前 run / 阶段，
 * 因此 `llm_calls.run_id` / `stage_id` 不再恒为空。
 *
 * @param options 依赖项（根目录 / 存储根 / 数据库 / 配置 / 留痕 / 端口与时钟）
 * @returns agent 运行时句柄
 * @throws VideoForgeError(`CONFIG_INVALID`) `chat_model` 仍为占位值，或模型解析不到
 */
export async function createAgentRuntime(
  options: CreateAgentRuntimeOptions,
): Promise<AgentRuntime> {
  // 1) 会话注册表在 provider 之后创建：用惰性引用让 streamSimple 在请求发生时再解析会话
  let sessionsRef: AgentSessionRegistry | undefined;

  // 2) 模型运行时：注册 Ark provider；LLM 留痕目标按 sessionId 惰性解析
  const modelRuntime = await createArkModelRuntime({
    rootDir: options.rootDir,
    trace: options.trace,
    resolveTraceTarget: (sessionId) => {
      const target = sessionsRef?.resolveLlmTraceTarget(sessionId);
      if (!target) return undefined;
      return {
        trace: target.trace,
        context: { sessionId: target.sessionId, runId: target.runId, stageId: target.stageId },
      };
    },
  });

  // 3) 从配置解析要使用的模型 ID（与 provider 注册时用的是同一份配置来源）
  const chatModel = loadSystemConfig({ rootDir: options.rootDir }).engines.endpoints.ark.chat_model;
  const model = modelRuntime.getModel(ARK_PROVIDER_ID, chatModel);
  if (!model) {
    throw new VideoForgeError(
      "CONFIG_INVALID",
      `无法解析 Ark 模型 provider=${ARK_PROVIDER_ID} model=${chatModel}，请检查配置`,
    );
  }

  // 4) 会话注册表：复用同一模型运行时与模型
  const sessions = createSessionRegistry({ ...options, modelRuntime, model });
  sessionsRef = sessions;

  return { modelRuntime, model, sessions };
}
