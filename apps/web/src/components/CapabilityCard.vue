<script setup lang="ts">
/**
 * 能力卡（方案 §8.5 第 2 页 / SKILL #2）：能力名称与描述、阶段 chips（审核点标记）、
 * 参考片基线 meta（平均 3.7 秒一次画面变化）、已创建项目数、创建按钮与工作流说明入口。
 * 纯展示：数据全部来自服务端能力注册表与项目列表，不做能力启停/编排。
 */
import type { Capability } from "../stores/capabilities";
import { STAGE_LABELS } from "./state-mapping";
import VfButton from "./ui/VfButton.vue";
import VfCard from "./ui/VfCard.vue";
import VfPill from "./ui/VfPill.vue";

defineProps<{
  /** 能力只读视图（服务端注册表）。 */
  capability: Capability;
  /** 该能力下已创建的项目数（服务端项目列表计数）。 */
  projectCount: number;
  /** 工作流说明是否展开（由父级控制）。 */
  workflowOpen: boolean;
}>();

const emit = defineEmits<{
  /** 点击「创建项目」。 */
  (event: "create"): void;
  /** 点击「工作流说明」切换展开态。 */
  (event: "toggle-workflow"): void;
}>();

/** 阶段展示名：优先服务端 label，其次本地映射表。 */
function stageLabel(stage: string, label: string): string {
  return label || STAGE_LABELS[stage] || stage;
}
</script>

<template>
  <VfCard class="capability-card">
    <header class="capability-head">
      <div class="capability-title-wrap">
        <h2 class="capability-title">{{ capability.name }}</h2>
        <VfPill tone="success" dot>可用</VfPill>
      </div>
      <p class="capability-desc">{{ capability.description }}</p>
    </header>

    <div class="capability-stages" aria-label="阶段">
      <span
        v-for="stage in capability.stages"
        :key="stage.stage"
        class="capability-stage"
        :class="{ 'is-gate': stage.reviewGate }"
      >
        {{ stageLabel(stage.stage, stage.label) }}
        <span v-if="stage.reviewGate" class="capability-stage__gate">审核</span>
      </span>
    </div>

    <dl class="capability-meta">
      <div class="capability-meta__item">
        <dt>画面变化</dt>
        <dd>平均 3.7 秒一次（参考片基线）</dd>
      </div>
      <div class="capability-meta__item">
        <dt>已创建项目</dt>
        <dd>{{ projectCount }}</dd>
      </div>
      <div class="capability-meta__item">
        <dt>最终产物</dt>
        <dd>{{ capability.finalArtifact }}</dd>
      </div>
    </dl>

    <div class="capability-actions">
      <VfButton variant="accent" @click="emit('create')">创建项目</VfButton>
      <VfButton variant="ghost" @click="emit('toggle-workflow')">
        {{ workflowOpen ? "收起工作流说明" : "工作流说明" }}
      </VfButton>
    </div>

    <section v-if="workflowOpen" class="capability-workflow" aria-label="工作流说明">
      <p class="capability-workflow__hint">
        能力按固定阶段顺序执行；标「审核」的阶段完成后会暂停等待人工确认。
      </p>
      <ol class="capability-workflow__list">
        <li
          v-for="(stage, index) in capability.stages"
          :key="stage.stage"
          class="capability-workflow__item"
        >
          <span class="capability-workflow__index">{{ index + 1 }}</span>
          <span class="capability-workflow__label">{{ stageLabel(stage.stage, stage.label) }}</span>
          <span class="capability-workflow__tool">{{ stage.tool }}</span>
          <VfPill v-if="stage.reviewGate" tone="warning">审核点</VfPill>
        </li>
      </ol>
    </section>
  </VfCard>
</template>

<style scoped>
.capability-head {
  margin-bottom: var(--space-4);
}

.capability-title-wrap {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.capability-title {
  margin: 0;
  font-size: var(--font-size-page-title);
  font-weight: var(--font-weight-strong);
  color: var(--text);
}

.capability-desc {
  margin: var(--space-2) 0 0;
  font-size: var(--font-size-body);
  line-height: var(--line-height-body);
  color: var(--text-sec);
}

/* 阶段 chips：可用阶段描边；审核点 chips 用 warning 软底 */
.capability-stages {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.capability-stage {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  font-size: var(--font-size-small);
  color: var(--text-sec);
}

.capability-stage.is-gate {
  border-color: var(--warning);
  color: var(--warning);
}

.capability-stage__gate {
  font-size: var(--font-size-caption);
  color: var(--warning);
}

.capability-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-6);
  margin: 0 0 var(--space-5);
  padding: var(--space-3) 0;
  border-block: 1px solid var(--border-soft);
}

.capability-meta__item dt {
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

.capability-meta__item dd {
  margin: 2px 0 0;
  font-size: var(--font-size-small);
  color: var(--text);
}

.capability-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.capability-workflow {
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-block-start: 1px solid var(--border-soft);
}

.capability-workflow__hint {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-small);
  color: var(--text-ter);
}

.capability-workflow__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.capability-workflow__item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--font-size-small);
  color: var(--text-sec);
}

.capability-workflow__index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  color: var(--text-sec);
  font-size: var(--font-size-caption);
}

.capability-workflow__label {
  min-width: 56px;
  color: var(--text);
}

.capability-workflow__tool {
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}
</style>
