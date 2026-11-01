import type { FastifyInstance } from "fastify";
import { VideoForgeError } from "@videoforge/shared";
import type { HttpDeps } from "../deps.js";
import { createAuthPreHandler, requireActor } from "../auth-hook.js";
import { buildArtifactIndex, type ArtifactIndex } from "../artifacts.js";
import { getCapability } from "../../workflow/capabilities.js";
import { resolveUserProjectDir } from "../../domain/storage-layout.js";
import { getProject } from "../../db/repositories/project-repository.js";

/**
 * 项目产物清单路由（见设计文档 §4.2 `/api/projects/:id/artifacts`）。
 * 需鉴权；项目查询 actor-first，取不到即 `AUTH_FORBIDDEN`（不区分不存在与越权）。
 */

/**
 * 注册产物清单路由。
 * @param app Fastify 实例
 * @param deps HTTP 层依赖
 */
export function registerArtifactRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const authPreHandler = createAuthPreHandler(app);

  /** 列出项目产物索引：能力缺失时回落到空清单。 */
  app.get("/api/projects/:id/artifacts", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    const project = getProject(deps.db, actor, id);
    if (!project) {
      throw new VideoForgeError("AUTH_FORBIDDEN", `项目不存在：${id}`);
    }

    // 落盘路径由 resolveUserProjectDir 派生（禁止字符串拼接敏感路径）
    const projectDir = resolveUserProjectDir(deps.storageRoot, actor.userId, project.name);
    const capability = getCapability(project.capability_id);
    const artifacts: ArtifactIndex = capability
      ? buildArtifactIndex(projectDir, capability, project.profile)
      : { finalVideoExists: false, entries: [] };

    reply.code(200);
    return { artifacts };
  });
}
