<script setup lang="ts">
/**
 * 应用外壳（方案 §8.3）：196px 侧栏（--deep）+ 56px 顶栏 + 内容区（padding 28px）。
 *
 * - 导航 5 项：能力中心 / 项目 / 素材库 / 组件库 / 管理（管理仅 admin 可见）；
 *   38px 行高，选中态 --surface-2 底 + 左侧 3×20 主色条；
 * - 顶栏：面包屑 12.5px（数据来自 route.meta.breadcrumb）+ 右侧搜索 240×34（行为留 T312）、
 *   通知入口、头像 32px；
 * - 底部用户卡：名称 + 角色，下拉菜单提供个人设置与退出登录（沿用现有 auth 行为）；
 * - 响应式：<1280px 侧栏收为 64px 图标栏（方案 960–1279 档，向下覆盖至 768px）；
 *   <768px 改抽屉导航，顶栏显示菜单按钮。
 */
import { computed, onMounted, onUnmounted, ref, watch, type Component } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  AppstoreOutlined,
  BellOutlined,
  BlockOutlined,
  MenuOutlined,
  PictureOutlined,
  ProjectOutlined,
  SettingOutlined,
} from "@ant-design/icons-vue";
import { useAuthStore } from "../stores/auth";
import { apiRequest } from "../services/api";
import VfInput from "../components/ui/VfInput.vue";

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

/** 顶栏搜索框受控值（全局搜索，T312）。 */
const searchText = ref("");
/** 搜索结果（空串查询或未请求时为 null）。 */
const searchResults = ref<SearchResponse | null>(null);
/** 结果面板是否展开。 */
const searchOpen = ref(false);
/** 搜索请求中。 */
const searchLoading = ref(false);
/** 搜索失败标记。 */
const searchError = ref(false);
/** 键盘当前高亮项索引。 */
const searchActiveIndex = ref(-1);
/** 搜索容器（点击外部关闭）。 */
const searchBox = ref<HTMLElement | null>(null);

/** `/api/search` 响应子集。 */
interface SearchResponse {
  q: string;
  projects: Array<{ id: string; name: string; topic: string; status: string }>;
  assets: Array<{
    id: string;
    project_id: string;
    project_name: string;
    label: string;
    kind: string;
    source: string;
  }>;
  components: Array<{ id: string; name: string; category: string; coverage_note: string | null }>;
}

/** 扁平化搜索结果（键盘导航与渲染共用）。 */
interface SearchHit {
  key: string;
  kind: "project" | "asset" | "component";
  label: string;
  detail: string;
  to: string;
}

const searchHits = computed<SearchHit[]>(() => {
  const data = searchResults.value;
  if (!data) return [];
  return [
    ...data.projects.map((item) => ({
      key: `project-${item.id}`,
      kind: "project" as const,
      label: item.name,
      detail: item.topic,
      to: `/projects/${item.id}`,
    })),
    ...data.assets.map((item) => ({
      key: `asset-${item.id}`,
      kind: "asset" as const,
      label: item.label,
      detail: `${item.project_name} · ${item.kind}`,
      to: `/assets?projectId=${encodeURIComponent(item.project_id)}`,
    })),
    ...data.components.map((item) => ({
      key: `component-${item.id}`,
      kind: "component" as const,
      label: item.name,
      detail: `${item.id}${item.coverage_note ? ` · ${item.coverage_note}` : ""}`,
      to: "/components",
    })),
  ];
});

/** 搜索请求去抖计时器。 */
let searchTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 执行全局搜索（空串直接收起面板）。
 * @param keyword 关键词
 */
async function runSearch(keyword: string): Promise<void> {
  const query = keyword.trim();
  if (query.length === 0) {
    searchResults.value = null;
    searchOpen.value = false;
    searchActiveIndex.value = -1;
    return;
  }
  searchLoading.value = true;
  searchError.value = false;
  searchOpen.value = true;
  try {
    searchResults.value = await apiRequest<SearchResponse>(
      `/api/search?q=${encodeURIComponent(query)}`,
    );
    searchActiveIndex.value = -1;
  } catch (error) {
    searchError.value = true;
    searchResults.value = null;
    console.warn("[web] 全局搜索失败", error);
  } finally {
    searchLoading.value = false;
  }
}

