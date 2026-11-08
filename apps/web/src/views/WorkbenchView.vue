<script setup lang="ts">
/**
 * 工作台（方案 §8.5 第 5 页，核心页）：单项目的全部操作面。
 *
 * 布局：页头（返回/项目名/能力/项目状态/run 状态/操作）+ 左对话流 + 右侧 4 Tab
 * （阶段进度 / 分镜 / 项目资产 / 流水线产物）。`<900px` 时改为「对话 / 阶段 / 分镜 / 资产 / 产物」
 * 顶部切换。状态一律来自 `workbench` store（纯 reducer + SSE），页面只做渲染与交互编排。
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
import { buildChatItems, type ChatItem } from "../components/chat-grouping";
import {
  mapProjectStatus,
  mapRunStatus,
  statusTone,
} from "../components/state-mapping";
import WorkbenchTabs from "../components/WorkbenchTabs.vue";
import MessageBubble from "../components/MessageBubble.vue";
import ToolGroup from "../components/ToolGroup.vue";
import VfPill from "../components/ui/VfPill.vue";
import VfButton from "../components/ui/VfButton.vue";

const route = useRoute();
const router = useRouter();
const workbench = useWorkbenchStore();
const assets = useAssetsStore();
const capabilities = useCapabilitiesStore();

/** 当前项目 id（来自路由参数）。 */
const projectId = computed(() => String(route.params.id ?? ""));
/** 右侧 Tab 当前项。 */
const activeTab = ref("stage");
/** 窄屏顶部 Tab（chat 或右侧 Tab key）。 */
const narrowTab = ref("chat");
/** 是否窄屏（<900px）。 */
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

/** 项目状态展示。 */
const projectStatus = computed(() =>
  workbench.project ? mapProjectStatus(workbench.project.status) : null,
);

/** run 状态展示。 */
const runStatus = computed(() =>
  workbench.currentRun
    ? mapRunStatus(workbench.currentRun.status, workbench.currentRun.error_code)
    : null,
);

/** 待审核阶段。 */
const reviewStage = computed(() =>
  workbench.currentRun?.status === "waiting_review" ? workbench.currentRun.current_stage : null,
);

/** 加载错误是否为 403 越权。 */
const forbidden = computed(
  () => (workbench.loadError as { code?: string } | null)?.code === "AUTH_FORBIDDEN",
);

/** 输入框占位提示。 */
const inputPlaceholder = computed(() =>
  workbench.runActive
    ? "任务运行中，可随时与 agent 讨论…（Enter 发送，Shift+Enter 换行）"
    : "输入消息，Enter 发送，Shift+Enter 换行",
);

/** 发送按钮禁用。 */
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

/** 可引用的资产选项（排除已选）。 */
const assetOptions = computed(() =>
  assets.items.filter((asset) => !selectedAssetIds.value.includes(asset.id)),
);

/** 流式刷新令牌（驱动滚动锚定）。 */
const streamTick = computed(() => {
  const list = workbench.messages;
  const last = list[list.length - 1];
  return `${list.length}:${last?.text?.length ?? 0}:${last?.tool?.status ?? ""}`;
});

/** 渲染项：连续内置工具折叠为工具组。 */
const chatItems = computed(() => buildChatItems(workbench.messages));

/**
 * 取渲染项对应阶段。
 * @param item 渲染项
 * @returns 阶段标识
 */
function itemStage(item: ChatItem): string {
  if (item.kind === "toolGroup") return item.items[0]?.tool?.stage ?? "";
  return item.message.tool?.stage ?? "";
}

/**
 * 窄屏断点变化。
 * @param event 媒体查询对象或事件
 */
function handleMediaChange(event: MediaQueryListEvent | MediaQueryList): void {
  isNarrow.value = event.matches;
}

/** 滚动到对话流底部。 */
function scrollToBottom(): void {
  const el = listRef.value;
  if (el) el.scrollTop = el.scrollHeight;
}

/** 记录是否停留在底部。 */
function onListScroll(): void {
  const el = listRef.value;
  if (!el) return;
  stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

/**
 * 点击阶段：滚动定位到对话流中该阶段的首个工具卡片。
 * @param stage 阶段标识
 */
function scrollToStage(stage: string): void {
  const el = listRef.value?.querySelector(`[data-stage="${stage}"]`);
  if (el instanceof HTMLElement) el.scrollIntoView({ block: "nearest" });
}

/**
 * 加载更早历史消息并保持视口。
 */
async function onLoadEarlier(): Promise<void> {
  const el = listRef.value;
  const previousHeight = el?.scrollHeight ?? 0;
  const previousTop = el?.scrollTop ?? 0;
  try {
    await workbench.loadEarlier();
  } catch {
    return;
  }
  await nextTick();
  if (el) el.scrollTop = el.scrollHeight - previousHeight + previousTop;
}

/** 加载工作台数据。 */
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
    // store 已统一提示
  }
}

