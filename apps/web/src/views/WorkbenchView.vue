<script setup lang="ts">
/**
 * 工作台（Web 专题 §5.4，核心页）：单项目的全部操作面——对话、阶段进度、审核、产物、run 控制。
 *
 * 布局：页头（返回 + 项目名 + 能力/项目/run 状态 + 发起/取消/查看 Trace）+ 左对话流 + 右上阶段进度 +
 * 右下产物面板 + 底部输入框；`<900px` 时右侧两块与对话流合并为顶部 Tab。
 * 状态一律来自 `workbench` store（纯 reducer + SSE），本页只做渲染与交互编排，不推导状态机。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { message } from "ant-design-vue";
import { ArrowLeftOutlined, SendOutlined } from "@ant-design/icons-vue";
import { useWorkbenchStore } from "../stores/workbench";
import { useCapabilitiesStore } from "../stores/capabilities";
import { formatApiError } from "../services/api";
import type { ResumePayload } from "../components/review-logic";
import type { WorkbenchMessage } from "../stores/workbench-reducer";
import StageSteps from "../components/StageSteps.vue";
import ArtifactTabs from "../components/ArtifactTabs.vue";
import MessageBubble from "../components/MessageBubble.vue";
import StateTag from "../components/StateTag.vue";

const route = useRoute();
const router = useRouter();
const workbench = useWorkbenchStore();
const capabilities = useCapabilitiesStore();

/** 当前项目 id（来自路由参数）。 */
const projectId = computed(() => String(route.params.id ?? ""));
/** 产物面板当前 Tab（受控）。 */
const activeTab = ref("copy");
/** 窄屏下顶部 Tab 的当前项（对话 / 进度 / 产物）。 */
const narrowTab = ref("chat");
/** 是否处于窄屏（<900px，右侧两块并入顶部 Tab）。 */
const isNarrow = ref(false);
/** 输入框草稿。 */
const draft = ref("");
/** 对话流滚动容器。 */
const listRef = ref<HTMLElement | null>(null);
/** 用户是否停留在底部（上翻时不强跳）。 */
let stickToBottom = true;

let mediaQuery: MediaQueryList | null = null;

/** 能力中文名（未命中回退能力 id）。 */
const capabilityName = computed(
  () =>
    capabilities.findById(workbench.project?.capability_id ?? "")?.name ??
    workbench.project?.capability_id ??
    "",
);

/** 待审核阶段（run 处于 waiting_review 时高亮步骤条对应阶段）。 */
const reviewStage = computed(() =>
  workbench.currentRun?.status === "waiting_review" ? workbench.currentRun.current_stage : null,
);

/** 加载错误是否为 403 越权。 */
const forbidden = computed(
  () => (workbench.loadError as { code?: string } | null)?.code === "AUTH_FORBIDDEN",
);

/** 页头「查看 Trace」是否可用（须存在最近一次 run）。 */
const traceEnabled = computed(() => Boolean(workbench.currentRun?.id));

/** 输入框占位提示：run 活跃时提示可继续自由对话（§5.4.2）。 */
const inputPlaceholder = computed(() =>
  workbench.runActive
    ? "任务运行中，可随时与 agent 讨论…"
    : "输入消息，Enter 发送，Shift+Enter 换行",
);

/** 发送按钮是否禁用。 */
const sendDisabled = computed(
  () => workbench.sending || draft.value.trim().length === 0 || !workbench.session,
);

/**
 * 流式刷新令牌：`text_delta` 追加到最后一条气泡但不改变消息数量，
 * 故用「消息数 + 末条文本长度 + 末条工具状态」的复合键驱动滚动锚定。
 */
const streamTick = computed(() => {
  const list = workbench.messages;
  const last = list[list.length - 1];
  return `${list.length}:${last?.text?.length ?? 0}:${last?.tool?.status ?? ""}`;
});

/** 取消息对应阶段（用于点击步骤条时滚动定位）。 */
function messageStage(item: WorkbenchMessage): string {
  return item.tool?.stage ?? "";
}

/**
 * 计算窄屏断点。
 * @param event 媒体查询对象或事件
 */
function handleMediaChange(event: MediaQueryListEvent | MediaQueryList): void {
  isNarrow.value = event.matches;
}

/** 滚动到对话流底部。 */
function scrollToBottom(): void {
  const el = listRef.value;
  if (el) {
    el.scrollTop = el.scrollHeight;
  }
}

