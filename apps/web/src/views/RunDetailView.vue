<script setup lang="ts">
/**
 * Run 详情（方案 §8.5 第 9 页）：失败 banner + 8 阶段列表 + 工具/LLM/事件留痕 + 质检门禁。
 *
 * 数据：`GET /api/runs/:id` + `GET /api/runs/:id/trace`（分页/阶段过滤）+ `GET /api/projects/:id/quality`。
 * 只读为主；失败时提供「从失败阶段重跑」（`POST /api/runs/:id/resume` retry）。
 * admin 从 `/admin` 进入时数据改走 `GET /api/admin/runs/:id/trace`，返回链接回 `/admin`。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { message } from "ant-design-vue";
import { useTraceStore, DEFAULT_TRACE_LIMIT } from "../stores/trace";
import { toStageProgress } from "../stores/workbench-reducer";
import { STAGE_LABELS, mapStageStatus, toolDisplayName } from "../components/state-mapping";
import { formatApiError, apiRequest } from "../services/api";
import { formatDateTime, formatDurationMs, formatElapsed } from "../components/format";
import StateTag from "../components/StateTag.vue";
import VfButton from "../components/ui/VfButton.vue";
import VfPill from "../components/ui/VfPill.vue";

/** 质检报告子集（`GET /api/projects/:id/quality` 的 `report`）。 */
interface QualityReportView {
  version: string;
  runId: string;
  generatedAt: string;
  checks: Array<{
    id: string;
    label: string;
    status: string;
    violations: Array<{ shotId?: string; detail: string }>;
  }>;
}

const route = useRoute();
const router = useRouter();
const trace = useTraceStore();

/** 单段 JSON 展示上限（超出截断并注明）。 */
const MAX_JSON_CHARS = 50 * 1024;

/** 当前项目 id。 */
const projectId = computed(() => String(route.params.id ?? ""));
/** 当前 run id。 */
const runId = computed(() => String(route.params.runId ?? route.params.id ?? ""));
/** 是否来自管理视图。 */
const isAdminSource = computed(() => route.query.admin === "1");
/** 当前选中的阶段实例 id（右侧明细按此过滤）。 */
const selectedStageId = ref("");
/** 明细 Tab 当前项。 */
const detailTab = ref("tools");
/** 是否处于窄屏。 */
const isNarrow = ref(false);
/** 质检报告。 */
const quality = ref<QualityReportView | null>(null);
/** 质检加载失败标记。 */
const qualityError = ref(false);
/** 重跑请求中。 */
const retrying = ref(false);
/** 正在提交单镜重生成的目标镜头 id（空串表示空闲）。 */
const rerunningShot = ref("");

let mediaQuery: MediaQueryList | null = null;

/** run 详情。 */
const run = computed(() => trace.run);
/** 加载错误是否为 403 越权。 */
const forbidden = computed(
  () => (trace.error as { code?: string } | null)?.code === "AUTH_FORBIDDEN",
);

/**
 * 阶段步骤行：复用 `toStageProgress` 按八阶段折叠（重试行只保留最新一次尝试，
 * 缺失阶段补 `pending`），旧七阶段 run 的 `captions` 显示为待执行。
 */
const stageRows = computed(() =>
  toStageProgress(trace.stages).map((row) => ({
    id: row.stage,
    stage: row.stage,
    status: row.status,
    label: STAGE_LABELS[row.stage] ?? row.stage,
    meta: mapStageStatus(row.status),
    attempt: row.attempt,
    errorCode: row.error_code,
    elapsed: formatElapsed(row.started_at, row.ended_at),
  })),
);

/** 当前页工具调用。 */
const toolRows = computed(() => trace.toolCalls);
/** 当前页 LLM 调用。 */
const llmRows = computed(() => trace.llmCalls);

/** 事件时间线：选中阶段时保留该阶段事件与 run 级事件。 */
const eventRows = computed(() =>
  trace.events.filter(
    (item) => !selectedStageId.value || !item.stage || item.stage === selectedStageId.value,
  ),
);

