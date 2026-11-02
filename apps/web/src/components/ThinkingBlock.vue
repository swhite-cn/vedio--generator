<script setup lang="ts">
/**
 * 思考过程折叠块（参考 Claude Code）：生成中自动展开并显示光标，结束后自动折叠。
 * 内容按纯文本渲染（不解析 Markdown），避免模型输出的 HTML 注入。
 */
import { computed, onMounted, ref, watch } from "vue";
import { LoadingOutlined } from "@ant-design/icons-vue";

const props = withDefaults(
  defineProps<{
    /** 思考文本。 */
    text?: string;
    /** 是否仍在生成。 */
    streaming?: boolean;
  }>(),
  { text: "", streaming: false },
);

/** 展开状态：生成中强制展开，结束后自动折叠。 */
const expanded = ref(props.streaming);

watch(
  () => props.streaming,
  (streaming) => {
    expanded.value = streaming;
  },
);

onMounted(() => {
  expanded.value = props.streaming;
});

/** 折叠时的摘要。 */
const summary = computed(() =>
  props.streaming ? "正在思考…" : `思考过程 · ${(props.text ?? "").length} 字`,
);

/** 切换展开。 */
function toggle(): void {
  expanded.value = !expanded.value;
}
</script>

<template>
  <div class="thinking-block" :class="{ 'is-streaming': streaming }">
    <button
      type="button"
      class="thinking-head"
      :aria-expanded="expanded"
      aria-label="展开或折叠思考过程"
      @click="toggle"
    >
      <loading-outlined v-if="streaming" spin aria-hidden="true" />
      <span v-else class="thinking-dot" aria-hidden="true">✻</span>
      <span class="thinking-title">{{ summary }}</span>
      <span class="thinking-chevron" aria-hidden="true">{{ expanded ? "▾" : "▸" }}</span>
    </button>
    <pre v-if="expanded && text" class="thinking-body">{{ text }}</pre>
  </div>
</template>

<style scoped>
.thinking-block {
  max-width: 92%;
  border-inline-start: 2px solid #e5e7eb;
  padding-inline-start: 10px;
}

.thinking-head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: rgb(0 0 0 / 45%);
  font-size: 12px;
  cursor: pointer;
}

.thinking-head:hover {
  color: rgb(0 0 0 / 65%);
}

.thinking-title {
  font-weight: 500;
}

.thinking-chevron {
  font-size: 10px;
}

.thinking-body {
  max-height: 280px;
  margin: 6px 0 2px;
  padding: 8px 10px;
  overflow: auto;
  border-radius: 6px;
  background: #f8f9fb;
  color: rgb(0 0 0 / 65%);
  font-family: Consolas, "Courier New", monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
