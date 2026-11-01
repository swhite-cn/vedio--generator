/**
 * run Trace store（Web 专题 §5.5、§7.1）。
 *
 * 职责：装载单次 run 的详情 + 分页 trace 数据（工具调用 / LLM 调用 + 阶段实例），
 * 供 `/runs/:id/trace` 页消费；分页参数直达后端 `?limit=&offset=`。
 */
import { ref } from "vue";
import { defineStore } from "pinia";
import { apiRequest } from "../services/api";
import type { RunSummary } from "./workbench-reducer";

/** 阶段实例行（服务端 `run_stages`，保留 `id` 以便按阶段过滤留痕）。 */
export interface TraceStage {
  id: string;
  run_id: string;
  stage: string;
  status: string;
  attempt: number;
  error_code: string | null;
  artifact_paths: string[];
  started_at: string | null;
  ended_at: string | null;
}

/** 工具调用留痕行（服务端 `tool_calls`）。 */
export interface TraceToolCall {
  id: string;
  session_id: string;
  run_id?: string;
  stage_id?: string;
  tool: string;
  args_json: unknown;
  ok: boolean;
  error_code: string | null;
  duration_ms: number;
  artifact_paths: string[];
  created_at: string;
}

/** LLM 调用留痕行（服务端 `llm_calls`）。 */
export interface TraceLlmCall {
  id: string;
  session_id: string;
  run_id?: string;
  stage_id?: string;
  model: string;
  request_json: unknown;
  response_json: unknown;
  prompt_tokens: number;
  completion_tokens: number;
  duration_ms: number;
  ok: boolean;
  error_code: string | null;
  created_at: string;
}

/** trace 接口响应体（`GET /api/runs/:id/trace` 与 admin 版本形状一致）。 */
interface TraceResponse {
  run: RunSummary;
  stages: TraceStage[];
  toolCalls: TraceToolCall[];
  llmCalls: TraceLlmCall[];
  total: { toolCalls: number; llmCalls: number };
  paging: { limit: number; offset: number };
}

/** 默认每页条数（与后端 `DEFAULT_TRACE_LIMIT` 一致）。 */
export const DEFAULT_TRACE_LIMIT = 50;

export const useTraceStore = defineStore("trace", () => {
  /** run 详情。 */
  const run = ref<RunSummary | null>(null);
  /** 阶段实例列表（含 `id`，供按阶段过滤）。 */
  const stages = ref<TraceStage[]>([]);
  /** 当前页工具调用切片。 */
  const toolCalls = ref<TraceToolCall[]>([]);
  /** 当前页 LLM 调用切片。 */
  const llmCalls = ref<TraceLlmCall[]>([]);
  /** 分片前总数。 */
  const total = ref({ toolCalls: 0, llmCalls: 0 });
  /** 当前分页（`{ limit, offset }`）。 */
  const paging = ref({ limit: DEFAULT_TRACE_LIMIT, offset: 0 });
  /** 加载中。 */
  const loading = ref(false);
  /** 加载错误（供页面渲染 Result）。 */
  const error = ref<unknown>(null);

  /**
   * 加载 run trace。
   * @param runId run id
   * @param options 分页与来源选项（`admin=true` 走 `GET /api/admin/runs/:id/trace`）
   */
  async function load(
    runId: string,
    options: { limit?: number; offset?: number; admin?: boolean } = {},
  ): Promise<void> {
    const limit = options.limit ?? DEFAULT_TRACE_LIMIT;
    const offset = options.offset ?? 0;
    const base = options.admin
      ? `/api/admin/runs/${encodeURIComponent(runId)}/trace`
      : `/api/runs/${encodeURIComponent(runId)}/trace`;

    loading.value = true;
    error.value = null;
    try {
      const result = await apiRequest<TraceResponse>(
        `${base}?limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(offset))}`,
      );
      run.value = result.run;
      stages.value = result.stages;
      toolCalls.value = result.toolCalls;
      llmCalls.value = result.llmCalls;
      total.value = result.total;
      paging.value = result.paging;
      console.info(
        `[web-store] trace 已加载：${runId}（工具 ${result.toolCalls.length}/${result.total.toolCalls}）`,
      );
    } catch (caught) {
      error.value = caught;
      throw caught;
    } finally {
      loading.value = false;
    }
  }

  /** 重置 trace 状态（切换 run 时调用）。 */
  function reset(): void {
    run.value = null;
    stages.value = [];
    toolCalls.value = [];
    llmCalls.value = [];
    total.value = { toolCalls: 0, llmCalls: 0 };
    paging.value = { limit: DEFAULT_TRACE_LIMIT, offset: 0 };
    error.value = null;
  }

  return { run, stages, toolCalls, llmCalls, total, paging, loading, error, load, reset };
});