/** 工具调用表列定义。 */
const toolColumns = [
  { title: "阶段", key: "stage", width: 90 },
  { title: "工具", dataIndex: "tool", key: "tool" },
  { title: "状态", dataIndex: "ok", key: "ok", width: 90 },
  { title: "耗时", dataIndex: "duration_ms", key: "duration_ms", width: 90 },
  { title: "产物数", key: "artifacts", width: 80 },
];

/** LLM 调用表列定义。 */
const llmColumns = [
  { title: "阶段", key: "stage", width: 90 },
  { title: "模型", dataIndex: "model", key: "model" },
  { title: "prompt", dataIndex: "prompt_tokens", key: "prompt_tokens", width: 90 },
  { title: "completion", dataIndex: "completion_tokens", key: "completion_tokens", width: 100 },
  { title: "耗时", dataIndex: "duration_ms", key: "duration_ms", width: 90 },
  { title: "状态", dataIndex: "ok", key: "ok", width: 80 },
];

/** 阶段实例 id → 阶段名（表格「阶段」列展示）。 */
const stageNameById = computed(
  () => new Map(trace.stages.map((row) => [row.id, row.stage] as const)),
);

/**
 * 取留痕行所属阶段的中文名。
 * @param stageId 阶段实例 id（可能缺失）
 * @returns 阶段中文名；无法解析时为 `-`
 */
function stageLabelOf(stageId?: string): string {
  if (!stageId) return "-";
  const stage = stageNameById.value.get(stageId);
  return stage ? (STAGE_LABELS[stage] ?? stage) : "-";
}

/** 返回链接目标（admin 源回 `/admin`，否则回项目工作台）。 */
const backTarget = computed(() => {
  if (isAdminSource.value) return "/admin";
  return projectId.value ? `/projects/${projectId.value}` : "/projects";
});

/** 工具/LLM 表分页配置（后端分页：`limit`/`offset`）。 */
function tablePagination(total: number) {
  return {
    total,
    pageSize: trace.paging.limit,
    current: Math.floor(trace.paging.offset / trace.paging.limit) + 1,
    showSizeChanger: true,
    pageSizeOptions: ["20", "50", "100", "200"],
    showTotal: (value: number) => `共 ${value} 条`,
  };
}

/**
 * 优雅格式化 JSON 文本（超阈值截断并注明）。
 * @param value 待展示值
 * @returns `{ text, truncated }`
 */
function presentJson(value: unknown): { text: string; truncated: boolean } {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  if (!text) text = "（空）";
  if (text.length > MAX_JSON_CHARS) {
    return { text: text.slice(0, MAX_JSON_CHARS), truncated: true };
  }
  return { text, truncated: false };
}

/**
 * 复制文本到剪贴板。
 * @param text 待复制文本
 */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
    message.success("已复制");
  } catch (error) {
    console.warn("[web] 复制失败", error);
    message.warning("复制失败，请手动选择");
  }
}

/**
 * 加载项目质检报告（报告缺失时保持 null，不视为错误）。
 */
async function loadQuality(): Promise<void> {
  if (!projectId.value) return;
  qualityError.value = false;
  try {
    const result = await apiRequest<{ report: QualityReportView | null }>(
      `/api/projects/${encodeURIComponent(projectId.value)}/quality`,
    );
    quality.value = result.report;
  } catch (error) {
    qualityError.value = true;
    console.warn("[web] 质检报告加载失败", error);
  }
}

/**
 * 质检检查项 → 单镜重生成阶段（T404）。
 * - 静帧：重渲帧并重新合成；
 * - 字幕溢出：重跑 TTS → 时间轴 → 渲染 → 合成（cue 与时长一起更新）；
 * - 来源标签 / 动效越界：重跑场景选型 → 渲染 → 合成；
 * - 对比度是主题级全局问题，不提供单镜重跑。
 */
const RERUN_STAGES_BY_CHECK: Readonly<Record<string, readonly string[]>> = {
  freeze: ["render", "compose"],
  "subtitle-overflow": ["tts", "storyboard", "render", "compose"],
  "source-label": ["scene", "render", "compose"],
  "animation-duration": ["scene", "render", "compose"],
};

