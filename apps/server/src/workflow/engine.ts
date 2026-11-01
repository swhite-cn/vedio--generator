import type {
  Actor,
  CapabilityDeclaration,
  CapabilityStageDeclaration,
  PipelineStage,
  Project,
  Run,
  RunStageStatus,
} from "@videoforge/shared";
import { VideoForgeError } from "@videoforge/shared";
import type { SystemConfig } from "@videoforge/pipeline";
import { getProject } from "../db/repositories/project-repository.js";
import { getRun, updateRunStatus } from "../db/repositories/run-repository.js";
import {
  createRunStage,
  findRunStageByAttempt,
  listRunStages,
  updateRunStage,
} from "../db/repositories/run-stage-repository.js";
import { appendMessage } from "../db/repositories/message-repository.js";
import { resolveUserProjectDir } from "../domain/storage-layout.js";
import { assertRunTransition, assertStageTransition } from "./run-state.js";
import { resolveBreakpoint, verifyStageArtifact } from "./breakpoint.js";
import { getCapability } from "./capabilities.js";
import { buildStageInstruction, buildStageInstructionMessage } from "./stage-instruction.js";

// ---------------------------------------------------------------------------
// 工作流引擎主循环（见设计文档 §6.1–§6.5）。
// 引擎按能力声明驱动七阶段线性 DAG：不含阶段知识（顺序 / 工具名 / 产物判据全部来自声明）、
// 不直接调用内核（通过注入的 `executeStage` 端口驱动 agent 会话），只负责
// 阶段顺序、断点选择、状态推进、审核点暂停、重试上限与全局阶段并发。
// ---------------------------------------------------------------------------

/**
 * `runs.error_code` 在「全部阶段完成但最终产物缺失」场景下的取值。
 * 注意：它仅是 `runs.error_code` 的取值，**不是** API 错误码（沿用 `RUN_ERROR_INTERRUPTED` 的惯例）。
 */
const RUN_ERROR_ARTIFACT_MISSING = "ARTIFACT_MISSING";

/** 兜底错误码：执行器抛异常且未给出错误码时，按外部进程 / 网络失败收口。 */
const EXECUTOR_FAILURE_ERROR_CODE = "TOOL_UNAVAILABLE";

/** 引擎执行单个阶段的请求（由引擎构造，交给注入的执行器）。 */
export interface StageExecutionRequest {
  actor: Actor;
  runId: string;
  stageId: string;
  projectId: string;
  sessionId: string;
  /** 项目落盘目录（绝对路径）。 */
  projectDir: string;
  stage: PipelineStage;
  /** 该阶段的阶段工具名（如 copy_generate）。 */
  tool: string;
  /** 阶段展示名（如 文案生成）。 */
  label: string;
  /** 已解析的画幅 Profile。 */
  profile: string;
  /** 当前尝试序号（0 = 首次）。 */
  attempt: number;
  /** 已落库的阶段指令正文。 */
  instruction: string;
  /** 用户 retry 反馈（仅审核点重跑时非空）。 */
  feedback?: string;
}

/** 阶段执行结果（由执行器返回）。 */
export interface StageExecutionResult {
  ok: boolean;
  errorCode?: string | null;
  artifactPaths?: string[];
}

/** 阶段执行器端口：P9 接到会话注册表（取会话 → 下发指令 → 等 agent 跑完）；单测注入假实现。 */
export type StageExecutor = (request: StageExecutionRequest) => Promise<StageExecutionResult>;

/**
 * 阶段状态变更留痕入参（供外层把 `run_stages` 双写到 `trace.jsonl`）。
 * 与 `TraceStageInput` 一一对应，额外携带 `actor` 以便外层解析该用户专属的 trace store。
 */
export interface StageChangeRecord {
  /** 请求主体（trace store 绑定单个 actor）。 */
  actor: Actor;
  runId: string;
  stage: PipelineStage;
  status: RunStageStatus;
  attempt: number;
  errorCode?: string | null;
  artifactPaths?: string[];
  startedAt?: string | null;
  endedAt?: string | null;
}

/** 工作流事件（P9 接到 SSE 事件总线；本阶段缺省 no-op）。 */
export interface WorkflowEvent {
  type:
    | "run_started"
    | "stage_started"
    | "stage_done"
    | "stage_failed"
    | "review_gate"
    | "run_done"
    | "run_failed"
    | "run_canceled";
  runId: string;
  projectId: string;
  sessionId: string;
  stage?: PipelineStage;
  /** 事件附加信息（如 review_gate 的产物清单、失败的 errorCode）。 */
  payload?: Record<string, unknown>;
  at: string;
}

