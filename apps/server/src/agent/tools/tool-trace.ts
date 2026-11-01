import { relative, sep } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { VideoForgeError } from "@videoforge/shared";
import type { TraceStore } from "../../trace/trace-store.js";

/**
 * 通用「工具调用留痕」包装器（见设计文档 §7.3）。
 *
 * 用一层包装把任意 `ToolDefinition` 的 `execute` 前后事实落进 `tool_calls`：
 * - **异常不吞**：包装后的 `execute` 与原行为完全一致地向上抛异常（仅在抛之前补一条 `ok:false` 留痕）；
 * - **留痕失败不影响工具**：所有 `recordToolCall` 调用都有 `try/catch` 兜底，把审计问题与功能故障隔离；
 * - **`args` 裁剪**：`write` / `edit` 只保留目标路径（相对项目目录），**绝不记录正文**（正文可能超大且可能含敏感信息）；
 *   `bash` 记录命令原文，并尽量从 `structuredContent.exit_code` 补记退出码；其它工具原样记录整个 params；
 * - **无写入器即零开销**：`trace === undefined` 时直接返回原定义，行为与不加包装完全一致。
 */

/**
 * 留痕 ID 来源：既支持静态值，也支持函数。
 *
 * 场景工具在**会话创建时**构建，而 run / 阶段在**引擎进入阶段时**才确定；
 * 用函数可在每次工具调用时读取会话当前阶段上下文，避免留痕行永远落 `run_id=null`。
 */
export type TraceIdSource = string | null | undefined | (() => string | null | undefined);

/** `withToolTrace` 的留痕上下文。 */
export interface ToolTraceOptions {
  /** 三级留痕写入器；缺省时不记录任何调用（直接返回原定义）。 */
  trace?: TraceStore;
  /** 会话 ID（留痕必填）。 */
  sessionId: string;
  /** 运行 ID（自由对话时为 null/undefined，或返回当前 run 的函数）。 */
  runId?: TraceIdSource;
  /** 阶段 ID（自由对话时为 null/undefined，或返回当前阶段的函数）。 */
  stageId?: TraceIdSource;
  /**
   * 项目工作目录：仅用于把 `write` / `edit` 的绝对路径入参转成相对展示路径。
   * 缺省时退化为记录原始路径字符串（不改变「绝不记录正文」的裁剪规则）。
   */
  projectDir?: string;
}

/**
 * 解析留痕 ID 来源为最终字符串或 null。
 * @param source 静态值或取值函数
 * @returns 解析后的 ID（缺失时为 null）
 */
function resolveTraceId(source: TraceIdSource): string | null {
  const value = typeof source === "function" ? source() : source;
  return value ?? null;
}

/** `write` / `edit` 允许保留的路径类字段名（两者参数都只含 `path`）。 */
const PATH_PARAM_KEYS = ["path", "file_path", "filePath"] as const;

/** `bash` 工具名（留痕需补记退出码）。 */
const BASH_TOOL_NAME = "bash";

/** 需要裁剪正文的工具名（只保留路径类字段）。 */
const PATH_ONLY_TOOL_NAMES = new Set(["write", "edit"]);

/**
 * 把绝对路径转成「相对项目目录、正斜杠」的展示路径（便于跨平台断言与展示）。
 * 项目目录缺失时返回原值，避免在无法判定基准时凭空改写路径。
 * @param projectDir 项目工作目录
 * @param target 待转换的目标路径
 * @returns 项目相对、正斜杠形式的展示路径
 */
export function toProjectRelativePath(projectDir: string, target: string): string {
  return relative(projectDir, target).split(sep).join("/");
}

/**
 * 依据工具名裁剪 `args`，并按需补记 `bash` 退出码。
 * - `write` / `edit`：只保留 `path`（转相对项目目录），**剔除 `content` / `edits` 等正文**；
 * - `bash`：保留 `{ command, timeout? }`，成功拿到结构化结果时补记 `exit_code`；
 * - 其它工具：原样记录整个 params 对象。
 * @param toolName 工具名
 * @param params 工具入参
 * @param projectDir 项目工作目录（可空）
 * @param result 工具执行结果（仅 `bash` 用其补记退出码）
 * @returns 可安全落库的 `args`
 */
function buildTraceArgs(
  toolName: string,
  params: unknown,
  projectDir: string | undefined,
  result?: AgentToolResult<unknown>,
): unknown {
  if (toolName === BASH_TOOL_NAME && params && typeof params === "object") {
    const record = params as Record<string, unknown>;
    const args: Record<string, unknown> = { command: record.command };
    if (record.timeout !== undefined) args.timeout = record.timeout;
    const exitCode = extractExitCode(result);
    if (exitCode !== undefined) args.exit_code = exitCode;
    return args;
  }

  if (PATH_ONLY_TOOL_NAMES.has(toolName) && params && typeof params === "object") {
    const record = params as Record<string, unknown>;
    const trimmed: Record<string, unknown> = {};
    for (const key of PATH_PARAM_KEYS) {
      const value = record[key];
      if (typeof value === "string") {
        trimmed[key] = projectDir ? toProjectRelativePath(projectDir, value) : value;
      }
    }
    // 无论是否识别到路径字段都只返回裁剪结果：绝不回退记录整个 params（否则可能带出正文）
    return trimmed;
  }

  return params;
}

