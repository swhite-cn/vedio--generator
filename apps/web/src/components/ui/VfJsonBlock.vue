<script setup lang="ts">
/**
 * JSON 展示块基元（方案 §8.6）：技术文本统一 JetBrains Mono（--font-mono）。
 * 默认提供一键复制（clipboard 不可用时静默失败，不阻塞展示）。
 */
import { computed, ref } from "vue";

const props = withDefaults(
  defineProps<{
    /** 任意可序列化值（对象/数组原样格式化，标量直接展示）。 */
    value: unknown;
    /** 是否提供复制按钮。 */
    copyable?: boolean;
    /** 内容区最大高度（溢出滚动）。 */
    maxHeight?: string;
  }>(),
  { copyable: true, maxHeight: "320px" },
);

/** 格式化后的 JSON 文本。 */
const formatted = computed(() => {
  if (typeof props.value === "string") return props.value;
  try {
    return JSON.stringify(props.value, null, 2) ?? String(props.value);
  } catch {
    return String(props.value);
  }
});

/** 复制成功后的短暂提示状态。 */
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

/** 复制 JSON 文本到剪贴板；环境不支持时静默忽略。 */
async function copyValue(): Promise<void> {
  try {
    await navigator.clipboard.writeText(formatted.value);
    copied.value = true;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied.value = false;
    }, 1600);
  } catch {
    // 剪贴板不可用（权限/非安全上下文）：保持静默
  }
}
</script>

<template>
  <div class="vf-json" :style="{ '--vf-json-max-height': maxHeight }">
    <div v-if="copyable" class="vf-json__bar">
      <button
        type="button"
        class="vf-json__copy"
        :aria-label="copied ? '已复制' : '复制 JSON'"
        @click="copyValue"
      >
        {{ copied ? "已复制" : "复制" }}
      </button>
    </div>
    <pre class="vf-json__pre"><code>{{ formatted }}</code></pre>
  </div>
</template>

<style scoped>
.vf-json {
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-control);
  background: var(--inset);
  overflow: hidden;
}

.vf-json__bar {
  display: flex;
  justify-content: flex-end;
  padding: var(--space-1) var(--space-2) 0;
}

.vf-json__copy {
  padding: 2px 8px;
  border: 0;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-ter);
  font-size: var(--font-size-small);
  cursor: pointer;
}

.vf-json__copy:hover {
  color: var(--text);
  background: var(--surface-2);
}

.vf-json__copy:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.vf-json__pre {
  margin: 0;
  padding: var(--space-3);
  max-height: var(--vf-json-max-height);
  overflow: auto;
  font-family: var(--font-mono);
  font-size: var(--font-size-small);
  line-height: 1.6;
  color: var(--text-sec);
}
</style>
