/**
 * 管理 store（Web 专题 §5.6、§7.1）。
 *
 * 职责：admin 视角的三个只读列表（用户 / 项目 / Runs）与唯一写操作「重置密码」。
 * 所有路径走 `/api/admin/*`；非 admin 调用会被服务端拒绝（`AUTH_FORBIDDEN`），
 * 由页面渲染 `Result 403`。响应体不含任何口令明文或密码哈希。
 */
import { ref } from "vue";
import { defineStore } from "pinia";
import { apiRequest } from "../services/api";
import type { Project } from "./projects";
import type { RunSummary } from "./workbench-reducer";

/** 服务端对外用户视图（`GET /api/admin/users` 元素，与 `GET /api/auth/me` 同形）。 */
export interface AdminUser {
  id: string;
  username: string;
  display_name: string;
  role: string;
  must_change_password: boolean;
  created_at?: string;
  last_login_at?: string | null;
}

/** Runs 列表筛选条件。 */
export interface AdminRunFilter {
  /** run 状态（空串表示不限）。 */
  status?: string;
  /** 错误码模糊匹配（空串表示不限）。 */
  errorCode?: string;
}

export const useAdminStore = defineStore("admin", () => {
  const users = ref<AdminUser[]>([]);
  const projects = ref<Project[]>([]);
  const runs = ref<RunSummary[]>([]);

  const usersLoading = ref(false);
  const projectsLoading = ref(false);
  const runsLoading = ref(false);

  const usersError = ref<unknown>(null);
  const projectsError = ref<unknown>(null);
  const runsError = ref<unknown>(null);

  /** 加载全站用户列表。 */
  async function loadUsers(): Promise<void> {
    usersLoading.value = true;
    usersError.value = null;
    try {
      const result = await apiRequest<{ users: AdminUser[] }>("/api/admin/users");
      users.value = result.users;
      console.info(`[web-store] 管理用户列表已加载：${users.value.length} 项`);
    } catch (caught) {
      usersError.value = caught;
      throw caught;
    } finally {
      usersLoading.value = false;
    }
  }

  /** 加载全站项目列表（只读；状态为服务端存储值）。 */
  async function loadProjects(): Promise<void> {
    projectsLoading.value = true;
    projectsError.value = null;
    try {
      const result = await apiRequest<{ projects: Project[] }>("/api/admin/projects");
      projects.value = result.projects;
      console.info(`[web-store] 管理项目列表已加载：${projects.value.length} 项`);
    } catch (caught) {
      projectsError.value = caught;
      throw caught;
    } finally {
      projectsLoading.value = false;
    }
  }

  /**
   * 加载全站 run 列表（可按状态 / 错误码过滤）。
   * @param filter 过滤条件（空串不入参）
   */
  async function loadRuns(filter: AdminRunFilter = {}): Promise<void> {
    runsLoading.value = true;
    runsError.value = null;
    try {
      const params = new URLSearchParams();
      if (filter.status) params.set("status", filter.status);
      if (filter.errorCode) params.set("errorCode", filter.errorCode);
      const query = params.toString();
      const result = await apiRequest<{ runs: RunSummary[] }>(
        query.length > 0 ? `/api/admin/runs?${query}` : "/api/admin/runs",
      );
      runs.value = result.runs;
      console.info(`[web-store] 管理 run 列表已加载：${runs.value.length} 项`);
    } catch (caught) {
      runsError.value = caught;
      throw caught;
    } finally {
      runsLoading.value = false;
    }
  }

  /**
   * 重置指定用户密码（唯一写操作；响应体不回传新口令）。
   * @param userId 目标用户 id
   * @param newPassword 新密码（由 admin 在 Popconfirm 内录入）
   */
  async function resetPassword(userId: string, newPassword: string): Promise<void> {
    await apiRequest(`/api/admin/users/${encodeURIComponent(userId)}/reset-password`, {
      method: "POST",
      body: { newPassword },
    });
    console.info(`[web-store] 已重置用户密码：${userId}`);
  }

  return {
    users,
    projects,
    runs,
    usersLoading,
    projectsLoading,
    runsLoading,
    usersError,
    projectsError,
    runsError,
    loadUsers,
    loadProjects,
    loadRuns,
    resetPassword,
  };
});
