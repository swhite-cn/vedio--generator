<script setup lang="ts">
/**
 * 阶段进度（Web 专题 §5.4.3）：竖排七步，状态经 §2.3 唯一权威表映射。
 * 当前步显示 attempt（"第 N 次尝试"）与已耗时；`skipped` 阶段虚线样式 + Tooltip；
 * 点击阶段仅滚动定位到对话流中该阶段的工具卡片锚链，**不提供"跳到该阶段"操作**。
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import { SKIPPED_TOOLTIP, STAGE_LABELS, mapStageStatus } from "./state-mapping";
import { formatElapsed, formatRunningElapsed } from "./format";
import type { StageProgress } from "../stores/workbench-reducer";

const props = withDefaults(
  defineProps<{
    /** 恒为七条的阶段进度（来自 store / 纯 reducer）。 */
    stages: StageProgress[];
    /** 处于待审核的阶段（在步骤条上追加金色「待审核」标记）。 */
    reviewStage?: string | null;
  }>(),
  { reviewStage: null },
);

const emit = defineEmits<{
  /** 点击某阶段：交由父组件滚动定位到该阶段的工具卡片。 */
  (event: "select", stage: string): void;
}>();

/** 秒级时钟：驱动"运行中"阶段的已耗时展示。 */
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});

onUnmounted(() => {
  if (timer) {
    clearInterval(timer);
  }
});

/** 当前激活步索引（用于 Steps 的高亮游标）。 */
const activeIndex = computed(() => {
  const runningIndex = props.stages.findIndex((item) => item.status === "running");
  return runningIndex >= 0 ? runningIndex : props.stages.length;
});

/** 渲染用的阶段行。 */
const rows = computed(() =>
  props.stages.map((item) => {
    const meta = mapStageStatus(item.status);
    const running = item.status === "running";
    return {
      stage: item.stage,
      label: STAGE_LABELS[item.stage] ?? item.stage,
      text: meta.text,
      stepStatus: meta.stepStatus,
      attempt: item.attempt,
      running,
      skipped: item.status === "skipped",
      review: props.reviewStage === item.stage,
      /** 失败阶段的稳定错误码（Web 专题 §5.5：阶段卡片需包含 errorCode）。 */
      errorCode: item.error_code,
      elapsed: running
        ? formatRunningElapsed(item.started_at, now.value)
        : formatElapsed(item.started_at, item.ended_at),
    };
  }),
);

/**
 * 点击阶段：仅通知父组件滚动定位到该阶段的工具卡片锚链。
 * @param stage 阶段标识
 */
function onSelect(stage: string): void {
  emit("select", stage);
}
</script>

<template>
  <div class="stage-steps" aria-live="polite" aria-label="阶段进度">
    <a-steps direction="vertical" size="small" :current="activeIndex">
      <a-step
        v-for="row in rows"
        :key="row.stage"
        :status="row.stepStatus"
        :class="{ 'is-skipped': row.skipped }"
      >
        <template #title>
          <a-tooltip v-if="row.skipped" :title="SKIPPED_TOOLTIP">
            <span class="stage-title is-skipped">{{ row.label }}</span>
          </a-tooltip>
          <span
            v-else
            class="stage-title"
            role="button"
            tabindex="0"
            :aria-label="`定位 ${row.label} 阶段的工具调用`"
            @click="onSelect(row.stage)"
            @keydown.enter="onSelect(row.stage)"
          >
            {{ row.label }}
          </span>
        </template>
        <template #description>
          <div class="stage-desc">
            <span class="stage-status">{{ row.text }}</span>
            <span v-if="row.running && row.attempt > 0" class="stage-attempt">
              · 第 {{ row.attempt }} 次尝试
            </span>
            <span v-if="row.elapsed !== '-'" class="stage-elapsed">· 耗时 {{ row.elapsed }}</span>
            <a-tooltip v-if="row.errorCode" :title="`错误码：${row.errorCode}`">
              <a-tag color="error" class="stage-error">{{ row.errorCode }}</a-tag>
            </a-tooltip>
            <a-tag v-if="row.review" color="warning" class="stage-review">待审核</a-tag>
          </div>
        </template>
      </a-step>
    </a-steps>
  </div>
</template>

<style scoped>
.stage-title {
  cursor: pointer;
}

.stage-title.is-skipped {
  color: rgb(0 0 0 / 45%);
  text-decoration: line-through;
  cursor: default;
}

/* skipped 阶段：步骤条虚线样式（Web 专题 §2.3）。 */
.stage-steps :deep(.is-skipped .ant-steps-item-tail)::after {
  border-inline-start: 1px dashed #d9d9d9;
}

.stage-desc {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: rgb(0 0 0 / 45%);
  font-size: 12px;
}

.stage-review {
  margin-inline-start: 4px;
}

@media (prefers-reduced-motion: reduce) {
  .stage-steps :deep(*) {
    transition: none !important;
    animation: none !important;
  }
}
</style>
