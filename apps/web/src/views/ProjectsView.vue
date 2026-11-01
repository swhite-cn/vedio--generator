<script setup lang="ts">
/**
 * 项目列表（Web 专题 §5.2）：页头 + 卡片栅格（每行 3 张、窄屏 1 张）。
 * 卡片展示能力 Tag、状态 Tag、更新时间与成片就绪标记；整卡点击进工作台。
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import dayjs from "dayjs";
import { useProjectsStore, type Project } from "../stores/projects";
import { useCapabilitiesStore } from "../stores/capabilities";
import StateTag from "../components/StateTag.vue";
import NewProjectModal from "../components/NewProjectModal.vue";

const projectsStore = useProjectsStore();
const capabilitiesStore = useCapabilitiesStore();
const router = useRouter();

/** 新建项目 Modal 开关。 */
const newProjectOpen = ref(false);

/**
 * 加载项目列表与能力列表（能力列表用于展示所属能力名）。
 */
async function loadData(): Promise<void> {
  // 能力列表加载失败不影响项目列表展示，仅回退展示能力 id
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
 * 统一格式化时间。
 * @param value ISO 时间串
 * @returns `YYYY-MM-DD HH:mm:ss` 文案
 */
function formatTime(value: string): string {
  return dayjs(value).format("YYYY-MM-DD HH:mm:ss");
}

/**
 * 打开项目工作台（`/projects/:id` 视图属 P11-B）。
 * @param project 目标项目
 */
function openProject(project: Project): void {
  void router.push(`/projects/${project.id}`);
}

/**
 * 项目创建成功：跳转工作台。
 * @param project 新建的项目
 */
function onProjectCreated(project: Project): void {
  void router.push(`/projects/${project.id}`);
}

onMounted(() => {
  void loadData();
});
</script>

<template>
  <div class="projects-view">
    <div class="page-header">
      <h1 class="page-title">项目</h1>
      <a-button type="primary" @click="newProjectOpen = true">新建项目</a-button>
    </div>

    <a-result
      v-if="projectsStore.error"
      status="warning"
      title="项目列表加载失败"
      sub-title="请检查服务是否在线后重试"
    >
      <template #extra>
        <a-button type="primary" @click="loadData">重试</a-button>
      </template>
    </a-result>

    <a-skeleton v-else-if="projectsStore.loading && projectsStore.list.length === 0" active />

    <a-empty
      v-else-if="projectsStore.list.length === 0"
      description="从能力中心挑选一个能力开始，或直接新建项目"
    >
      <a-button type="primary" @click="newProjectOpen = true">新建项目</a-button>
    </a-empty>

    <a-row v-else :gutter="[16, 16]">
      <a-col v-for="project in projectsStore.list" :key="project.id" :xs="24" :sm="12" :md="8">
        <a-card
          hoverable
          class="project-card"
          role="button"
          tabindex="0"
          :aria-label="`打开项目 ${project.name}`"
          @click="openProject(project)"
          @keydown.enter="openProject(project)"
        >
          <template #title>{{ project.name }}</template>
          <template #extra>
            <a-tag color="blue">{{ capabilityName(project.capability_id) }}</a-tag>
          </template>

          <a-tooltip :title="project.topic">
            <p class="project-topic">{{ project.topic }}</p>
          </a-tooltip>

          <div class="project-meta">
            <state-tag type="project" :status="project.status" />
            <span class="project-updated">{{ formatTime(project.updated_at) }}</span>
          </div>

          <div v-if="project.status === 'done'" class="project-ready" aria-label="成片就绪">
            ▶ 成片就绪
          </div>
        </a-card>
      </a-col>
    </a-row>

    <new-project-modal v-model:open="newProjectOpen" @created="onProjectCreated" />
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
}

.page-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
}

.project-card {
  height: 100%;
  cursor: pointer;
}

.project-topic {
  margin: 0 0 12px;
  color: rgb(0 0 0 / 65%);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.project-updated {
  color: rgb(0 0 0 / 45%);
  font-size: 13px;
}

.project-ready {
  margin-top: 8px;
  color: #52c41a;
  font-weight: 600;
}
</style>
