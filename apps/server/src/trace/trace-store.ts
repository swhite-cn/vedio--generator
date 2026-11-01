import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Actor,
  LlmCall,
  PipelineStage,
  RunStage,
  RunStageStatus,
  ToolCall,
} from "@videoforge/shared";
import { VideoForgeError } from "@videoforge/shared";
import { assertInsideUserRoot } from "@videoforge/pipeline";
import { getProject } from "../db/repositories/project-repository.js";
import { getRun } from "../db/repositories/run-repository.js";
import {
  createRunStage,
  findRunStageByAttempt,
  updateRunStage,
  type RunStagePatch,
} from "../db/repositories/run-stage-repository.js";
import { getSession } from "../db/repositories/session-repository.js";
import {
  recordLlmCall as repoRecordLlmCall,
  recordToolCall as repoRecordToolCall,
} from "../db/repositories/trace-repository.js";
import { resolveUserProjectDir } from "../domain/storage-layout.js";
import { createRedactor } from "./redact.js";

/**
 * 三级留痕写入器（见设计文档 §7.1）：
 * - 先脱敏再落盘（`args` / `request` / `response` 走 `redactDeep`）；
 * - 三级记录落 SQLite 后，追加写入 `<项目目录>/trace.jsonl`（每行一条 JSON，字段与表一致）。
 * 自由对话（无 run）只挂 `session_id`，`run_id` / `stage_id` 写 null。
 */

/** trace 追加文件名（取代旧的 run-log.jsonl，见设计文档 §7.1）。 */
const TRACE_FILE_NAME = "trace.jsonl";

/** 创建 trace store 的依赖项。 */
export interface CreateTraceStoreOptions {
  /** Drizzle 数据库实例。 */
  db: any;
  /** 请求主体（用于仓储归属校验与项目目录解析）。 */
  actor: Actor;
  /** 存储根目录（项目目录位于其下）。 */
  storageRoot: string;
  /** 仓库根目录（用于 `loadLocalEnv` 与脱敏器）。 */
  rootDir: string;
}

