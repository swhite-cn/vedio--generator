import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mirrorGenerationRecords } from "../../trace/generation-mirror.js";
import { createBuiltinTools, type BuiltinToolContext } from "./builtin-tools.js";
import { createStageTools, type StageToolContext } from "./stage-tools.js";
import { withToolTrace, resolveTraceId, type ToolTraceOptions } from "./tool-trace.js";

/**
 * agent 工具集入口。
 * 汇总「8 个阶段工具」（自定义工具，见 `stage-tools.ts`）与「Pi 内置工具」（见 `builtin-tools.ts`），
 * 并提供把两者组合、统一挂上工具调用留痕的 `createAgentTools`。
 */
export {
  createStageTools,
  PROFILE_NAME_TO_OUTPUT_PROFILE,
  resolveOutputProfile,
  RENDER_TIMEOUT_MS,
  COMPOSE_TIMEOUT_MS,
  type StageToolContext,
  type StageToolDetails,
} from "./stage-tools.js";

export {
  withToolTrace,
  toProjectRelativePath,
  resolveTraceId,
  type ToolTraceOptions,
  type TraceIdSource,
} from "./tool-trace.js";

export {
  createBuiltinTools,
  BUILTIN_TOOL_NAMES_READONLY,
  BUILTIN_TOOL_NAMES_WRITE,
  type BuiltinToolContext,
} from "./builtin-tools.js";

export {
  applyCommandGuardrails,
  withCommandGuardrails,
  type CommandGuardrailRule,
  type GuardrailOutcome,
} from "./command-guardrails.js";

export {
  createToolFailureState,
  stableStringify,
  withToolCircuitBreaker,
  type ToolCircuitBreakerOptions,
  type ToolFailureState,
} from "./tool-circuit-breaker.js";

/** 组合工具的上下文：阶段工具与内置工具各用各自既有上下文，避免重复定义一套运行参数。 */
export interface AgentToolComposition {
  /** 既有阶段工具上下文（项目目录、画幅、风格、runId、配置）。 */
  stage: StageToolContext;
  /** 内置工具上下文（项目目录、放开策略、留痕上下文）。 */
  builtin: BuiltinToolContext;
}

/**
 * 给阶段工具补一层「生成清单 → llm_calls」镜像。
 *
 * 阶段生成的模型调用发生在 `packages/pipeline` 内部，不经过 Pi provider，因此不会自动留痕。
 * 这里在工具执行结束后把本次新增的生成记录镜像为 LLM 调用，让 trace 页能同时看到生成阶段的
 * 提示词与模型信息；镜像失败不影响工具结果。
 * @param tool 原始阶段工具
 * @param builtin 内置工具上下文（提供 trace / sessionId / runId / stageId / projectDir）
 * @returns 已挂上生成留痕的工具；无 trace 时原样返回
 */
function withGenerationMirror(
  tool: ToolDefinition<any, any>,
  builtin: BuiltinToolContext,
): ToolDefinition<any, any> {
  const trace = builtin.trace;
  if (!trace) return tool;
  return {
    ...tool,
    async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
      const startedAtIso = new Date().toISOString();
      try {
        return await tool.execute(toolCallId, params, signal, onUpdate, ctx);
      } finally {
        mirrorGenerationRecords(
          {
            trace,
            sessionId: builtin.sessionId,
            runId: resolveTraceId(builtin.runId),
            stageId: resolveTraceId(builtin.stageId),
            projectDir: builtin.projectDir,
          },
          tool.name,
          startedAtIso,
        );
      }
    },
  };
}

/**
 * 组合阶段工具与内置工具，并按 `(sessionId, runId, stageId)` 统一挂上工具调用留痕。
 *
 * 设计取舍（§7.3 要求「每次工具调用（含 Pi 内置工具）记录 tool_calls」）：
 * 留痕上下文**直接取自 `composition.builtin.{trace,sessionId,runId,stageId}`**，
 * 不再为阶段工具单独引入第二套上下文——二者同属一个会话/运行/阶段，共用一份上下文更简单且不易错位。
 * 阶段工具属于自定义工具，同样必须留痕，因此这里也对它套一层 `withToolTrace`。
 *
 * `composition.builtin.trace === undefined` 时退化为直接返回原始工具（不包装），避免无意义开销。
 * @param composition 阶段工具与内置工具的上下文组合
 * @returns 阶段工具在前、内置工具在后的工具定义数组
 */
export function createAgentTools(composition: AgentToolComposition): ToolDefinition<any, any>[] {
  const stageTools = (createStageTools(composition.stage) as ToolDefinition<any, any>[]).map(
    (tool) => withGenerationMirror(tool, composition.builtin),
  );
  // createBuiltinTools 内部已按同一上下文包装留痕（trace 缺省时退化为不包装）
  const builtinTools = createBuiltinTools(composition.builtin);

  const { trace, sessionId, runId, stageId, projectDir, outputPreviewChars } = composition.builtin;
  if (!trace) {
    return [...stageTools, ...builtinTools];
  }

  const traceOptions: ToolTraceOptions = {
    trace,
    sessionId,
    runId,
    stageId,
    projectDir,
    outputPreviewChars,
  };
  return [...stageTools.map((tool) => withToolTrace(tool, traceOptions)), ...builtinTools];
}
