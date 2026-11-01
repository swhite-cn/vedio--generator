<script setup lang="ts">
/**
 * 全局工作台外壳（Web 专题 §4）：顶栏 48px + 侧边栏（208px，可折叠到 48px）+ 内容区。
 * `<768px` 时侧边栏折叠为抽屉；`/admin` 菜单仅 admin 渲染；
 * `hideSider` 为 true 时（工作台页）不渲染侧边栏与折叠按钮，仅保留顶栏 + 页面内返回链接。
 */
import { computed, h, onMounted, onUnmounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  AppstoreOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  MenuUnfoldOutlined,
  ProjectOutlined,
  SettingOutlined,
  UserOutlined,
} from "@ant-design/icons-vue";
import { useAuthStore } from "../stores/auth";

const props = withDefaults(
  defineProps<{
    /** 隐藏侧边栏（工作台页使用，为对话流让出宽度）。 */
    hideSider?: boolean;
  }>(),
  { hideSider: false },
);

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

/** 是否隐藏侧边栏（工作台页）。 */
const hideSider = computed(() => props.hideSider);

/** 侧边栏折叠状态（桌面端）。 */
const collapsed = ref(false);
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
        v-if="!hideSider && isNarrow"
        type="text"
        aria-label="打开导航"
        @click="drawerOpen = true"
      >
        <menu-outlined />
      </a-button>
      <a-button
        v-else-if="!hideSider"
        type="text"
        :aria-label="collapsed ? '展开侧边栏' : '折叠侧边栏'"
        @click="collapsed = !collapsed"
      >
        <menu-unfold-outlined v-if="collapsed" />
        <menu-fold-outlined v-else />
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
      <a-layout-sider
        v-if="!isNarrow && !hideSider"
        v-model:collapsed="collapsed"
        collapsible
        :trigger="null"
        :width="208"
        :collapsed-width="48"
        theme="light"
        class="app-sider"
      >
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
  height: 48px;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  background: #fff;
  border-block-end: 1px solid #f0f0f0;
  line-height: 48px;
}

.app-brand {
  color: rgb(0 0 0 / 88%);
  font-size: 17px;
  font-weight: 700;
  cursor: pointer;
}

.user-dropdown {
  margin-inline-start: auto;
}

.user-name {
  margin-inline-start: 6px;
}

.app-sider {
  border-inline-end: 1px solid #f0f0f0;
}

.app-content {
  min-height: 0;
  overflow: auto;
  background: #f5f5f5;
}

.content-inner {
  max-width: 1440px;
  margin: 0 auto;
  padding: 24px;
}

@media (prefers-reduced-motion: reduce) {
  .app-layout :deep(*) {
    transition: none !important;
    animation: none !important;
  }
}
</style>
