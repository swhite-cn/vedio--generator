import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Actor, LlmCall, ToolCall } from "@videoforge/shared";
import { VideoForgeError } from "@videoforge/shared";
import { llmCalls, toolCalls } from "../schema.js";
import { getSession } from "./session-repository.js";

/** 断言调用方为 admin，否则抛 `AUTH_FORBIDDEN`（跨用户只读仅对 admin 放开）。 */
function assertAdmin(actor: Actor): void {
  if (actor.role !== "admin") {
    throw new VideoForgeError("AUTH_FORBIDDEN", "Admin role required");
  }
}

/** 将数据库行映射为领域 `ToolCall`（见设计文档 §11、§7.3）。 */
function toToolCall(row: any): ToolCall {
  return {
    id: row.id,
    session_id: row.sessionId,
    run_id: row.runId ?? undefined,
    stage_id: row.stageId ?? undefined,
    tool: row.tool,
    args_json: JSON.parse(row.argsJson) as unknown,
    ok: row.ok,
    error_code: row.errorCode ?? null,
    duration_ms: row.durationMs,
    artifact_paths: row.artifactPaths ? (JSON.parse(row.artifactPaths) as string[]) : [],
    created_at: row.createdAt,
  };
}

/** 将数据库行映射为领域 `LlmCall`（见设计文档 §11、§7.2）。 */
function toLlmCall(row: any): LlmCall {
  return {
    id: row.id,
    session_id: row.sessionId,
    run_id: row.runId ?? undefined,
    stage_id: row.stageId ?? undefined,
    model: row.model,
    request_json: JSON.parse(row.requestJson) as unknown,
    response_json: JSON.parse(row.responseJson) as unknown,
    prompt_tokens: row.promptTokens,
    completion_tokens: row.completionTokens,
    duration_ms: row.durationMs,
    ok: row.ok,
    error_code: row.errorCode ?? null,
    created_at: row.createdAt,
  };
}

export interface RecordToolCallInput {
  id?: string;
  sessionId: string;
  runId?: string | null;
  stageId?: string | null;
  tool: string;
  args: unknown;
  ok: boolean;
  errorCode?: string | null;
  durationMs: number;
  artifactPaths?: string[];
}

/**
 * 记录一次工具调用（含内置工具；自由对话时 runId/stageId 为空，见设计文档 §7.1）。
 * 归属校验：会话必须属于 actor。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param input 工具调用留痕
 * @returns 创建后的工具调用记录
 * @throws VideoForgeError(`AUTH_FORBIDDEN`) 会话不存在或不属于 actor
 */
export function recordToolCall(db: any, actor: Actor, input: RecordToolCallInput): ToolCall {
  if (!getSession(db, actor, input.sessionId)) {
    throw new VideoForgeError("AUTH_FORBIDDEN", `Session not found: ${input.sessionId}`);
  }
  const row = {
    id: input.id ?? randomUUID(),
    sessionId: input.sessionId,
    runId: input.runId ?? null,
    stageId: input.stageId ?? null,
    tool: input.tool,
    argsJson: JSON.stringify(input.args ?? null),
    ok: input.ok,
    errorCode: input.errorCode ?? null,
    durationMs: input.durationMs,
    artifactPaths: JSON.stringify(input.artifactPaths ?? []),
    createdAt: new Date().toISOString(),
  };
  db.insert(toolCalls).values(row).run();
  return toToolCall(row);
}

export interface TraceFilter {
  runId?: string;
  stageId?: string;
}

/**
 * 按会话列出工具调用留痕（可选按 runId/stageId 过滤；会话不属于 actor 时为空）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param sessionId 会话 ID
 * @param filter 可选过滤条件
 * @returns 工具调用列表（按创建时间升序）
 */
export function listToolCalls(
  db: any,
  actor: Actor,
  sessionId: string,
  filter: TraceFilter = {},
): ToolCall[] {
  if (!getSession(db, actor, sessionId)) return [];
  const conditions = [eq(toolCalls.sessionId, sessionId)];
  if (filter.runId !== undefined) conditions.push(eq(toolCalls.runId, filter.runId));
  if (filter.stageId !== undefined) conditions.push(eq(toolCalls.stageId, filter.stageId));
  return db
    .select()
    .from(toolCalls)
    .where(and(...conditions))
    .orderBy(asc(toolCalls.createdAt))
    .all()
    .map(toToolCall);
}

