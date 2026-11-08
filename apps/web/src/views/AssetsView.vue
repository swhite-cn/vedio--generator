<script setup lang="ts">
/**
 * 素材库（方案 §8.5 第 7 页 / T309）：项目作用域的资产浏览、6 类筛选、风格锚 banner 与上传。
 *
 * 数据：
 * - `GET /api/projects/:id/assets`（T118：`categories` + `boundShots`）；
 * - 风格锚来自 `GET /api/projects/:id/storyboard` 的 copy v2 `styleAnchors`（只读展示，运营留 T401）。
 * 前端只渲染服务端字段，不推导绑定关系。
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { message } from "ant-design-vue";
import { useProjectsStore, type Project } from "../stores/projects";
import { useAssetsStore, type ProjectAsset } from "../stores/assets";
import { useStoryboardStore } from "../stores/storyboard";
import { apiRequest, formatApiError } from "../services/api";
import { getMediaTicket } from "../services/media-ticket";
import { buildMediaUrl } from "../components/media-url";
import { formatBytes } from "../components/format";
import VfButton from "../components/ui/VfButton.vue";
import VfPill from "../components/ui/VfPill.vue";
import StyleAnchorModal from "../components/StyleAnchorModal.vue";

const route = useRoute();
const router = useRouter();
const projectsStore = useProjectsStore();
const assets = useAssetsStore();
const storyboard = useStoryboardStore();

/** 6 类分类中文名（服务端枚举来自 PROJECT_VISUAL_CATEGORIES）。 */
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  "ai-generated": "AI 生成",
  "live-action": "实拍上传",
  "archive-photo": "档案照片",
  "3d-render": "3D 渲染",
  "video-clip": "视频片段",
  "style-anchor": "风格锚",
};

/** 当前项目 id（来自查询参数或首个项目）。 */
const currentProjectId = ref("");
/** 分类筛选（空串 = 全部）。 */
const categoryFilter = ref("");
/** 媒体票据。 */
const mediaTicket = ref("");
/** 隐藏上传框。 */
const uploadInput = ref<HTMLInputElement | null>(null);
/** 行内错误。 */
const actionError = ref("");
/** 风格锚管理模态开关（T401）。 */
const manageOpen = ref(false);

/** 当前项目实体。 */
const project = computed<Project | null>(
  () => projectsStore.list.find((item) => item.id === currentProjectId.value) ?? null,
);

/** 筛选项：全部 + 服务端 6 类（缺失时回退内置枚举）。 */
const categoryOptions = computed(() => {
  const list = assets.categories.length > 0 ? assets.categories : Object.keys(CATEGORY_LABELS);
  return [{ value: "", label: "全部" }, ...list.map((value) => ({
    value,
    label: CATEGORY_LABELS[value] ?? value,
  }))];
});

/** 当前项目筛选后的资产。 */
const visibleAssets = computed(() => {
  const keyword = assets.query.trim().toLowerCase();
  return assets.items.filter(
    (asset) =>
      (!categoryFilter.value || asset.visual_category === categoryFilter.value) &&
      (!keyword || asset.label.toLowerCase().includes(keyword)),
  );
});

/** 风格锚（copy v2 快照）。 */
const anchors = computed(() => storyboard.styleAnchors);

/** 可绑定为风格锚的图片资产（服务端 `mime_type` 判定）。 */
const imageAssets = computed(() =>
  assets.items.filter((asset) => asset.mime_type.startsWith("image/")),
);

/** 各分类计数（用于筛选按钮）。 */
const categoryCounts = computed(() => {
  const counts: Record<string, number> = { "": assets.items.length };
  for (const asset of assets.items) {
    const key = asset.visual_category ?? "";
    if (key) counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
});

/**
 * 构造资产缩略图地址。
 * @param asset 资产
 * @returns 媒体 URL；非图片或项目缺失时为空串
 */
function thumbUrl(asset: ProjectAsset): string {
  if (!project.value || !asset.mime_type.startsWith("image/")) return "";
  return buildMediaUrl(project.value, asset.relative_path, mediaTicket.value);
}

/**
 * 构造风格锚参考图地址。
 * @param assetPath copy v2 anchor.assetPath
 * @returns 媒体 URL；缺失时为空串
 */
function anchorThumb(assetPath?: string): string {
  if (!project.value || !assetPath) return "";
  return buildMediaUrl(project.value, assetPath, mediaTicket.value);
}

/**
 * 打开资产原文件（新窗口）。
 * @param asset 资产
 */
function openAsset(asset: ProjectAsset): void {
  if (!project.value) return;
  const url = buildMediaUrl(project.value, asset.relative_path, mediaTicket.value);
  if (url) window.open(url, "_blank", "noopener");
}

/** 打开系统文件选择器。 */
function chooseUpload(): void {
  uploadInput.value?.click();
}

/**
 * 上传素材到当前项目。
 * @param event 文件输入事件
 */
async function onUpload(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !currentProjectId.value) return;
  actionError.value = "";
  try {
    const asset = await assets.upload(currentProjectId.value, file);
    message.success(`已上传：${asset.label}`);
    await refresh();
  } catch (error) {
    actionError.value = formatApiError(error);
  }
}

