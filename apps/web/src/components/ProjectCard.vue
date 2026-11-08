<script setup lang="ts">
/**
 * 项目卡片（方案 §8.5 第 4 页 / §8.6 复合组件 ProjectCard）。
 *
 * 只渲染服务端字段：状态 pill、镜头数、总时长、进度、最新 run 错误码；
 * 卡片整体可点击（Enter/Space 等价），失败项目提供「重试」入口且不触发卡片跳转。
 */
import { computed } from "vue";
import type { Project } from "../stores/projects";
import { formatDateTime, formatMediaDuration, mapProjectStatus, statusTone } from "./state-mapping";
import VfPill from "./ui/VfPill.vue";
import VfButton from "./ui/VfButton.vue";

const props = withDefaults(
  defineProps<{
    /** 项目（`GET /api/projects` 元素）。 */
    project: Project;
    /** 能力中文名；未命中时可传能力 id。 */
    capabilityName?: string;
    /** 是否正在发起重试（禁用按钮）。 */
    retrying?: boolean;
  }>(),
  { capabilityName: "", retrying: false },
);

const emit = defineEmits<{
  /** 打开项目工作台。 */
  (event: "open", projectId: string): void;
  /** 从断点重跑（失败项目）。 */
  (event: "retry", projectId: string): void;
}>();

/** 项目状态文案与色调（唯一权威映射表）。 */
const statusMeta = computed(() => mapProjectStatus(props.project.status));

/** 进度百分比（服务端 0..1，前端仅取整展示）。 */
const progressPercent = computed(() => {
  const value = props.project.progress;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value * 100)));
});

/** 卡片是否展示进度条：仅在推进中且有服务端进度时。 */
const showProgress = computed(
  () => (props.project.status === "running" || props.project.status === "review") && progressPercent.value !== null,
);

/** 打开项目。 */
function open(): void {
  emit("open", props.project.id);
}

/** 键盘等价操作（Enter/Space）。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    open();
  }
}

/**
 * 重试：阻止冒泡，避免同时触发卡片跳转。
 * @param event 原生点击事件
 */
function retry(event: Event): void {
  event.stopPropagation();
  emit("retry", props.project.id);
}
</script>

<template>
  <article
    class="project-card"
    role="button"
    tabindex="0"
    :aria-label="`打开项目 ${project.name}`"
    @click="open"
    @keydown="onKeydown"
  >
    <header class="project-card__head">
      <h3 class="project-card__name">{{ project.name }}</h3>
      <VfPill :tone="statusTone(statusMeta.color)">{{ statusMeta.text }}</VfPill>
    </header>

    <p class="project-card__topic" :title="project.topic">{{ project.topic }}</p>

    <dl class="project-card__meta">
      <div class="meta-item">
        <dt>能力</dt>
        <dd>{{ capabilityName || project.capability_id }}</dd>
      </div>
      <div class="meta-item">
        <dt>创建</dt>
        <dd class="is-mono">{{ formatDateTime(project.created_at) }}</dd>
      </div>
    </dl>

    <p class="project-card__metrics is-mono">
      <span>镜头 {{ project.shotCount ?? "—" }}</span>
      <span aria-hidden="true">·</span>
      <span>时长 {{ formatMediaDuration(project.totalMs) }}</span>
    </p>

    <div
      v-if="showProgress"
      class="project-card__progress"
      role="progressbar"
      aria-label="流水线进度"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="progressPercent ?? 0"
    >
      <div class="project-card__progress-fill" :style="{ width: `${progressPercent ?? 0}%` }" />
    </div>

    <footer class="project-card__foot">
      <span v-if="project.status === 'done'" class="project-card__ready">成片就绪</span>
      <span v-else-if="project.status === 'failed'" class="project-card__failed">
        <span class="project-card__error is-mono">{{ project.latestRun?.error_code ?? "运行失败" }}</span>
        <VfButton variant="ghost" :disabled="retrying" @click="retry">
          {{ retrying ? "重试中…" : "重试" }}
        </VfButton>
      </span>
      <span v-else-if="showProgress" class="project-card__percent is-mono">
        {{ progressPercent }}%
      </span>
      <span v-else class="project-card__hint">等待运行</span>
    </footer>
  </article>
</template>

<style scoped>
.project-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  height: 100%;
  padding: var(--space-4) var(--space-5);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  cursor: pointer;
  transition: border-color var(--motion-fast) ease;
}

.project-card:hover {
  border-color: var(--accent);
}

.project-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.project-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.project-card__name {
  margin: 0;
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-strong);
  color: var(--text);
  overflow-wrap: anywhere;
}

.project-card__topic {
  margin: 0;
  font-size: var(--font-size-small);
  line-height: var(--line-height-body);
  color: var(--text-sec);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.project-card__meta {
  display: flex;
  gap: var(--space-4);
  margin: 0;
  font-size: var(--font-size-caption);
}

.meta-item {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.meta-item dt {
  color: var(--text-ter);
}

.meta-item dd {
  margin: 0;
  color: var(--text-sec);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-card__metrics {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  font-size: var(--font-size-meta);
  color: var(--text-sec);
}

.project-card__progress {
  height: 4px;
  overflow: hidden;
  background: var(--surface-2);
  border-radius: var(--radius-pill);
}

.project-card__progress-fill {
  height: 100%;
  background: var(--accent);
}

.project-card__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: auto;
  padding-top: var(--space-2);
  min-height: 36px;
}

.project-card__ready {
  font-size: var(--font-size-small);
  font-weight: var(--font-weight-strong);
  color: var(--success);
}

.project-card__failed {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.project-card__error {
  font-size: var(--font-size-caption);
  color: var(--danger);
}

.project-card__percent {
  margin-left: auto;
  font-size: var(--font-size-meta);
  color: var(--accent);
}

.project-card__hint {
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

.is-mono {
  font-family: var(--font-mono);
}
</style>