/**
 * 跨用户只读：按会话列出工具调用留痕（供 `GET /api/admin/runs/:id/trace`，仅 admin）。
 * 与 `listToolCalls` 不同，不做会话归属校验，完全依赖 `assertAdmin` 守卫。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体，必须为 admin
 * @param sessionId 会话 ID
 * @param filter 可选过滤条件（runId / stageId）
 * @returns 工具调用列表（按创建时间升序）
 */
export function adminListToolCalls(
  db: any,
  actor: Actor,
  sessionId: string,
  filter: TraceFilter = {},
): ToolCall[] {
  assertAdmin(actor);
  const conditions = [eq(toolCalls.sessionId, sessionId)];
  if (filter.runId !== undefined) conditions.push(eq(toolCalls.runId, filter.runId));
  if (filter.stageId !== undefined) conditions.push(eq(toolCalls.stageId, filter.stageId));
  return db
    .select()
    .from(toolCalls)
    .where(and(...conditions))
    .orderBy(asc(toolCalls.createdAt))
    .all()
    .map(toToolCall);
}

export interface RecordLlmCallInput {
  id?: string;
  sessionId: string;
  runId?: string | null;
  stageId?: string | null;
  model: string;
  request: unknown;
  response: unknown;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  ok: boolean;
  errorCode?: string | null;
}

/**
 * 记录一次 LLM 调用全文留痕（调用方需在写入前完成脱敏，见设计文档 §7.2、§7.4）。
 * 归属校验：会话必须属于 actor。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param input LLM 调用留痕
 * @returns 创建后的 LLM 调用记录
 * @throws VideoForgeError(`AUTH_FORBIDDEN`) 会话不存在或不属于 actor
 */
export function recordLlmCall(db: any, actor: Actor, input: RecordLlmCallInput): LlmCall {
  if (!getSession(db, actor, input.sessionId)) {
    throw new VideoForgeError("AUTH_FORBIDDEN", `Session not found: ${input.sessionId}`);
  }
  const row = {
    id: input.id ?? randomUUID(),
    sessionId: input.sessionId,
    runId: input.runId ?? null,
    stageId: input.stageId ?? null,
    model: input.model,
    requestJson: JSON.stringify(input.request ?? null),
    responseJson: JSON.stringify(input.response ?? null),
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    durationMs: input.durationMs,
    ok: input.ok,
    errorCode: input.errorCode ?? null,
    createdAt: new Date().toISOString(),
  };
  db.insert(llmCalls).values(row).run();
  return toLlmCall(row);
}

/**
 * 按会话列出 LLM 调用留痕（可选按 runId/stageId 过滤；会话不属于 actor 时为空）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体
 * @param sessionId 会话 ID
 * @param filter 可选过滤条件
 * @returns LLM 调用列表（按创建时间升序）
 */
export function listLlmCalls(
  db: any,
  actor: Actor,
  sessionId: string,
  filter: TraceFilter = {},
): LlmCall[] {
  if (!getSession(db, actor, sessionId)) return [];
  const conditions = [eq(llmCalls.sessionId, sessionId)];
  if (filter.runId !== undefined) conditions.push(eq(llmCalls.runId, filter.runId));
  if (filter.stageId !== undefined) conditions.push(eq(llmCalls.stageId, filter.stageId));
  return db
    .select()
    .from(llmCalls)
    .where(and(...conditions))
    .orderBy(asc(llmCalls.createdAt))
    .all()
    .map(toLlmCall);
}

/**
 * 跨用户只读：按会话列出 LLM 调用留痕（供 `GET /api/admin/runs/:id/trace`，仅 admin）。
 * 与 `listLlmCalls` 不同，不做会话归属校验，完全依赖 `assertAdmin` 守卫。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体，必须为 admin
 * @param sessionId 会话 ID
 * @param filter 可选过滤条件（runId / stageId）
 * @returns LLM 调用列表（按创建时间升序）
 */
export function adminListLlmCalls(
  db: any,
  actor: Actor,
  sessionId: string,
  filter: TraceFilter = {},
): LlmCall[] {
  assertAdmin(actor);
  const conditions = [eq(llmCalls.sessionId, sessionId)];
  if (filter.runId !== undefined) conditions.push(eq(llmCalls.runId, filter.runId));
  if (filter.stageId !== undefined) conditions.push(eq(llmCalls.stageId, filter.stageId));
  return db
    .select()
    .from(llmCalls)
    .where(and(...conditions))
    .orderBy(asc(llmCalls.createdAt))
    .all()
    .map(toLlmCall);
}
