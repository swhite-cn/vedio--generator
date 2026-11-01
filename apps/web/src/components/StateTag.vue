<script setup lang="ts">
/**
 * 状态标签组件：按 Web 专题 §2.3 唯一权威表渲染项目 5 态 / run 6 态 / 阶段 5 态。
 * 专用 Tooltip（INTERRUPTED / skipped）由 `state-mapping` 的 `statusTooltip` 决定。
 */
import { computed } from "vue";
import { LoadingOutlined } from "@ant-design/icons-vue";
import { mapProjectStatus, mapRunStatus, mapStageStatus, statusTooltip } from "./state-mapping";

const props = withDefaults(
  defineProps<{
    /** 状态类别：项目 / run / 阶段。 */
    type?: "project" | "run" | "stage";
    /** 服务端状态值。 */
    status: string;
    /** run 错误码（仅 run 用，判定 INTERRUPTED）。 */
    errorCode?: string | null;
  }>(),
  { type: "project", errorCode: null },
);

/** 当前状态对应的文案与颜色。 */
const meta = computed(() => {
  if (props.type === "run") {
    return mapRunStatus(props.status, props.errorCode);
  }
  if (props.type === "stage") {
    return mapStageStatus(props.status);
  }
  return mapProjectStatus(props.status);
});

/** `processing` 色（运行中）在标签内追加转动图标。 */
const spinning = computed(() => meta.value.color === "processing");

/** 需要展示的 Tooltip 文案。 */
const tooltip = computed(() => statusTooltip(props.type, props.status, props.errorCode));
</script>

<template>
  <a-tooltip v-if="tooltip" :title="tooltip">
    <a-tag :color="meta.color" :aria-label="`状态：${meta.text}`">
      <loading-outlined v-if="spinning" spin aria-hidden="true" />
      <span>{{ meta.text }}</span>
    </a-tag>
  </a-tooltip>
  <a-tag v-else :color="meta.color" :aria-label="`状态：${meta.text}`">
    <loading-outlined v-if="spinning" spin aria-hidden="true" />
    <span>{{ meta.text }}</span>
  </a-tag>
</template>

<style scoped>
.ant-tag {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  margin-inline-end: 0;
}
</style>
