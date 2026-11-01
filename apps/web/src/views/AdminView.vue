<script setup lang="ts">
/**
 * 管理视图（Web 专题 §5.6，仅 admin）：全站只读监控 + 唯一救援写操作（重置密码）。
 *
 * 三 Tab：用户（可重置密码）、项目（只读，可按状态筛选）、Runs（只读，可按状态/错误码筛选，
 * 行内「Trace」跳 run Trace 视图）。非 admin 越权时服务端返回 `AUTH_FORBIDDEN`，页面渲染 `Result 403`。
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { message } from "ant-design-vue";
import { useAdminStore, type AdminUser } from "../stores/admin";
import { useCapabilitiesStore } from "../stores/capabilities";
import type { Project } from "../stores/projects";
import type { RunSummary } from "../stores/workbench-reducer";
import { formatApiError } from "../services/api";
import { formatDateTime, formatElapsed } from "../components/format";
import { mapProjectStatus, mapRunStatus } from "../components/state-mapping";
import StateTag from "../components/StateTag.vue";

const router = useRouter();
const admin = useAdminStore();
const capabilities = useCapabilitiesStore();

/** 当前 Tab。 */
const activeTab = ref("users");
/** 项目 Tab 的状态筛选（空串表示不限）。 */
const projectStatusFilter = ref("");
/** Runs Tab 的状态筛选（空串表示不限）。 */
const runStatusFilter = ref("");
/** Runs Tab 的错误码模糊筛选。 */
const runErrorCodeFilter = ref("");

/** 正在重置密码的用户 id（控制对应 Popconfirm 展开）。 */
const resetTargetId = ref("");
/** 重置密码输入框内容。 */
const resetPassword = ref("");

/** 用户表列定义。 */
const userColumns = [
  { title: "用户名", dataIndex: "username", key: "username" },
  { title: "显示名", dataIndex: "display_name", key: "display_name" },
  { title: "角色", dataIndex: "role", key: "role", width: 90 },
  { title: "注册时间", dataIndex: "created_at", key: "created_at", width: 180 },
  { title: "最近登录", dataIndex: "last_login_at", key: "last_login_at", width: 180 },
  { title: "操作", key: "action", width: 120 },
];

/** 项目表列定义。 */
const projectColumns = [
  { title: "属主", dataIndex: "user_id", key: "user_id" },
  { title: "名称", dataIndex: "name", key: "name" },
  { title: "能力", dataIndex: "capability_id", key: "capability_id" },
  { title: "主题", dataIndex: "topic", key: "topic" },
  { title: "状态", dataIndex: "status", key: "status", width: 100 },
  { title: "更新时间", dataIndex: "updated_at", key: "updated_at", width: 180 },
];

/** Runs 表列定义。 */
const runColumns = [
  { title: "Run ID", dataIndex: "id", key: "id" },
  { title: "项目", key: "project", width: 160 },
  { title: "属主", key: "owner", width: 160 },
  { title: "状态", dataIndex: "status", key: "status", width: 100 },
  { title: "errorCode", dataIndex: "error_code", key: "error_code", width: 140 },
  { title: "创建时间", dataIndex: "created_at", key: "created_at", width: 180 },
  { title: "耗时", key: "elapsed", width: 90 },
  { title: "操作", key: "trace", width: 90 },
];

/** 状态筛选选项（项目 5 态）。 */
const projectStatusOptions = ["draft", "running", "review", "done", "failed"].map((value) => ({
  value,
  label: mapProjectStatus(value).text,
}));

/** 状态筛选选项（run 6 态）。 */
const runStatusOptions = ["queued", "running", "waiting_review", "done", "failed", "canceled"].map(
  (value) => ({
    value,
    label: mapRunStatus(value).text,
  }),
);

/** 任一 admin 请求返回 403 时整页渲染越权提示。 */
const forbidden = computed(() =>
  [admin.usersError, admin.projectsError, admin.runsError].some(
    (error) => (error as { code?: string } | null)?.code === "AUTH_FORBIDDEN",
  ),
);

