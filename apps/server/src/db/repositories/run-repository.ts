import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Actor, PipelineStage, Run, RunStatus, RunTrigger } from "@videoforge/shared";
import { RUN_ERROR_INTERRUPTED, VideoForgeError } from "@videoforge/shared";
import { projects, runs } from "../schema.js";
import { getProject } from "./project-repository.js";

/** 持有项目租约的活跃 run 状态（见设计文档 §8.4）。 */
const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting_review"] as const;

/** 断言调用方为 admin，否则抛 `AUTH_FORBIDDEN`。 */
function assertAdmin(actor: Actor): void {
  if (actor.role !== "admin") {
    throw new VideoForgeError("AUTH_FORBIDDEN", "Admin role required");
  }
}

/** 将数据库行映射为领域 `Run`（snake_case，见设计文档 §11）。 */
function toRun(row: any): Run {
  return {
    id: row.id,
    project_id: row.projectId,
    session_id: row.sessionId,
    status: row.status as RunStatus,
    trigger: row.trigger as RunTrigger,
    current_stage: (row.currentStage ?? null) as PipelineStage | null,
    error_code: row.errorCode ?? null,
    created_at: row.createdAt,
    started_at: row.startedAt ?? null,
    ended_at: row.endedAt ?? null,
  };
}

/** 构造“当前用户拥有的项目 ID”子查询，供 runs 的读写 where 限定用户归属。 */
function ownedProjectIds(db: any, actor: Actor) {
  return db.select({ id: projects.id }).from(projects).where(eq(projects.userId, actor.userId));
}

export interface CreateRunInput {
  id?: string;
  projectId: string;
  sessionId: string;
  trigger: RunTrigger;
  status?: RunStatus;
}

/**
 * 为 actor 自己的项目创建 run（归属校验：项目必须属于 actor）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param input run 信息
 * @returns 创建后的 run
 * @throws VideoForgeError(`AUTH_FORBIDDEN`) 项目不存在或不属于 actor
 */
export function createRun(db: any, actor: Actor, input: CreateRunInput): Run {
  if (!getProject(db, actor, input.projectId)) {
    throw new VideoForgeError("AUTH_FORBIDDEN", `Project not found: ${input.projectId}`);
  }
  const row = {
    id: input.id ?? randomUUID(),
    projectId: input.projectId,
    sessionId: input.sessionId,
    status: input.status ?? "queued",
    trigger: input.trigger,
    currentStage: null,
    errorCode: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
  };
  db.insert(runs).values(row).run();
  console.info(`[run-repository] created run: ${row.id}`);
  return toRun(row);
}

/**
 * 按 ID 读取 run（join projects 限定 `user_id = actor.userId`）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param runId run ID
 * @returns run 或 undefined（不存在或不属于 actor）
 */
export function getRun(db: any, actor: Actor, runId: string): Run | undefined {
  const row = db
    .select({ run: runs })
    .from(runs)
    .innerJoin(projects, eq(runs.projectId, projects.id))
    .where(and(eq(runs.id, runId), eq(projects.userId, actor.userId)))
    .get();
  return row ? toRun(row.run) : undefined;
}

/**
 * 列出 actor 某个项目下的 run（按创建时间倒序）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param projectId 项目 ID
 * @returns run 列表（项目不属于 actor 时为空）
 */
export function listRuns(db: any, actor: Actor, projectId: string): Run[] {
  if (!getProject(db, actor, projectId)) return [];
  return db
    .select()
    .from(runs)
    .where(eq(runs.projectId, projectId))
    .orderBy(desc(runs.createdAt))
    .all()
    .map(toRun);
}

/**
 * 查找项目当前活跃 run（`queued`/`running`/`waiting_review`），用于租约冲突检查（见设计文档 §8.4）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param projectId 项目 ID
 * @returns 活跃 run 或 undefined
 */