/**
 * 读取某检查项允许的单镜重跑阶段。
 * @param checkId 质检检查项 ID
 * @returns 阶段数组；不支持单镜重跑时为空数组
 */
function rerunStages(checkId: string): readonly string[] {
  return RERUN_STAGES_BY_CHECK[checkId] ?? [];
}

/**
 * 对质检失败镜头一键重生成（`POST /api/projects/:id/shots/:shotId/regenerate`）。
 * @param checkId 质检检查项 ID
 * @param shotId 失败镜头 ID
 */
async function rerunShot(checkId: string, shotId: string): Promise<void> {
  if (!projectId.value || rerunningShot.value) return;
  const stages = rerunStages(checkId);
  if (stages.length === 0) return;
  rerunningShot.value = shotId;
  try {
    const result = await apiRequest<{ run: { id: string } }>(
      `/api/projects/${encodeURIComponent(projectId.value)}/shots/${encodeURIComponent(shotId)}/regenerate`,
      { method: "POST", body: { stages } },
    );
    message.success(`已提交 ${shotId} 单镜重生成`);
    void router.push(`/projects/${projectId.value}/runs/${result.run.id}`);
  } catch (error) {
    message.error(formatApiError(error));
  } finally {
    rerunningShot.value = "";
  }
}

/**
 * 从失败阶段重跑（`POST /api/runs/:id/resume` retry），随后重拉留痕。
 */
async function retryFromFailure(): Promise<void> {
  if (!runId.value) return;
  retrying.value = true;
  try {
    await apiRequest(`/api/runs/${encodeURIComponent(runId.value)}/resume`, {
      method: "POST",
      body: { action: "retry" },
    });
    message.success("已请求从失败阶段续跑");
    await load();
  } catch (error) {
    message.error(formatApiError(error));
  } finally {
    retrying.value = false;
  }
}

/**
 * 质检状态对应 VfPill 色调。
 * @param status 质检结论
 * @returns pill tone
 */
function qualityTone(status: string): "success" | "danger" | "warning" | "neutral" {
  if (status === "pass") return "success";
  if (status === "fail") return "danger";
  if (status === "warn") return "warning";
  return "neutral";
}

/**
 * 加载 trace 数据（阶段过滤交给服务端，分页与过滤一致）。
 * @param offset 偏移量（默认 0）
 * @param limit 每页条数（默认当前分页）
 */
async function load(offset = 0, limit = trace.paging.limit): Promise<void> {
  try {
    await trace.load(runId.value, {
      limit,
      offset,
      admin: isAdminSource.value,
      stage: selectedStageId.value || null,
    });
  } catch (error) {
    console.warn("[web] trace 加载失败", error);
  }
}

/**
 * 表格分页变化：直达后端分页参数。
 * @param pagination 分页器状态
 */
function onTableChange(pagination: { current?: number; pageSize?: number }): void {
  const limit = pagination.pageSize ?? DEFAULT_TRACE_LIMIT;
  const current = pagination.current ?? 1;
  void load((current - 1) * limit, limit);
}

/**
 * 选中某阶段：同步地址栏 `?stage=`（刷新 / 从工作台锚链进入时保持选中），并重拉该阶段留痕。
 * @param id 阶段选中键（阶段名，见 `stageRows`）
 */
function selectStage(id: string): void {
  if (selectedStageId.value === id) return;
  selectedStageId.value = id;
  void router.replace({ path: route.path, query: { ...route.query, stage: id } });
  void load(0, trace.paging.limit);
}

/**
 * 清除阶段过滤，查看整条 run 的全部留痕。
 */
function clearStage(): void {
  selectedStageId.value = "";
  const query = { ...route.query };
  delete query.stage;
  void router.replace({ path: route.path, query });
  void load(0, trace.paging.limit);
}

/**
 * 从地址栏读取预选阶段（工作台工具卡片的「查看 trace」锚链会带 `?stage=`）。
 * @returns 阶段名；缺省为空串（由首个已执行阶段兜底）
 */
function stageFromQuery(): string {
  const value = route.query.stage;
  return typeof value === "string" ? value : "";
}