/** 项目 id → 项目（用于 Runs 表联表展示项目名与属主）。 */
const projectById = computed(() => {
  const map = new Map<string, Project>();
  for (const project of admin.projects) {
    map.set(project.id, project);
  }
  return map;
});

/** 项目 Tab 展示数据（按状态筛选，客户端过滤）。 */
const filteredProjects = computed(() =>
  projectStatusFilter.value
    ? admin.projects.filter((project) => project.status === projectStatusFilter.value)
    : admin.projects,
);

/** 取能力中文名（未命中回退能力 id）。 */
function capabilityName(capabilityId: string): string {
  return capabilities.findById(capabilityId)?.name ?? capabilityId;
}

/** 加载管理数据（用户 + 项目 + Runs）。 */
async function loadAll(): Promise<void> {
  await Promise.all([
    admin.loadUsers().catch((error) => console.warn("[web] 管理用户列表加载失败", error)),
    admin.loadProjects().catch((error) => console.warn("[web] 管理项目列表加载失败", error)),
    admin.loadRuns().catch((error) => console.warn("[web] 管理 run 列表加载失败", error)),
  ]);
  try {
    await capabilities.load();
  } catch (error) {
    console.warn("[web] 能力列表加载失败，管理视图回退展示能力 id", error);
  }
}

/** 按当前筛选条件重拉 run 列表。 */
async function reloadRuns(): Promise<void> {
  try {
    await admin.loadRuns({
      status: runStatusFilter.value,
      errorCode: runErrorCodeFilter.value,
    });
  } catch (error) {
    console.warn("[web] 管理 run 列表加载失败", error);
  }
}

/**
 * 展开某行的重置密码确认框。
 * @param user 目标用户
 */
function startReset(user: AdminUser): void {
  resetTargetId.value = user.id;
  resetPassword.value = "";
}

/** 关闭重置密码确认框。 */
function cancelReset(): void {
  resetTargetId.value = "";
  resetPassword.value = "";
}

/**
 * 确认重置密码。
 * @param user 目标用户
 */
async function confirmReset(user: AdminUser): Promise<void> {
  if (resetPassword.value.length === 0) return;
  try {
    await admin.resetPassword(user.id, resetPassword.value);
    message.success("已重置，该用户下次登录需改密");
    cancelReset();
    await admin.loadUsers().catch(() => undefined);
  } catch (error) {
    message.error(formatApiError(error));
  }
}

/**
 * 跳转某 run 的 Trace 视图（携带 `admin=1` 以走管理数据源）。
 * @param run run 视图
 */
function goTrace(run: RunSummary): void {
  void router.push(`/runs/${run.id}/trace?admin=1`);
}

onMounted(() => {
  void loadAll();
});

// 筛选条件变化时重拉 run 列表
watch([runStatusFilter, runErrorCodeFilter], () => {
  void reloadRuns();
});
</script>