/**
 * 从产物面板发起定向重生成：写入草稿交给 Agent 执行。
 * @param payload 目标阶段与镜头 ID（v2 产物按镜头粒度归属）
 */
function prefillRegeneration(payload: { stage: "image" | "scene" | "tts"; shotId: string }): void {
  const label = payload.stage === "image" ? "配图" : payload.stage === "scene" ? "场景版式" : "配音";
  draft.value = `只重新生成镜头 ${payload.shotId} 的${label}，不要改动其它镜头。请先读取 manifest/generations.jsonl 中该镜头最新的生成记录，在其提示词基础上增量调整。`;
  if (isNarrow.value) narrowTab.value = "chat";
}

/**
 * 引用一个资产到当前草稿，重复选择忽略。
 * @param assetId 资产 id
 */
function addAssetReference(assetId: string): void {
  if (!selectedAssetIds.value.includes(assetId)) {
    selectedAssetIds.value = [...selectedAssetIds.value, assetId];
  }
}

/**
 * 移除草稿中的资产引用。
 * @param assetId 资产 id
 */
function removeAssetReference(assetId: string): void {
  selectedAssetIds.value = selectedAssetIds.value.filter((id) => id !== assetId);
}

/**
 * 原生 select 变更后引用资产并复位选择器。
 * @param event change 事件
 */
function onSelectAsset(event: Event): void {
  const select = event.target as HTMLSelectElement;
  if (select.value) addAssetReference(select.value);
  select.value = "";
}

/** 打开系统文件选择器。 */
function chooseUpload(): void {
  uploadInputRef.value?.click();
}

/**
 * 上传用户选择的单个项目素材，成功后自动加入草稿引用。
 * @param event 文件输入事件
 */
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
  if (event.shiftKey || event.isComposing) return;
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

/** 跳转最近一次 run 详情。 */
function goRunDetail(): void {
  const runId = workbench.currentRun?.id;
  if (runId) void router.push(`/projects/${projectId.value}/runs/${runId}`);
}

/** 中断当前自由对话轮。 */
function onAbort(): void {
  void workbench.abortChat();
}

/**
 * 提交审核结论。
 * @param messageId 审核卡片消息 id
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

/** 打开分镜编辑器。 */
function openStoryboard(): void {
  void router.push(`/projects/${projectId.value}/storyboard`);
}

/** 最佳努力加载能力列表。 */
async function loadCapabilities(): Promise<void> {
  if (capabilities.loaded) return;
  try {
    await capabilities.load();
  } catch (error) {
    console.warn("[web] 能力列表加载失败，工作台回退展示能力 id", error);
  }
}

/**
 * 窄屏顶部导航栏（对话 + 4 个右侧 Tab）。
 * @param key 导航项
 */
