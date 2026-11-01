<script setup lang="ts">
/**
 * 应用根组件：全局 Ant Design Vue 主题与外壳选择。
 * `meta.layout === "blank"`（登录页）渲染独立全屏页；`meta.layout === "workbench"`
 * （工作台核心页）渲染隐藏侧边栏的布局（仅顶栏 + 返回链接，为对话流让出宽度）；其余渲染 AppLayout。
 */
import { computed } from "vue";
import { useRoute } from "vue-router";
import zhCN from "ant-design-vue/es/locale/zh_CN";
import AppLayout from "./layouts/AppLayout.vue";

const route = useRoute();

/** 全局主题 token（见 Web 专题 §2.2）。 */
const theme = {
  token: {
    colorPrimary: "#1677ff",
    borderRadius: 6,
    fontFamily: 'Inter, "Segoe UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif',
  },
};

/** 当前路由是否为无框架布局。 */
const isBlankLayout = computed(() => route.meta.layout === "blank");

/** 当前路由是否为工作台布局（隐藏侧边栏）。 */
const isWorkbenchLayout = computed(() => route.meta.layout === "workbench");
</script>

<template>
  <a-config-provider :locale="zhCN" :theme="theme">
    <router-view v-if="isBlankLayout" />
    <app-layout v-else :hide-sider="isWorkbenchLayout">
      <router-view />
    </app-layout>
  </a-config-provider>
</template>