/** 工具调用留痕入参（`id` / `created_at` 由仓储生成）。 */
export interface TraceToolCallInput {
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

/** LLM 调用留痕入参（`id` / `created_at` 由仓储生成）。 */
export interface TraceLlmCallInput {
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

/** 阶段实例留痕入参（按 (runId, stage, attempt) upsert）。 */
export interface TraceStageInput {
  runId: string;
  stage: PipelineStage;
  status: RunStageStatus;
  attempt?: number;
  errorCode?: string | null;
  artifactPaths?: string[];
  startedAt?: string | null;
  endedAt?: string | null;
}

/** trace store 对外能力。 */
export interface TraceStore {
  recordToolCall(input: TraceToolCallInput): ToolCall;
  recordLlmCall(input: TraceLlmCallInput): LlmCall;
  recordStage(input: TraceStageInput): RunStage;
}

/**
 * 创建 trace store：封装“脱敏 → 落 SQLite → 追加 trace.jsonl”的三级留痕流程。
 * @param options 依赖项（db / actor / storageRoot / rootDir）
 * @returns trace store 实例
 */
export function createTraceStore(options: CreateTraceStoreOptions): TraceStore {
  const { db, actor, storageRoot, rootDir } = options;
  const redact = createRedactor(rootDir);

  /** 由会话解析项目落盘目录：session → project → `storage/users/<uid>/projects/<name>`。 */
  function projectDirForSession(sessionId: string): string {
    const session = getSession(db, actor, sessionId);
    if (!session) throw new VideoForgeError("AUTH_FORBIDDEN", `Session not found: ${sessionId}`);
    const project = getProject(db, actor, session.project_id);
    if (!project)
      throw new VideoForgeError("AUTH_FORBIDDEN", `Project not found: ${session.project_id}`);
    return resolveUserProjectDir(storageRoot, actor.userId, project.name);
  }

  /** 由 run 解析项目落盘目录：run → project → `storage/users/<uid>/projects/<name>`。 */
  function projectDirForRun(runId: string): string {
    const run = getRun(db, actor, runId);
    if (!run) throw new VideoForgeError("AUTH_FORBIDDEN", `Run not found: ${runId}`);
    const project = getProject(db, actor, run.project_id);
    if (!project)
      throw new VideoForgeError("AUTH_FORBIDDEN", `Project not found: ${run.project_id}`);
    return resolveUserProjectDir(storageRoot, actor.userId, project.name);
  }

  /** 追加一条已脱敏的 trace 记录到 `<项目目录>/trace.jsonl`（UTF-8，逐行 JSON，目录不存在则递归创建）。 */
  function appendTraceLine(projectDir: string, entry: Record<string, unknown>): void {
    const file = join(projectDir, TRACE_FILE_NAME);
    // 复用 path-safety：确保目标文件位于 storageRoot 内，禁止越界写入
    assertInsideUserRoot(storageRoot, file);
    mkdirSync(projectDir, { recursive: true });
    appendFileSync(file, `${JSON.stringify(redact(entry))}\n`, "utf-8");
  }

  return {
    recordToolCall(input: TraceToolCallInput): ToolCall {
      const record = repoRecordToolCall(db, actor, {
        sessionId: input.sessionId,
        runId: input.runId ?? null,
        stageId: input.stageId ?? null,
        tool: input.tool,
        args: redact(input.args),
        ok: input.ok,
        errorCode: input.errorCode ?? null,
        durationMs: input.durationMs,
        artifactPaths: input.artifactPaths ?? [],
      });
      appendTraceLine(projectDirForSession(record.session_id), {
        type: "tool_call",
        id: record.id,
        session_id: record.session_id,
        run_id: record.run_id ?? null,
        stage_id: record.stage_id ?? null,
        tool: record.tool,
        args_json: record.args_json,
        ok: record.ok,
        error_code: record.error_code,
        duration_ms: record.duration_ms,
        artifact_paths: record.artifact_paths,
        created_at: record.created_at,
      });
      return record;
    },

    recordLlmCall(input: TraceLlmCallInput): LlmCall {
      const record = repoRecordLlmCall(db, actor, {
        sessionId: input.sessionId,
        runId: input.runId ?? null,
        stageId: input.stageId ?? null,
        model: input.model,
        request: redact(input.request),
        response: redact(input.response),
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        durationMs: input.durationMs,
        ok: input.ok,
        errorCode: input.errorCode ?? null,
      });
      appendTraceLine(projectDirForSession(record.session_id), {
        type: "llm_call",
        id: record.id,
        session_id: record.session_id,
        run_id: record.run_id ?? null,
        stage_id: record.stage_id ?? null,
        model: record.model,
        request_json: record.request_json,
        response_json: record.response_json,
        prompt_tokens: record.prompt_tokens,
        completion_tokens: record.completion_tokens,
        duration_ms: record.duration_ms,
        ok: record.ok,
        error_code: record.error_code,
        created_at: record.created_at,
      });
      return record;
    },

    recordStage(input: TraceStageInput): RunStage {
      const attempt = input.attempt ?? 0;
      const existing = findRunStageByAttempt(db, actor, input.runId, input.stage, attempt);
      const stageId = existing
        ? existing.id
        : createRunStage(db, actor, {
            runId: input.runId,
            stage: input.stage,
            status: input.status,
            attempt,
            artifactPaths: input.artifactPaths ?? [],
            startedAt: input.startedAt ?? null,
          }).id;

      const patch: RunStagePatch = { status: input.status, attempt };
      if (input.errorCode !== undefined) patch.errorCode = input.errorCode;
      if (input.artifactPaths !== undefined) patch.artifactPaths = input.artifactPaths;
      if (input.startedAt !== undefined) patch.startedAt = input.startedAt;
      if (input.endedAt !== undefined) patch.endedAt = input.endedAt;
      updateRunStage(db, actor, stageId, patch);

      const record = findRunStageByAttempt(db, actor, input.runId, input.stage, attempt);
      if (!record) throw new VideoForgeError("AUTH_FORBIDDEN", `Run stage not found: ${stageId}`);
      appendTraceLine(projectDirForRun(input.runId), {
        type: "run_stage",
        id: record.id,
        run_id: record.run_id,
        stage: record.stage,
        status: record.status,
        attempt: record.attempt,
        error_code: record.error_code,
        artifact_paths: record.artifact_paths,
        started_at: record.started_at,
        ended_at: record.ended_at,
      });
      return record;
    },
  };
}