export interface WorkflowEngineOptions {
  db: any;
  /** 存储根目录（项目目录在其下）。 */
  storageRoot: string;
  config: SystemConfig;
  executeStage: StageExecutor;
  /** 事件出口；缺省 no-op。 */
  emit?: (event: WorkflowEvent) => void;
  /**
   * 阶段状态变更出口（用于 `run_stages` 双写 `trace.jsonl`）；缺省 no-op。
   * 回调异常会被吞掉并打诊断日志——留痕问题不得中断工作流。
   */
  onStageChange?: (record: StageChangeRecord) => void;
  /** 时钟注入（测试）；缺省 Date.now。 */
  now?: () => number;
}

export interface WorkflowEngine {
  /** 启动/续跑：从断点推进到下一个审核点、终态或失败；非法流转抛 RUN_STATE_INVALID。 */
  run(actor: Actor, runId: string, options?: { feedback?: string }): Promise<Run>;
  /** 审核点/失败恢复：approve 继续，retry 重跑目标阶段（可带 feedback）。 */
  resume(actor: Actor, runId: string, action: "approve" | "retry", feedback?: string): Promise<Run>;
  /** 取消活跃 run（queued|running|waiting_review）；终态抛 RUN_STATE_INVALID。 */
  cancel(actor: Actor, runId: string): Run;
}

/**
 * 小型计数信号量（自实现，不新增依赖），用于限制跨 run 的阶段执行并发上限。
 */
interface Semaphore {
  /** 获取一个执行位；返回释放函数（务必在 `finally` 中调用一次）。 */
  acquire(): Promise<() => void>;
}

/**
 * 创建计数信号量。
 * 当已有持有者达到 `limit` 时，`acquire()` 挂起等待，直到有持有者释放并把执行位直接交给队首等待者。
 * @param limit 并发上限（≥1）
 * @returns 信号量实例
 */