<template>
  <div class="admin-view">
    <header class="page-header">
      <h1 class="page-title">管理</h1>
      <a-button @click="loadAll">刷新</a-button>
    </header>

    <a-result v-if="forbidden" status="403" title="没有权限查看该内容" />

    <a-tabs v-else v-model:activeKey="activeTab">
      <!-- 用户 -->
      <a-tab-pane key="users" tab="用户">
        <a-result
          v-if="admin.usersError"
          status="warning"
          title="用户列表加载失败"
          sub-title="请检查服务是否在线后重试"
        >
          <template #extra
            ><a-button type="primary" @click="admin.loadUsers()">重试</a-button></template
          >
        </a-result>
        <a-table
          v-else
          :data-source="admin.users"
          :columns="userColumns"
          :loading="admin.usersLoading"
          row-key="id"
          size="small"
          :scroll="{ x: 'max-content' }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'role'">
              <a-tag :color="record.role === 'admin' ? 'gold' : 'default'">
                {{ record.role === "admin" ? "管理员" : "用户" }}
              </a-tag>
            </template>
            <template v-else-if="column.key === 'created_at'">{{
              formatDateTime(record.created_at)
            }}</template>
            <template v-else-if="column.key === 'last_login_at'">
              {{ formatDateTime(record.last_login_at) }}
            </template>
            <template v-else-if="column.key === 'action'">
              <a-popconfirm
                :open="resetTargetId === record.id"
                title="重置该用户密码？"
                ok-text="确认重置"
                cancel-text="取消"
                :ok-button-props="{ disabled: resetPassword.length === 0 }"
                @confirm="confirmReset(record)"
                @cancel="cancelReset"
              >
                <template #description>
                  <a-input-password
                    v-model:value="resetPassword"
                    placeholder="输入新的初始密码"
                    aria-label="新密码"
                  />
                </template>
                <a-button size="small" @click="startReset(record)">重置密码</a-button>
              </a-popconfirm>
            </template>
          </template>
        </a-table>
      </a-tab-pane>

      <!-- 项目 -->
      <a-tab-pane key="projects" tab="项目">
        <div class="admin-filter">
          <span class="admin-filter-label">状态：</span>
          <a-select
            v-model:value="projectStatusFilter"
            :options="[{ value: '', label: '全部' }, ...projectStatusOptions]"
            style="width: 140px"
            aria-label="按状态筛选项目"
          />
        </div>
        <a-result
          v-if="admin.projectsError"
          status="warning"
          title="项目列表加载失败"
          sub-title="请检查服务是否在线后重试"
        >
          <template #extra
            ><a-button type="primary" @click="admin.loadProjects()">重试</a-button></template
          >
        </a-result>
        <a-table
          v-else
          :data-source="filteredProjects"
          :columns="projectColumns"
          :loading="admin.projectsLoading"
          row-key="id"
          size="small"
          :scroll="{ x: 'max-content' }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'capability_id'">{{
              capabilityName(record.capability_id)
            }}</template>
            <template v-else-if="column.key === 'status'">
              <state-tag type="project" :status="record.status" />
            </template>
            <template v-else-if="column.key === 'updated_at'">{{
              formatDateTime(record.updated_at)
            }}</template>
          </template>
        </a-table>
      </a-tab-pane>

      <!-- Runs -->
      <a-tab-pane key="runs" tab="Runs">
        <div class="admin-filter">
          <span class="admin-filter-label">状态：</span>
          <a-select
            v-model:value="runStatusFilter"
            :options="[{ value: '', label: '全部' }, ...runStatusOptions]"
            style="width: 140px"
            aria-label="按状态筛选 Runs"
          />
          <span class="admin-filter-label">errorCode：</span>
          <a-input
            v-model:value="runErrorCodeFilter"
            placeholder="模糊匹配"
            style="width: 180px"
            aria-label="按 errorCode 筛选 Runs"
          />
        </div>
        <a-result
          v-if="admin.runsError"
          status="warning"
          title="Runs 列表加载失败"
          sub-title="请检查服务是否在线后重试"
        >
          <template #extra><a-button type="primary" @click="reloadRuns">重试</a-button></template>
        </a-result>
        <a-table
          v-else
          :data-source="admin.runs"
          :columns="runColumns"
          :loading="admin.runsLoading"
          row-key="id"
          size="small"
          :scroll="{ x: 'max-content' }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'project'">
              {{ projectById.get(record.project_id)?.name ?? record.project_id }}
            </template>
            <template v-else-if="column.key === 'owner'">
              {{ projectById.get(record.project_id)?.user_id ?? "-" }}
            </template>
            <template v-else-if="column.key === 'status'">
              <state-tag type="run" :status="record.status" :error-code="record.error_code" />
            </template>
            <template v-else-if="column.key === 'error_code'">{{
              record.error_code ?? "-"
            }}</template>
            <template v-else-if="column.key === 'created_at'">{{
              formatDateTime(record.created_at)
            }}</template>
            <template v-else-if="column.key === 'elapsed'">
              {{ formatElapsed(record.started_at, record.ended_at) }}
            </template>
            <template v-else-if="column.key === 'trace'">
              <a-button size="small" @click="goTrace(record)">Trace</a-button>
            </template>
          </template>
        </a-table>
      </a-tab-pane>
    </a-tabs>
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.page-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
}

.admin-filter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.admin-filter-label {
  color: rgb(0 0 0 / 65%);
  font-size: 13px;
}
</style>
