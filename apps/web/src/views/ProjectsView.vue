<script setup lang="ts">
/**
 * 项目列表（方案 §8.5 第 4 页）：页头 + 筛选 + 卡片网格。
 *
 * - 卡片展示名称、主题摘要、创建时间、镜头数 · 总时长、状态 pill、最终产物/进度/重试；
 * - 筛选 全部/进行中/已完成/失败；按最近更新倒序；
 * - 状态、进度全部来自服务端字段（`GET /api/projects`，T116），前端只做展示与分组。
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useProjectsStore, type Project } from "../stores/projects";
import { useCapabilitiesStore } from "../stores/capabilities";
import { apiRequest, formatApiError } from "../services/api";
import {
  PROJECT_FILTERS,
  countProjectFilters,
  filterProjects,
  sortProjectsByUpdatedAt,
  type ProjectFilter,
} from "../components/project-filter";
import ProjectCard from "../components/ProjectCard.vue";
import NewProjectModal from "../components/NewProjectModal.vue";
import VfButton from "../components/ui/VfButton.vue";

const projectsStore = useProjectsStore();
const capabilitiesStore = useCapabilitiesStore();
const router = useRouter();

/** 新建项目 Modal 开关。 */
const newProjectOpen = ref(false);
/** 当前筛选档位。 */
const filter = ref<ProjectFilter>("all");
/** 正在重试的项目 id（按钮禁用态）。 */
const retryingId = ref<string | null>(null);
/** 重试等操作的行内错误文案。 */
const actionError = ref("");

/** 按最近更新倒序排列的项目（不修改 store 原始顺序）。 */
const sortedProjects = computed(() => sortProjectsByUpdatedAt(projectsStore.list));

/** 当前筛选下可见的项目。 */
const visibleProjects = computed(() => filterProjects(sortedProjects.value, filter.value));

/** 各筛选档位的项目计数。 */
const filterCounts = computed(() => countProjectFilters(projectsStore.list));

/**
 * 加载项目列表与能力列表；能力失败只影响卡片上的能力名展示。
 */
async function loadData(): Promise<void> {
  actionError.value = "";
  if (!capabilitiesStore.loaded) {
    try {
      await capabilitiesStore.load();
    } catch (error) {
      console.warn("[web] 能力列表加载失败，项目卡片回退展示能力 id", error);
    }
  }
  try {
    await projectsStore.load();
  } catch (error) {
    console.warn("[web] 项目列表加载失败", error);
  }
}

/**
 * 取能力中文名，未命中时回退能力 id。
 * @param capabilityId 能力 id
 * @returns 展示用能力名
 */
function capabilityName(capabilityId: string): string {
  return capabilitiesStore.findById(capabilityId)?.name ?? capabilityId;
}

/**
 * 打开项目工作台。
 * @param projectId 项目 id
 */
function openProject(projectId: string): void {
  void router.push(`/projects/${projectId}`);
}

/**
 * 新建成功：跳转工作台（服务端已自动触发首个 run）。
 * @param project 新建的项目
 */
function onProjectCreated(project: Project): void {
  void router.push(`/projects/${project.id}`);
}

/**
 * 失败项目重试：建立新 run 并从断点续跑，然后刷新列表状态。
 * @param projectId 项目 id
 */
async function retryProject(projectId: string): Promise<void> {
  retryingId.value = projectId;
  actionError.value = "";
  try {
    await apiRequest(`/api/projects/${encodeURIComponent(projectId)}/runs`, { method: "POST" });
    await projectsStore.load();
  } catch (error) {
    actionError.value = formatApiError(error);
  } finally {
    retryingId.value = null;
  }
}

onMounted(() => {
  void loadData();
});
</script>

<template>
  <div class="projects-view">
    <header class="page-head">
      <div class="page-head__text">
        <h1 class="page-title">项目</h1>
        <p class="page-subtitle">
          共 {{ projectsStore.list.length }} 个项目，按最近更新排序。
        </p>
      </div>
      <VfButton @click="newProjectOpen = true">新建项目</VfButton>
    </header>

    <nav class="filter-bar" aria-label="项目筛选">
      <button
        v-for="item in PROJECT_FILTERS"
        :key="item.value"
        type="button"
        class="filter-button"
        :class="{ 'is-active': filter === item.value }"
        :aria-pressed="filter === item.value"
        @click="filter = item.value"
      >
        {{ item.label }}
        <span class="filter-count is-mono">{{ filterCounts[item.value] }}</span>
      </button>
    </nav>

    <p v-if="actionError" class="action-error" role="alert">{{ actionError }}</p>

    <p v-if="projectsStore.error" class="section-error">
      项目列表加载失败，请检查服务是否在线。
      <button type="button" class="link-button" @click="loadData">重试</button>
    </p>

    <p v-else-if="projectsStore.loading && projectsStore.list.length === 0" class="section-muted">
      正在加载项目…
    </p>

    <section v-else-if="projectsStore.list.length === 0" class="empty-state">
      <p class="empty-title">还没有项目</p>
      <p class="empty-desc">从能力中心挑选一个能力开始，或直接新建项目。</p>
      <VfButton @click="newProjectOpen = true">新建项目</VfButton>
    </section>

    <p v-else-if="visibleProjects.length === 0" class="section-muted">
      当前筛选下没有项目。
    </p>

    <div v-else class="project-grid">
      <ProjectCard
        v-for="project in visibleProjects"
        :key="project.id"
        :project="project"
        :capability-name="capabilityName(project.capability_id)"
        :retrying="retryingId === project.id"
        @open="openProject"
        @retry="retryProject"
      />
    </div>

    <NewProjectModal v-model:open="newProjectOpen" @created="onProjectCreated" />
  </div>
</template>

<style scoped>
.projects-view {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
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

/* 筛选条：胶囊按钮，选中态用强调色软底 */
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.filter-button {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 32px;
  padding: 0 var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--surface);
  color: var(--text-sec);
  font-family: inherit;
  font-size: var(--font-size-small);
  cursor: pointer;
  transition: border-color var(--motion-fast) ease;
}

.filter-button:hover {
  border-color: var(--accent);
}

.filter-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.filter-button.is-active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: var(--font-weight-strong);
}

.filter-count {
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

.filter-button.is-active .filter-count {
  color: var(--accent);
}

.action-error {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--danger);
}

.section-muted {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--text-ter);
}

.section-error {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--danger);
}

.link-button {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: var(--font-size-small);
  cursor: pointer;
}

.link-button:hover {
  text-decoration: underline;
}

.link-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* 空态 */
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
  font-weight: var(--font-weight-strong);
  color: var(--text);
}

.empty-desc {
  margin: 0;
  font-size: var(--font-size-small);
  color: var(--text-ter);
}

/* 卡片网格：桌面 3 列，窄屏 1 列（方案 §8.5） */
.project-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--space-4);
  align-items: stretch;
}

@media (max-width: 767.98px) {
  .project-grid {
    grid-template-columns: 1fr;
  }
}

.is-mono {
  font-family: var(--font-mono);
}
</style>
