import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  QUALITY_REPORT_RELATIVE_PATH,
  readQualityReport,
  summarizeQualityReport,
} from "@videoforge/pipeline";
import { VideoForgeError } from "@videoforge/shared";
import type { HttpDeps } from "../deps.js";
import { createAuthPreHandler, requireActor } from "../auth-hook.js";
import { getProject } from "../../db/repositories/project-repository.js";
import { resolveUserProjectDir } from "../../domain/storage-layout.js";

/**
 * 质检报告读取路由（T207，方案 §7.1）。
 * 返回项目最新一次质检报告与服务端汇总（前端不推导状态机）；
 * 报告尚未生成时 `report`/`summary` 为 null（不视为错误）。
 * @param app Fastify 实例
 * @param deps HTTP 层依赖
 */
export function registerQualityRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const authPreHandler = createAuthPreHandler(app);

  app.get("/api/projects/:id/quality", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    const projectId = (request.params as { id: string }).id;
    const project = getProject(deps.db, actor, projectId);
    if (!project) {
      throw new VideoForgeError("AUTH_FORBIDDEN", "项目不存在或无访问权限");
    }

    const reportPath = join(
      resolveUserProjectDir(deps.storageRoot, actor.userId, project.name),
      QUALITY_REPORT_RELATIVE_PATH,
    );
    // 缺报告 = 该项目尚未跑过质检（v1 项目不进质检链路，同样返回 null）
    const report = existsSync(reportPath) ? readQualityReport(reportPath) : null;

    reply.code(200);
    return {
      projectId: project.id,
      report,
      summary: report ? summarizeQualityReport(report) : null,
    };
  });
}
