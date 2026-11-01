import type { FastifyInstance } from "fastify";
import type { Actor, Project, ProjectStatus } from "@videoforge/shared";
import { VideoForgeError } from "@videoforge/shared";
import type { HttpDeps } from "../deps.js";
import { createAuthPreHandler, requireActor } from "../auth-hook.js";
import { buildArtifactIndex, type ArtifactIndex } from "../artifacts.js";
import { getCapability } from "../../workflow/capabilities.js";
import { assertProjectLease } from "../../workflow/lease.js";
import { verifyStageArtifact } from "../../workflow/breakpoint.js";
import { deriveProjectStatus } from "../../domain/project-status.js";
import { resolveUserProjectDir } from "../../domain/storage-layout.js";
import {
  createProject,
  getProject,
  listProjects,
} from "../../db/repositories/project-repository.js";
import { createSession, listSessions } from "../../db/repositories/session-repository.js";
import { createRun, listRuns } from "../../db/repositories/run-repository.js";
import { listRunStages } from "../../db/repositories/run-stage-repository.js";

/**
 * 项目与会话（项目维度）路由（见设计文档 §4.2、§8.3、§8.4）。
 * 所有路由需鉴权；项目查询一律 actor-first，取不到即 `AUTH_FORBIDDEN`（不区分不存在与越权）。
 */

/** 默认输出 Profile（能力声明的 `profile` 参数默认值，见 §6.1）。 */
const DEFAULT_PROFILE = "landscape-1080p";

/**
 * 推导单个项目的运行状态（纯函数 `deriveProjectStatus` 的数据装配层）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param project 项目
 * @param projectDir 项目绝对目录
 * @returns 推导出的项目状态
 */
function deriveStatusForProject(
  db: any,
  actor: Actor,
  project: Project,
  projectDir: string,
): ProjectStatus {
  const runs = listRuns(db, actor, project.id);
  const runStages = runs.flatMap((run) => listRunStages(db, actor, run.id));
  const capability = getCapability(project.capability_id);
  const finalRelativePath = capability?.finalArtifact ?? "final.mp4";
  const finalVideoExists = verifyStageArtifact(
    projectDir,
    { kind: "file", relativePath: finalRelativePath },
    project.profile,
  );
  return deriveProjectStatus({ runs, runStages, artifacts: { finalVideoExists } });
}

/**
 * 注册项目路由。
 * @param app Fastify 实例
 * @param deps HTTP 层依赖
 */
export function registerProjectRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const authPreHandler = createAuthPreHandler(app);

  /** 列出当前用户全部项目，附推导状态。 */
  app.get("/api/projects", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    const projects = listProjects(deps.db, actor).map((project) => ({
      ...project,
      status: deriveStatusForProject(
        deps.db,
        actor,
        project,
        resolveUserProjectDir(deps.storageRoot, actor.userId, project.name),
      ),
    }));
    reply.code(200);
    return { projects };
  });

  /** 新建项目：按能力声明校验参数 → 建项目 → 建会话 → 建首个 run → 异步触发工作流。 */
  app.post("/api/projects", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const capabilityId = typeof body.capabilityId === "string" ? body.capabilityId : "";

    // ① 能力必须存在
    const capability = getCapability(capabilityId);
    if (!capability) {
      throw new VideoForgeError("CONFIG_INVALID", `能力不存在：${capabilityId}`);
    }

    // ② 用能力声明的 paramsSchema 结构化校验其余参数（不 import zod）
    const { capabilityId: _capabilityId, ...paramsInput } = body;
    const schema = capability.paramsSchema as {
      safeParse(input: unknown): { success: boolean; data?: any };
    };
    const parsed = schema.safeParse(paramsInput);
    if (!parsed.success) {
      throw new VideoForgeError("CONFIG_INVALID", "项目参数非法");
    }
    const params = parsed.data as { topic: string; style?: string; profile?: string };

    // ③ 项目名额上限
    if (listProjects(deps.db, actor).length >= deps.config.server.max_projects_per_user) {
      throw new VideoForgeError("CONFIG_INVALID", "项目数量已达上限");
    }

    // ④ 建项目
    const name =
      typeof body.name === "string" && body.name.trim().length > 0 ? body.name : params.topic;
    const project = createProject(deps.db, actor, {
      capabilityId,
      name,
      topic: params.topic,
      style: params.style ?? null,
      profile: params.profile ?? DEFAULT_PROFILE,
    });

    // ⑤ 自动建会话
    const session = createSession(deps.db, actor, { projectId: project.id, title: params.topic });

    // ⑥ 租约检查（新建项目时为恒真）+ 建首个 run
    assertProjectLease(deps.db, actor, project.id);
    const run = createRun(deps.db, actor, {
      projectId: project.id,
      sessionId: session.id,
      trigger: "user",
    });

    // ⑦ 异步触发工作流（不 await，避免 HTTP 长时间挂起）
    void deps.workflow.run(actor, run.id).catch((err) => {
      app.log.error({ err, runId: run.id }, "[http] 触发工作流失败");
    });

    // ⑧ 返回
    reply.code(201);
    return { project, session, run };
  });

  /** 项目详情：状态 + 产物索引。 */
  app.get("/api/projects/:id", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    const project = getProject(deps.db, actor, id);
    if (!project) {
      throw new VideoForgeError("AUTH_FORBIDDEN", `项目不存在：${id}`);
    }

    const projectDir = resolveUserProjectDir(deps.storageRoot, actor.userId, project.name);
    const status = deriveStatusForProject(deps.db, actor, project, projectDir);
    const capability = getCapability(project.capability_id);
    const artifacts: ArtifactIndex = capability
      ? buildArtifactIndex(projectDir, capability, project.profile)
      : { finalVideoExists: false, entries: [] };

    reply.code(200);
    return { project: { ...project, status }, artifacts };
  });

  /** 列出项目下的会话（先判项目归属，再列）。 */
  app.get("/api/projects/:id/sessions", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    if (!getProject(deps.db, actor, id)) {
      throw new VideoForgeError("AUTH_FORBIDDEN", `项目不存在：${id}`);
    }
    reply.code(200);
    return { sessions: listSessions(deps.db, actor, id) };
  });

  /** 新建会话。 */
  app.post("/api/projects/:id/sessions", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    if (!getProject(deps.db, actor, id)) {
      throw new VideoForgeError("AUTH_FORBIDDEN", `项目不存在：${id}`);
    }
    const body = (request.body ?? {}) as { title?: unknown };
    const title = typeof body.title === "string" && body.title.length > 0 ? body.title : "新会话";
    const session = createSession(deps.db, actor, { projectId: id, title });
    reply.code(201);
    return { session };
  });
}
