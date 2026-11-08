<script setup lang="ts">
/**
 * 应用根组件：全局 Ant Design Vue 主题与外壳选择。
 * 主题来自 styles/theme.ts（T007：tokens.css 的 AntD 深色映射，方案 §8.2）；
 * `meta.layout === "blank"`（登录页）渲染独立全屏页；其余页面统一渲染
 * AppShell（方案 §8.3：196px 侧栏 + 56px 顶栏）。
 */
import { computed } from "vue";
import { useRoute } from "vue-router";
import zhCN from "ant-design-vue/es/locale/zh_CN";
import { VF_THEME } from "./styles/theme";
import AppShell from "./layouts/AppShell.vue";

const route = useRoute();

/** 当前路由是否为无框架布局。 */
const isBlankLayout = computed(() => route.meta.layout === "blank");
</script>

<template>
  <a-config-provider :locale="zhCN" :theme="VF_THEME">
    <router-view v-if="isBlankLayout" />
    <app-shell v-else>
      <router-view />
    </app-shell>
  </a-config-provider>
</template>