// 输入变化后 250ms 去抖请求，避免逐字打接口
watch(searchText, (value) => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    void runSearch(value);
  }, 250);
});

/**
 * 打开一条搜索结果。
 * @param hit 搜索结果
 */
function openSearchHit(hit: SearchHit): void {
  searchOpen.value = false;
  searchText.value = "";
  searchResults.value = null;
  void router.push(hit.to);
}

/**
 * 搜索框键盘导航：↑↓ 选择、Enter 打开、Esc 收起。
 * @param event 键盘事件
 */
function onSearchKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    searchOpen.value = false;
    return;
  }
  if (!searchOpen.value || searchHits.value.length === 0) {
    if (event.key === "Enter") void runSearch(searchText.value);
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    searchActiveIndex.value = (searchActiveIndex.value + 1) % searchHits.value.length;
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    searchActiveIndex.value =
      (searchActiveIndex.value - 1 + searchHits.value.length) % searchHits.value.length;
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const hit = searchHits.value[searchActiveIndex.value] ?? searchHits.value[0];
    if (hit) openSearchHit(hit);
  }
}

/** 点击外部时收起搜索结果。 */
function onDocumentClick(event: MouseEvent): void {
  if (!searchBox.value) return;
  if (!searchBox.value.contains(event.target as Node)) {
    searchOpen.value = false;
  }
}

/** 结果类型中文名。 */
function kindLabel(kind: SearchHit["kind"]): string {
  return kind === "project" ? "项目" : kind === "asset" ? "素材" : "组件";
}

/** 主导航项（管理项按角色追加）；能力中心为默认首页（`/`，方案 §8.4）。 */
const NAV_ITEMS: Array<{ to: string; label: string; icon: Component }> = [
  { to: "/", label: "能力中心", icon: AppstoreOutlined },
  { to: "/projects", label: "项目", icon: ProjectOutlined },
  { to: "/assets", label: "素材库", icon: PictureOutlined },
  { to: "/components", label: "组件库", icon: BlockOutlined },
];

/** 侧栏收窄断点是否命中（<1280px）。 */
const isCompact = ref(false);
/** 抽屉断点是否命中（<768px）。 */
const isNarrow = ref(false);
/** 抽屉开关。 */
const drawerOpen = ref(false);

let compactQuery: MediaQueryList | null = null;
let narrowQuery: MediaQueryList | null = null;

/** 侧栏收窄断点变化处理。 */
function handleCompactChange(event: MediaQueryListEvent | MediaQueryList): void {
  isCompact.value = event.matches;
}

/** 抽屉断点变化处理；退出窄屏时收起抽屉。 */
function handleNarrowChange(event: MediaQueryListEvent | MediaQueryList): void {
  isNarrow.value = event.matches;
  if (!event.matches) {
    drawerOpen.value = false;
  }
}

onMounted(() => {
  compactQuery = window.matchMedia("(max-width: 1279.98px)");
  handleCompactChange(compactQuery);
  compactQuery.addEventListener("change", handleCompactChange);
  narrowQuery = window.matchMedia("(max-width: 767.98px)");
  handleNarrowChange(narrowQuery);
  narrowQuery.addEventListener("change", handleNarrowChange);
  document.addEventListener("click", onDocumentClick);
});

onUnmounted(() => {
  compactQuery?.removeEventListener("change", handleCompactChange);
  narrowQuery?.removeEventListener("change", handleNarrowChange);
  compactQuery = null;
  narrowQuery = null;
  document.removeEventListener("click", onDocumentClick);
  if (searchTimer) clearTimeout(searchTimer);
});

/** 完整导航项（含管理，按角色过滤）；抽屉与侧栏共用。 */
const navItems = computed(() => {
  const items = [...NAV_ITEMS];
  if (auth.me?.role === "admin") {
    items.push({ to: "/admin", label: "管理", icon: SettingOutlined });
  }
  return items;
});