function onNarrowTab(key: string): void {
  narrowTab.value = key;
  if (key !== "chat") activeTab.value = key;
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

// 项目切换（路由复用同一组件）时重新装载
watch(projectId, () => {
  activeTab.value = "stage";
  narrowTab.value = "chat";
  selectedAssetIds.value = [];
  void load();
  void assets.load(projectId.value).catch(() => undefined);
});

// 产物/资产变化时刷新项目资产列表（tool_end / asset.bound）
watch(
  () => workbench.state.artifactRefreshToken,
  () => {
    void assets.load(projectId.value).catch(() => undefined);
  },
);

// run 成功完成时切到「产物」Tab
watch(
  () => workbench.finalReady,
  (ready) => {
    if (ready) {
      activeTab.value = "artifacts";
      if (isNarrow.value) narrowTab.value = "artifacts";
    }
  },
);

// 对话流变化时锚定到底部
watch(streamTick, async () => {
  await nextTick();
  if (stickToBottom) scrollToBottom();
});
</script>

<template>
  <div class="workbench">
    <!-- 页头 -->
    <header class="wb-header">
      <button type="button" class="wb-back" aria-label="返回项目列表" @click="goBack">
        <arrow-left-outlined aria-hidden="true" />
        返回
      </button>
      <h1 class="wb-title" :title="workbench.project?.name">
        {{ workbench.project?.name ?? "工作台" }}
      </h1>
      <VfPill v-if="capabilityName" tone="info">{{ capabilityName }}</VfPill>
      <VfPill v-if="projectStatus" :tone="statusTone(projectStatus.color)">
        {{ projectStatus.text }}
      </VfPill>
      <VfPill v-if="runStatus" :tone="statusTone(runStatus.color)">{{ runStatus.text }}</VfPill>

      <div class="wb-actions">
        <VfButton
          :disabled="workbench.runActive || workbench.actionPending"
          @click="onStartRun"
        >
          {{ workbench.actionPending && !workbench.runActive ? "发起中…" : "发起 Run" }}
        </VfButton>
        <VfButton v-if="workbench.runActive" variant="danger" @click="onCancelRun">
          取消 Run
        </VfButton>
        <VfButton variant="ghost" :disabled="!workbench.currentRun" @click="goRunDetail">
          查看 Run
        </VfButton>
      </div>
    </header>

    <!-- 越权 / 加载失败 -->
    <section v-if="forbidden" class="wb-state">
      <h2 class="wb-state__title">没有权限查看该内容</h2>
    </section>
    <section v-else-if="workbench.loadError" class="wb-state">
      <h2 class="wb-state__title">工作台加载失败</h2>
      <p class="wb-state__desc">请检查服务是否在线后重试。</p>
      <VfButton @click="load">重试</VfButton>
    </section>
    <p v-else-if="workbench.loading && !workbench.project" class="wb-state__desc">正在加载工作台…</p>

    <template v-else>
      <!-- 窄屏导航 -->
      <nav v-if="isNarrow" class="wb-narrow-nav" aria-label="工作台分区">
        <button
          v-for="item in [
            { key: 'chat', label: '对话' },
            { key: 'stage', label: '阶段' },
            { key: 'storyboard', label: '分镜' },
            { key: 'assets', label: '资产' },
            { key: 'artifacts', label: '产物' },
          ]"
          :key="item.key"
          type="button"
          class="wb-narrow-tab"
          :class="{ 'is-active': narrowTab === item.key }"
          :aria-pressed="narrowTab === item.key"
          @click="onNarrowTab(item.key)"
        >
          {{ item.label }}
        </button>
      </nav>

      <div class="wb-body" :class="{ 'is-narrow': isNarrow }">
        <!-- 对话流 -->
        <section
          v-show="!isNarrow || narrowTab === 'chat'"
          class="wb-chat"
          aria-label="对话流"
        >
          <p v-if="workbench.connection === 'disconnected'" class="wb-conn" role="alert">
            实时连接已断开，正在重试…
          </p>

          <div ref="listRef" class="wb-messages" aria-live="polite" @scroll="onListScroll">
            <div v-if="workbench.hasMoreHistory" class="wb-load-earlier">
              <VfButton variant="ghost" @click="onLoadEarlier">
                {{ workbench.loadingEarlier ? "加载中…" : "加载更早的消息" }}
              </VfButton>
            </div>
            <p v-if="workbench.messages.length === 0" class="wb-muted">
              暂无对话，任务进度与工具调用将实时显示在这里。
            </p>
            <div
              v-for="item in chatItems"
              :key="item.key"
              :data-stage="itemStage(item)"
              class="wb-message"
            >
              <ToolGroup
                v-if="item.kind === 'toolGroup'"
                :items="item.items"
                :project="workbench.project"
                :run-id="workbench.currentRun?.id"
              />
              <MessageBubble
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
              <span v-for="asset in selectedAssets" :key="asset.id" class="wb-chip">
                {{ asset.kind }} · {{ asset.label }}
                <button
                  type="button"
                  class="wb-chip__remove"
                  :aria-label="`移除引用 ${asset.label}`"
                  @click="removeAssetReference(asset.id)"
                >
                  ×
                </button>
              </span>
            </div>

            <textarea
              v-model="draft"
              class="wb-textarea"
              rows="2"
              :placeholder="inputPlaceholder"
              aria-label="对话输入框"
              :disabled="workbench.sending || !workbench.session"
              @keydown.enter="onPressEnter"
            />

            <div class="wb-input-actions">
              <select class="wb-asset-select" aria-label="引用项目资产" @change="onSelectAsset">
                <option value="">@ 引用项目资产</option>
                <option v-for="asset in assetOptions" :key="asset.id" :value="asset.id">
                  {{ asset.kind }} · {{ asset.label }}
                </option>
              </select>
              <input
                ref="uploadInputRef"
                class="wb-upload-input"
                type="file"
                accept=".txt,.md,.pdf,.png,.jpg,.jpeg,.webp,.mp3,.wav,.m4a,.ogg"
                @change="onUpload"
              />
              <VfButton variant="ghost" @click="chooseUpload">
                <paper-clip-outlined aria-hidden="true" />
                {{ assets.uploading ? "上传中…" : "上传" }}
              </VfButton>
              <VfButton v-if="workbench.agentStreaming" variant="danger" @click="onAbort">
                中断
              </VfButton>
              <VfButton :disabled="sendDisabled" @click="send">
                <send-outlined aria-hidden="true" />
                {{ workbench.sending ? "发送中…" : "发送" }}
              </VfButton>
            </div>
          </div>
        </section>

        <!-- 右栏 4 Tab -->
        <aside
          v-show="!isNarrow || narrowTab !== 'chat'"
          class="wb-side"
          aria-label="项目分区"
        >
          <WorkbenchTabs
            v-model:active-tab="activeTab"
            :project="workbench.project"
            :run="workbench.currentRun"
            :stages="workbench.stages"
            :artifacts="workbench.artifacts"
            :assets="assets.items"
            :review-stage="reviewStage"
            :final-ready="workbench.finalReady"
            :storyboard-refresh-token="workbench.state.storyboardRefreshToken"
            :quality-refresh-token="workbench.state.qualityRefreshToken"
            @reference-asset="addAssetReference"
            @select-stage="scrollToStage"
            @open-storyboard="openStoryboard"
            @regenerate="prefillRegeneration"
          />
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
  gap: var(--space-3);
}