/**
 * 窄屏断点变化处理。
 * @param event 媒体查询对象或事件
 */
function handleMediaChange(event: MediaQueryListEvent | MediaQueryList): void {
  isNarrow.value = event.matches;
}

/** 返回上一级（admin 源回管理视图，否则回项目工作台）。 */
function goBack(): void {
  void router.push(backTarget.value);
}

onMounted(async () => {
  mediaQuery = window.matchMedia("(max-width: 899.98px)");
  handleMediaChange(mediaQuery);
  mediaQuery.addEventListener("change", handleMediaChange);
  selectedStageId.value = stageFromQuery();
  await Promise.all([load(), loadQuality()]);
});

// 切换项目时重拉质检报告
watch(projectId, () => {
  void loadQuality();
});

onUnmounted(() => {
  mediaQuery?.removeEventListener("change", handleMediaChange);
  mediaQuery = null;
  trace.reset();
});

// 切换 run 时重置选中与分页后重拉（保留地址栏指定阶段）
watch(runId, () => {
  trace.reset();
  selectedStageId.value = stageFromQuery();
  void load(0, DEFAULT_TRACE_LIMIT);
});

// 地址栏 `?stage=` 变化（如从工作台另一张工具卡片进入）时同步选中并重拉
watch(
  () => route.query.stage,
  (value) => {
    const next = typeof value === "string" ? value : "";
    if (next === selectedStageId.value) return;
    selectedStageId.value = next;
    void load(0, trace.paging.limit);
  },
);

// 阶段数据到达后默认选中首个已执行阶段（`stageRows` 恒为八阶段，故取首个非 pending）
watch(
  () => trace.stages.length,
  () => {
    if (selectedStageId.value) return;
    const first = stageRows.value.find((row) => row.status !== "pending") ?? stageRows.value[0];
    if (!first) return;
    selectedStageId.value = first.id;
    void load(0, trace.paging.limit);
  },
);
</script>

