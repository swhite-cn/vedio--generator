import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VideoForgeError, type RunStatus } from "@videoforge/shared";
import type { HttpDeps } from "../deps.js";
import { createAuthPreHandler, requireActor, requireAdmin } from "../auth-hook.js";
import { buildRunEvents } from "../../trace/run-events.js";
import { deriveProjectStatus } from "../../domain/project-status.js";
import { resolveUserProjectDir } from "../../domain/storage-layout.js";
import { hashPassword } from "../../auth/password.js";
import { toPublicUser } from "./auth.js";
import { adminGetRun, adminListRuns } from "../../db/repositories/run-repository.js";
import { adminListRunStages } from "../../db/repositories/run-stage-repository.js";
import { adminListLlmCalls, adminListToolCalls } from "../../db/repositories/trace-repository.js";
import { adminListProjects } from "../../db/repositories/project-repository.js";
import { adminListUsers, adminResetPassword } from "../../db/repositories/user-repository.js";

/**
 * 管理 API（见设计文档 §4.3）。全部路由需 Bearer 鉴权且首行 `requireAdmin`，
 * 非 admin 一律返回 `AUTH_FORBIDDEN`(403)；只读数据一律经 `admin*` 仓储方法跨用户读取，
 * 普通路由无任何跨用户路径。响应体绝不回传密码哈希或明文口令。
 */

/** trace 分页默认每页条数（与 `GET /api/runs/:id/trace` 规则一致）。 */
const DEFAULT_TRACE_LIMIT = 50;
/** trace 分页每页条数上限。 */
const MAX_TRACE_LIMIT = 200;

/**
 * 解析 trace 分页参数（规则同 `GET /api/runs/:id/trace`）。
 * `limit` 默认 50、合法范围 1..200，非法值回落默认；`offset` 默认 0、要求 >= 0 整数，非法值回落 0。
 * @param query Fastify 请求查询串（可能为空）
 * @returns 归一化后的 `{ limit, offset }`
 */
function parsePaging(query: unknown): { limit: number; offset: number } {
  const raw = (query ?? {}) as Record<string, unknown>;

  let limit = DEFAULT_TRACE_LIMIT;
  const rawLimit = typeof raw.limit === "string" ? Number(raw.limit) : Number.NaN;
  if (Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= MAX_TRACE_LIMIT) {
    limit = rawLimit;
  }

  let offset = 0;
  const rawOffset = typeof raw.offset === "string" ? Number(raw.offset) : Number.NaN;
  if (Number.isInteger(rawOffset) && rawOffset >= 0) {
    offset = rawOffset;
  }

  return { limit, offset };
}

/**
 * 注册管理路由。
 * @param app Fastify 实例
 * @param deps HTTP 层依赖
 */
export function registerAdminRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const authPreHandler = createAuthPreHandler(app);

  /** 全站用户列表（经 `toPublicUser` 剥离合法的密码哈希字段）。 */
  app.get("/api/admin/users", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    requireAdmin(actor);
    reply.code(200);
    return { users: adminListUsers(deps.db, actor).map(toPublicUser) };
  });

  /** 重置指定用户密码（响应体绝不回传新密码）。 */
  app.post(
    "/api/admin/users/:id/reset-password",
    { preHandler: authPreHandler },
    async (request, reply) => {
      const actor = requireActor(request);
      requireAdmin(actor);
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { newPassword?: unknown };
      const newPassword = body.newPassword;
      if (typeof newPassword !== "string" || newPassword.length === 0) {
        throw new VideoForgeError("CONFIG_INVALID", "newPassword 不能为空");
      }
      adminResetPassword(deps.db, actor, id, hashPassword(newPassword));
      app.log.info({ targetUserId: id }, "[http] 管理员重置了用户密码");
      reply.code(200);
      return { ok: true };
    },
  );

  /** 全站项目列表（只读，按 `deriveProjectStatus` 推导真实状态）。 */
  app.get("/api/admin/projects", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    requireAdmin(actor);
    const projects = adminListProjects(deps.db, actor);
    const runs = adminListRuns(deps.db, actor);
    const withStatus = projects.map((project) => {
      const projectRuns = runs.filter((run) => run.project_id === project.id);
      const projectDir = resolveUserProjectDir(deps.storageRoot, project.user_id, project.name);
      const finalVideoExists = existsSync(join(projectDir, "final.mp4"));
      return {
        ...project,
        status: deriveProjectStatus({
          runs: projectRuns,
          runStages: [],
          artifacts: { finalVideoExists },
        }),
      };
    });
    reply.code(200);
    return { projects: withStatus };
  });

  /** 全站 run 列表（只读，可按 `status` / `errorCode` 过滤；空字符串参数不入 filter）。 */
  app.get("/api/admin/runs", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    requireAdmin(actor);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const filter: { status?: RunStatus; errorCode?: string } = {};
    if (typeof query.status === "string" && query.status.length > 0) {
      filter.status = query.status as RunStatus;
    }
    if (typeof query.errorCode === "string" && query.errorCode.length > 0) {
      filter.errorCode = query.errorCode;
    }
    reply.code(200);
    return { runs: adminListRuns(deps.db, actor, filter) };
  });

  /** 任意 run 的完整 trace（跨用户只读，形状同 `GET /api/runs/:id/trace`）。 */
  app.get("/api/admin/runs/:id/trace", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    requireAdmin(actor);
    const { id } = request.params as { id: string };
    const run = adminGetRun(deps.db, actor, id);
    if (!run) {
      throw new VideoForgeError("AUTH_FORBIDDEN", `run 不存在：${id}`);
    }

    const { limit, offset } = parsePaging(request.query);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const stageFilter =
      typeof query.stage === "string" && query.stage.length > 0 ? query.stage : null;
    const stages = adminListRunStages(deps.db, actor, id);
    const stageIds = stageFilter
      ? new Set(stages.filter((row) => row.stage === stageFilter).map((row) => row.id))
      : null;
    const rawToolCalls = adminListToolCalls(deps.db, actor, run.session_id, { runId: id });
    const rawLlmCalls = adminListLlmCalls(deps.db, actor, run.session_id, { runId: id });
    const allToolCalls = stageIds
      ? rawToolCalls.filter((call) => call.stage_id && stageIds.has(call.stage_id))
      : rawToolCalls;
    const allLlmCalls = stageIds
      ? rawLlmCalls.filter((call) => call.stage_id && stageIds.has(call.stage_id))
      : rawLlmCalls;

    reply.code(200);
    return {
      run,
      stages,
      toolCalls: allToolCalls.slice(offset, offset + limit),
      llmCalls: allLlmCalls.slice(offset, offset + limit),
      total: { toolCalls: allToolCalls.length, llmCalls: allLlmCalls.length },
      paging: { limit, offset },
      events: buildRunEvents(run, stages, rawToolCalls, rawLlmCalls),
    };
  });
}
