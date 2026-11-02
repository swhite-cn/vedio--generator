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
import { ArrowLeftOutlined, PaperClipOutlined, SendOutlined } from "@ant-design/icons-vue";
import { useWorkbenchStore } from "../stores/workbench";
import { useAssetsStore } from "../stores/assets";
import { useCapabilitiesStore } from "../stores/capabilities";
import { formatApiError } from "../services/api";
import type { ResumePayload } from "../components/review-logic";
import { buildChatItems } from "../components/chat-grouping";
import type { ChatItem } from "../components/chat-grouping";
import StageSteps from "../components/StageSteps.vue";
import ArtifactTabs from "../components/ArtifactTabs.vue";
import MessageBubble from "../components/MessageBubble.vue";
import ToolGroup from "../components/ToolGroup.vue";
import StateTag from "../components/StateTag.vue";

const route = useRoute();
const router = useRouter();
const workbench = useWorkbenchStore();
const assets = useAssetsStore();
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
/** 当前草稿引用的项目资产 ID。 */
const selectedAssetIds = ref<string[]>([]);
/** 隐藏上传控件引用。 */
const uploadInputRef = ref<HTMLInputElement | null>(null);
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

/** 已选择的资产实体。 */
const selectedAssets = computed(() =>
  selectedAssetIds.value.flatMap((id) => {
    const asset = assets.items.find((item) => item.id === id);
    return asset ? [asset] : [];
  }),
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

/** 渲染项：连续的内置工具调用折叠为一个工具组，其余逐条渲染。 */
const chatItems = computed(() => buildChatItems(workbench.messages));

/**
 * 取渲染项对应的阶段（工具组取首条卡片）。
 * @param item 渲染项
 * @returns 阶段标识
 */
function itemStage(item: ChatItem): string {
  if (item.kind === "toolGroup") {
    return item.items[0]?.tool?.stage ?? "";
  }
  return item.message.tool?.stage ?? "";
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

/**
 * 加载更早的历史消息，并保持当前视口内容不因前置插入而跳动。
 */
async function onLoadEarlier(): Promise<void> {
  const el = listRef.value;
  const previousHeight = el?.scrollHeight ?? 0;
  const previousTop = el?.scrollTop ?? 0;
  try {
    await workbench.loadEarlier();
  } catch {
    // store 已统一提示（formatApiError），此处保持原视口不动
    return;
  }
  await nextTick();
  if (el) {
    // 前置插入会推高 scrollHeight，补偿差值即可让原首条消息停在原位
    el.scrollTop = el.scrollHeight - previousHeight + previousTop;
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
    await workbench.sendMessage(text, selectedAssetIds.value);
    draft.value = "";
    selectedAssetIds.value = [];
  } catch {
    // store 已统一提示（formatApiError），此处仅保留草稿
  }
}

/**
 * 从产物面板发起定向重生成：把范围写进草稿，交给 Agent 按最小范围执行。
 * 不直接调用生成接口，保证仍然经过 Agent 与三级留痕。
 * @param payload 目标阶段与场景 ID
 */
function prefillRegeneration(payload: { stage: "image" | "scene" | "tts"; sceneId: string }): void {
  const label =
    payload.stage === "image" ? "配图" : payload.stage === "scene" ? "场景动画" : "配音";
  draft.value = `只重新生成场景 ${payload.sceneId} 的${label}，不要改动其它场景。请先读取 manifest/generations.jsonl 中该场景最新的生成记录，在其提示词基础上增量调整。`;
  if (isNarrow.value) narrowTab.value = "chat";
}

/** 添加一个资产到当前草稿引用，重复选择自动忽略。 */
function addAssetReference(assetId: string): void {
  if (!selectedAssetIds.value.includes(assetId)) {
    selectedAssetIds.value = [...selectedAssetIds.value, assetId];
  }
}

/** 从当前草稿中移除一个资产引用，不影响项目资产本身。 */
function removeAssetReference(assetId: string): void {
  selectedAssetIds.value = selectedAssetIds.value.filter((id) => id !== assetId);
}

/** 打开系统文件选择器。 */
function chooseUpload(): void {
  uploadInputRef.value?.click();
}

/** 上传用户选择的单个项目素材，成功后自动加入草稿引用。 */
async function onUpload(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !projectId.value) return;
  try {
    const asset = await assets.upload(projectId.value, file);
    addAssetReference(asset.id);
    message.success(`已上传并引用：${asset.label}`);
  } catch (error) {
    message.error(formatApiError(error));
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
  await assets
    .load(projectId.value)
    .catch((error) => console.warn("[web] 项目资产加载失败", error));
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
  selectedAssetIds.value = [];
  void load();
  void assets.load(projectId.value).catch(() => undefined);
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
        <a-tab-pane key="artifact" tab="资产" />
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
            <div v-if="workbench.hasMoreHistory" class="wb-load-earlier">
              <a-button
                type="link"
                size="small"
                :loading="workbench.loadingEarlier"
                @click="onLoadEarlier"
              >
                加载更早的消息
              </a-button>
            </div>
            <a-empty
              v-if="workbench.messages.length === 0"
              description="暂无对话，任务进度与工具调用将实时显示在这里"
            />
            <div
              v-for="item in chatItems"
              :key="item.key"
              :data-stage="itemStage(item)"
              class="wb-message"
            >
              <tool-group
                v-if="item.kind === 'toolGroup'"
                :items="item.items"
                :project="workbench.project"
                :run-id="workbench.currentRun?.id"
              />
              <message-bubble
                v-else
                :message="item.message"
                :project="workbench.project"
                :run-id="workbench.currentRun?.id"
                :review-submitting="workbench.actionPending"
                @review-submit="(payload) => onReviewSubmit(item.message.id, payload)"
              />
            </div>
          </div>

          <div class="wb-input">
            <div v-if="selectedAssets.length" class="wb-asset-chips" aria-label="已引用资产">
              <a-tag
                v-for="asset in selectedAssets"
                :key="asset.id"
                closable
                @close.prevent="removeAssetReference(asset.id)"
              >
                {{ asset.kind }} · {{ asset.label }}
              </a-tag>
            </div>
            <a-textarea
              v-model:value="draft"
              :auto-size="{ minRows: 1, maxRows: 5 }"
              :placeholder="inputPlaceholder"
              :disabled="workbench.sending || !workbench.session"
              aria-label="对话输入框"
              @press-enter="onPressEnter"
            />
            <div class="wb-input-actions">
              <a-select
                class="wb-asset-select"
                show-search
                :value="undefined"
                placeholder="@ 引用项目资产"
                :options="
                  assets.filteredItems.map((asset) => ({
                    value: asset.id,
                    label: `${asset.kind} · ${asset.label}`,
                  }))
                "
                aria-label="引用项目资产"
                @select="addAssetReference"
              />
              <input
                ref="uploadInputRef"
                class="wb-upload-input"
                type="file"
                accept=".txt,.md,.pdf,.png,.jpg,.jpeg,.webp,.mp3,.wav,.m4a,.ogg"
                @change="onUpload"
              />
              <a-button :loading="assets.uploading" aria-label="上传项目素材" @click="chooseUpload">
                <template #icon><paper-clip-outlined /></template>
                上传
              </a-button>
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
            <div class="wb-assets-heading">
              <h2 class="wb-panel-title">项目资产</h2>
              <a-input
                v-model:value="assets.query"
                size="small"
                placeholder="搜索素材"
                aria-label="搜索项目资产"
              />
            </div>
            <div class="wb-asset-list">
              <a-empty
                v-if="!assets.filteredItems.length"
                :image="false"
                description="暂无可引用资产"
              />
              <button
                v-for="asset in assets.filteredItems"
                :key="asset.id"
                type="button"
                class="wb-asset-item"
                @click="addAssetReference(asset.id)"
              >
                <span>{{ asset.kind }}</span>
                <strong>{{ asset.label }}</strong>
                <small>{{ asset.source === "uploaded" ? "已上传" : "流水线生成" }}</small>
              </button>
            </div>
            <a-divider />
            <h3 class="wb-panel-title">流水线产物</h3>
            <artifact-tabs
              v-model:active-tab="activeTab"
              :artifacts="workbench.artifacts"
              :project="workbench.project"
              :final-ready="workbench.finalReady"
              @regenerate="prefillRegeneration"
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
  width: 100%;
  flex-direction: column;
  /* 高度 = 视口 - 顶栏 - 内容区上下内边距（16px × 2），保证输入框始终可见 */
  height: calc(100vh - var(--vf-header-height) - 32px);
  min-height: 420px;
  margin: 0 auto;
  gap: 10px;
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
  border: 1px solid var(--vf-border-strong);
  border-radius: var(--vf-radius-sm);
  background: var(--vf-surface);
  color: var(--vf-text-secondary);
  cursor: pointer;
}

.wb-title {
  max-width: 320px;
  margin: 0;
  overflow: hidden;
  font-size: 16px;
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
  gap: 10px;
}

.wb-body.is-narrow {
  grid-template-columns: minmax(0, 1fr);
}

.wb-chat {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--vf-border);
  border-radius: var(--vf-radius);
  background: var(--vf-surface);
}

.wb-conn-alert {
  flex: none;
}

.wb-load-earlier {
  display: flex;
  flex: none;
  justify-content: center;
}

.wb-messages {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: 8px;
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

.wb-asset-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.wb-asset-select {
  width: 180px;
}

.wb-upload-input {
  display: none;
}

.wb-assets-heading {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wb-assets-heading .wb-panel-title {
  flex: none;
}

.wb-asset-list {
  display: grid;
  max-height: 160px;
  gap: 4px;
  overflow: auto;
}

.wb-asset-item {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) auto;
  gap: 6px;
  padding: 6px;
  border: 1px solid var(--vf-border);
  border-radius: var(--vf-radius-sm);
  background: var(--vf-surface);
  color: var(--vf-text);
  cursor: pointer;
  text-align: left;
}

.wb-asset-item:hover {
  border-color: var(--vf-primary);
}

.wb-asset-item strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-asset-item small {
  color: var(--vf-text-tertiary);
}

.wb-side {
  display: grid;
  min-height: 0;
  grid-template-rows: minmax(0, auto) minmax(0, 1fr);
  gap: 10px;
}

.wb-body.is-narrow .wb-side {
  grid-template-rows: auto;
}

.wb-panel {
  min-height: 0;
  padding: 10px;
  overflow: auto;
  border: 1px solid var(--vf-border);
  border-radius: var(--vf-radius);
  background: var(--vf-surface);
}

.wb-panel-title {
  margin: 0 0 8px;
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
