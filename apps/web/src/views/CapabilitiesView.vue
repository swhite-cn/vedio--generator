<script setup lang="ts">
/**
 * 能力中心（方案 §8.5 第 2 页 / SKILL #2，默认首页 `/`）。
 *
 * - 主能力卡：阶段 chips、参考片基线 meta、已创建项目数、创建项目入口、工作流说明；
 * - 即将上线区：3 张禁用态卡（抖音短视频 / 小说推文 / 产品宣传），不进流水线；
 * - 最近运行表：项目 / Run / 镜头数 / 状态 / 耗时 / 时间，全部来自服务端字段
 *   （`GET /api/projects` 的派生指标与 latestRun）；前端只做展示格式化，不推导状态机。
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useCapabilitiesStore, type Capability } from "../stores/capabilities";
import { useProjectsStore, type Project } from "../stores/projects";
import {
  formatDateTime,
  formatElapsed,
  mapRunStatus,
  statusTone,
} from "../components/state-mapping";
import CapabilityCard from "../components/CapabilityCard.vue";
import NewProjectModal from "../components/NewProjectModal.vue";
import VfCard from "../components/ui/VfCard.vue";
import VfPill from "../components/ui/VfPill.vue";
import VfButton from "../components/ui/VfButton.vue";

const capabilitiesStore = useCapabilitiesStore();
const projectsStore = useProjectsStore();
const router = useRouter();

/** 新建项目 Modal 开关。 */
const newProjectOpen = ref(false);
/** 预选能力 id。 */
const initialCapabilityId = ref("");
/** 工作流说明展开态。 */
const workflowOpen = ref(false);
/** 项目列表加载失败（不影响能力卡展示）。 */
const projectsError = ref(false);

/** 即将上线能力（设计稿固定 3 项，仅禁用态展示，不代表已注册能力）。 */
const UPCOMING = [
  { id: "douyin", name: "抖音短视频", detail: "竖屏强节奏剪辑，适配平台发布节奏" },
  { id: "novel", name: "小说推文", detail: "长文本拆条，按章节点组织镜头" },
  { id: "product", name: "产品宣传", detail: "卖点脚本 + 数据卡，面向商品页与投放" },
] as const;

/** 主能力（服务端返回的第一条；缺失时展示空态）。 */
const primaryCapability = computed<Capability | undefined>(() => capabilitiesStore.list[0]);

/** 该能力下的项目数（服务端列表计数，非本地推导）。 */
const projectCount = computed(() =>
  projectsStore.list.filter(
    (project) => project.capability_id === primaryCapability.value?.id,
  ).length,
);

/** 最近运行：按 latestRun.created_at 倒序取前 6 条（无 run 的项目不出现）。 */
const recentRuns = computed(() => {
  const rows = projectsStore.list
    .filter((project): project is Project & { latestRun: NonNullable<Project["latestRun"]> } =>
      Boolean(project.latestRun),
    )
    .map((project) => ({ project, run: project.latestRun }));
  return rows.sort((a, b) => b.run.created_at.localeCompare(a.run.created_at)).slice(0, 6);
});

/**
 * 加载能力与项目列表：两者独立容错（项目失败只影响计数与最近运行表）。
 */
async function loadData(): Promise<void> {
  projectsError.value = false;
  const results = await Promise.allSettled([
    capabilitiesStore.load(true),
    projectsStore.load(),
  ]);
  if (results[1]?.status === "rejected") {
    projectsError.value = true;
    console.warn("[web] 能力中心加载项目列表失败", results[1].reason);
  }
}

/** 打开新建项目 Modal（预选主能力）。 */
function onCreate(): void {
  initialCapabilityId.value = primaryCapability.value?.id ?? "";
  newProjectOpen.value = true;
}

/**
 * 项目创建成功：跳转该项目工作台。
 * @param project 新建的项目
 */
function onProjectCreated(project: Project): void {
  void router.push(`/projects/${project.id}`);
}

/** 最近运行表中点击项目名跳工作台。 */
function openProject(projectId: string): void {
  void router.push(`/projects/${projectId}`);
}

onMounted(() => {
  void loadData();
});
</script>

