<script setup lang="ts">
/**
 * 管理视图（方案 §8.5 第 10 页，仅 admin）：4 KPI + 用户/项目/Runs/登录日志。
 *
 * 只读监控 + 唯一救援写操作（重置密码）。非 admin 访问由路由守卫与服务端 403 双重拦截。
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
import VfPill from "../components/ui/VfPill.vue";

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

/** 登录日志表列定义。 */
const loginColumns = [
  { title: "时间", dataIndex: "created_at", key: "created_at", width: 170 },
  { title: "用户", dataIndex: "username", key: "username", width: 140 },
  { title: "结果", key: "ok", width: 90 },
  { title: "原因", dataIndex: "reason", key: "reason", width: 150 },
  { title: "IP", dataIndex: "ip", key: "ip", width: 130 },
  { title: "User-Agent", dataIndex: "user_agent", key: "user_agent" },
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
  [
    admin.usersError,
    admin.projectsError,
    admin.runsError,
    admin.overviewError,
    admin.loginError,
  ].some((error) => (error as { code?: string } | null)?.code === "AUTH_FORBIDDEN"),
);

/** 4 个 KPI 卡片（口径固定：成功率 = done/(done+failed)，canceled 不计；T405）。 */
const kpis = computed(() => [
  {
    key: "users",
    label: "注册用户",
    value: admin.overview?.totalUsers ?? "—",
    hint: "全部账号",
  },
  {
    key: "projects",
    label: "项目总数",
    value: admin.overview?.totalProjects ?? "—",
    hint: "全站项目",
  },
  {
    key: "week",
    label: "本周运行",
    value: admin.overview?.runsThisWeek ?? "—",
    hint: "本周一 00:00 起（本地时区）",
  },
  {
    key: "rate",
    label: "运行成功率",
    value:
      admin.overview === null
        ? "—"
        : `${admin.overview.successRate}%`,
    hint: admin.overview?.basis
      ? `done ${admin.overview.basis.doneRuns} / (done+failed) ${admin.overview.basis.completedRuns} · canceled ${admin.overview.basis.canceledRuns ?? 0} 不计`
      : "done / (done + failed)",
  },
]);

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

/** 加载管理数据（KPI + 用户 + 项目 + Runs + 登录日志）。 */
async function loadAll(): Promise<void> {
  await Promise.all([
    admin.loadOverview().catch((error) => console.warn("[web] 管理 KPI 加载失败", error)),
    admin.loadUsers().catch((error) => console.warn("[web] 管理用户列表加载失败", error)),
    admin.loadProjects().catch((error) => console.warn("[web] 管理项目列表加载失败", error)),
    admin.loadRuns().catch((error) => console.warn("[web] 管理 run 列表加载失败", error)),
    admin.loadLoginEvents().catch((error) => console.warn("[web] 登录日志加载失败", error)),
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
 * 跳转某 run 的详情视图（新路由；`admin=1` 表示返回管理页）。
 * @param run run 视图
 */
function goTrace(run: RunSummary): void {
  void router.push(`/projects/${run.project_id}/runs/${run.id}?admin=1`);
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

    <!-- 4 个 KPI -->
    <section v-if="!forbidden" class="kpi-grid" aria-label="管理 KPI">
      <article v-for="kpi in kpis" :key="kpi.key" class="kpi-card">
        <span class="kpi-label">{{ kpi.label }}</span>
        <span class="kpi-value is-mono">{{ kpi.value }}</span>
        <span class="kpi-hint">{{ kpi.hint }}</span>
      </article>
    </section>

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

      <!-- 登录日志 -->
      <a-tab-pane key="logins" tab="登录日志">
        <a-result
          v-if="admin.loginError"
          status="warning"
          title="登录日志加载失败"
          sub-title="请检查服务是否在线后重试"
        >
          <template #extra>
            <a-button type="primary" @click="admin.loadLoginEvents()">重试</a-button>
          </template>
        </a-result>
        <a-table
          v-else
          :data-source="admin.loginEvents"
          :columns="loginColumns"
          :loading="admin.loginLoading"
          row-key="id"
          size="small"
          :scroll="{ x: 'max-content' }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'created_at'">{{
              formatDateTime(record.created_at)
            }}</template>
            <template v-else-if="column.key === 'ok'">
              <VfPill :tone="record.ok ? 'success' : 'danger'">
                {{ record.ok ? "成功" : "失败" }}
              </VfPill>
            </template>
            <template v-else-if="column.key === 'reason'">{{ record.reason ?? "-" }}</template>
            <template v-else-if="column.key === 'ip'">{{ record.ip ?? "-" }}</template>
            <template v-else-if="column.key === 'user_agent'">
              <span class="ua" :title="record.user_agent ?? ''">
                {{ record.user_agent ?? "-" }}
              </span>
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
  font-size: var(--font-size-page-title);
  font-weight: var(--font-weight-strong);
  color: var(--text);
}

/* 4 个 KPI */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.kpi-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-3) var(--space-4);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
}

.kpi-label {
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

.kpi-value {
  font-size: 24px;
  font-weight: var(--font-weight-strong);
  color: var(--text);
}

.kpi-hint {
  font-size: var(--font-size-caption);
  color: var(--text-ter);
}

.admin-filter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.admin-filter-label {
  color: var(--text-sec);
  font-size: var(--font-size-small);
}

.ua {
  display: inline-block;
  max-width: 380px;
  overflow: hidden;
  color: var(--text-ter);
  font-size: var(--font-size-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.is-mono {
  font-family: var(--font-mono);
}
</style>
