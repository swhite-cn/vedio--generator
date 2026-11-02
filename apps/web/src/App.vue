<script setup lang="ts">
/**
 * 应用根组件：全局 Ant Design Vue 主题与外壳选择。
 * `meta.layout === "blank"`（登录页）渲染独立全屏页；其余页面统一渲染
 * AppLayout（顶栏 + 侧边栏 + 内容区）。
 */
import { computed } from "vue";
import { useRoute } from "vue-router";
import zhCN from "ant-design-vue/es/locale/zh_CN";
import AppLayout from "./layouts/AppLayout.vue";

const route = useRoute();

/** 全局主题 token（见 Web 专题 §2.2「视觉基线」）：圆角 8、字号 14、浅灰画布。 */
const theme = {
  token: {
    colorPrimary: "#1677ff",
    colorBgLayout: "#f5f7fa",
    colorBorderSecondary: "#f0f2f5",
    colorText: "rgba(0, 0, 0, 0.88)",
    colorTextSecondary: "rgba(0, 0, 0, 0.65)",
    colorTextTertiary: "rgba(0, 0, 0, 0.45)",
    borderRadius: 8,
    fontSize: 14,
    lineHeight: 1.5715,
    fontFamily: 'Inter, "Segoe UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif',
  },
};

/** 当前路由是否为无框架布局。 */
const isBlankLayout = computed(() => route.meta.layout === "blank");
</script>

<template>
  <a-config-provider :locale="zhCN" :theme="theme">
    <router-view v-if="isBlankLayout" />
    <app-layout v-else>
      <router-view />
    </app-layout>
  </a-config-provider>
</template>
