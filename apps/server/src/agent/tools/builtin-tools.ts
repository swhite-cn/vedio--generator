import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TraceStore } from "../../trace/trace-store.js";
import { withCommandGuardrails, type CommandGuardrailRule } from "./command-guardrails.js";
import {
  createToolFailureState,
  withToolCircuitBreaker,
  type ToolFailureState,
} from "./tool-circuit-breaker.js";
import { withToolTrace, type TraceIdSource } from "./tool-trace.js";

/**
 * Pi 内置工具集（见设计文档 §5.4）。
 *
 * 放开策略：
 * - `read` / `grep` / `find` / `ls` **恒开**：agent 可自查项目内进度与产物；
 * - `bash` / `write` / `edit` 由 `agent.allow_shell_write_edit` 控制（默认 true），关闭后一键收紧为只读；
 * - 所有内置工具的 **`cwd` 固定为项目目录**——模型默认相对基准被锁在项目内；
 * - 每个工具都经 `withToolTrace` 包装，调用事实（命令原文、退出码、相对路径、耗时）全量落 `tool_calls`；
 * - `bash` 额外经**命令预检护栏**（`agent.command_guardrails`，配置驱动）与**重复失败熔断**
 *   （`agent.tool_failure_circuit_breaker`，相同参数连续失败即拒绝）两层防护。
 *
 * 设计边界（§14.6）：Pi 无 OS 级沙箱，`bash` / `write` / `edit` 放开后越界防护依赖
 * 「cwd 锁定 + 工具调用全量留痕 + 系统提示行为边界 + 命令护栏 + 重复失败熔断」，
 * 必要时用 `agent.allow_shell_write_edit: false` 收紧。
 */

/** 内置工具的运行上下文：由会话注册表 / 工作流引擎注入，模型无法覆盖。 */
export interface BuiltinToolContext {
  /** 项目工作目录：所有内置工具的 cwd 都锁死在这里（模型无法越出项目目录的默认相对基准）。 */
  projectDir: string;
  /** 是否放开 bash / write / edit（来自 config.agent.allow_shell_write_edit）。 */
  allowShellWriteEdit: boolean;
  /** 三级留痕写入器；缺省时不记录。 */
  trace?: TraceStore;
  /** 会话 ID（留痕必填）。 */
  sessionId: string;
  /** 运行 ID / 阶段 ID（自由对话时留空；也可传函数在每次调用时读取当前阶段上下文）。 */
  runId?: TraceIdSource;
  stageId?: TraceIdSource;
  /** 工具输出预览字符上限；缺省 `TOOL_OUTPUT_PREVIEW_CHARS`（来自 `agent.tool_output_preview_chars`）。 */
  outputPreviewChars?: number;
  /** bash 命令预检护栏规则（来自 `agent.command_guardrails`）；缺省空数组表示不启用。 */
  commandGuardrails?: readonly CommandGuardrailRule[];
  /** 相同（工具+参数）连续失败熔断阈值（来自 `agent.tool_failure_circuit_breaker`）；<= 0 表示关闭。 */
  toolFailureCircuitBreaker?: number;
}

/** 恒开的只读内置工具名（供测试与运行时核对工具集差异）。 */
export const BUILTIN_TOOL_NAMES_READONLY = ["read", "grep", "find", "ls"] as const;

/** 受 `allow_shell_write_edit` 控制的内置工具名（供测试与运行时核对工具集差异）。 */
export const BUILTIN_TOOL_NAMES_WRITE = ["bash", "write", "edit"] as const;

/**
 * 构造 Pi 内置工具集，并用工具调用留痕统一包装。
 * 顺序稳定：只读四件套在前，写 / 执行类在后（顺序与 `BUILTIN_TOOL_NAMES_*` 一致）。
 * 不包含 `powershell`（设计文档只提 `bash`）。
 *
 * 包装层次（由内到外）：命令护栏（仅 bash）→ 重复失败熔断 → 工具调用留痕。
 * 熔断状态按会话新建一份（同一会话的所有内置工具共用），阈值 / 规则均来自配置，
 * 缺省值时两层都退化为不包装，行为与改动前一致。
 * @param context 运行时注入的上下文（项目目录、放开策略、护栏与熔断配置、留痕上下文）
 * @returns 已包装留痕的内置工具定义数组
 */
export function createBuiltinTools(context: BuiltinToolContext): ToolDefinition<any, any>[] {
  const { projectDir } = context;
  const traceOptions = {
    trace: context.trace,
    sessionId: context.sessionId,
    runId: context.runId,
    stageId: context.stageId,
    projectDir,
    outputPreviewChars: context.outputPreviewChars,
  };
  const guardrails = context.commandGuardrails ?? [];
  const failureState: ToolFailureState = createToolFailureState();
  const breakerThreshold = context.toolFailureCircuitBreaker ?? 0;

  const definitions: ToolDefinition<any, any>[] = [
    createReadToolDefinition(projectDir),
    createGrepToolDefinition(projectDir),
    createFindToolDefinition(projectDir),
    createLsToolDefinition(projectDir),
  ];

  if (context.allowShellWriteEdit) {
    definitions.push(
      withCommandGuardrails(createBashToolDefinition(projectDir), guardrails),
      createWriteToolDefinition(projectDir),
      createEditToolDefinition(projectDir),
    );
  }

  return definitions.map((definition) =>
    withToolTrace(
      withToolCircuitBreaker(definition, { threshold: breakerThreshold, state: failureState }),
      traceOptions,
    ),
  );
}
