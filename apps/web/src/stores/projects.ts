/**
 * 项目 store（见 Web 专题 §7.1、§5.2）：项目列表与新建。
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import { apiRequest } from "../services/api";

/** 最新 run 的展示摘要（`GET /api/projects` 的 `latestRun`；字段沿用服务端 snake_case）。 */
export interface ProjectLatestRun {
  id: string;
  status: string;
  trigger?: string;
  current_stage?: string | null;
  error_code?: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

/** 项目（`GET /api/projects` 的 `projects[]` 元素；`status` 与指标均为服务端推导值）。 */
export interface Project {
  id: string;
  user_id: string;
  capability_id: string;
  name: string;
  topic: string;
  style: string | null;
  profile: string;
  status: string;
  created_at: string;
  updated_at: string;
  /** copy v2 镜头数；v1 项目或产物缺失时为 null（T116）。 */
  shotCount?: number | null;
  /** 成片总时长毫秒；缺失时为 null（T116）。 */
  totalMs?: number | null;
  /** 镜头平均时长毫秒（T116）。 */
  averageShotMs?: number | null;
  /** 流水线进度 0..1，服务端计算（T116）。 */
  progress?: number;
  /** 预计剩余秒数；无历史样本时为 null（T116）。 */
  etaSeconds?: number | null;
  /** 已绑定资产的镜头数（T116）。 */
  boundShotCount?: number | null;
  /** 最新一次 run（无 run 时为 null）。 */
  latestRun?: ProjectLatestRun | null;
}

/** 新建项目载荷（`capabilityId` 必填，其余由服务端按能力参数契约校验）。 */
export interface CreateProjectPayload {
  capabilityId: string;
  name: string;
  topic: string;
  style?: string;
  profile?: string;
}

export const useProjectsStore = defineStore("projects", () => {
  /** 当前用户的项目列表。 */
  const list = ref<Project[]>([]);
  /** 是否正在加载列表。 */
  const loading = ref(false);
  /** 最近一次加载错误。 */
  const error = ref<unknown>(null);

  /**
   * 加载当前用户的项目列表。
   * @returns 项目列表
   */
  async function load(): Promise<Project[]> {
    loading.value = true;
    error.value = null;
    try {
      const result = await apiRequest<{ projects: Project[] }>("/api/projects");
      list.value = result.projects;
      console.info(`[web-store] 项目列表已加载：${list.value.length} 项`);
    } catch (caught) {
      error.value = caught;
      throw caught;
    } finally {
      loading.value = false;
    }
    return list.value;
  }

  /**
   * 新建项目（服务端会同时建会话与首个 run）。
   * @param payload 新建载荷
   * @returns 新建的项目
   */
  async function create(payload: CreateProjectPayload): Promise<Project> {
    const result = await apiRequest<{ project: Project }>("/api/projects", {
      method: "POST",
      body: payload,
    });
    list.value = [result.project, ...list.value];
    console.info(`[web-store] 项目已创建：${result.project.id}`);
    return result.project;
  }

  return { list, loading, error, load, create };
});
