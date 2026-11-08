<script setup lang="ts">
/**
 * 模态基元（方案 §8.6/§8.8）：包装 a-modal 作为统一入口。
 * 焦点陷阱、ESC 关闭、遮罩点击关闭由 AntD 行为层保证；视觉由 theme.ts 的
 * Modal 组件映射（--surface 底、12px 圆角）+ tokens 遮罩承担。
 */
withDefaults(
  defineProps<{
    /** 是否打开（v-model:open）。 */
    open: boolean;
    /** 标题。 */
    title?: string;
    /** 宽度像素。 */
    width?: number;
  }>(),
  { title: undefined, width: 520 },
);

const emit = defineEmits<{ "update:open": [value: boolean] }>();

/** 关闭事件统一回写 v-model:open。 */
function onClose(): void {
  emit("update:open", false);
}
</script>

<template>
  <a-modal
    class="vf-modal"
    :open="open"
    :title="title"
    :width="width"
    :footer="null"
    @cancel="onClose"
  >
    <slot />
    <footer v-if="$slots.footer" class="vf-modal__footer">
      <slot name="footer" />
    </footer>
  </a-modal>
</template>

<style scoped>
.vf-modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-6);
}
</style>
