import type { FastifyInstance } from "fastify";
import { componentRegistry } from "@videoforge/template-sdk";
import type { HttpDeps } from "../deps.js";
import { createAuthPreHandler, requireActor } from "../auth-hook.js";
import { listProjects } from "../../db/repositories/project-repository.js";
import { listProjectAssets } from "../../db/repositories/asset-repository.js";

/**
 * 顶栏全局搜索（T312，方案 §7.1 `GET /api/search?q=`）。
 *
 * 只搜索当前 actor 可见的数据：自己的项目、项目资产、全局组件注册表。
 * 结果每类最多 8 条；空查询返回空数组（不触发任何查询）。
 * 前端只渲染本接口结果，不在本地拼接或推导其它数据源。
 */

/** 单类结果上限。 */
const SEARCH_LIMIT = 8;

/**
 * 判断文本是否命中关键词（大小写不敏感包含）。
 * @param value 被搜索文本
 * @param keyword 已小写的关键词
 * @returns 命中返回 true
 */
function matches(value: string | null | undefined, keyword: string): boolean {
  return typeof value === "string" && value.toLowerCase().includes(keyword);
}

/**
 * 注册全局搜索路由。
 * @param app Fastify 实例
 * @param deps HTTP 层依赖
 */
export function registerSearchRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const authPreHandler = createAuthPreHandler(app);

  app.get("/api/search", { preHandler: authPreHandler }, async (request) => {
    const actor = requireActor(request);
    const rawQuery = (request.query as { q?: unknown } | undefined)?.q;
    const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
    if (query.length === 0) {
      return { q: "", projects: [], assets: [], components: [] };
    }
    const keyword = query.toLowerCase();

    const projects = listProjects(deps.db, actor);
    const projectMatches = projects
      .filter((project) => matches(project.name, keyword) || matches(project.topic, keyword))
      .slice(0, SEARCH_LIMIT)
      .map((project) => ({
        id: project.id,
        name: project.name,
        topic: project.topic,
        status: project.status,
      }));

    const assetMatches: Array<{
      id: string;
      project_id: string;
      project_name: string;
      label: string;
      kind: string;
      source: string;
    }> = [];
    for (const project of projects) {
      if (assetMatches.length >= SEARCH_LIMIT) break;
      const assets = listProjectAssets(deps.db, actor, project.id);
      for (const asset of assets) {
        if (assetMatches.length >= SEARCH_LIMIT) break;
        if (matches(asset.label, keyword)) {
          assetMatches.push({
            id: asset.id,
            project_id: project.id,
            project_name: project.name,
            label: asset.label,
            kind: asset.kind,
            source: asset.source,
          });
        }
      }
    }

    const components = componentRegistry
      .list()
      .filter((entry) => matches(entry.name, keyword) || matches(entry.id, keyword))
      .slice(0, SEARCH_LIMIT)
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        category: entry.category,
        coverage_note: entry.coverageNote ?? null,
      }));

    return {
      q: query,
      projects: projectMatches,
      assets: assetMatches,
      components,
    };
  });
}
