<script setup lang="ts">
/**
 * 全局工作台外壳（Web 专题 §4）：顶栏 48px + 固定侧边栏 208px + 内容区。
 * `<768px` 时改用抽屉导航；`/admin` 菜单仅 admin 渲染。
 * 侧边栏不提供折叠按钮：设计稿采用固定宽度侧栏，保持内容区宽度稳定。
 */
import { computed, h, onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  AppstoreOutlined,
  MenuOutlined,
  ProjectOutlined,
  SettingOutlined,
  UserOutlined,
} from "@ant-design/icons-vue";
import { useAuthStore } from "../stores/auth";

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

/** 窄屏抽屉开关。 */
const drawerOpen = ref(false);
/** 是否处于窄屏（<768px）。 */
const isNarrow = ref(false);

let mediaQuery: MediaQueryList | null = null;

/** 窄屏断点变化处理。 */
function handleMediaChange(event: MediaQueryListEvent | MediaQueryList): void {
  isNarrow.value = event.matches;
  if (!event.matches) {
    drawerOpen.value = false;
  }
}

/** 顶栏右侧展示的用户名。 */
const displayName = computed(() => auth.me?.displayName || auth.me?.username || "用户");

/** 侧边栏菜单项（管理员额外渲染「管理」）。 */
const menuItems = computed(() => {
  const items = [
    { key: "/capabilities", icon: () => h(AppstoreOutlined), label: "能力中心" },
    { key: "/projects", icon: () => h(ProjectOutlined), label: "项目" },
  ];
  if (auth.me?.role === "admin") {
    items.push({ key: "/admin", icon: () => h(SettingOutlined), label: "管理" });
  }
  return items;
});

/** 当前高亮菜单项（`/projects` 与 `/capabilities` 精确匹配）。 */
const selectedKeys = computed<string[]>(() => {
  if (route.path.startsWith("/capabilities")) {
    return ["/capabilities"];
  }
  if (route.path.startsWith("/projects")) {
    return ["/projects"];
  }
  if (route.path.startsWith("/admin")) {
    return ["/admin"];
  }
  return [];
});

/** 用户下拉菜单项。 */
const userMenuItems = [
  { key: "settings", label: "个人设置" },
  { key: "logout", label: "退出登录" },
];

/** 点击产品名回到项目列表。 */
function goHome(): void {
  void router.push("/projects");
}

/** 侧边栏菜单点击跳转。 */
function onMenuClick(info: { key: string | number }): void {
  drawerOpen.value = false;
  void router.push(String(info.key));
}

/** 顶栏用户菜单点击处理。 */
async function onUserMenuClick(info: { key: string | number }): Promise<void> {
  if (info.key === "settings") {
    void router.push("/settings");
    return;
  }
  if (info.key === "logout") {
    await auth.logout();
    void router.push("/login");
  }
}

onMounted(() => {
  mediaQuery = window.matchMedia("(max-width: 767.98px)");
  handleMediaChange(mediaQuery);
  mediaQuery.addEventListener("change", handleMediaChange);
});

onUnmounted(() => {
  mediaQuery?.removeEventListener("change", handleMediaChange);
  mediaQuery = null;
});
</script>

<template>
  <a-layout class="app-layout">
    <a-layout-header class="app-header">
      <a-button
        v-if="isNarrow"
        type="text"
        aria-label="打开导航"
        @click="drawerOpen = true"
      >
        <menu-outlined />
      </a-button>

      <span class="app-brand" role="link" tabindex="0" @click="goHome" @keydown.enter="goHome">
        VideoForge
      </span>

      <a-dropdown class="user-dropdown">
        <a-button type="text">
          <user-outlined />
          <span class="user-name">{{ displayName }}</span>
        </a-button>
        <template #overlay>
          <a-menu :items="userMenuItems" @click="onUserMenuClick" />
        </template>
      </a-dropdown>
    </a-layout-header>

    <a-layout>
      <a-layout-sider v-if="!isNarrow" :width="208" theme="light" class="app-sider">
        <a-menu
          mode="inline"
          :selected-keys="selectedKeys"
          :items="menuItems"
          @click="onMenuClick"
        />
      </a-layout-sider>

      <a-layout-content class="app-content">
        <div class="content-inner">
          <slot />
        </div>
      </a-layout-content>
    </a-layout>

    <a-drawer
      v-model:open="drawerOpen"
      placement="left"
      :width="208"
      :closable="false"
      title="导航"
    >
      <a-menu mode="inline" :selected-keys="selectedKeys" :items="menuItems" @click="onMenuClick" />
    </a-drawer>
  </a-layout>
</template>

<style scoped>
.app-layout {
  min-height: 100vh;
}

.app-header {
  display: flex;
  height: var(--vf-header-height);
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  border-block-end: 1px solid var(--vf-border);
  background: var(--vf-surface);
  line-height: var(--vf-header-height);
}

.app-brand {
  color: var(--vf-text);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.01em;
  cursor: pointer;
}

.user-dropdown {
  margin-inline-start: auto;
}

.user-name {
  margin-inline-start: 6px;
}

.app-sider {
  border-inline-end: 1px solid var(--vf-border);
}

.app-sider :deep(.ant-menu) {
  border-inline-end: 0;
}

.app-content {
  min-height: 0;
  overflow: auto;
  background: var(--vf-canvas);
}

.content-inner {
  /* Trace 页需要更宽的表格，默认按 1440 收敛；工作台页铺满该宽度 */
  max-width: var(--vf-trace-max);
  margin: 0 auto;
  padding: 16px;
}

@media (max-width: 767.98px) {
  .content-inner {
    padding: 12px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .app-layout :deep(*) {
    transition: none !important;
    animation: none !important;
  }
}
</style>