<template>
  <div class="trace-view">
    <!-- 页头 -->
    <header class="trace-header">
      <button type="button" class="trace-back" aria-label="返回" @click="goBack">← 返回</button>
      <h1 class="trace-title">Run #{{ runId }}</h1>
      <state-tag v-if="run" type="run" :status="run.status" :error-code="run.error_code" />
      <span v-if="run" class="trace-meta">触发：{{ run.trigger }}</span>
      <span v-if="run" class="trace-meta">开始：{{ formatDateTime(run.started_at) }}</span>
      <span v-if="run" class="trace-meta">结束：{{ formatDateTime(run.ended_at) }}</span>
      <span v-if="run" class="trace-meta"
        >耗时：{{ formatElapsed(run.started_at, run.ended_at) }}</span
      >
    </header>

    <!-- 失败 banner：错误码 + 失败阶段 + 从失败阶段重跑 -->
    <section v-if="run?.status === 'failed'" class="run-failure" role="alert">
      <div class="run-failure__body">
        <h2 class="run-failure__title">运行失败{{ run.error_code ? `（${run.error_code}）` : "" }}</h2>
        <p class="run-failure__desc">
          失败阶段：{{ STAGE_LABELS[run.current_stage ?? ""] ?? run.current_stage ?? "未知" }}
        </p>
      </div>
      <VfButton :disabled="retrying" @click="retryFromFailure">
        {{ retrying ? "提交中…" : "从失败阶段重跑" }}
      </VfButton>
    </section>

    <a-result v-if="forbidden" status="403" title="没有权限查看该内容" />
    <a-result
      v-else-if="trace.error"
      status="warning"
      title="Trace 加载失败"
      sub-title="请检查服务是否在线后重试"
    >
      <template #extra>
        <a-button type="primary" @click="load()">重试</a-button>
      </template>
    </a-result>

    <a-skeleton v-else-if="trace.loading && !run" active />

    <template v-else>
      <!-- 质检门禁（5 项，失败定位到镜头） -->
      <section class="run-quality" aria-label="质检门禁">
      <header class="run-quality__head">
        <h2 class="run-quality__title">质检门禁</h2>
        <span v-if="quality" class="run-quality__time is-mono">
          {{ quality.generatedAt }} · run {{ quality.runId.slice(0, 8) }}
        </span>
      </header>
      <p v-if="qualityError" class="run-quality__empty">质检报告加载失败。</p>
      <p v-else-if="!quality" class="run-quality__empty">尚未生成质检报告（合成阶段完成后产出）。</p>
      <ul v-else class="run-quality__list">
        <li v-for="check in quality.checks" :key="check.id">
          <VfPill :tone="qualityTone(check.status)">{{ check.label }}</VfPill>
          <ul v-if="check.violations.length > 0" class="run-quality__violations">
            <li
              v-for="(violation, index) in check.violations"
              :key="index"
              class="run-quality__violation"
            >
              <span class="is-mono">
                {{ violation.shotId ? `#${violation.shotId} ` : "" }}{{ violation.detail }}
              </span>
              <VfButton
                v-if="violation.shotId && rerunStages(check.id).length > 0"
                variant="ghost"
                class="run-quality__rerun"
                :disabled="rerunningShot === violation.shotId"
                @click="rerunShot(check.id, violation.shotId)"
              >
                {{ rerunningShot === violation.shotId ? "提交中…" : "重跑该镜" }}
              </VfButton>
            </li>
          </ul>
        </li>
      </ul>
      </section>

      <div class="trace-body" :class="{ 'is-narrow': isNarrow }">
      <!-- 左：八阶段步骤条 -->
      <section class="trace-stages" aria-label="阶段列表">
        <a-steps
          direction="vertical"
          size="small"
          :current="stageRows.findIndex((row) => row.id === selectedStageId)"
        >
          <a-step v-for="row in stageRows" :key="row.id" :status="row.meta.stepStatus">
            <template #title>
              <span
                class="trace-stage-title"
                :class="{ 'is-selected': row.id === selectedStageId }"
                role="button"
                tabindex="0"
                :aria-pressed="row.id === selectedStageId"
                :aria-label="`查看 ${row.label} 阶段明细`"
                @click="selectStage(row.id)"
                @keydown.enter="selectStage(row.id)"
              >
                {{ row.label }}
              </span>
            </template>
            <template #description>
              <div class="trace-stage-desc">
                <span>{{ row.meta.text }}</span>
                <span v-if="row.attempt > 0">· 第 {{ row.attempt }} 次尝试</span>
                <span v-if="row.elapsed !== '-'">· 耗时 {{ row.elapsed }}</span>
                <span v-if="row.errorCode" class="trace-stage-error">· {{ row.errorCode }}</span>
              </div>
            </template>
          </a-step>
        </a-steps>
      </section>

      <!-- 右：选中阶段明细 -->
      <section class="trace-detail">
        <div class="trace-scope">
          <span v-if="selectedStageId">
            当前阶段：{{ STAGE_LABELS[selectedStageId] ?? selectedStageId }}
          </span>
          <span v-else>当前展示：全部留痕</span>
          <a-button v-if="selectedStageId" type="link" size="small" @click="clearStage">
            查看全部留痕
          </a-button>
        </div>
        <a-tabs v-model:activeKey="detailTab">
          <!-- 工具调用 -->
          <a-tab-pane key="tools" tab="工具调用">
            <a-table
              :data-source="toolRows"
              :columns="toolColumns"
              :pagination="tablePagination(trace.total.toolCalls)"
              row-key="id"
              size="small"
              :scroll="{ x: 'max-content' }"
              @change="(pagination) => onTableChange(pagination)"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'stage'">{{
                  stageLabelOf(record.stage_id)
                }}</template>
                <template v-else-if="column.key === 'tool'">{{
                  toolDisplayName(record.tool)
                }}</template>
                <template v-else-if="column.key === 'ok'">
                  <a-tag :color="record.ok ? 'success' : 'error'">{{
                    record.ok ? "成功" : "失败"
                  }}</a-tag>
                </template>
                <template v-else-if="column.key === 'duration_ms'">
                  {{ formatDurationMs(record.duration_ms) }}
                </template>
                <template v-else-if="column.key === 'artifacts'">{{
                  record.artifact_paths.length
                }}</template>
              </template>
              <template #expandedRowRender="{ record }">
                <div class="trace-json">
                  <div class="trace-json-head">
                    <span>参数（args_json）</span>
                    <a-button size="small" @click="copyText(presentJson(record.args_json).text)"
                      >复制</a-button
                    >
                  </div>
                  <pre class="trace-code">{{ presentJson(record.args_json).text }}</pre>
                  <p v-if="presentJson(record.args_json).truncated" class="trace-truncated">
                    内容超过 50KB 已截断；完整内容本期请用 SQL 查询。
                  </p>

                  <!-- 输出预览：内置工具 stdout / 文件片段（服务端已截断） -->
                  <template v-if="record.output_preview">
                    <div class="trace-json-head">
                      <span>
                        输出
                        <span v-if="record.output_truncated" class="trace-truncated"
                          >（已截断）</span
                        >
                      </span>
                      <a-button size="small" @click="copyText(String(record.output_preview))"
                        >复制</a-button
                      >
                    </div>
                    <pre class="trace-code">{{ record.output_preview }}</pre>
                  </template>
                </div>
              </template>
            </a-table>
          </a-tab-pane>

          <!-- LLM 调用 -->
          <a-tab-pane key="llm" tab="LLM 调用">
            <a-table
              :data-source="llmRows"
              :columns="llmColumns"
              :pagination="tablePagination(trace.total.llmCalls)"
              row-key="id"
              size="small"
              :scroll="{ x: 'max-content' }"
              @change="(pagination) => onTableChange(pagination)"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'stage'">{{
                  stageLabelOf(record.stage_id)
                }}</template>
                <template v-else-if="column.key === 'ok'">
                  <a-tag :color="record.ok ? 'success' : 'error'">{{
                    record.ok ? "成功" : "失败"
                  }}</a-tag>
                </template>
                <template v-else-if="column.key === 'duration_ms'">
                  {{ formatDurationMs(record.duration_ms) }}
                </template>
              </template>
              <template #expandedRowRender="{ record }">
                <div class="trace-json">
                  <a-collapse ghost>
                    <a-collapse-panel key="req" header="请求（request_json）">
                      <div class="trace-json-head">
                        <a-button
                          size="small"
                          @click="copyText(presentJson(record.request_json).text)"
                        >
                          复制
                        </a-button>
                      </div>
                      <pre class="trace-code">{{ presentJson(record.request_json).text }}</pre>
                      <p v-if="presentJson(record.request_json).truncated" class="trace-truncated">
                        内容超过 50KB 已截断。
                      </p>
                    </a-collapse-panel>
                    <a-collapse-panel key="resp" header="响应（response_json）">
                      <div class="trace-json-head">
                        <a-button
                          size="small"
                          @click="copyText(presentJson(record.response_json).text)"
                        >
                          复制
                        </a-button>
                      </div>
                      <pre class="trace-code">{{ presentJson(record.response_json).text }}</pre>
                      <p v-if="presentJson(record.response_json).truncated" class="trace-truncated">
                        内容超过 50KB 已截断。
                      </p>
                    </a-collapse-panel>
                  </a-collapse>
                </div>
              </template>
            </a-table>
          </a-tab-pane>

          <!-- 事件：由 run / 阶段 / 工具 / LLM 留痕合成的时间线（不是原始 SSE 流） -->
          <a-tab-pane key="events" :tab="`事件（${eventRows.length}）`">
            <ul v-if="eventRows.length > 0" class="trace-events">
              <li
                v-for="item in eventRows"
                :key="item.id"
                class="trace-event"
                :class="`is-${item.type}`"
              >
                <span class="trace-event-time">{{ formatDateTime(item.at) }}</span>
                <span class="trace-event-dot" aria-hidden="true" />
                <span class="trace-event-title">{{ item.title }}</span>
                <a-tag v-if="item.stage" class="trace-event-stage">
                  {{ STAGE_LABELS[item.stage] ?? item.stage }}
                </a-tag>
                <span v-if="item.detail" class="trace-event-detail">{{ item.detail }}</span>
              </li>
            </ul>
            <a-empty v-else description="暂无留痕事件" />
          </a-tab-pane>
        </a-tabs>
      </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.trace-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.trace-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.trace-back {
  padding: 4px 8px;
  border: 1px solid var(--vf-border-strong);
  border-radius: var(--vf-radius-sm);
  background: var(--vf-surface);
  color: var(--vf-text-secondary);
  cursor: pointer;
}