<template>
  <div class="capabilities-view">
    <header class="page-head">
      <h1 class="page-title">能力中心</h1>
      <p class="page-subtitle">每个能力是一条完整工作流；选择能力，创建项目后自动开跑。</p>
    </header>

    <!-- 主能力区 -->
    <section class="section" aria-labelledby="available-title">
      <h2 id="available-title" class="section-title">可用能力</h2>

      <p v-if="capabilitiesStore.error" class="section-error">
        能力列表加载失败，请检查服务是否在线。
        <button type="button" class="link-button" @click="loadData">重试</button>
      </p>
      <p v-else-if="capabilitiesStore.loading && !primaryCapability" class="section-muted">
        正在加载能力…
      </p>
      <p v-else-if="!primaryCapability" class="section-muted">暂无可用能力，请联系管理员。</p>

      <CapabilityCard
        v-else
        :capability="primaryCapability"
        :project-count="projectCount"
        :workflow-open="workflowOpen"
        @create="onCreate"
        @toggle-workflow="workflowOpen = !workflowOpen"
      />
    </section>

    <!-- 即将上线区 -->
    <section class="section" aria-labelledby="upcoming-title">
      <h2 id="upcoming-title" class="section-title">即将上线</h2>
      <div class="upcoming-grid">
        <article v-for="item in UPCOMING" :key="item.id" class="upcoming-card">
          <header class="upcoming-head">
            <h3 class="upcoming-title">{{ item.name }}</h3>
            <VfPill tone="neutral">即将上线</VfPill>
          </header>
          <p class="upcoming-detail">{{ item.detail }}</p>
        </article>
      </div>
    </section>

    <!-- 最近运行 -->
    <section class="section" aria-labelledby="recent-title">
      <VfCard>
        <header class="recent-head">
          <h2 id="recent-title" class="section-title">最近运行</h2>
          <VfButton variant="ghost" @click="router.push('/projects')">全部项目</VfButton>
        </header>

        <p v-if="projectsError" class="section-error">项目列表加载失败，最近运行暂不可用。</p>
        <p v-else-if="recentRuns.length === 0" class="section-muted">
          还没有运行记录；创建项目后首个 run 会自动出现在这里。
        </p>

        <table v-else class="run-table">
          <thead>
            <tr>
              <th scope="col">项目</th>
              <th scope="col">Run</th>
              <th scope="col" class="is-num">镜头数</th>
              <th scope="col">状态</th>
              <th scope="col">耗时</th>
              <th scope="col">时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="{ project, run } in recentRuns" :key="run.id">
              <td>
                <button
                  type="button"
                  class="link-button"
                  :aria-label="`打开项目 ${project.name}`"
                  @click="openProject(project.id)"
                >
                  {{ project.name }}
                </button>
              </td>
              <td class="is-mono">{{ run.id.slice(0, 8) }}</td>
              <td class="is-num is-mono">{{ project.shotCount ?? "—" }}</td>
              <td>
                <VfPill :tone="statusTone(mapRunStatus(run.status, run.error_code).color)">
                  {{ mapRunStatus(run.status, run.error_code).text }}
                </VfPill>
              </td>
              <td class="is-mono">{{ formatElapsed(run.started_at, run.ended_at) }}</td>
              <td class="is-mono">{{ formatDateTime(run.created_at) }}</td>
            </tr>
          </tbody>
        </table>
      </VfCard>
    </section>

    <NewProjectModal
      v-model:open="newProjectOpen"
      :initial-capability-id="initialCapabilityId"
      @created="onProjectCreated"
    />
  </div>
</template>

<style scoped>
.capabilities-view {
  display: flex;
  flex-direction: column;
  gap: var(--space-7);
}

.page-head {
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

.section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.section-title {
  margin: 0;
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-strong);
  color: var(--text);
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
  text-align: start;
}

.link-button:hover {
  text-decoration: underline;
}

.link-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-control);
}

/* 即将上线：禁用态卡片（低对比、无交互） */
.upcoming-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--space-4);
}

.upcoming-card {
  padding: var(--space-4);
  background: var(--surface);
  border: 1px dashed var(--border);
  border-radius: var(--radius-card);
  opacity: 0.6;
}

.upcoming-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.upcoming-title {
  margin: 0;
  font-size: var(--font-size-card-title);
  font-weight: var(--font-weight-strong);
  color: var(--text);
}

.upcoming-detail {
  margin: 0;
  font-size: var(--font-size-small);
  line-height: var(--line-height-body);
  color: var(--text-ter);
}

/* 最近运行表：技术列（Run/镜头/耗时/时间）用等宽字体 */
.recent-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.run-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-size-small);
  color: var(--text-sec);
}

.run-table th {
  padding: var(--space-2) var(--space-3);
  border-block-end: 1px solid var(--border-soft);
  font-weight: var(--font-weight-strong);
  font-size: var(--font-size-caption);
  color: var(--text-ter);
  text-align: start;
}

.run-table td {
  padding: var(--space-2) var(--space-3);
  border-block-end: 1px solid var(--border-soft);
  color: var(--text);
}

.run-table tr:last-child td {
  border-block-end: 0;
}

.run-table .is-num {
  text-align: end;
}

.run-table .is-mono {
  font-family: var(--font-mono);
  font-size: var(--font-size-caption);
  color: var(--text-sec);
}

/* 窄屏：横向滚动表格，避免挤压列 */
@media (max-width: 767.98px) {
  .recent-head {
    flex-wrap: wrap;
  }

  .run-table {
    display: block;
    overflow-x: auto;
    white-space: nowrap;
  }
}
</style>
