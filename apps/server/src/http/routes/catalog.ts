import type { FastifyInstance } from "fastify";
import {
  componentRegistry,
  readComponentPreviewFixture,
} from "@videoforge/template-sdk";
import { loadTheme, listThemes } from "@videoforge/pipeline";
import type { HttpDeps } from "../deps.js";
import { createAuthPreHandler, requireActor } from "../auth-hook.js";

/**
 * 组件与主题只读目录路由（T117，方案 §7.1）：
 * - `GET /api/components`：组件注册表（含参数 schema 与覆盖率说明）→ 组件库、scene 阶段提示词辅助；
 * - `GET /api/components/:id/preview`：组件预览 fixture → 组件库预览卡；
 * - `GET /api/themes`、`GET /api/themes/:id`：主题 token → 新建项目、Inspector。
 * 数据在运行期只读（随服务重启生效），响应带短缓存头。
 */

/** 目录响应缓存秒数；本地单机无代理，`private` 即可。 */
const CATALOG_CACHE_SECONDS = 300;

/**
 * 注册组件/主题只读目录路由。
 * @param app Fastify 实例
 * @param deps HTTP 层依赖
 */
export function registerCatalogRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const authPreHandler = createAuthPreHandler(app);

  /** 列出全部组件声明（按注册顺序）。 */
  app.get("/api/components", { preHandler: authPreHandler }, async (_request, reply) => {
    requireActor(_request);
    reply.header("Cache-Control", `private, max-age=${CATALOG_CACHE_SECONDS}`);
    return { items: componentRegistry.list() };
  });

  /** 读取单个组件的预览 fixture（组件未登记或文件缺失报 `CONFIG_INVALID`）。 */
  app.get(
    "/api/components/:id/preview",
    { preHandler: authPreHandler },
    async (request, reply) => {
      requireActor(request);
      const { id } = request.params as { id: string };
      const fixture = readComponentPreviewFixture(deps.rootDir, id);
      reply.header("Cache-Control", `private, max-age=${CATALOG_CACHE_SECONDS}`);
      return { fixture };
    },
  );

  /** 列出全部可用主题（按 ID 字典序；非法主题跳过并告警）。 */
  app.get("/api/themes", { preHandler: authPreHandler }, async (_request, reply) => {
    requireActor(_request);
    reply.header("Cache-Control", `private, max-age=${CATALOG_CACHE_SECONDS}`);
    return { items: listThemes(deps.rootDir) };
  });

  /** 读取单个主题；不存在报 `CONFIG_INVALID`（与项目创建入口同口径）。 */
  app.get("/api/themes/:id", { preHandler: authPreHandler }, async (request, reply) => {
    requireActor(request);
    const { id } = request.params as { id: string };
    const theme = loadTheme({ rootDir: deps.rootDir, themeId: id });
    reply.header("Cache-Control", `private, max-age=${CATALOG_CACHE_SECONDS}`);
    return { theme };
  });
}
