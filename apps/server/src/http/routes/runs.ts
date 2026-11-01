import type { FastifyInstance } from "fastify";
import { VideoForgeError } from "@videoforge/shared";
import type { HttpDeps } from "../deps.js";
import { createAuthPreHandler, requireActor } from "../auth-hook.js";
import { assertProjectLease } from "../../workflow/lease.js";
import { getProject } from "../../db/repositories/project-repository.js";
import { createRun, getRun, listRuns } from "../../db/repositories/run-repository.js";
import { listRunStages } from "../../db/repositories/run-stage-repository.js";
import { getSession, listSessions } from "../../db/repositories/session-repository.js";
import { listLlmCalls, listToolCalls } from "../../db/repositories/trace-repository.js";

/**
 * 运行（run）与 trace 路由（见设计文档 §4.2）。
 * 所有路由需鉴权；项目 / run 查询一律 actor-first，取不到即 `AUTH_FORBIDDEN`
 * （§8.3：不区分「不存在」与「不属于你」，避免枚举他人资源 ID）。
 */

/** trace 分页默认每页条数（见设计文档 §4.2「分页」；代码常量，不进配置）。 */
const DEFAULT_TRACE_LIMIT = 50;
/** trace 分页每页条数上限。 */
const MAX_TRACE_LIMIT = 200;

/**
 * 解析 trace 分页参数。
 * `limit` 默认 50、合法范围 1..200，非法值（非整数 / 越界 / 非字符串）回落默认；
 * `offset` 默认 0、要求 >= 0 的整数，非法值回落 0。
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
 * 注册运行与 trace 路由。
 * @param app Fastify 实例
 * @param deps HTTP 层依赖
 */
export function registerRunRoutes(app: FastifyInstance, deps: HttpDeps): void {
  const authPreHandler = createAuthPreHandler(app);

  /** 列出项目下的 run（先判项目归属，再列出；按创建时间倒序）。 */
  app.get("/api/projects/:id/runs", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    if (!getProject(deps.db, actor, id)) {
      throw new VideoForgeError("AUTH_FORBIDDEN", `项目不存在：${id}`);
    }
    reply.code(200);
    return { runs: listRuns(deps.db, actor, id) };
  });

  /**
   * 从断点续跑发起一个新 run（见设计文档 §4.2 `/api/projects/:id/runs`）。
   * 解析会话 → 租约检查（冲突抛 PROJECT_BUSY → 409）→ 建 run → 非阻塞触发工作流。
   */
  app.post("/api/projects/:id/runs", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    if (!getProject(deps.db, actor, id)) {
      throw new VideoForgeError("AUTH_FORBIDDEN", `项目不存在：${id}`);
    }

    // 解析目标会话：显式传入时校验归属与本项目；缺省时取该项目最新会话
    const body = (request.body ?? {}) as { sessionId?: unknown };
    let sessionId: string;
    if (typeof body.sessionId === "string" && body.sessionId.length > 0) {
      const session = getSession(deps.db, actor, body.sessionId);
      if (!session || session.project_id !== id) {
        throw new VideoForgeError("CONFIG_INVALID", "会话不属于该项目");
      }
      sessionId = session.id;
    } else {
      const latest = [...listSessions(deps.db, actor, id)].sort((a, b) =>
        b.created_at.localeCompare(a.created_at),
      )[0];
      if (!latest) {
        throw new VideoForgeError("CONFIG_INVALID", "项目无会话");
      }
      sessionId = latest.id;
    }

    // 租约检查：项目已有活跃 run 时抛 PROJECT_BUSY（→ 409）
    assertProjectLease(deps.db, actor, id);
    const run = createRun(deps.db, actor, { projectId: id, sessionId, trigger: "user" });

    // 非阻塞触发工作流（不 await，避免 HTTP 长时间挂起；失败仅记日志）
    void deps.workflow.run(actor, run.id).catch((err) => {
      app.log.error({ err, runId: run.id }, "[http] 触发 run 失败");
    });

    reply.code(201);
    return { run };
  });

  /** run 详情：含各阶段实例状态与 `started_at` / `ended_at`（供前端算耗时）。 */
  app.get("/api/runs/:id", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    const run = getRun(deps.db, actor, id);
    if (!run) {
      throw new VideoForgeError("AUTH_FORBIDDEN", `run 不存在：${id}`);
    }
    reply.code(200);
    return { run, stages: listRunStages(deps.db, actor, id) };
  });

  /**
   * 审核点确认 / 失败续跑（见设计文档 §4.2 `/api/runs/:id/resume`）。
   * 先返回当前 run（202），再非阻塞交给工作流引擎处理（`await` 会让 HTTP 长时间挂起）。
   */
  app.post("/api/runs/:id/resume", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { action?: unknown; feedback?: unknown };
    const action = body.action;
    if (action !== "approve" && action !== "retry") {
      throw new VideoForgeError("CONFIG_INVALID", "action 必须为 approve 或 retry");
    }

    const current = getRun(deps.db, actor, id);
    if (!current) {
      throw new VideoForgeError("AUTH_FORBIDDEN", `run 不存在：${id}`);
    }

    const feedback = typeof body.feedback === "string" ? body.feedback : undefined;
    void deps.workflow.resume(actor, id, action, feedback).catch((err) => {
      app.log.error({ err, runId: id }, "[http] 恢复 run 失败");
    });

    reply.code(202);
    return { run: current };
  });

  /** 取消活跃 run（引擎的非法态取消会抛 RUN_STATE_INVALID → 409，交由统一错误处理器）。 */
  app.post("/api/runs/:id/cancel", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    if (!getRun(deps.db, actor, id)) {
      throw new VideoForgeError("AUTH_FORBIDDEN", `run 不存在：${id}`);
    }
    const run = deps.workflow.cancel(actor, id);
    reply.code(200);
    return { run };
  });

  /** run 的完整 trace：阶段实例 + 工具调用 + LLM 调用（后两者分页，`total` 为切片前总数）。 */
  app.get("/api/runs/:id/trace", { preHandler: authPreHandler }, async (request, reply) => {
    const actor = requireActor(request);
    const { id } = request.params as { id: string };
    const run = getRun(deps.db, actor, id);
    if (!run) {
      throw new VideoForgeError("AUTH_FORBIDDEN", `run 不存在：${id}`);
    }

    const { limit, offset } = parsePaging(request.query);
    // 阶段数固定（7），不分页；留痕按 runId 过滤后切片分页
    const stages = listRunStages(deps.db, actor, id);
    const allToolCalls = listToolCalls(deps.db, actor, run.session_id, { runId: id });
    const allLlmCalls = listLlmCalls(deps.db, actor, run.session_id, { runId: id });

    reply.code(200);
    return {
      run,
      stages,
      toolCalls: allToolCalls.slice(offset, offset + limit),
      llmCalls: allLlmCalls.slice(offset, offset + limit),
      total: { toolCalls: allToolCalls.length, llmCalls: allLlmCalls.length },
      paging: { limit, offset },
    };
  });
}