/** 记录用户是否停留在底部（上翻时不强跳）。 */
function onListScroll(): void {
  const el = listRef.value;
  if (!el) return;
  stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

/**
 * 点击步骤条阶段：滚动定位到该阶段的首个工具卡片锚链（不提供跳转操作）。
 * @param stage 阶段标识
 */
function scrollToStage(stage: string): void {
  const el = listRef.value?.querySelector(`[data-stage="${stage}"]`);
  if (el instanceof HTMLElement) {
    el.scrollIntoView({ block: "nearest" });
  }
}

/** 加载工作台数据（失败时由 `loadError` 渲染 `Result`）。 */
async function load(): Promise<void> {
  try {
    await workbench.load(projectId.value);
  } catch (error) {
    console.warn("[web] 工作台加载失败", error);
  }
}

/** 发送输入框内容。 */
async function send(): Promise<void> {
  const text = draft.value.trim();
  if (text.length === 0 || workbench.sending) return;
  try {
    await workbench.sendMessage(text);
    draft.value = "";
  } catch {
    // store 已统一提示（formatApiError），此处仅保留草稿
  }
}

/**
 * 回车发送（Shift+Enter 换行）。
 * @param event 键盘事件
 */
function onPressEnter(event: KeyboardEvent): void {
  if (event.shiftKey) return;
  event.preventDefault();
  void send();
}

/** 发起 run。 */
function onStartRun(): void {
  void workbench.startRun().catch(() => undefined);
}

/** 取消当前 run。 */
function onCancelRun(): void {
  void workbench.cancelRun().catch(() => undefined);
}

/** 跳转最近一次 run 的 Trace 视图。 */
function goTrace(): void {
  const id = workbench.currentRun?.id;
  if (id) {
    void router.push(`/runs/${id}/trace`);
  }
}

/** 中断当前自由对话轮（§5.4.2「中断」按钮）。 */
function onAbort(): void {
  void workbench.abortChat();
}

/**
 * 提交审核结论（来自审核卡片）。
 * @param messageId 审核卡片所在消息 id
 * @param payload resume 请求体
 */
async function onReviewSubmit(messageId: string, payload: ResumePayload): Promise<void> {
  try {
    await workbench.resumeRun(messageId, payload.action, payload.feedback);
  } catch (error) {
    message.error(formatApiError(error));
  }
}

/** 返回项目列表。 */
function goBack(): void {
  void router.push("/projects");
}

/** 最佳努力加载能力列表（用于展示能力中文名，失败仅回退能力 id）。 */
async function loadCapabilities(): Promise<void> {
  if (capabilities.loaded) return;
  try {
    await capabilities.load();
  } catch (error) {
    console.warn("[web] 能力列表加载失败，工作台回退展示能力 id", error);
  }
}

onMounted(async () => {
  mediaQuery = window.matchMedia("(max-width: 899.98px)");
  handleMediaChange(mediaQuery);
  mediaQuery.addEventListener("change", handleMediaChange);

  await loadCapabilities();
  await load();
  await nextTick();
  scrollToBottom();
});

onUnmounted(() => {
  mediaQuery?.removeEventListener("change", handleMediaChange);
  mediaQuery = null;
  workbench.dispose();
});

// 项目 id 变化（路由复用同一组件）时重新装载
watch(projectId, () => {
  activeTab.value = "copy";
  void load();
});

// run 成功完成时把产物面板切到「成片」Tab（§7.2 run_end）
watch(
  () => workbench.finalReady,
  (ready) => {
    if (ready) activeTab.value = "final";
  },
);

// 对话流内容变化时若用户停留在底部则锚定到底
watch(streamTick, async () => {
  await nextTick();
  if (stickToBottom) scrollToBottom();
});
</script>

<template>
  <div class="workbench">
    <!-- 页头区（§5.4.1） -->
    <header class="wb-header">
      <button type="button" class="wb-back" aria-label="返回项目列表" @click="goBack">
        <arrow-left-outlined aria-hidden="true" />
        返回
      </button>
      <h1 class="wb-title" :title="workbench.project?.name">
        {{ workbench.project?.name ?? "工作台" }}
      </h1>
      <a-tag v-if="capabilityName" color="blue">{{ capabilityName }}</a-tag>
      <state-tag v-if="workbench.project" type="project" :status="workbench.project.status" />
      <state-tag
        v-if="workbench.currentRun"
        type="run"
        :status="workbench.currentRun.status"
        :error-code="workbench.currentRun.error_code"
      />

      <div class="wb-actions">
        <a-tooltip :title="workbench.runActive ? '已有任务在运行' : ''">
          <a-button
            type="primary"
            :disabled="workbench.runActive || workbench.actionPending"
            :loading="workbench.actionPending && !workbench.runActive"
            @click="onStartRun"
          >
            发起 run
          </a-button>
        </a-tooltip>
        <a-popconfirm
          v-if="workbench.runActive"
          title="确定取消当前运行？"
          ok-text="取消运行"
          cancel-text="继续等待"
          @confirm="onCancelRun"
        >
          <a-button danger :disabled="workbench.actionPending">取消 run</a-button>
        </a-popconfirm>
        <a-button :disabled="!traceEnabled" @click="goTrace">查看 Trace</a-button>
      </div>
    </header>

    <!-- 越权 / 加载失败（§8） -->
    <a-result v-if="forbidden" status="403" title="没有权限查看该内容" />
    <a-result
      v-else-if="workbench.loadError"
      status="warning"
      title="工作台加载失败"
      sub-title="请检查服务是否在线后重试"
    >
      <template #extra>
        <a-button type="primary" @click="load">重试</a-button>
      </template>
    </a-result>

    <a-skeleton v-else-if="workbench.loading && !workbench.project" active />

    <template v-else>
      <!-- 窄屏顶部 Tab 导航 -->
      <a-tabs v-if="isNarrow" v-model:activeKey="narrowTab" class="wb-narrow-nav">
        <a-tab-pane key="chat" tab="对话" />
        <a-tab-pane key="progress" tab="进度" />
        <a-tab-pane key="artifact" tab="产物" />
      </a-tabs>

      <div class="wb-body" :class="{ 'is-narrow': isNarrow }">
        <!-- 对话流（左栏，§5.4.2） -->
        <section v-show="!isNarrow || narrowTab === 'chat'" class="wb-chat" aria-label="对话流">
          <a-alert
            v-if="workbench.connection === 'disconnected'"
            type="error"
            show-icon
            banner
            message="实时连接已断开，正在重试…"
            class="wb-conn-alert"
          />

          <div ref="listRef" class="wb-messages" aria-live="polite" @scroll="onListScroll">
            <a-empty
              v-if="workbench.messages.length === 0"
              description="暂无对话，任务进度与工具调用将实时显示在这里"
            />
            <div
              v-for="item in workbench.messages"
              :key="item.id"
              :data-stage="messageStage(item)"
              class="wb-message"
            >
              <message-bubble
                :message="item"
                :project="workbench.project"
                :run-id="workbench.currentRun?.id"
                :review-submitting="workbench.actionPending"
                @review-submit="(payload) => onReviewSubmit(item.id, payload)"
              />
            </div>
          </div>

          <div class="wb-input">
            <a-textarea
              v-model:value="draft"
              :auto-size="{ minRows: 1, maxRows: 5 }"
              :placeholder="inputPlaceholder"
              :disabled="workbench.sending || !workbench.session"
              aria-label="对话输入框"
              @press-enter="onPressEnter"
            />
            <div class="wb-input-actions">
              <a-button v-if="workbench.agentStreaming" danger @click="onAbort">中断</a-button>
              <a-button
                type="primary"
                :disabled="sendDisabled"
                :loading="workbench.sending"
                @click="send"
              >
                <template #icon><send-outlined /></template>
                发送
              </a-button>
            </div>
          </div>
        </section>

        <!-- 右栏：阶段进度 + 产物面板 -->
        <aside class="wb-side">
          <section v-show="!isNarrow || narrowTab === 'progress'" class="wb-panel wb-stages">
            <h2 class="wb-panel-title">阶段进度</h2>
            <stage-steps
              :stages="workbench.stages"
              :review-stage="reviewStage"
              @select="scrollToStage"
            />
          </section>

          <section v-show="!isNarrow || narrowTab === 'artifact'" class="wb-panel wb-artifacts">
            <h2 class="wb-panel-title">产物</h2>
            <artifact-tabs
              v-model:active-tab="activeTab"
              :artifacts="workbench.artifacts"
              :project="workbench.project"
              :final-ready="workbench.finalReady"
            />
          </section>
        </aside>
      </div>
    </template>
  </div>
</template>

<style scoped>
.workbench {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 48px - 48px);
  min-height: 420px;
  gap: 12px;
}

