import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Actor, PipelineStage, RunStage, RunStageStatus } from "@videoforge/shared";
import { PIPELINE_STAGES, VideoForgeError } from "@videoforge/shared";
import { projects, runStages, runs } from "../schema.js";
import { getRun } from "./run-repository.js";

/** 将数据库行映射为领域 `RunStage`（`artifact_paths` 反序列化，见设计文档 §11）。 */
function toRunStage(row: any): RunStage {
  return {
    id: row.id,
    run_id: row.runId,
    stage: row.stage as PipelineStage,
    status: row.status as RunStageStatus,
    attempt: row.attempt,
    error_code: row.errorCode ?? null,
    artifact_paths: row.artifactPaths ? (JSON.parse(row.artifactPaths) as string[]) : [],
    started_at: row.startedAt ?? null,
    ended_at: row.endedAt ?? null,
  };
}

/** 断言调用方为 admin，否则抛 `AUTH_FORBIDDEN`（跨用户只读仅对 admin 放开）。 */
function assertAdmin(actor: Actor): void {
  if (actor.role !== "admin") {
    throw new VideoForgeError("AUTH_FORBIDDEN", "Admin role required");
  }
}

/** 构造“当前用户拥有的 run ID”子查询，供 run_stages 的读写 where 限定用户归属。 */
function ownedRunIds(db: any, actor: Actor) {
  const projectIds = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.userId, actor.userId));
  return db.select({ id: runs.id }).from(runs).where(inArray(runs.projectId, projectIds));
}

export interface CreateRunStageInput {
  id?: string;
  runId: string;
  stage: PipelineStage;
  status?: RunStageStatus;
  attempt?: number;
  artifactPaths?: string[];
  startedAt?: string | null;
}

/**
 * 为一个 run 创建阶段实例（归属校验：run 必须属于 actor）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param input 阶段实例信息
 * @returns 创建后的阶段实例
 * @throws VideoForgeError(`AUTH_FORBIDDEN`) run 不存在或不属于 actor
 */
export function createRunStage(db: any, actor: Actor, input: CreateRunStageInput): RunStage {
  if (!getRun(db, actor, input.runId)) {
    throw new VideoForgeError("AUTH_FORBIDDEN", `Run not found: ${input.runId}`);
  }
  const row = {
    id: input.id ?? randomUUID(),
    runId: input.runId,
    stage: input.stage,
    status: input.status ?? "pending",
    attempt: input.attempt ?? 0,
    errorCode: null,
    artifactPaths: JSON.stringify(input.artifactPaths ?? []),
    startedAt: input.startedAt ?? null,
    endedAt: null,
  };
  db.insert(runStages).values(row).run();
  console.info(`[run-stage-repository] created stage ${row.stage} for run: ${row.runId}`);
  return toRunStage(row);
}

/**
 * 列出某个 run 的全部阶段实例（按流水线阶段顺序排序；run 不属于 actor 时为空）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param runId run ID
 * @returns 阶段实例列表
 */
export function listRunStages(db: any, actor: Actor, runId: string): RunStage[] {
  if (!getRun(db, actor, runId)) return [];
  const rows = db
    .select()
    .from(runStages)
    .where(eq(runStages.runId, runId))
    .all()
    .map(toRunStage) as RunStage[];
  // run_stages 无顺序列：按 PIPELINE_STAGES 声明的阶段顺序排序
  return rows.sort((a, b) => PIPELINE_STAGES.indexOf(a.stage) - PIPELINE_STAGES.indexOf(b.stage));
}

/**
 * 按 (runId, stage, attempt) 查找阶段实例（用于 upsert 语义；run 不属于 actor 时返回 undefined）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param runId run ID
 * @param stage 流水线阶段
 * @param attempt 尝试次数
 * @returns 匹配的阶段实例或 undefined
 */
export function findRunStageByAttempt(
  db: any,
  actor: Actor,
  runId: string,
  stage: PipelineStage,
  attempt: number,
): RunStage | undefined {
  if (!getRun(db, actor, runId)) return undefined;
  const row = db
    .select()
    .from(runStages)
    .where(
      and(eq(runStages.runId, runId), eq(runStages.stage, stage), eq(runStages.attempt, attempt)),
    )
    .get();
  return row ? toRunStage(row) : undefined;
}

export interface RunStagePatch {
  status?: RunStageStatus;
  attempt?: number;
  errorCode?: string | null;
  artifactPaths?: string[];
  startedAt?: string | null;
  endedAt?: string | null;
}

/**
 * 更新阶段实例（where 限定阶段所属 run 属于 actor）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param stageId 阶段实例 ID
 * @param patch 待更新字段（仅传入的字段会被写入）
 * @throws VideoForgeError(`AUTH_FORBIDDEN`) 阶段不存在或不属于 actor
 */
export function updateRunStage(db: any, actor: Actor, stageId: string, patch: RunStagePatch): void {
  const values: Record<string, unknown> = {};
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.attempt !== undefined) values.attempt = patch.attempt;
  if (patch.errorCode !== undefined) values.errorCode = patch.errorCode;
  if (patch.artifactPaths !== undefined) values.artifactPaths = JSON.stringify(patch.artifactPaths);
  if (patch.startedAt !== undefined) values.startedAt = patch.startedAt;
  if (patch.endedAt !== undefined) values.endedAt = patch.endedAt;

  const result = db
    .update(runStages)
    .set(values)
    .where(and(eq(runStages.id, stageId), inArray(runStages.runId, ownedRunIds(db, actor))))
    .run();
  if (result.changes === 0) {
    throw new VideoForgeError("AUTH_FORBIDDEN", `Run stage not found: ${stageId}`);
  }
}

/**
 * 跨用户只读：列出任意 run 的全部阶段实例（供 `GET /api/admin/runs/:id/trace`，仅 admin）。
 * 与 `listRunStages` 不同，不做 run 归属校验，完全依赖 `assertAdmin` 守卫；
 * 排序逻辑与 `listRunStages` 一致（按 `PIPELINE_STAGES` 声明顺序）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体，必须为 admin
 * @param runId run ID
 * @returns 阶段实例列表
 */
export function adminListRunStages(db: any, actor: Actor, runId: string): RunStage[] {
  assertAdmin(actor);
  const rows = db
    .select()
    .from(runStages)
    .where(eq(runStages.runId, runId))
    .all()
    .map(toRunStage) as RunStage[];
  return rows.sort((a, b) => PIPELINE_STAGES.indexOf(a.stage) - PIPELINE_STAGES.indexOf(b.stage));
}
