<script setup lang="ts">
/**
 * 按钮基元（方案 §8.6）：accent（主操作）/ ghost（次操作）/ danger / success 四变体。
 * 视觉完全由 tokens.css 承担，行为层保留原生 button 语义（键盘 Enter/Space 原生可用）。
 */
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    /** 视觉变体：accent 主操作、ghost 次操作、danger 危险、success 确认。 */
    variant?: "accent" | "ghost" | "danger" | "success";
    /** 原生按钮类型：默认 button（避免误触发表单提交）；表单提交按钮传 submit。 */
    type?: "button" | "submit" | "reset";
  }>(),
  { variant: "accent", type: "button" },
);

/** 视觉类名（variant 决定）。 */
const variantClass = computed(() => `vf-button--${props.variant}`);
</script>

<template>
  <button :type="type" class="vf-button" :class="variantClass">
    <slot />
  </button>
</template>

<style scoped>
.vf-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 36px; /* 与 theme.ts controlHeight 对齐 */
  padding: 0 var(--space-4);
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  font-family: inherit;
  font-size: var(--font-size-body);
  font-weight: var(--font-weight-strong);
  line-height: 1;
  cursor: pointer;
  transition: filter var(--motion-fast) ease;
}

.vf-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.vf-button:not(:disabled):hover {
  filter: brightness(1.1);
}

.vf-button:not(:disabled):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* accent：主色实心，深色文字对比不足时用浅文字 */
.vf-button--accent {
  background: var(--accent);
  color: #ffffff;
}

/* ghost：透明底描边，次操作与大量列表场景 */
.vf-button--ghost {
  background: transparent;
  border-color: var(--border);
  color: var(--text);
}

.vf-button--ghost:not(:disabled):hover {
  background: var(--surface-2);
  filter: none;
}

/* danger：危险操作实心 */
.vf-button--danger {
  background: var(--danger);
  color: #ffffff;
}

/* success：确认操作实心 */
.vf-button--success {
  background: var(--success);
  color: #06251a;
}
</style>