export function findActiveRun(db: any, actor: Actor, projectId: string): Run | undefined {
  if (!getProject(db, actor, projectId)) return undefined;
  const row = db
    .select()
    .from(runs)
    .where(and(eq(runs.projectId, projectId), inArray(runs.status, [...ACTIVE_RUN_STATUSES])))
    .orderBy(desc(runs.createdAt))
    .get();
  return row ? toRun(row) : undefined;
}

export interface RunStatusPatch {
  status: RunStatus;
  errorCode?: string | null;
  currentStage?: PipelineStage | null;
  startedAt?: string | null;
  endedAt?: string | null;
}

/**
 * 更新 run 状态与相关时间戳（where 限定 run 所属项目属于 actor）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param runId run ID
 * @param patch 待更新字段（仅传入的字段会被写入）
 * @throws VideoForgeError(`AUTH_FORBIDDEN`) run 不存在或不属于 actor
 */
export function updateRunStatus(db: any, actor: Actor, runId: string, patch: RunStatusPatch): void {
  const values: Record<string, unknown> = { status: patch.status };
  if (patch.errorCode !== undefined) values.errorCode = patch.errorCode;
  if (patch.currentStage !== undefined) values.currentStage = patch.currentStage;
  if (patch.startedAt !== undefined) values.startedAt = patch.startedAt;
  if (patch.endedAt !== undefined) values.endedAt = patch.endedAt;

  const result = db
    .update(runs)
    .set(values)
    .where(and(eq(runs.id, runId), inArray(runs.projectId, ownedProjectIds(db, actor))))
    .run();
  if (result.changes === 0) {
    throw new VideoForgeError("AUTH_FORBIDDEN", `Run not found: ${runId}`);
  }
}

/**
 * 跨用户只读：按 ID 读取任意 run（供 `GET /api/admin/runs/:id/trace`，仅 admin）。
 * 与 `getRun` 不同，不做 `user_id` 归属 join 过滤，完全依赖 `assertAdmin` 守卫。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体，必须为 admin
 * @param runId run ID
 * @returns run 或 undefined（不存在时）
 */
export function adminGetRun(db: any, actor: Actor, runId: string): Run | undefined {
  assertAdmin(actor);
  const row = db.select().from(runs).where(eq(runs.id, runId)).get();
  return row ? toRun(row) : undefined;
}

export interface AdminRunFilter {
  status?: RunStatus;
  errorCode?: string;
}

/**
 * 跨用户只读：列出全站 run（供 `GET /api/admin/runs`，仅 admin）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体，必须为 admin
 * @param filter 可选过滤条件（status / errorCode）
 * @returns 全站 run 列表（按创建时间倒序）
 */
export function adminListRuns(db: any, actor: Actor, filter: AdminRunFilter = {}): Run[] {
  assertAdmin(actor);
  const conditions = [];
  if (filter.status !== undefined) conditions.push(eq(runs.status, filter.status));
  if (filter.errorCode !== undefined) conditions.push(eq(runs.errorCode, filter.errorCode));
  const base = db.select().from(runs);
  const rows = conditions.length > 0 ? base.where(and(...conditions)) : base;
  return rows.orderBy(desc(runs.createdAt)).all().map(toRun);
}

/**
 * 系统启动专用：跨用户、无 actor 归属校验，仅供服务启动恢复调用。
 * 把 `status ∈ {running, queued}` 的全部 run 置为 `canceled` 且
 * `error_code = RUN_ERROR_INTERRUPTED`（见设计文档 §6.5、§8.4 重启解锁）；
 * `waiting_review` 不重置（本就活着，等用户确认）。返回处理的 run 条数。
 * @param db Drizzle 数据库实例
 * @returns 被重置为 `canceled` 的 run 条数
 */
export function recoverInterruptedRuns(db: any): number {
  const result = db
    .update(runs)
    .set({
      status: "canceled",
      errorCode: RUN_ERROR_INTERRUPTED,
      endedAt: new Date().toISOString(),
    })
    .where(inArray(runs.status, ["running", "queued"]))
    .run();
  console.warn(`[run-repository] recovered ${result.changes} interrupted runs at startup`);
  return result.changes;
}