/**
 * 切换项目并同步地址栏查询参数。
 * @param event change 事件
 */
function onProjectChange(event: Event): void {
  const id = (event.target as HTMLSelectElement).value;
  void router.replace({ path: "/assets", query: id ? { projectId: id } : {} });
  currentProjectId.value = id;
}

/** 重新加载资产与风格锚。 */
async function refresh(): Promise<void> {
  if (!currentProjectId.value) return;
  await Promise.all([
    assets.load(currentProjectId.value),
    storyboard.load(currentProjectId.value, true),
  ]);
}

/** 打开风格锚管理模态（无项目时不可用）。 */
function openAnchorManager(): void {
  if (!currentProjectId.value) return;
  manageOpen.value = true;
}

/** 风格锚变更成功后刷新资产与分镜快照。 */
async function onAnchorSaved(): Promise<void> {
  await refresh();
}

/**
 * 根据项目切换装载数据并刷新媒体票据。
 */
async function load(): Promise<void> {
  if (!currentProjectId.value) return;
  actionError.value = "";
  await assets.load(currentProjectId.value).catch((error) => {
    actionError.value = formatApiError(error);
  });
  await storyboard.load(currentProjectId.value, true).catch((error) => {
    console.warn("[web] 风格锚加载失败", error);
  });
  try {
    mediaTicket.value = await getMediaTicket();
  } catch (error) {
    console.warn("[web] 媒体票据获取失败", error);
  }
}

onMounted(async () => {
  try {
    await projectsStore.load();
  } catch (error) {
    actionError.value = formatApiError(error);
  }
  const fromQuery = typeof route.query.projectId === "string" ? route.query.projectId : "";
  currentProjectId.value =
    projectsStore.list.find((item) => item.id === fromQuery)?.id ??
    projectsStore.list[0]?.id ??
    "";
  await load();
});

watch(currentProjectId, () => {
  categoryFilter.value = "";
  void load();
});
</script>

<template>
  <div class="assets-view">
    <header class="page-head">
      <div class="page-head__text">
        <h1 class="page-title">素材库</h1>
        <p class="page-subtitle">项目作用域素材与风格锚；绑定镜头数由 copy v2 计算。</p>
      </div>
      <div class="page-head__actions">
        <select
          class="se-select"
          aria-label="选择项目"
          :value="currentProjectId"
          @change="onProjectChange"
        >
          <option v-for="item in projectsStore.list" :key="item.id" :value="item.id">
            {{ item.name }}
          </option>
        </select>
        <input
          ref="uploadInput"
          class="upload-input"
          type="file"
          accept=".txt,.md,.pdf,.png,.jpg,.jpeg,.webp,.mp3,.wav,.m4a,.ogg,.mp4"
          @change="onUpload"
        />
        <VfButton :disabled="!currentProjectId || assets.uploading" @click="chooseUpload">
          {{ assets.uploading ? "上传中…" : "上传素材" }}
        </VfButton>
      </div>
    </header>

    <p v-if="actionError" class="action-error" role="alert">{{ actionError }}</p>

    <section v-if="projectsStore.list.length === 0" class="empty-state">
      <p class="empty-title">还没有项目</p>
      <p class="empty-desc">先创建项目，素材库会按项目展示上传与生成资产。</p>
      <VfButton @click="router.push('/projects')">去创建项目</VfButton>
    </section>

    <template v-else>
      <!-- 风格锚 banner（只读运营展示） -->
      <section class="anchor-bar" aria-label="风格锚">
        <div class="anchor-bar__head">
          <h2 class="anchor-bar__title">风格锚</h2>
          <VfPill tone="neutral">跨镜头复用</VfPill>
          <VfButton
            variant="ghost"
            :disabled="!currentProjectId"
            title="绑定素材、编辑 seed 或重建锚点"
            @click="openAnchorManager"
          >
            管理锚点
          </VfButton>
        </div>
        <div class="anchor-bar__list">
          <article v-for="anchor in anchors" :key="anchor.key" class="anchor">
            <span class="anchor__thumb">
              <img v-if="anchorThumb(anchor.assetPath)" :src="anchorThumb(anchor.assetPath)" :alt="`风格锚 ${anchor.key}`" />
              <span v-else>{{ anchor.key.slice(0, 2) }}</span>
            </span>
            <div class="anchor__meta">
              <span class="anchor__label">{{ anchor.label ?? anchor.key }}</span>
              <span class="anchor__seed is-mono">seed {{ anchor.seed ?? "—" }}</span>
            </div>
          </article>
          <p v-if="anchors.length === 0" class="anchor-bar__empty">
            该项目尚未定义风格锚（copy v2 `styleAnchors` 为空）。
          </p>
        </div>
      </section>

      <div class="toolbar">
        <nav class="filter-bar" aria-label="素材分类筛选">
          <button
            v-for="option in categoryOptions"
            :key="option.value"
            type="button"
            class="filter-button"
            :class="{ 'is-active': categoryFilter === option.value }"
            :aria-pressed="categoryFilter === option.value"
            @click="categoryFilter = option.value"
          >
            {{ option.label }}
            <span class="filter-count is-mono">{{ categoryCounts[option.value] ?? 0 }}</span>
          </button>
        </nav>
        <input v-model="assets.query" class="search-input" placeholder="搜索文件名" aria-label="搜索素材" />
      </div>

      <p v-if="assets.loading" class="muted">正在加载素材…</p>
      <p v-else-if="visibleAssets.length === 0" class="muted">
        当前筛选下没有素材；可上传文件或等待流水线生成。
      </p>
      <div v-else class="asset-grid">
        <article
          v-for="asset in visibleAssets"
          :key="asset.id"
          class="asset-card"
          role="button"
          tabindex="0"
          :aria-label="`打开素材 ${asset.label}`"
          @click="openAsset(asset)"
          @keydown.enter="openAsset(asset)"
        >
          <div class="asset-card__thumb">
            <img v-if="thumbUrl(asset)" :src="thumbUrl(asset)" :alt="asset.label" loading="lazy" />
            <span v-else class="asset-card__kind is-mono">{{ asset.kind }}</span>
          </div>
          <div class="asset-card__body">
            <span class="asset-card__label" :title="asset.label">{{ asset.label }}</span>
            <span class="asset-card__meta is-mono">
              {{ CATEGORY_LABELS[asset.visual_category ?? ""] ?? asset.kind }}
              · {{ formatBytes(asset.size_bytes) }}
            </span>
            <VfPill :tone="(asset.boundShots ?? 0) > 0 ? 'success' : 'neutral'">
              已绑定 {{ asset.boundShots ?? 0 }} 镜头
            </VfPill>
          </div>
        </article>
      </div>
    </template>

    <StyleAnchorModal
      v-model:open="manageOpen"
      :project="project"
      :anchors="anchors"
      :image-assets="imageAssets"
      :media-ticket="mediaTicket"
      @saved="onAnchorSaved"
    />
  </div>