.trace-scope {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
  color: var(--vf-text-tertiary);
  font-size: 12px;
}

.trace-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}

.trace-meta {
  color: var(--text-ter);
  font-size: var(--font-size-small);
}

/* 失败 banner */
.run-failure {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4);
  background: var(--danger-soft);
  border: 1px solid var(--danger);
  border-radius: var(--radius-card);
}

.run-failure__title {
  margin: 0 0 var(--space-1);
  font-size: var(--font-size-card-title);
  color: var(--danger);
}

.run-failure__desc {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--text-sec);
}

/* 质检门禁 */
.run-quality {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
}

.run-quality__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.run-quality__title {
  margin: 0;
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-strong);
  color: var(--text);
}

.run-quality__time {
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

.run-quality__empty {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--text-ter);
}

.run-quality__list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.run-quality__list > li {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.run-quality__violations {
  margin: 0;
  padding-inline-start: var(--space-4);
  font-size: var(--font-size-caption);
  color: var(--danger);
}

.run-quality__violation {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-2);
}

.run-quality__rerun {
  flex-shrink: 0;
  min-height: 28px;
  padding: 0 var(--space-3);
  font-size: var(--font-size-caption);
}

.trace-body {
  display: grid;
  grid-template-columns: minmax(0, 300px) minmax(0, 1fr);
  gap: 16px;
}

