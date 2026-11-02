<script setup lang="ts">
/**
 * 工具调用组（参考 Claude Code）：同一轮内连续的内置工具合并为一行摘要，展开后逐行查看参数与输出。
 * - 组头：`运行了 N 个工具 · 读取文件 ×3 · 执行命令 ×1 · 12.3s`；
 * - 行：工具名 + 关键参数（路径 / 命令）+ 状态 + 耗时，点击展开参数与输出预览；
 * - 失败行显示 errorCode 与「查看 trace」锚链。
 */
import { computed, ref } from "vue";
import { CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined } from "@ant-design/icons-vue";
import { formatDurationMs } from "./format";
import { buildMediaUrl } from "./media-url";
import { toolDisplayName } from "./state-mapping";
import { summarizeToolGroup } from "./chat-grouping";
import type { Project } from "../stores/projects";
import type { WorkbenchMessage } from "../stores/workbench-reducer";

const props = withDefaults(
  defineProps<{
    /** 组内工具卡片消息。 */
    items: WorkbenchMessage[];
    /** 所属项目（产物链接）。 */
    project?: Project | null;
    /** 所属 run（失败时跳 trace）。 */
    runId?: string | null;
  }>(),
  { project: null, runId: null },
);

/** 组是否展开。 */
const expanded = ref(false);
/** 已展开详情的工具调用 id 集合。 */
const openRows = ref<Set<string>>(new Set());

/** 组内是否有运行中的工具。 */
const running = computed(() => props.items.some((item) => item.tool?.status === "running"));

/** 组总耗时（已完成项之和；有运行中项时不显示）。 */
const totalDuration = computed(() => {
  if (running.value) return "";
  const total = props.items.reduce((sum, item) => sum + (item.tool?.durationMs ?? 0), 0);
  return total > 0 ? formatDurationMs(total) : "";
});

/** 组摘要。 */
const summary = computed(() => summarizeToolGroup(props.items));

/** 切换组展开。 */
function toggle(): void {
  expanded.value = !expanded.value;
}

/**
 * 切换单行详情。
 * @param toolCallId 工具调用 id
 */
function toggleRow(toolCallId: string): void {
  const next = new Set(openRows.value);
  if (next.has(toolCallId)) next.delete(toolCallId);
  else next.add(toolCallId);
  openRows.value = next;
}

/**
 * 取工具的关键参数（路径 / 命令 / 模式），用于单行展示。
 * @param args 工具参数
 * @returns 单行摘要文本
 */
function keyArgument(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const candidate =
    record.path ?? record.command ?? record.pattern ?? record.query ?? record.file_path;
  if (typeof candidate === "string") {
    return candidate.length > 80 ? `${candidate.slice(0, 80)}…` : candidate;
  }
  return "";
}

