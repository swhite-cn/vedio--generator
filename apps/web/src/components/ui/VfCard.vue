<script setup lang="ts">
/**
 * 卡片基元（方案 §8.6）：--surface 容器 + --border 描边 + 12px 圆角。
 * `title` 缺省时可用 #header 插槽自定义头部。
 */
defineProps<{
  /** 可选卡片标题（渲染在默认头部）。 */
  title?: string;
}>();
</script>

<template>
  <section class="vf-card">
    <header v-if="title || $slots.header" class="vf-card__header">
      <slot name="header">
        <h3 class="vf-card__title">{{ title }}</h3>
      </slot>
    </header>
    <div class="vf-card__body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.vf-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
}

.vf-card__header {
  padding: var(--space-4) var(--space-5) 0;
}

.vf-card__title {
  margin: 0;
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-strong);
  color: var(--text);
}

.vf-card__body {
  padding: var(--space-5);
}

/* 有头部时收紧正文上边距，标题与内容留呼吸 */
.vf-card__header + .vf-card__body {
  padding-top: var(--space-3);
}
</style>