.wb-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.wb-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  background: #fff;
  color: rgb(0 0 0 / 75%);
  cursor: pointer;
}

.wb-title {
  max-width: 320px;
  margin: 0;
  overflow: hidden;
  font-size: 18px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-actions {
  display: flex;
  margin-inline-start: auto;
  gap: 8px;
}

.wb-narrow-nav :deep(.ant-tabs-content-holder) {
  display: none;
}

.wb-body {
  display: grid;
  flex: 1;
  min-height: 0;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: 12px;
}

.wb-body.is-narrow {
  grid-template-columns: minmax(0, 1fr);
}

.wb-chat {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  background: #fff;
}

.wb-conn-alert {
  flex: none;
}

.wb-messages {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  padding: 4px 2px;
}

.wb-input {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 8px;
}

.wb-input-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.wb-side {
  display: grid;
  min-height: 0;
  grid-template-rows: minmax(0, auto) minmax(0, 1fr);
  gap: 12px;
}

.wb-body.is-narrow .wb-side {
  grid-template-rows: auto;
}

.wb-panel {
  min-height: 0;
  padding: 12px;
  overflow: auto;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  background: #fff;
}

.wb-panel-title {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
}

.wb-stages {
  max-height: 46vh;
}

@media (max-width: 899.98px) {
  .workbench {
    height: auto;
    min-height: 0;
  }

  .wb-stages {
    max-height: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .workbench :deep(*) {
    transition: none !important;
    animation: none !important;
  }
}
</style>
