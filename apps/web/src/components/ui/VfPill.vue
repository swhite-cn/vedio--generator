<script setup lang="ts">
/**
 * 状态 pill 基元（方案 §8.6/§8.8）：软底 + 语义前景色成对出现；
 * 可选前置圆点。可访问性：pill 始终有文本内容，颜色不是唯一信息载体。
 */
withDefaults(
  defineProps<{
    /** 语义色调：neutral/accent/success/danger/warning/info/teal。 */
    tone?: "neutral" | "accent" | "success" | "danger" | "warning" | "info" | "teal";
    /** 是否渲染前置圆点。 */
    dot?: boolean;
  }>(),
  { tone: "neutral", dot: false },
);
</script>

<template>
  <span class="vf-pill" :class="`vf-pill--${tone}`">
    <span v-if="dot" class="vf-pill__dot" aria-hidden="true" />
    <slot />
  </span>
</template>

<style scoped>
.vf-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  font-size: var(--font-size-small);
  font-weight: var(--font-weight-strong);
  line-height: 1.6;
  white-space: nowrap;
}

.vf-pill__dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-pill);
  background: currentcolor;
}

/* neutral：中性信息 */
.vf-pill--neutral {
  background: var(--surface-2);
  color: var(--text-sec);
}

/* 以下各 tone 均为「软底 + 语义前景」成对令牌 */
.vf-pill--accent {
  background: var(--accent-soft);
  color: var(--accent);
}

.vf-pill--success {
  background: var(--success-soft);
  color: var(--success);
}

.vf-pill--danger {
  background: var(--danger-soft);
  color: var(--danger);
}

.vf-pill--warning {
  background: var(--warning-soft);
  color: var(--warning);
}

.vf-pill--info {
  background: var(--info-soft);
  color: var(--info);
}

.vf-pill--teal {
  background: var(--teal-soft);
  color: var(--teal);
}
</style>
