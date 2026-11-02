<script setup lang="ts">
/**
 * run Trace 视图（Web 专题 §5.5）：一次 run 的完整留痕只读展示。
 *
 * 页头（返回 + Run #id + run 状态 + 触发方式 + 起止时间 + 总耗时）→ 左右分栏
 * （窄屏上下堆叠）：左为七阶段步骤条（含 attempt / 耗时 / errorCode，点击选中），
 * 右为选中阶段的明细 Tab（工具调用 / LLM 调用 / 事件）。
 * admin 从 `/admin` 进入时数据改走 `GET /api/admin/runs/:id/trace`，仅返回链接回 `/admin`。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { message } from "ant-design-vue";
import { useTraceStore, DEFAULT_TRACE_LIMIT } from "../stores/trace";
import { toStageProgress } from "../stores/workbench-reducer";
import { STAGE_LABELS, mapStageStatus, toolDisplayName } from "../components/state-mapping";
import { formatDateTime, formatDurationMs, formatElapsed } from "../components/format";
import StateTag from "../components/StateTag.vue";

const route = useRoute();
const router = useRouter();
const trace = useTraceStore();

/** 单段 JSON 展示上限（超出截断并注明，见 §5.5）。 */
const MAX_JSON_CHARS = 50 * 1024;

/** 当前 run id。 */
const runId = computed(() => String(route.params.id ?? ""));
/** 是否来自管理视图（决定数据来源与返回链接）。 */
const isAdminSource = computed(() => route.query.admin === "1");
/** 当前选中的阶段实例 id（右侧明细按此过滤）。 */
const selectedStageId = ref("");
/** 明细 Tab 当前项。 */
const detailTab = ref("tools");
/** 是否处于窄屏（左右分栏改为上下堆叠）。 */
const isNarrow = ref(false);

let mediaQuery: MediaQueryList | null = null;

/** run 详情。 */
const run = computed(() => trace.run);
/** 加载错误是否为 403 越权。 */
const forbidden = computed(
  () => (trace.error as { code?: string } | null)?.code === "AUTH_FORBIDDEN",
);

/**
 * 阶段步骤行：复用 `toStageProgress` 按七阶段折叠（重试行只保留最新一次尝试，
 * 缺失阶段补 `pending`），保证步骤条恒为 1..7（Web 专题 §5.5「`Steps` 竖排七阶段」）。
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

/** 当前页工具调用（服务端已按选中阶段过滤）。 */
const toolRows = computed(() => trace.toolCalls);
/** 当前页 LLM 调用（服务端已按选中阶段过滤）。 */
const llmRows = computed(() => trace.llmCalls);

/**
 * 事件时间线：选中阶段时保留该阶段事件与 run 级事件（`stage` 为空）。
 */
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

/** 返回链接目标（admin 源回 `/admin`，否则回该 run 所属项目工作台）。 */
const backTarget = computed(() => {
  if (isAdminSource.value) return "/admin";
  return run.value?.project_id ? `/projects/${run.value.project_id}` : "/projects";
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
  await load();
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

// 阶段数据到达后默认选中首个已执行阶段（`stageRows` 恒为七阶段，故取首个非 pending）
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

    <div v-else class="trace-body" :class="{ 'is-narrow': isNarrow }">
      <!-- 左：七阶段步骤条 -->
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
  color: rgb(0 0 0 / 45%);
  font-size: 13px;
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
  color: #1677ff;
}

.trace-stage-desc {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  color: rgb(0 0 0 / 45%);
  font-size: 12px;
}

.trace-stage-error {
  color: #cf1322;
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
  background: #f5f5f5;
  font-family: Consolas, "Courier New", monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}

.trace-truncated {
  margin: 6px 0 0;
  color: #d46b08;
  font-size: 12px;
}

@media (prefers-reduced-motion: reduce) {
  .trace-view :deep(*) {
    transition: none !important;
    animation: none !important;
  }
}
</style>
