import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { VideoForgeError } from "@videoforge/shared";
import type { TSchema } from "typebox";

/**
 * 工具调用「重复失败熔断」（L3，见设计文档 §14.6）。
 *
 * 背景：工具失败后模型常常**原样重试同一调用**。真机曾出现 agent 用完全相同的参数
 * 连续调用 grep 99 次、每次都因同一个原因失败，白白烧掉数分钟。
 * 硬熔断的做法：相同（工具名 + 参数）连续失败达到阈值后，后续**完全相同的调用不再执行本体**，
 * 直接返回 `TOOL_CIRCUIT_OPEN`，强制模型换参数或换思路。
 *
 * 状态按会话、按「工具名 + 规范化参数」分桶：某签名一旦成功即清零，不影响其它签名。
 * 阈值来自配置 `agent.tool_failure_circuit_breaker`，为 0 时整个包装退化为原定义。
 */

/** 熔断状态：key = `工具名\0规范化参数`，value = 该签名当前连续失败次数。 */
export type ToolFailureState = Map<string, number>;

/**
 * 创建一份空的熔断状态（每次会话一份，避免跨会话串味）。
 * @returns 空的失败计数表
 */
export function createToolFailureState(): ToolFailureState {
  return new Map();
}

/**
 * 把值规范化为「键名有序」的结构，保证同一逻辑参数得到同一字符串。
 * 只处理 JSON 可表达的结构；日期等非纯对象原样交由 JSON.stringify 处理。
 * @param value 任意参数值
 * @returns 键名已排序的等价结构
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonicalize(source[key]);
    return sorted;
  }
  return value;
}

/**
 * 稳定序列化：对象键名排序后 JSON 序列化，作为参数指纹。
 * @param value 任意参数值
 * @returns 稳定字符串（无法序列化时退化为 String）
 */
export function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(canonicalize(value)) ?? String(value);
  } catch {
    return String(value);
  }
}

/** `withToolCircuitBreaker` 的配置。 */
export interface ToolCircuitBreakerOptions {
  /** 熔断阈值（连续失败次数）；<= 0 表示关闭熔断，直接返回原定义。 */
  threshold: number;
  /** 会话级共享状态（同一会话的所有工具共用一个 Map）。 */
  state: ToolFailureState;
  /** 熔断触发时的回调（用于日志/留痕，可选）。 */
  onOpen?: (info: { tool: string; failures: number }) => void;
}

/**
 * 给工具挂一层「重复失败熔断」。
 *
 * 语义：
 * - 进入时若该签名已连续失败 ≥ 阈值 → 不执行本体，抛 `TOOL_CIRCUIT_OPEN`；
 * - 执行返回 `isError` 结果或抛异常 → 该签名失败计数 +1；
 * - 执行成功 → 清除该签名计数。
 *
 * `threshold <= 0` 时原样返回定义（零开销）。
 * @param definition 被包装的工具定义
 * @param options 阈值与共享状态
 * @returns 包装后的工具定义（保留原全部字段）
 */
export function withToolCircuitBreaker<TParams extends TSchema, TDetails>(
  definition: ToolDefinition<TParams, TDetails>,
  options: ToolCircuitBreakerOptions,
): ToolDefinition<TParams, TDetails> {
  const { threshold, state, onOpen } = options;
  if (threshold <= 0) return definition;

  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>> {
      const key = `${definition.name}\u0000${stableStringify(params)}`;
      const failures = state.get(key) ?? 0;

      if (failures >= threshold) {
        onOpen?.({ tool: definition.name, failures });
        throw new VideoForgeError(
          "TOOL_CIRCUIT_OPEN",
          `工具 ${definition.name} 以相同参数已连续失败 ${failures} 次，已熔断：请更换参数或改用其它方式，不要重复同一调用。`,
        );
      }

      try {
        const result = await definition.execute(toolCallId, params, signal, onUpdate, ctx);
        if (result.isError === true) {
          state.set(key, failures + 1);
        } else {
          state.delete(key);
        }
        return result;
      } catch (error) {
        // 异常同样计入失败，保证「抛错型失败」也会被熔断
        state.set(key, failures + 1);
        throw error;
      }
    },
  };
}