function createSemaphore(limit: number): Semaphore {
  let available = limit;
  const waiters: Array<() => void> = [];
  const release = (): void => {
    const next = waiters.shift();
    if (next) {
      // 直接把执行位交接给队首等待者，不归还计数（保证并发不超过上限）
      next();
    } else {
      available += 1;
    }
  };
  const acquire = async (): Promise<() => void> => {
    if (available > 0) {
      available -= 1;
    } else {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    return release;
  };
  return { acquire };
}

/** 引擎内部上下文（把注入依赖与共享信号量收敛到一处）。 */
interface EngineContext {
  db: any;
  storageRoot: string;
  /** 阶段失败后自救重试上限（`workflow.max_stage_retry`）。 */
  maxRetry: number;
  executeStage: StageExecutor;
  emit: (event: WorkflowEvent) => void;
  onStageChange: (record: StageChangeRecord) => void;
  timestamp: () => string;
  semaphore: Semaphore;
}

/** 单个阶段的执行结论：`done` 携带产物路径；`failed` 携带最后一次错误码。 */
type StageOutcome =
  { status: "done"; artifactPaths: string[] } | { status: "failed"; errorCode: string | null };

/**
 * 读取项目，取不到时抛 `AUTH_FORBIDDEN`（与仓储归属校验一致）。
 * @param ctx 引擎上下文
 * @param actor 请求主体
 * @param projectId 项目 ID
 * @returns 项目
 * @throws VideoForgeError(`AUTH_FORBIDDEN`) 项目不存在或不属于 actor
 */
function requireProject(ctx: EngineContext, actor: Actor, projectId: string): Project {
  const project = getProject(ctx.db, actor, projectId);
  if (!project) {
    throw new VideoForgeError("AUTH_FORBIDDEN", `Project not found: ${projectId}`);
  }
  return project;
}

/**
 * 按 id 读取能力声明，取不到时抛 `CONFIG_INVALID`（属于配置问题）。
 * @param capabilityId 能力标识
 * @returns 能力声明
 * @throws VideoForgeError(`CONFIG_INVALID`) 能力未注册
 */
function requireCapability(capabilityId: string): CapabilityDeclaration {
  const capability = getCapability(capabilityId);
  if (!capability) {
    throw new VideoForgeError("CONFIG_INVALID", `Capability not found: ${capabilityId}`);
  }
  return capability;
}

/**
 * 读取 run，取不到时抛 `AUTH_FORBIDDEN`。
 * @param ctx 引擎上下文
 * @param actor 请求主体
 * @param runId run ID
 * @returns run
 * @throws VideoForgeError(`AUTH_FORBIDDEN`) run 不存在或不属于 actor
 */
function getRunOrThrow(ctx: EngineContext, actor: Actor, runId: string): Run {
  const run = getRun(ctx.db, actor, runId);
  if (!run) {
    throw new VideoForgeError("AUTH_FORBIDDEN", `Run not found: ${runId}`);
  }
  return run;
}

/**
 * 发射一个工作流事件（补齐 runId / projectId / sessionId / at）。
 * @param ctx 引擎上下文
 * @param run 事件所属 run
 * @param type 事件类型
 * @param extra 附加字段（stage / payload）
 */
function emitEvent(
  ctx: EngineContext,
  run: Run,
  type: WorkflowEvent["type"],
  extra: { stage?: PipelineStage; payload?: Record<string, unknown> } = {},
): void {
  ctx.emit({
    type,
    runId: run.id,
    projectId: run.project_id,
    sessionId: run.session_id,
    at: ctx.timestamp(),
    ...extra,
  });
}

/**
 * 通知阶段状态变更（供外层双写 trace.jsonl）；留痕失败只告警，不影响工作流推进。
 * @param ctx 引擎上下文
 * @param record 阶段状态变更记录
 */
function notifyStageChange(ctx: EngineContext, record: StageChangeRecord): void {
  try {
    ctx.onStageChange(record);
  } catch (error) {
    console.warn(
      `[workflow-engine] 阶段留痕失败（${record.stage}/${record.status}）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * 执行单个阶段（含自救重试），整段由全局并发信号量包住。
 *
 * 尝试序号从该阶段「首个 `pending` 行的 attempt」起算（正常首跑为 0；审核点 retry 为「最大 attempt + 1」），
 * 至多执行 `maxRetry + 1` 次；每次先 `pending→running`，执行后按「执行器成功且产物判据达标」决定 `done` / `failed`。
 * @param ctx 引擎上下文
 * @param actor 请求主体
 * @param run 当前 run
 * @param declaration 阶段声明
 * @param project 项目（提供 topic / style / profile）
 * @param projectDir 项目落盘目录（绝对路径）
 * @param feedback 用户 retry 反馈（仅审核点重跑时非空）
 * @returns 阶段结论（`done` 或 `failed`）
 */
async function executeStageWithRetry(
  ctx: EngineContext,
  actor: Actor,
  run: Run,
  declaration: CapabilityStageDeclaration,
  project: Project,
  projectDir: string,
  feedback?: string,
): Promise<StageOutcome> {
  const release = await ctx.semaphore.acquire();
  let previousErrorCode: string | null = null;
  try {
    // 起始尝试序号：优先复用已存在的 pending 行（首跑 attempt=0；retry 为新建的 attempt=max+1）
    const stageRows = listRunStages(ctx.db, actor, run.id).filter(
      (row) => row.stage === declaration.stage,
    );
    const pendingRow = stageRows.find((row) => row.status === "pending");
    const baseAttempt = pendingRow ? pendingRow.attempt : 0;

    for (let attempt = baseAttempt; attempt <= baseAttempt + ctx.maxRetry; attempt += 1) {
      let row = findRunStageByAttempt(ctx.db, actor, run.id, declaration.stage, attempt);
      if (!row) {
        // attempt > 0（或首次也无行）→ 新建阶段行，attempt 递增（done 无出边，故重跑必新建行）
        row = createRunStage(ctx.db, actor, {
          runId: run.id,
          stage: declaration.stage,
          attempt,
          status: "pending",
        });
      }
      // 先断言再写：pending → running 为唯一合法入口
      assertStageTransition(row.status, "running");
      const startedAt = ctx.timestamp();
      updateRunStage(ctx.db, actor, row.id, {
        status: "running",
        attempt,
        startedAt,
      });
      notifyStageChange(ctx, {
        actor,
        runId: run.id,
        stage: declaration.stage,
        status: "running",
        attempt,
        startedAt,
      });

      const instructionInput = {
        stage: declaration,
        project: { topic: project.topic, style: project.style, profile: project.profile },
        profile: project.profile,
        attempt,
        previousErrorCode,
        feedback: feedback ?? null,
      };
      const instruction = buildStageInstruction(instructionInput);
      // 阶段指令以 role=system 落库（Pi 兼容负载），供历史重建与 trace 回放
      appendMessage(ctx.db, actor, {
        sessionId: run.session_id,
        role: "system",
        payload: buildStageInstructionMessage(instructionInput),
        runId: run.id,
      });
      emitEvent(ctx, run, "stage_started", {
        stage: declaration.stage,
        payload: { attempt, startedAt },
      });

      let result: StageExecutionResult;
      try {
        result = await ctx.executeStage({
          actor,
          runId: run.id,
          stageId: row.id,
          projectId: project.id,
          sessionId: run.session_id,
          projectDir,
          stage: declaration.stage,
          tool: declaration.tool,
          label: declaration.label,
          profile: project.profile,
          attempt,
          instruction,
          feedback: feedback ?? undefined,
        });
      } catch (err) {
        // 执行器异常不冒泡出 run()：按「本阶段未达标」处理，记一次诊断日志
        console.warn(
          `[workflow-engine] executeStage threw for stage ${declaration.stage} (attempt ${attempt}): ${(err as Error).message}`,
        );
        result = { ok: false, errorCode: EXECUTOR_FAILURE_ERROR_CODE };
      }

      // 达标 = 执行器自报成功 且 产物判据在工作区内通过
      const satisfied =
        result.ok && verifyStageArtifact(projectDir, declaration.artifact, project.profile);
      const artifactPaths = result.artifactPaths ?? [];
      if (satisfied) {
        assertStageTransition("running", "done");
        const endedAt = ctx.timestamp();
        updateRunStage(ctx.db, actor, row.id, {
          status: "done",
          errorCode: null,
          artifactPaths,
          endedAt,
        });
        notifyStageChange(ctx, {
          actor,
          runId: run.id,
          stage: declaration.stage,
          status: "done",
          attempt,
          errorCode: null,
          artifactPaths,
          startedAt,
          endedAt,
        });
        emitEvent(ctx, run, "stage_done", {
          stage: declaration.stage,
          payload: { attempt, artifactPaths, endedAt },
        });
        return { status: "done", artifactPaths };
      }

      // 未达标：标记本行 failed；仍有重试余额则继续下一次尝试，否则返回 failed 让上层收口 run。
      // 执行器可能自报成功（ok:true, errorCode:null）而产物判据未通过，此时必须补一个稳定错误码，
      // 否则 run 与 run_stages 的 error_code 均为空，界面无法呈现失败原因。
      assertStageTransition("running", "failed");
      const errorCode = result.errorCode ?? RUN_ERROR_ARTIFACT_MISSING;
      const endedAt = ctx.timestamp();
      updateRunStage(ctx.db, actor, row.id, {
        status: "failed",
        errorCode,
        endedAt,
      });
      notifyStageChange(ctx, {
        actor,
        runId: run.id,
        stage: declaration.stage,
        status: "failed",
        attempt,
        errorCode,
        startedAt,
        endedAt,
      });
      emitEvent(ctx, run, "stage_failed", {
        stage: declaration.stage,
        payload: { attempt, errorCode, endedAt },
      });
      previousErrorCode = errorCode;
    }

    return { status: "failed", errorCode: previousErrorCode };
  } finally {
    release();
  }
}

/**
 * 引擎主循环：把 run 置 running 后，从 `startIndex` 起按能力声明顺序推进阶段，
 * 直到到达审核点（`waiting_review`）、终态（`done`）或失败（`failed`）。
 * @param ctx 引擎上下文
 * @param actor 请求主体
 * @param run 当前 run
 * @param context.startIndex 续跑起点下标（阶段声明下标）
 * @param context.feedback 用户 retry 反馈（仅审核点重跑时非空）
 * @returns 推进后的最新 run
 * @throws VideoForgeError(`RUN_STATE_INVALID`) 当前状态无法流转到 running 时
 * @throws VideoForgeError(`AUTH_FORBIDDEN` | `CONFIG_INVALID`) 项目 / 能力缺失时
 */
async function advance(
  ctx: EngineContext,
  actor: Actor,
  run: Run,
  context: { startIndex: number; feedback?: string },
): Promise<Run> {
  const project = requireProject(ctx, actor, run.project_id);
  const capability = requireCapability(project.capability_id);
  const projectDir = resolveUserProjectDir(ctx.storageRoot, actor.userId, project.name);

  // 进入执行：运行态置 running（保留首次 started_at），清空当前阶段
  assertRunTransition(run.status, "running");
  updateRunStatus(ctx.db, actor, run.id, {
    status: "running",
    startedAt: run.started_at ?? ctx.timestamp(),
    currentStage: null,
  });
  emitEvent(ctx, run, "run_started");

  for (let index = context.startIndex; index < capability.stages.length; index += 1) {
    const declaration = capability.stages[index];
    const outcome = await executeStageWithRetry(
      ctx,
      actor,
      run,
      declaration,
      project,
      projectDir,
      context.feedback,
    );

    if (outcome.status === "failed") {
      updateRunStatus(ctx.db, actor, run.id, {
        status: "failed",
        errorCode: outcome.errorCode,
        currentStage: declaration.stage,
        endedAt: ctx.timestamp(),
      });
      emitEvent(ctx, run, "run_failed", {
        stage: declaration.stage,
        payload: { errorCode: outcome.errorCode },
      });
      return getRunOrThrow(ctx, actor, run.id);
    }

    // 阶段 done：保持 running 并记录当前阶段（running→running 无合法边，故不做断言，直接写库）
    updateRunStatus(ctx.db, actor, run.id, { status: "running", currentStage: declaration.stage });

    // 审核点：暂停等待用户确认
    if (declaration.reviewGate) {
      assertRunTransition("running", "waiting_review");
      updateRunStatus(ctx.db, actor, run.id, {
        status: "waiting_review",
        currentStage: declaration.stage,
      });
      emitEvent(ctx, run, "review_gate", {
        stage: declaration.stage,
        payload: { artifactPaths: outcome.artifactPaths },
      });
      return getRunOrThrow(ctx, actor, run.id);
    }
  }

  // 全部阶段 done：以最终产物存在为唯一 done 判据
  const finalPresent = verifyStageArtifact(
    projectDir,
    { kind: "file", relativePath: capability.finalArtifact },
    project.profile,
  );
  if (finalPresent) {
    assertRunTransition("running", "done");
    updateRunStatus(ctx.db, actor, run.id, { status: "done", endedAt: ctx.timestamp() });
    emitEvent(ctx, run, "run_done");
  } else {
    updateRunStatus(ctx.db, actor, run.id, {
      status: "failed",
      errorCode: RUN_ERROR_ARTIFACT_MISSING,
      endedAt: ctx.timestamp(),
    });
    emitEvent(ctx, run, "run_failed", { payload: { errorCode: RUN_ERROR_ARTIFACT_MISSING } });
  }
  return getRunOrThrow(ctx, actor, run.id);
}

/**
 * 启动 / 续跑一个 run：解析断点、幂等补建阶段行，并委托 `advance` 推进。
 * @param ctx 引擎上下文
 * @param actor 请求主体
 * @param runId run ID
 * @param options.feedback 用户 retry 反馈（可选）
 * @returns 推进后的最新 run
 * @throws VideoForgeError(`RUN_STATE_INVALID`) 非法流转（如对 `done`/`canceled` 调用）
 */
async function runWorkflow(
  ctx: EngineContext,
  actor: Actor,
  runId: string,
  options?: { feedback?: string },
): Promise<Run> {
  const run = getRunOrThrow(ctx, actor, runId);
  assertRunTransition(run.status, "running");

  const project = requireProject(ctx, actor, run.project_id);
  const capability = requireCapability(project.capability_id);
  const projectDir = resolveUserProjectDir(ctx.storageRoot, actor.userId, project.name);
  const { startIndex } = resolveBreakpoint(projectDir, capability, project.profile);

  // 幂等补建阶段行：断点前已达标者标 skipped，其余标 pending；已存在（attempt=0）不重复创建
  for (let index = 0; index < capability.stages.length; index += 1) {
    const declaration = capability.stages[index];
    if (!findRunStageByAttempt(ctx.db, actor, runId, declaration.stage, 0)) {
      const skipped = index < startIndex;
      createRunStage(ctx.db, actor, {
        runId,
        stage: declaration.stage,
        attempt: 0,
        status: skipped ? "skipped" : "pending",
      });
      // 断点前阶段不执行，但也是该 run 的实际阶段记录，需一并留痕
      if (skipped) {
        notifyStageChange(ctx, {
          actor,
          runId,
          stage: declaration.stage,
          status: "skipped",
          attempt: 0,
        });
      }
    }
  }

  return advance(ctx, actor, run, { startIndex, feedback: options?.feedback });
}

/**
 * 审核点 / 失败恢复：`approve` 从审核点下一阶段继续，`retry` 重跑目标阶段（可带反馈）。
 * @param ctx 引擎上下文
 * @param actor 请求主体
 * @param runId run ID
 * @param action `approve`（审核点通过）或 `retry`（重跑）
 * @param feedback 用户 retry 反馈（可选，仅 retry 有意义）
 * @returns 推进后的最新 run
 * @throws VideoForgeError(`RUN_STATE_INVALID`) 非法流转、缺少当前阶段或对 `failed` 做 approve
 */
async function resumeWorkflow(
  ctx: EngineContext,
  actor: Actor,
  runId: string,
  action: "approve" | "retry",
  feedback?: string,
): Promise<Run> {
  const run = getRunOrThrow(ctx, actor, runId);
  assertRunTransition(run.status, "running");

  const project = requireProject(ctx, actor, run.project_id);
  const capability = requireCapability(project.capability_id);

  const currentStage = run.current_stage;
  if (!currentStage) {
    throw new VideoForgeError("RUN_STATE_INVALID", "Run has no current stage to resume");
  }
  const targetIndex = capability.stages.findIndex(
    (declaration) => declaration.stage === currentStage,
  );
  if (targetIndex < 0) {
    throw new VideoForgeError("RUN_STATE_INVALID", `Stage not in capability: ${currentStage}`);
  }

  if (action === "approve") {
    // approve 仅在审核点（waiting_review）有意义；对 failed 的 approve 会错误跳过失败阶段
    if (run.status !== "waiting_review") {
      throw new VideoForgeError(
        "RUN_STATE_INVALID",
        `approve requires waiting_review, got ${run.status}`,
      );
    }
    // 从审核点阶段的下一阶段继续（审核点阶段本身已 done）
    return advance(ctx, actor, run, { startIndex: targetIndex + 1 });
  }

  // retry：新建 attempt = 最大 attempt + 1 的 pending 行，从目标阶段重跑（feedback 透传给指令）
  const stageRows = listRunStages(ctx.db, actor, runId).filter((row) => row.stage === currentStage);
  const maxAttempt = stageRows.reduce((max, row) => Math.max(max, row.attempt), -1);
  createRunStage(ctx.db, actor, {
    runId,
    stage: currentStage,
    attempt: maxAttempt + 1,
    status: "pending",
  });
  return advance(ctx, actor, run, { startIndex: targetIndex, feedback });
}

/**
 * 取消活跃 run（`queued` / `running` / `waiting_review`）。
 * @param ctx 引擎上下文
 * @param actor 请求主体
 * @param runId run ID
 * @returns 取消后的最新 run
 * @throws VideoForgeError(`RUN_STATE_INVALID`) run 已处于终态
 */
function cancelWorkflow(ctx: EngineContext, actor: Actor, runId: string): Run {
  const run = getRunOrThrow(ctx, actor, runId);
  assertRunTransition(run.status, "canceled");
  updateRunStatus(ctx.db, actor, runId, { status: "canceled", endedAt: ctx.timestamp() });
  emitEvent(ctx, run, "run_canceled");
  return getRunOrThrow(ctx, actor, runId);
}

/**
 * 组装工作流引擎（注入端口驱动，含跨 run 共享的全局阶段并发信号量）。
 * @param options 依赖与配置
 * @returns 工作流引擎实例
 */
export function createWorkflowEngine(options: WorkflowEngineOptions): WorkflowEngine {
  const ctx: EngineContext = {
    db: options.db,
    storageRoot: options.storageRoot,
    maxRetry: options.config.workflow.max_stage_retry,
    executeStage: options.executeStage,
    emit: options.emit ?? (() => {}),
    onStageChange: options.onStageChange ?? (() => {}),
    timestamp: () => new Date((options.now ?? Date.now)()).toISOString(),
    semaphore: createSemaphore(options.config.runtime.max_concurrent_stage),
  };

  return {
    run: (actor, runId, runOptions) => runWorkflow(ctx, actor, runId, runOptions),
    resume: (actor, runId, action, feedback) => resumeWorkflow(ctx, actor, runId, action, feedback),
    cancel: (actor, runId) => cancelWorkflow(ctx, actor, runId),
  };
}
