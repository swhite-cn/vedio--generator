<script setup lang="ts">
/**
 * 能力中心（Web 专题 §5.3）：只读展示平台能力注册表，每行 2 张卡片、窄屏 1 张。
 * 失败展示 `a-result` + 重试；空态展示 `a-empty`。
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useCapabilitiesStore, type Capability } from "../stores/capabilities";
import type { Project } from "../stores/projects";
import CapabilityCard from "../components/CapabilityCard.vue";
import NewProjectModal from "../components/NewProjectModal.vue";

const capabilitiesStore = useCapabilitiesStore();
const router = useRouter();

/** 新建项目 Modal 开关。 */
const newProjectOpen = ref(false);
/** 预选能力 id（来自「使用此能力」）。 */
const initialCapabilityId = ref("");

/**
 * 加载能力列表（失败时记录错误供 `a-result` 展示）。
 */
async function loadCapabilities(): Promise<void> {
  try {
    await capabilitiesStore.load(true);
  } catch (error) {
    console.warn("[web] 能力中心加载失败", error);
  }
}

/**
 * 点击「使用此能力」：打开新建项目 Modal 并预选该能力。
 * @param capability 选中的能力
 */
function onUseCapability(capability: Capability): void {
  initialCapabilityId.value = capability.id;
  newProjectOpen.value = true;
}

/**
 * 项目创建成功：跳转工作台（`/projects/:id` 视图属 P11-B）。
 * @param project 新建的项目
 */
function onProjectCreated(project: Project): void {
  void router.push(`/projects/${project.id}`);
}

onMounted(() => {
  void loadCapabilities();
});
</script>

<template>
  <div class="capabilities-view">
    <div class="page-header">
      <h1 class="page-title">能力中心</h1>
      <p class="page-subtitle">每个能力是一条完整的工作流；选择能力，创建项目</p>
    </div>

    <a-result
      v-if="capabilitiesStore.error"
      status="warning"
      title="能力列表加载失败"
      sub-title="请检查服务是否在线后重试"
    >
      <template #extra>
        <a-button type="primary" @click="loadCapabilities">重试</a-button>
      </template>
    </a-result>

    <a-skeleton
      v-else-if="capabilitiesStore.loading && capabilitiesStore.list.length === 0"
      active
    />

    <a-empty
      v-else-if="capabilitiesStore.list.length === 0"
      description="暂无可用能力，请联系管理员"
    />

    <a-row v-else :gutter="[16, 16]">
      <a-col v-for="capability in capabilitiesStore.list" :key="capability.id" :xs="24" :md="12">
        <capability-card :capability="capability" @use="onUseCapability" />
      </a-col>
    </a-row>

    <new-project-modal
      v-model:open="newProjectOpen"
      :initial-capability-id="initialCapabilityId"
      @created="onProjectCreated"
    />
  </div>
</template>

<style scoped>
.page-header {
  margin-bottom: 24px;
}

.page-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
}

.page-subtitle {
  margin: 4px 0 0;
  color: rgb(0 0 0 / 45%);
}
</style>