</template>

<style scoped>
.assets-view {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.page-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-3);
}

.page-head__text {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.page-title {
  margin: 0;
  font-size: var(--font-size-page-title);
  font-weight: var(--font-weight-strong);
  color: var(--text);
}

.page-subtitle {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--text-ter);
}

.page-head__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.se-select,
.search-input {
  height: 36px;
  padding: 0 var(--space-2);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  color: var(--text);
  font-family: inherit;
  font-size: var(--font-size-small);
}

.se-select:focus,
.search-input:focus {
  outline: none;
  border-color: var(--accent);
}

.upload-input {
  display: none;
}

.action-error {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--danger);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-8) var(--space-6);
  background: var(--surface);
  border: 1px dashed var(--border);
  border-radius: var(--radius-card);
}

.empty-title {
  margin: 0;
  font-size: var(--font-size-card-title);
  color: var(--text);
}

.empty-desc {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--text-ter);
}

/* 风格锚 banner */
.anchor-bar {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
}

.anchor-bar__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.anchor-bar__title {
  margin: 0;
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-strong);
  color: var(--text);
}

.anchor-bar__list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.anchor {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2);
  background: var(--surface-2);
  border-radius: var(--radius-control);
}

.anchor__thumb {
  display: flex;
  width: 44px;
  height: 44px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: var(--inset);
  border-radius: var(--radius-control);
  color: var(--text-ter);
  font-size: var(--font-size-caption);
}

.anchor__thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.anchor__meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.anchor__label {
  font-size: var(--font-size-small);
  color: var(--text);
}

.anchor__seed {
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

.anchor-bar__empty {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--text-ter);
}

/* 筛选与搜索 */
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.filter-button {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 32px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--surface);
  color: var(--text-sec);
  font-family: inherit;
  font-size: var(--font-size-small);
  cursor: pointer;
}

.filter-button.is-active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: var(--font-weight-strong);
}

.filter-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.filter-count {
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

.search-input {
  width: 220px;
}

.muted {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--text-ter);
}

/* 卡片网格 */
.asset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--space-3);
}

.asset-card {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  cursor: pointer;
}

.asset-card:hover {
  border-color: var(--accent);
}

.asset-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.asset-card__thumb {
  display: flex;
  aspect-ratio: 16 / 10;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: var(--inset);
}

.asset-card__thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.asset-card__kind {
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

.asset-card__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3) var(--space-3);
}

.asset-card__label {
  overflow: hidden;
  font-size: var(--font-size-small);
  font-weight: var(--font-weight-strong);
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-card__meta {
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

.is-mono {
  font-family: var(--font-mono);
}

@media (max-width: 767.98px) {
  .asset-grid {
    grid-template-columns: 1fr;
  }

  .search-input {
    width: 100%;
  }
}
</style>