/** 顶栏展示的用户名。 */
const displayName = computed(() => auth.me?.displayName || auth.me?.username || "用户");

/** 头像内的首字符。 */
const avatarChar = computed(() => displayName.value.slice(0, 1).toUpperCase());

/** 角色展示文案。 */
const roleLabel = computed(() => (auth.me?.role === "admin" ? "管理员" : "成员"));

/** 已知路径的面包屑兜底映射（路由 meta.breadcrumb 缺失时使用）。 */
const BREADCRUMB_FALLBACK: Readonly<Record<string, string>> = {
  "/capabilities": "能力中心",
  "/projects": "项目",
  "/assets": "素材库",
  "/components": "组件库",
  "/admin": "管理",
  "/settings": "设置",
};

/** 面包屑层级：优先 route.meta.breadcrumb，其次按已知前缀兜底。 */
const breadcrumbs = computed<string[]>(() => {
  const fromMeta = route.meta.breadcrumb;
  if (Array.isArray(fromMeta) && fromMeta.length > 0) {
    return fromMeta as string[];
  }
  const matched = Object.keys(BREADCRUMB_FALLBACK).find((prefix) => route.path.startsWith(prefix));
  return matched ? [BREADCRUMB_FALLBACK[matched]!] : [];
});

/** 导航项是否处于选中态：根路径精确匹配，其余前缀匹配（覆盖 /projects/:id 等子路径）。 */
function isActive(to: string): boolean {
  if (to === "/") return route.path === "/";
  return route.path === to || route.path.startsWith(`${to}/`);
}

/** 用户下拉菜单项（与旧外壳行为一致）。 */
const userMenuItems = [
  { key: "settings", label: "个人设置" },
  { key: "logout", label: "退出登录" },
];

/** 点击 Logo 回到能力中心（默认首页）。 */
function goHome(): void {
  void router.push("/");
}

/** 导航点击后收起抽屉；跳转交给 RouterLink。 */
function onNavigated(): void {
  drawerOpen.value = false;
}

/** 用户菜单点击处理。 */
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
</script>

