<script setup lang="ts">
/**
 * 能力卡片（Web 专题 §5.3）：展示能力说明、阶段 DAG 迷你步骤条（审核点金色标记）、
 * 产物契约摘要与「使用此能力」入口。卡片只读，不提供能力启停/编排。
 */
import { computed } from "vue";
import { StarFilled } from "@ant-design/icons-vue";
import type { Capability } from "../stores/capabilities";
import { STAGE_LABELS } from "./state-mapping";

const props = defineProps<{
  /** 能力只读视图。 */
  capability: Capability;
}>();

const emit = defineEmits<{
  /** 点击「使用此能力」。 */
  (event: "use", capability: Capability): void;
}>();

/** 取阶段中文名，缺失时回退阶段标识。 */
function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

/** 产物契约摘要文案（由能力声明的 profile 枚举与最终产物推导，如「横屏/竖屏 1080p mp4 成片」）。 */
const artifactSummary = computed(() => {
  const orientationLabels: Record<string, string> = {
    "landscape-1080p": "横屏",
    "portrait-1080p": "竖屏",
  };
  const profileParam = props.capability.params.find((param) => param.name === "profile");
  const orientations = (profileParam?.enumValues ?? []).map(
    (value) => orientationLabels[value] ?? value,
  );
  const resolution = (profileParam?.enumValues ?? [])
    .map((value) => value.match(/\d+p/)?.[0])
    .find((token): token is string => Boolean(token));
  const finalLabel = props.capability.finalArtifact.endsWith(".mp4")
    ? "mp4 成片"
    : props.capability.finalArtifact;
  return [orientations.join("/"), resolution, finalLabel].filter(Boolean).join(" ");
});
</script>

<template>
  <a-card class="capability-card" :title="capability.name" :bordered="true">
    <p class="capability-desc">{{ capability.description }}</p>

    <a-steps class="capability-steps" size="small" :current="-1">
      <a-step v-for="stage in capability.stages" :key="stage.stage">
        <template #title>
          <span class="stage-title">{{ stageLabel(stage.stage) }}</span>
          <a-tooltip v-if="stage.reviewGate" title="该阶段后需人工确认">
            <star-filled class="review-gate-mark" aria-label="审核点" />
          </a-tooltip>
        </template>
      </a-step>
    </a-steps>

    <p class="capability-artifact">产出：{{ artifactSummary }}</p>

    <template #actions>
      <a-button type="primary" @click="emit('use', capability)">使用此能力</a-button>
    </template>
  </a-card>
</template>

<style scoped>
.capability-card {
  height: 100%;
}

.capability-desc {
  margin: 0 0 16px;
  color: rgb(0 0 0 / 65%);
}

.capability-steps {
  margin-bottom: 16px;
  overflow-x: auto;
}

.stage-title {
  font-size: 12px;
}

.review-gate-mark {
  margin-inline-start: 2px;
  color: #faad14;
}

.capability-artifact {
  margin: 0;
  color: rgb(0 0 0 / 65%);
}
</style>
