<script setup lang="ts">
/**
 * 输入框基元（方案 §8.6）：原生 input + tokens 视觉，受控 v-model。
 * 复杂输入（带前后缀、校验）由页面基于 a-input 扩展，本基元只覆盖统一视觉。
 */
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    /** 受控值（v-model）。 */
    modelValue?: string;
    /** 占位提示。 */
    placeholder?: string;
    /** 输入类型（text/password 等原生类型）。 */
    type?: string;
    /** 是否禁用。 */
    disabled?: boolean;
    /** 无可见标签时的可访问名称。 */
    ariaLabel?: string;
    /** 原生 id（供 `<label for>` 关联）。 */
    id?: string;
    /** 原生自动填充提示（username/current-password 等）。 */
    autocomplete?: string;
  }>(),
  {
    modelValue: "",
    placeholder: undefined,
    type: "text",
    disabled: false,
    ariaLabel: undefined,
    id: undefined,
    autocomplete: undefined,
  },
);

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

/** 输入事件回写受控值。 */
function onInput(event: Event): void {
  emit("update:modelValue", (event.target as HTMLInputElement).value);
}

/** 透传给 input 的动态绑定。 */
const inputAttrs = computed(() => ({
  id: props.id,
  value: props.modelValue,
  type: props.type,
  placeholder: props.placeholder,
  disabled: props.disabled,
  autocomplete: props.autocomplete,
  "aria-label": props.ariaLabel,
}));
</script>

<template>
  <input class="vf-input" v-bind="inputAttrs" @input="onInput" />
</template>

<style scoped>
.vf-input {
  width: 100%;
  height: 36px;
  padding: 0 var(--space-3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  color: var(--text);
  font-family: inherit;
  font-size: var(--font-size-body);
  transition: border-color var(--motion-fast) ease;
}

.vf-input::placeholder {
  color: var(--text-ter);
}

.vf-input:focus {
  outline: none;
  border-color: var(--accent);
}

.vf-input:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