<template>
  <div class="shell" :class="{ 'shell--compact': isCompact && !isNarrow }">
    <!-- 抽屉导航（<768px） -->
    <a-drawer
      v-model:open="drawerOpen"
      placement="left"
      :width="196"
      :closable="false"
      class="shell-drawer"
      root-class-name="shell-drawer-root"
    >
      <template #title>
        <span class="shell-brand">
          <span class="shell-brand__logo" aria-hidden="true">V</span>
          <span class="shell-brand__name">VideoForge</span>
        </span>
      </template>
      <nav class="shell-nav" aria-label="主导航">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="shell-nav__item"
          :class="{ 'is-active': isActive(item.to) }"
          @click="onNavigated"
        >
          <component :is="item.icon" class="shell-nav__icon" />
          <span class="shell-nav__label">{{ item.label }}</span>
        </RouterLink>
      </nav>
    </a-drawer>

    <!-- 侧栏 -->
    <aside class="shell-sider">
      <span
        class="shell-brand"
        role="link"
        tabindex="0"
        aria-label="回到能力中心"
        @click="goHome"
        @keydown.enter="goHome"
      >
        <span class="shell-brand__logo" aria-hidden="true">V</span>
        <span class="shell-brand__name">VideoForge</span>
      </span>

      <nav class="shell-nav" aria-label="主导航">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="shell-nav__item"
          :class="{ 'is-active': isActive(item.to) }"
          :title="item.label"
        >
          <component :is="item.icon" class="shell-nav__icon" />
          <span class="shell-nav__label">{{ item.label }}</span>
        </RouterLink>
      </nav>

      <a-dropdown class="shell-user" trigger="['click']">
        <button type="button" class="shell-user__card" :aria-label="`账户菜单：${displayName}`">
          <span class="shell-user__avatar" aria-hidden="true">{{ avatarChar }}</span>
          <span class="shell-user__meta">
            <span class="shell-user__name">{{ displayName }}</span>
            <span class="shell-user__role">{{ roleLabel }}</span>
          </span>
        </button>
        <template #overlay>
          <a-menu :items="userMenuItems" @click="onUserMenuClick" />
        </template>
      </a-dropdown>
    </aside>

    <!-- 右列：顶栏 + 内容 -->
    <div class="shell-body">
      <header class="shell-header">
        <a-button
          v-if="isNarrow"
          type="text"
          class="shell-header__menu"
          aria-label="打开导航"
          @click="drawerOpen = true"
        >
          <menu-outlined />
        </a-button>

        <nav v-if="breadcrumbs.length > 0" class="shell-breadcrumb" aria-label="面包屑">
          <template v-for="(crumb, index) in breadcrumbs" :key="`${crumb}-${index}`">
            <span v-if="index > 0" class="shell-breadcrumb__sep" aria-hidden="true">/</span>
            <span
              class="shell-breadcrumb__item"
              :class="{ 'is-current': index === breadcrumbs.length - 1 }"
            >
              {{ crumb }}
            </span>
          </template>
        </nav>

        <div class="shell-header__actions">
          <div ref="searchBox" class="shell-search">
            <VfInput
              v-model="searchText"
              placeholder="搜索项目、素材、组件"
              aria-label="全局搜索"
              role="combobox"
              aria-autocomplete="list"
              aria-controls="shell-search-list"
              :aria-expanded="searchOpen"
              :aria-activedescendant="
                searchActiveIndex >= 0 ? `shell-search-option-${searchActiveIndex}` : undefined
              "
              @keydown="onSearchKeydown"
            />
            <div v-if="searchOpen" id="shell-search-list" class="search-panel" role="listbox">
              <p v-if="searchLoading" class="search-state">正在搜索…</p>
              <p v-else-if="searchError" class="search-state">搜索失败，请稍后重试。</p>
              <p v-else-if="searchHits.length === 0" class="search-state">没有找到匹配结果。</p>
              <button
                v-for="(hit, index) in searchHits"
                :key="hit.key"
                :id="`shell-search-option-${index}`"
                type="button"
                role="option"
                class="search-hit"
                :class="{ 'is-active': index === searchActiveIndex }"
                :aria-selected="index === searchActiveIndex"
                @click="openSearchHit(hit)"
              >
                <span class="search-hit__kind">{{ kindLabel(hit.kind) }}</span>
                <span class="search-hit__label">{{ hit.label }}</span>
                <span class="search-hit__detail">{{ hit.detail }}</span>
              </button>
            </div>
          </div>
          <button type="button" class="shell-icon-btn" aria-label="通知（暂未开放）" title="通知">
            <bell-outlined />
          </button>
          <span class="shell-avatar" aria-hidden="true">{{ avatarChar }}</span>
        </div>
      </header>

      <main class="shell-main">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
}

/* --- 侧栏 --- */
.shell-sider {
  display: flex;
  flex-direction: column;
  flex: none;
  width: var(--shell-sider-width);
  background: var(--deep);
  border-inline-end: 1px solid var(--border-soft);
  padding: var(--space-4) var(--space-3);
}

.shell-brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-2) var(--space-5);
  cursor: pointer;
}

.shell-brand:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-control);
}

.shell-brand__logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--accent);
  color: #ffffff;
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-strong);
}

.shell-brand__name {
  font-size: 16px;
  font-weight: var(--font-weight-strong);
  color: var(--text);
  white-space: nowrap;
}

.shell-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.shell-nav__item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 38px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-control);
  color: var(--text-sec);
  font-size: var(--font-size-body);
  text-decoration: none;
  white-space: nowrap;
  transition: background var(--motion-fast) ease, color var(--motion-fast) ease;
}

.shell-nav__item:hover {
  background: var(--surface);
  color: var(--text);
}

.shell-nav__item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.shell-nav__item.is-active {
  background: var(--surface-2);
  color: var(--text);
}

