<script setup lang="ts">
/**
 * 对话流消息渲染（Web 专题 §5.4.2）：
 * - `user`：右侧蓝底白字气泡；
 * - `assistant`：左侧气泡 + 受限 Markdown（段落 / 列表 / 代码块 / 加粗），流式追加中带光标；
 * - `system`（引擎阶段指令）：居中浅灰条，可折叠；
 * - `tool` / `review`：委托 `ToolCallCard` / `ReviewCard`（非气泡）。
 */
import { computed, ref } from "vue";
import { RobotOutlined, UserOutlined } from "@ant-design/icons-vue";
import MessageBubbleTool from "./ToolCallCard.vue";
import ReviewCard from "./ReviewCard.vue";
import ThinkingBlock from "./ThinkingBlock.vue";
import { renderMarkdownLite } from "./markdown-lite";
import { formatDateTime } from "./format";
import { STAGE_LABELS } from "./state-mapping";
import type { ResumePayload } from "./review-logic";
import type { WorkbenchMessage } from "../stores/workbench-reducer";
import type { Project } from "../stores/projects";

const props = withDefaults(
  defineProps<{
    /** 待渲染消息。 */
    message: WorkbenchMessage;
    /** 所属项目（工具卡片产物链接用）。 */
    project?: Project | null;
    /** 所属 run（失败卡片 trace 锚链用）。 */
    runId?: string | null;
    /** 审核卡片是否正在提交。 */
    reviewSubmitting?: boolean;
  }>(),
  { project: null, runId: null, reviewSubmitting: false },
);

const emit = defineEmits<{
  /** 审核卡片提交结论（向上转发给页面 → store）。 */
  (event: "review-submit", payload: ResumePayload): void;
}>();

/** system 条是否展开（默认折叠）。 */
const systemExpanded = ref(false);

/** assistant 气泡的受限 Markdown HTML（已转义，安全）。 */
const assistantHtml = computed(() => renderMarkdownLite(props.message.text ?? ""));

/** 消息时间展示。 */
const timeText = computed(() => formatDateTime(props.message.at));

/**
 * 转发审核卡片提交事件。
 * @param payload resume 请求体
 */
function onReviewSubmit(payload: ResumePayload): void {
  emit("review-submit", payload);
}
</script>

<template>
  <!-- 工具卡片 -->
  <message-bubble-tool
    v-if="message.kind === 'tool' && message.tool"
    :tool="message.tool"
    :project="project"
    :run-id="runId"
  />

  <!-- 审核卡片 -->
  <review-card
    v-else-if="message.kind === 'review' && message.review"
    :review="message.review"
    :submitting="reviewSubmitting"
    @submit="onReviewSubmit"
  />

  <!-- 思考过程 -->
  <thinking-block
    v-else-if="message.kind === 'thinking'"
    :text="message.text"
    :streaming="message.streaming"
  />

  <!-- 错误条 -->
  <div v-else-if="message.kind === 'error'" class="msg-error" role="alert">
    {{ message.text }}
  </div>

  <!-- 阶段分隔条：居中胶囊，与 Claude Code 的阶段标题一致 -->
  <div v-else-if="message.kind === 'stageDivider'" class="msg-divider">
    <span>引擎指令：执行 {{ STAGE_LABELS[message.text ?? ""] ?? message.text }} 阶段</span>
  </div>

  <!-- 系统条（引擎阶段指令）：居中浅灰可折叠 -->
  <div v-else-if="message.kind === 'system'" class="msg-system">
    <button
      type="button"
      class="system-toggle"
      :aria-expanded="systemExpanded"
      @click="systemExpanded = !systemExpanded"
    >
      引擎指令 {{ systemExpanded ? "▾" : "▸" }}
    </button>
    <span v-if="!systemExpanded" class="system-preview">{{ message.text }}</span>
    <div v-else class="system-body">{{ message.text }}</div>
  </div>

  <!-- 用户 / assistant 气泡（含头像，对齐设计稿） -->
  <div v-else class="msg-row" :class="message.kind === 'user' ? 'is-user' : 'is-assistant'">
    <span class="msg-avatar" aria-hidden="true">
      <user-outlined v-if="message.kind === 'user'" />
      <robot-outlined v-else />
    </span>
    <div class="msg-column">
      <div class="msg-bubble" aria-live="polite">
        <!-- assistant 为受限 Markdown；user 直接文本 -->
        <div v-if="message.kind === 'assistant'" class="msg-markdown" v-html="assistantHtml" />
        <span v-else class="msg-text">{{ message.text }}</span>
        <span v-if="message.streaming" class="msg-cursor" aria-hidden="true">▍</span>
      </div>
      <div v-if="message.kind === 'user' && message.assetRefs?.length" class="asset-refs">
        <span v-for="asset in message.assetRefs" :key="asset.id" class="asset-ref">
          {{ asset.kind }} · {{ asset.label }}
        </span>
      </div>
      <span v-if="timeText !== '-'" class="msg-time">{{ timeText }}</span>
    </div>
  </div>
