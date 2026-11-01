<script setup lang="ts">
/**
 * 工具调用卡片（Web 专题 §5.4.2）：头部工具图标 + 中文名 + 状态 + 耗时；
 * 体部折叠展示参数摘要 / 产物链接 / 失败 errorCode；`bash` 命令等宽截断 + Tooltip；
 * 失败卡片提供"查看 trace"锚链（跳 trace 页对应阶段）。
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  ToolOutlined,
} from "@ant-design/icons-vue";
import { formatDurationMs, formatRunningElapsed } from "./format";
import { buildMediaUrl } from "./media-url";
import { toolDisplayName } from "./state-mapping";
import type { ToolCardData } from "../stores/workbench-reducer";
import type { Project } from "../stores/projects";

const props = withDefaults(
  defineProps<{
    /** 工具卡片数据（`tool_start` 建卡，`tool_end` 收尾）。 */
    tool: ToolCardData;
    /** 所属项目（用于把产物相对路径拼成 `/api/media/*` 地址）。 */
    project?: Project | null;
    /** 所属 run（用于失败时的 trace 锚链）。 */
    runId?: string | null;
  }>(),
  { project: null, runId: null },
);

/** 头部工具中文名。 */
const title = computed(() => toolDisplayName(props.tool.tool));

/** 状态对应的中文文案与 Tag 颜色。 */
const statusMeta = computed(() => {
  switch (props.tool.status) {
    case "done":
      return { text: "已完成", color: "success" as const };
    case "failed":
      return { text: "失败", color: "error" as const };
    default:
      return { text: "进行中", color: "processing" as const };
  }
});

/** 是否为内置 bash 工具（命令原文等宽展示）。 */
const isBash = computed(() => props.tool.tool === "bash");

/** 秒级时钟：驱动「运行中」卡片的已耗时展示（长阶段工具可能运行数十分钟）。 */
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});

/** 运行中卡片的实时耗时（无 startedAt 时回退 `-`，不展示）。 */
const runningElapsed = computed(() =>
  props.tool.status === "running" && props.tool.startedAt
    ? formatRunningElapsed(props.tool.startedAt, now.value)
    : "-",
);

/** bash 命令原文（取 `command` / `cmd`，缺失时回退参数 JSON）。 */
const bashCommand = computed(() => {
  const args = props.tool.args;
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    const command = record.command ?? record.cmd;
    if (typeof command === "string" && command.length > 0) {
      return command;
    }
  }
  return safeStringify(args);
});

/** 参数摘要文本。 */
const argsSummary = computed(() => safeStringify(props.tool.args));

/** 产物链接（把相对路径拼成媒体地址；无项目时回退纯文本）。 */
const artifacts = computed(() =>
  (props.tool.artifactPaths ?? []).map((path) => ({
    path,
    url: buildMediaUrl(props.project, path),
  })),
);

/** trace 锚链目标（带阶段查询参数，trace 页据此预选阶段）。 */
const traceTarget = computed(() => ({
  path: `/runs/${props.runId ?? ""}/trace`,
  query: props.tool.stage ? { stage: props.tool.stage } : {},
}));

/**
 * 安全序列化工具参数（循环引用 / 不可序列化时回退占位）。
 * @param value 待序列化值
 * @returns 缩进 JSON 文本
 */
function safeStringify(value: unknown): string {
  if (value === undefined || value === null) {
    return "（无参数）";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "（参数不可展示）";
  }
}

/**
 * 截断过长文本（用于 bash 命令单行展示，等宽 + Tooltip 全文）。
 * @param text 原始文本
 * @param max 最大字符数
 * @returns 截断后的文本
 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
</script>

<template>
  <div class="tool-card" :class="`is-${tool.status}`">
    <div class="tool-card-head">
      <span class="tool-icon" aria-hidden="true">
        <loading-outlined v-if="tool.status === 'running'" spin />
        <check-circle-outlined v-else-if="tool.status === 'done'" class="ok" />
        <close-circle-outlined v-else class="fail" />
      </span>
      <span class="tool-title">{{ title }}</span>
      <a-tag :color="statusMeta.color">{{ statusMeta.text }}</a-tag>
      <span v-if="tool.status === 'running' && runningElapsed !== '-'" class="tool-duration">
        已运行 {{ runningElapsed }}
      </span>
      <span v-else-if="tool.durationMs !== undefined" class="tool-duration">
        耗时 {{ formatDurationMs(tool.durationMs) }}
      </span>
    </div>

    <!-- bash 工具：命令原文等宽展示（长命令截断 + Tooltip 全文） -->
    <a-tooltip v-if="isBash" :title="bashCommand">
      <pre class="tool-bash">{{ truncate(bashCommand, 120) }}</pre>
    </a-tooltip>

    <a-collapse v-else ghost class="tool-body">
      <a-collapse-panel key="args" header="参数摘要">
        <pre class="tool-args">{{ argsSummary }}</pre>
      </a-collapse-panel>
    </a-collapse>

    <div v-if="artifacts.length > 0" class="tool-artifacts">
      <span class="tool-artifacts-label">产物：</span>
      <template v-for="item in artifacts" :key="item.path">
        <a
          v-if="item.url"
          :href="item.url"
          target="_blank"
          rel="noopener"
          class="tool-artifact-link"
        >
          {{ item.path }}
        </a>
        <span v-else class="tool-artifact-path">{{ item.path }}</span>
      </template>
    </div>

    <div v-if="tool.status === 'failed'" class="tool-fail">
      <span class="tool-error-code">
        <tool-outlined aria-hidden="true" />
        失败原因：{{ tool.errorCode ?? "未知错误" }}
      </span>
      <router-link v-if="runId" :to="traceTarget" class="tool-trace-link">查看 trace</router-link>
    </div>
  </div>
</template>

<style scoped>
.tool-card {
  padding: 10px 12px;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  background: #fafafa;
}

.tool-card.is-failed {
  border-color: #ffccc7;
  background: #fff2f0;
}

.tool-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tool-icon .ok {
  color: #52c41a;
}

.tool-icon .fail {
  color: #ff4d4f;
}

.tool-title {
  font-weight: 600;
}

.tool-duration {
  margin-inline-start: auto;
  color: rgb(0 0 0 / 45%);
  font-size: 12px;
}

.tool-bash,
.tool-args {
  margin: 8px 0 0;
  padding: 8px 10px;
  overflow-x: auto;
  border-radius: 6px;
  background: #f5f5f5;
  font-family: Consolas, "Courier New", monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}

.tool-body {
  margin-top: 4px;
}

.tool-artifacts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
  font-size: 12px;
}

.tool-artifacts-label {
  color: rgb(0 0 0 / 45%);
}

.tool-fail {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  color: #cf1322;
  font-size: 12px;
}

.tool-error-code {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
</style>