.wb-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border-soft);
}

.wb-back {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--text-sec);
  font-family: inherit;
  font-size: var(--font-size-small);
  cursor: pointer;
}

.wb-back:hover {
  border-color: var(--accent);
  color: var(--text);
}

.wb-back:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.wb-title {
  max-width: 320px;
  margin: 0;
  overflow: hidden;
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-strong);
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wb-actions {
  display: flex;
  margin-inline-start: auto;
  gap: var(--space-2);
}

.wb-state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-6);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
}

.wb-state__title {
  margin: 0;
  font-size: var(--font-size-card-title);
  color: var(--text);
}

.wb-state__desc {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--text-ter);
}

.wb-narrow-nav {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.wb-narrow-tab {
  min-height: 32px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--surface);
  color: var(--text-sec);
  font-family: inherit;
  font-size: var(--font-size-small);
  cursor: pointer;
}

.wb-narrow-tab.is-active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: var(--font-weight-strong);
}

.wb-narrow-tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.wb-body {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
  gap: var(--space-3);
  height: calc(100vh - var(--shell-header-height) - var(--shell-content-padding) * 2 - 60px);
  min-height: 520px;
}

.wb-body.is-narrow {
  grid-template-columns: minmax(0, 1fr);
  height: auto;
  min-height: 0;
}

.wb-chat {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
}

.wb-conn {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  background: var(--danger-soft);
  border-radius: var(--radius-control);
  color: var(--danger);
  font-size: var(--font-size-small);
}

.wb-load-earlier {
  display: flex;
  justify-content: center;
}

.wb-messages {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  gap: var(--space-2);
  overflow-y: auto;
  padding: var(--space-1);
}

.wb-message {
  display: flex;
  flex-direction: column;
}

.wb-input {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-soft);
}

.wb-textarea {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  color: var(--text);
  font-family: inherit;
  font-size: var(--font-size-body);
  line-height: var(--line-height-body);
  resize: vertical;
}

.wb-textarea:focus {
  outline: none;
  border-color: var(--accent);
}

.wb-input-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}

.wb-asset-select {
  max-width: 190px;
  height: 36px;
  padding: 0 var(--space-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  color: var(--text-sec);
  font-family: inherit;
  font-size: var(--font-size-small);
}

.wb-asset-select:focus {
  outline: none;
  border-color: var(--accent);
}

.wb-upload-input {
  display: none;
}

.wb-asset-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.wb-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px var(--space-2);
  background: var(--accent-soft);
  border-radius: var(--radius-pill);
  color: var(--accent);
  font-size: var(--font-size-caption);
}

.wb-chip__remove {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: var(--font-size-small);
  line-height: 1;
  cursor: pointer;
}

.wb-chip__remove:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.wb-side {
  display: flex;
  min-height: 0;
  flex-direction: column;
}

.wb-muted {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--text-ter);
}

@media (max-width: 899.98px) {
  .wb-body {
    grid-template-columns: minmax(0, 1fr);
    height: auto;
    min-height: 0;
  }

  .wb-chat {
    min-height: 320px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .workbench :deep(*) {
    transition: none !important;
    animation: none !important;
  }
}
</style>