/** 从工具的 `structuredContent` 中取 `exit_code`（`bash` 结构化输出字段）。 */
function extractExitCode(result?: AgentToolResult<unknown>): number | undefined {
  if (!result) return undefined;
  const structured = result.structuredContent as { exit_code?: unknown } | undefined;
  return typeof structured?.exit_code === "number" ? structured.exit_code : undefined;
}

/**
 * 从失败结果的 `structuredContent` / `details` 中取稳定错误码。
 * 二者均由本项目的工具约定承载（SDK 无 `errorCode` 字段，见 SPIKE §6）；取不到返回 null。
 * @param result 工具执行结果
 * @returns 错误码或 null
 */
function extractErrorCode(result: AgentToolResult<unknown>): string | null {
  const structured = result.structuredContent as { errorCode?: unknown } | undefined;
  if (typeof structured?.errorCode === "string") return structured.errorCode;
  const details = result.details as { errorCode?: unknown } | undefined;
  if (typeof details?.errorCode === "string") return details.errorCode;
  return null;
}

/** 从成功结果的 `details.artifacts` 中取产物相对路径（阶段工具使用此约定）。 */
function extractArtifactPaths(result: AgentToolResult<unknown>): string[] {
  const details = result.details as { artifacts?: unknown } | undefined;
  if (!Array.isArray(details?.artifacts)) return [];
  return details.artifacts.filter((path): path is string => typeof path === "string");
}

/**
 * 安全写入一条工具调用留痕：**留痕失败不得影响工具本身**（否则把审计问题升级为功能故障）。
 * @param trace 留痕写入器
 * @param options 留痕上下文
 * @param input 单条留痕的核心字段
 */
function safeRecordToolCall(
  trace: TraceStore,
  options: ToolTraceOptions,
  input: {
    tool: string;
    args: unknown;
    ok: boolean;
    errorCode: string | null;
    durationMs: number;
    artifactPaths: string[];
  },
): void {
  try {
    trace.recordToolCall({
      sessionId: options.sessionId,
      runId: resolveTraceId(options.runId),
      stageId: resolveTraceId(options.stageId),
      tool: input.tool,
      // 脱敏由 recordToolCall 内部 redactDeep 统一负责，此处不做二次处理
      args: input.args,
      ok: input.ok,
      errorCode: input.errorCode,
      durationMs: input.durationMs,
      artifactPaths: input.artifactPaths,
    });
  } catch (error) {
    console.error(
      `[tool-trace] 工具留痕写入失败（${input.tool}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * 用「工具调用留痕」包装一个 `ToolDefinition`。
 * 异常继续向上抛（不改变 Pi 的行为），但会在抛出前补记一条 `ok:false` 留痕。
 * `trace === undefined` 时直接返回原定义，零额外开销。
 * @param definition 被包装的工具定义
 * @param options 留痕上下文（写入器 / 会话 / 运行 / 阶段 / 项目目录）
 * @returns 包装后的工具定义（保留原全部字段）
 */
export function withToolTrace<TParams extends TSchema, TDetails>(
  definition: ToolDefinition<TParams, TDetails>,
  options: ToolTraceOptions,
): ToolDefinition<TParams, TDetails> {
  const { trace } = options;
  if (!trace) return definition;

  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>> {
      const startedAt = Date.now();
      let result: AgentToolResult<TDetails>;
      try {
        result = await definition.execute(toolCallId, params, signal, onUpdate, ctx);
      } catch (error) {
        // 先留痕（失败态），再原样抛出：绝不吞异常，避免改变 Pi 的重试/终止语义
        const errorCode = error instanceof VideoForgeError ? error.code : "TOOL_UNAVAILABLE";
        safeRecordToolCall(trace, options, {
          tool: definition.name,
          args: buildTraceArgs(definition.name, params, options.projectDir),
          ok: false,
          errorCode,
          durationMs: Date.now() - startedAt,
          artifactPaths: [],
        });
        throw error;
      }

      const ok = result.isError !== true;
      safeRecordToolCall(trace, options, {
        tool: definition.name,
        args: buildTraceArgs(
          definition.name,
          params,
          options.projectDir,
          result as AgentToolResult<unknown>,
        ),
        ok,
        errorCode: ok
          ? null
          : (extractErrorCode(result as AgentToolResult<unknown>) ?? "TOOL_UNAVAILABLE"),
        durationMs: Date.now() - startedAt,
        artifactPaths: extractArtifactPaths(result as AgentToolResult<unknown>),
      });
      return result;
    },
  };
}