/** 序列化参数 / 输出（循环引用兜底）。 */
function pretty(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 在产物面板 / 浏览器中打开产物。 */
function artifactUrl(path: string): string {
  return buildMediaUrl(props.project, path);
}
</script>

<template>
  <div class="tool-group">
    <button type="button" class="tool-group-head" :aria-expanded="expanded" @click="toggle">
      <loading-outlined v-if="running" spin class="group-icon" aria-hidden="true" />
      <span v-else class="group-dot" aria-hidden="true">●</span>
      <span class="group-title">
        运行了 {{ items.length }} 个工具
        <span v-if="summary" class="group-summary">· {{ summary }}</span>
      </span>
      <span v-if="totalDuration" class="group-duration">{{ totalDuration }}</span>
      <span class="group-chevron" aria-hidden="true">{{ expanded ? "▾" : "▸" }}</span>
    </button>

    <ul v-if="expanded" class="tool-group-list">
      <li
        v-for="item in items"
        :key="item.id"
        class="tool-row"
        :class="`is-${item.tool?.status ?? 'done'}`"
      >
        <button
          type="button"
          class="tool-row-head"
          :aria-expanded="openRows.has(item.tool?.toolCallId ?? '')"
          @click="toggleRow(item.tool?.toolCallId ?? '')"
        >
          <check-circle-outlined
            v-if="item.tool?.status === 'done'"
            class="ok"
            aria-hidden="true"
          />
          <close-circle-outlined
            v-else-if="item.tool?.status === 'failed'"
            class="fail"
            aria-hidden="true"
          />
          <loading-outlined v-else spin aria-hidden="true" />
          <span class="tool-name">{{ toolDisplayName(item.tool?.tool ?? "") }}</span>
          <span class="tool-arg">{{ keyArgument(item.tool?.args) }}</span>
          <span v-if="item.tool?.durationMs !== undefined" class="tool-duration">
            {{ formatDurationMs(item.tool.durationMs) }}
          </span>
        </button>

        <div v-if="openRows.has(item.tool?.toolCallId ?? '')" class="tool-row-body">
          <div class="tool-section">
            <span class="tool-section-title">参数</span>
            <pre class="tool-code">{{ pretty(item.tool?.args) }}</pre>
          </div>
          <div v-if="item.tool?.outputPreview" class="tool-section">
            <span class="tool-section-title">
              输出
              <span v-if="item.tool.outputTruncated" class="tool-truncated">（已截断）</span>
            </span>
            <pre class="tool-code">{{ item.tool.outputPreview }}</pre>
          </div>
          <div
            v-if="item.tool?.exitCode !== undefined && item.tool?.exitCode !== null"
            class="tool-meta"
          >
            退出码：{{ item.tool.exitCode }}
          </div>
          <div v-if="item.tool?.artifactPaths?.length" class="tool-meta">
            产物：
            <template v-for="path in item.tool.artifactPaths" :key="path">
              <a :href="artifactUrl(path)" target="_blank" rel="noopener">{{ path }}</a>
            </template>
          </div>
          <div v-if="item.tool?.status === 'failed'" class="tool-error">
            失败原因：{{ item.tool.errorCode ?? "未知错误" }}
            <router-link
              v-if="runId"
              :to="{ path: `/runs/${runId}/trace`, query: { stage: item.tool.stage ?? '' } }"
            >
              查看 trace
            </router-link>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.tool-group {
  max-width: 92%;
  border: 1px solid #eef0f3;
  border-radius: 8px;
  background: #fbfcfd;
}

.tool-group-head {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 0;
  background: transparent;
  color: rgb(0 0 0 / 65%);
  font-size: 13px;
  text-align: start;
  cursor: pointer;
}

.group-icon {
  color: #1677ff;
}

.group-dot {
  color: #8a919f;
}

.group-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-summary {
  color: rgb(0 0 0 / 45%);
}

.group-duration {
  color: rgb(0 0 0 / 45%);
  font-size: 12px;
}

.group-chevron {
  color: rgb(0 0 0 / 35%);
  font-size: 10px;
}

.tool-group-list {
  margin: 0;
  padding: 0 10px 8px;
  list-style: none;
}

.tool-row {
  border-top: 1px dashed #eef0f3;
}

.tool-row-head {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border: 0;
  background: transparent;
  color: rgb(0 0 0 / 75%);
  font-family: Consolas, "Courier New", monospace;
  font-size: 12px;
  text-align: start;
  cursor: pointer;
}

.tool-name {
  flex: none;
}

.tool-arg {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: rgb(0 0 0 / 45%);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-duration {
  flex: none;
  color: rgb(0 0 0 / 35%);
}

.ok {
  color: #52c41a;
}

.fail {
  color: #ff4d4f;
}

.tool-row-body {
  padding: 4px 0 10px 20px;
}

.tool-section {
  margin-bottom: 8px;
}

.tool-section-title {
  color: rgb(0 0 0 / 45%);
  font-size: 12px;
}

.tool-truncated {
  color: #d46b08;
}

.tool-code {
  max-height: 240px;
  margin: 4px 0 0;
  padding: 8px 10px;
  overflow: auto;
  border-radius: 6px;
  background: #f5f6f8;
  font-family: Consolas, "Courier New", monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.tool-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: rgb(0 0 0 / 45%);
  font-size: 12px;
}

.tool-error {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
  color: #cf1322;
  font-size: 12px;
}
</style>
