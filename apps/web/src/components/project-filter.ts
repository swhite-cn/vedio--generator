/**
 * 项目列表筛选与排序纯函数（方案 §8.5 第 4 页）。
 *
 * 只按服务端返回的项目状态分组，不在前端推导状态机；「进行中」包含
 * `running` 与 `review`（待审核仍在流水线内），`draft` 仅出现在「全部」。
 */
import type { Project } from "../stores/projects";

/** 项目列表筛选档位。 */
export type ProjectFilter = "all" | "active" | "done" | "failed";

/** 筛选档位展示顺序与中文名（页面按钮与单测共用）。 */
export const PROJECT_FILTERS: ReadonlyArray<{ value: ProjectFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "active", label: "进行中" },
  { value: "done", label: "已完成" },
  { value: "failed", label: "失败" },
];

/**
 * 判断项目是否命中筛选档位。
 * @param status 服务端项目状态
 * @param filter 筛选档位
 * @returns 命中返回 true
 */
export function matchesProjectFilter(status: string, filter: ProjectFilter): boolean {
  switch (filter) {
    case "active":
      return status === "running" || status === "review";
    case "done":
      return status === "done";
    case "failed":
      return status === "failed";
    default:
      return true;
  }
}

/**
 * 按筛选档位过滤项目（保持入参顺序）。
 * @param projects 项目列表
 * @param filter 筛选档位
 * @returns 过滤后的新数组
 */
export function filterProjects(projects: readonly Project[], filter: ProjectFilter): Project[] {
  return projects.filter((project) => matchesProjectFilter(project.status, filter));
}

/**
 * 按最近更新时间倒序排序（不修改入参）。
 * @param projects 项目列表
 * @returns 排序后的新数组
 */
export function sortProjectsByUpdatedAt(projects: readonly Project[]): Project[] {
  return [...projects].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/**
 * 统计各档位项目数量，供筛选按钮展示。
 * @param projects 项目列表
 * @returns 以档位为键的计数
 */
export function countProjectFilters(projects: readonly Project[]): Record<ProjectFilter, number> {
  return {
    all: projects.length,
    active: filterProjects(projects, "active").length,
    done: filterProjects(projects, "done").length,
    failed: filterProjects(projects, "failed").length,
  };
}