.trace-body.is-narrow {
  grid-template-columns: minmax(0, 1fr);
}

.trace-stages,
.trace-detail {
  padding: 16px;
  border: 1px solid var(--vf-border);
  border-radius: var(--vf-radius);
  background: var(--vf-surface);
}

/* 事件时间线：时间 + 状态点 + 标题 + 阶段标签 + 细节 */
.trace-events {
  margin: 0;
  padding: 0;
  list-style: none;
}

.trace-event {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 7px 4px;
  border-bottom: 1px dashed var(--vf-border);
  font-size: 13px;
}

.trace-event:last-child {
  border-bottom: 0;
}

.trace-event-time {
  flex: none;
  color: var(--vf-text-tertiary);
  font-family: var(--vf-font-mono);
  font-size: 12px;
}

.trace-event-dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: var(--vf-text-tertiary);
}

.trace-event.is-stage_failed .trace-event-dot,
.trace-event.is-run_failed .trace-event-dot {
  background: var(--vf-danger);
}

.trace-event.is-stage_done .trace-event-dot,
.trace-event.is-run_done .trace-event-dot {
  background: var(--vf-success);
}

.trace-event.is-stage_started .trace-event-dot,
.trace-event.is-run_started .trace-event-dot {
  background: var(--vf-primary);
}

.trace-event.is-stage_skipped .trace-event-dot {
  background: var(--vf-warning);
}

.trace-event-title {
  color: var(--vf-text);
}

.trace-event-stage {
  margin-inline-end: 0;
}

.trace-event-detail {
  color: var(--vf-text-tertiary);
  font-size: 12px;
}

.trace-stage-title {
  cursor: pointer;
}

.trace-stage-title.is-selected {
  font-weight: 700;
  color: var(--accent);
}

.trace-stage-desc {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  color: var(--text-ter);
  font-size: 12px;
}

.trace-stage-error {
  color: var(--danger);
}

.trace-json-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  font-size: 13px;
}

.trace-code {
  margin: 0;
  padding: 10px;
  max-height: 320px;
  overflow: auto;
  border-radius: 6px;
  background: var(--inset);
  color: var(--text-sec);
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}

.trace-truncated {
  margin: 6px 0 0;
  color: var(--warning);
  font-size: 12px;
}

@media (prefers-reduced-motion: reduce) {
  .trace-view :deep(*) {
    transition: none !important;
    animation: none !important;
  }
}
</style>
