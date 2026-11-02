import type { LlmCall, Run, RunStage, ToolCall } from "@videoforge/shared";

/**
 * Trace「事件」时间线：由 `runs` / `run_stages` / `tool_calls` / `llm_calls` 合成。
 *
 * 设计文档 §11 刻意不建 `events` 表，故本模块用既有留痕合成只读时间线，
 * 供 Trace 页「事件」Tab 展示；合成结果**不是**原始 SSE 事件流，仅表达留痕事实。
 */

/** 合成后的事件类型。 */
export type TraceEventType =
  | "run_started"
  | "run_done"
  | "run_failed"
  | "stage_started"
  | "stage_done"
  | "stage_failed"
  | "stage_skipped"
  | "tool_call"
  | "llm_call";

/** 一条合成事件。 */
export interface TraceEvent {
  /** 稳定 id（由来源与主键拼装，仅用于前端 key）。 */
  id: string;
  type: TraceEventType;
  /** 事件时间（ISO 字符串；缺失时为空串）。 */
  at: string;
  /** 所属阶段（run 级事件为空）。 */
  stage: string | null;
  /** 简短标题。 */
  title: string;
  /** 附加信息（失败码、耗时、token 等）。 */
  detail?: string;
}

/**
 * 合成一次 run 的留痕时间线（按时间升序）。
 * @param run run 详情
 * @param stages 阶段实例
 * @param toolCalls 工具调用（调用方传入全量，不含分页切片）
 * @param llmCalls LLM 调用（同上）
 * @returns 合成事件列表
 */
export function buildRunEvents(
  run: Run,
  stages: RunStage[],
  toolCalls: ToolCall[],
  llmCalls: LlmCall[],
): TraceEvent[] {
  const events: TraceEvent[] = [];
  // 阶段行 id → 阶段名（tool_calls / llm_calls 只存 stage_id，时间线需要阶段名）
  const stageNameById = new Map(stages.map((stage) => [stage.id, stage.stage]));

  if (run.started_at) {
    events.push({
      id: `run-started-${run.id}`,
      type: "run_started",
      at: run.started_at,
      stage: null,
      title: "run 开始",
      detail: run.trigger ? `触发：${run.trigger}` : undefined,
    });
  }
  if (run.ended_at) {
    const failed = run.status === "failed";
    events.push({
      id: `run-${failed ? "failed" : "done"}-${run.id}`,
      type: failed ? "run_failed" : "run_done",
      at: run.ended_at,
      stage: run.current_stage ?? null,
      title: failed ? "run 失败" : "run 结束",
      detail: run.error_code ?? undefined,
    });
  }

  for (const stage of stages) {
    const label = stage.stage;
    if (stage.started_at) {
      events.push({
        id: `stage-started-${stage.id}`,
        type: "stage_started",
        at: stage.started_at,
        stage: label,
        title: `${label} 阶段开始`,
        detail: stage.attempt > 0 ? `第 ${stage.attempt} 次尝试` : undefined,
      });
    }
    if (stage.ended_at) {
      const type =
        stage.status === "failed"
          ? "stage_failed"
          : stage.status === "skipped"
            ? "stage_skipped"
            : "stage_done";
      events.push({
        id: `stage-${stage.status}-${stage.id}`,
        type,
        at: stage.ended_at,
        stage: label,
        title: `${label} 阶段${stage.status === "failed" ? "失败" : stage.status === "skipped" ? "跳过" : "完成"}`,
        detail: stage.error_code ?? undefined,
      });
    }
  }

  for (const call of toolCalls) {
    events.push({
      id: `tool-${call.id}`,
      type: "tool_call",
      at: call.created_at,
      stage: call.stage_id ? (stageNameById.get(call.stage_id) ?? null) : null,
      title: `${call.tool} ${call.ok ? "成功" : "失败"}`,
      detail: call.error_code ?? `${call.duration_ms}ms`,
    });
  }

  for (const call of llmCalls) {
    events.push({
      id: `llm-${call.id}`,
      type: "llm_call",
      at: call.created_at,
      stage: call.stage_id ? (stageNameById.get(call.stage_id) ?? null) : null,
      title: `${call.model} ${call.ok ? "成功" : "失败"}`,
      detail: `${call.prompt_tokens + call.completion_tokens} tokens · ${call.duration_ms}ms`,
    });
  }

  return events.sort((a, b) => a.at.localeCompare(b.at));
}