/* 选中态左侧 3×20 主色条 */
.shell-nav__item.is-active::before {
  content: "";
  position: absolute;
  inset-inline-start: 0;
  inset-block-start: 9px;
  width: 3px;
  height: 20px;
  border-radius: 2px;
  background: var(--accent);
}

.shell-nav__icon {
  font-size: 15px;
  flex: none;
}

.shell-nav__label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.shell-user {
  margin-top: auto;
}

.shell-user__card {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}

.shell-user__card:hover {
  background: var(--surface);
}

.shell-user__card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.shell-user__avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  color: var(--text);
  font-size: var(--font-size-small);
  font-weight: var(--font-weight-strong);
}

.shell-user__meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.shell-user__name {
  font-size: var(--font-size-small);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shell-user__role {
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

/* --- 右列 --- */
.shell-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.shell-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: none;
  height: var(--shell-header-height);
  padding: 0 var(--space-5);
  background: var(--bg);
  border-block-end: 1px solid var(--border-soft);
}

.shell-header__menu {
  color: var(--text-sec);
}

.shell-breadcrumb {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: 12.5px;
}

.shell-breadcrumb__item {
  color: var(--text-ter);
  white-space: nowrap;
}

.shell-breadcrumb__item.is-current {
  color: var(--text);
}

.shell-breadcrumb__sep {
  color: var(--text-ter);
}

.shell-header__actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-inline-start: auto;
}

.shell-search {
  position: relative;
  width: 240px;
}

.shell-search :deep(.vf-input) {
  height: 34px;
}

/* 全局搜索结果面板 */
.search-panel {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 20;
  display: flex;
  width: 340px;
  max-height: 360px;
  flex-direction: column;
  gap: 2px;
  overflow: auto;
  padding: var(--space-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-modal);
}

.search-state {
  margin: 0;
  padding: var(--space-2);
  font-size: var(--font-size-small);
  color: var(--text-ter);
}

.search-hit {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 2px var(--space-2);
  padding: var(--space-2);
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text);
  font-family: inherit;
  text-align: start;
  cursor: pointer;
}

.search-hit:hover,
.search-hit.is-active {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.search-hit:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.search-hit__kind {
  grid-row: span 2;
  align-self: center;
  padding: 1px var(--space-2);
  background: var(--surface);
  border-radius: var(--radius-pill);
  color: var(--text-ter);
  font-size: var(--font-size-caption);
}

.search-hit__label {
  overflow: hidden;
  font-size: var(--font-size-small);
  font-weight: var(--font-weight-strong);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-hit__detail {
  overflow: hidden;
  font-size: var(--font-size-caption);
  color: var(--text-ter);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shell-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-sec);
  font-size: 15px;
  cursor: pointer;
}

.shell-icon-btn:hover {
  background: var(--surface-2);
  color: var(--text);
}

.shell-icon-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.shell-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  color: var(--text);
  font-size: var(--font-size-small);
  font-weight: var(--font-weight-strong);
}

/* --- 内容区 --- */
.shell-main {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: var(--shell-content-padding);
}

/* --- 收窄：侧栏 64px 图标栏（方案 960–1279 档） --- */
.shell--compact .shell-sider {
  width: 64px;
  padding: var(--space-4) var(--space-2);
  align-items: center;
}

.shell--compact .shell-brand {
  padding: var(--space-1) 0 var(--space-5);
}

.shell--compact .shell-brand__name,
.shell--compact .shell-nav__label,
.shell--compact .shell-user__meta {
  display: none;
}

.shell--compact .shell-nav__item {
  justify-content: center;
  padding: 0;
  width: 40px;
}

.shell--compact .shell-user__card {
  justify-content: center;
  padding: var(--space-1);
}

@media (max-width: 767.98px) {
  .shell-sider {
    display: none;
  }

  .shell-header {
    padding: 0 var(--space-3);
  }

  .shell-search {
    display: none;
  }

  .shell-main {
    padding: var(--space-4);
  }
}

@media (prefers-reduced-motion: reduce) {
  .shell *,
  .shell-drawer :deep(*) {
    transition: none !important;
    animation: none !important;
  }
}
</style>