</template>

<style scoped>
.msg-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.msg-row.is-user {
  flex-direction: row-reverse;
}

.msg-column {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.is-user .msg-column {
  align-items: flex-end;
}

.msg-avatar {
  display: inline-flex;
  width: 30px;
  height: 30px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--vf-primary);
  color: #fff;
  font-size: 15px;
}

.msg-bubble {
  max-width: 86%;
  padding: 9px 13px;
  border-radius: 10px;
  word-break: break-word;
}

.is-user .msg-bubble {
  border-top-right-radius: 2px;
  background: var(--vf-primary);
  color: #fff;
  white-space: pre-wrap;
}

.is-assistant .msg-bubble {
  max-width: 100%;
  border: 1px solid var(--vf-border);
  border-top-left-radius: 2px;
  background: var(--vf-surface);
}

.msg-markdown :deep(p) {
  margin: 0 0 6px;
}

.msg-markdown :deep(p:last-child) {
  margin-bottom: 0;
}

.msg-markdown :deep(pre) {
  padding: 8px 10px;
  overflow-x: auto;
  border-radius: 6px;
  background: #f5f5f5;
  font-family: Consolas, "Courier New", monospace;
  font-size: 12px;
}

.msg-markdown :deep(code) {
  font-family: Consolas, "Courier New", monospace;
}

.msg-markdown :deep(ul),
.msg-markdown :deep(ol) {
  margin: 0 0 6px;
  padding-inline-start: 20px;
}

.msg-time {
  color: rgb(0 0 0 / 35%);
  font-size: 11px;
}

.msg-cursor {
  color: #1677ff;
}

.asset-refs {
  display: flex;
  max-width: 86%;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
}

.asset-ref {
  padding: 2px 7px;
  border: 1px solid #bae0ff;
  border-radius: 999px;
  background: #e6f4ff;
  color: #0958d9;
  font-size: 11px;
}

.msg-system {
  display: flex;
  flex-direction: column;
  align-items: center;
  color: rgb(0 0 0 / 45%);
  font-size: 12px;
}

.msg-error {
  padding: 6px 10px;
  border: 1px solid #ffccc7;
  border-radius: 6px;
  background: #fff2f0;
  color: #cf1322;
  font-size: 12px;
}

.msg-divider {
  display: flex;
  justify-content: center;
  font-size: 12px;
}

.msg-divider span {
  padding: 3px 12px;
  border-radius: 999px;
  background: #f2f4f7;
  color: var(--vf-text-tertiary);
}

.system-toggle {
  padding: 2px 8px;
  border: 1px solid #f0f0f0;
  border-radius: 10px;
  background: #fafafa;
  color: rgb(0 0 0 / 45%);
  font-size: 12px;
  cursor: pointer;
}

.system-preview,
.system-body {
  margin-top: 4px;
  padding: 4px 10px;
  max-width: 90%;
  border-radius: 8px;
  background: #f5f5f5;
  text-align: center;
}

.system-body {
  white-space: pre-wrap;
}
</style>
