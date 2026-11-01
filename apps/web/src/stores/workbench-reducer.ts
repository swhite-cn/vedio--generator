/**
 * 工作台纯 reducer（Web 专题 §7.2「SSE 事件 → UI 映射（唯一权威表）」）。
 *
 * 全部 SSE 事件对 UI 的落点集中在本文件的 `applyEvent`：它是一个**纯函数**
 * （不读时钟、不做网络、不改输入），便于单元测试逐事件断言落点。
 * store（`workbench.ts`）只负责调用本函数并处理副作用（全局提示、产物刷新、resync 重拉）。
 */
import type { SseFrame } from "../services/sse";
import type { Project } from "./projects";
import { STAGE_LABELS } from "../components/state-mapping";

// ---------------------------------------------------------------------------
// 视图模型
// ---------------------------------------------------------------------------

/** 七阶段固定顺序（与 `STAGE_LABELS` 的键顺序一致，见 Web 专题 §2.3）。 */
export const STAGE_ORDER: readonly string[] = Object.keys(STAGE_LABELS);

/** 前端使用的 run 视图（字段与服务端 `runs` 表一致）。 */
export interface RunSummary {
  id: string;
  project_id: string;
  session_id: string;
  status: string;
  trigger: string;
  current_stage: string | null;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

/** 前端使用的会话视图（字段与服务端 `sessions` 表一致）。 */
export interface SessionSummary {
  id: string;
  project_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

/** 阶段进度（步骤条 / trace 左侧共用；字段取自服务端 `run_stages`）。 */
export interface StageProgress {
  stage: string;
  status: string;
  attempt: number;
  error_code: string | null;
  started_at: string | null;
  ended_at: string | null;
}

/** 产物清单中的一条（与服务端 `ArtifactEntry` 一致）。 */
export interface ArtifactEntry {
  stage: string;
  label: string;
  relativePath: string;
  sizeBytes: number;
}

/** 项目产物索引（与服务端 `ArtifactIndex` 一致）。 */
export interface ArtifactIndex {
  finalVideoExists: boolean;
  entries: ArtifactEntry[];
}

/** 工具卡片数据（`tool_start` 建卡 → `tool_end` 收尾）。 */
export interface ToolCardData {
  toolCallId: string;
  tool: string;
  args?: unknown;
  status: "running" | "done" | "failed";
  durationMs?: number;
  errorCode?: string | null;
  artifactPaths?: string[];
  /** 建卡时间（服务端 `tool_start.startedAt`），用于展示运行中卡片的实时耗时。 */
  startedAt?: string;
  /** 建卡时 run 的当前阶段（仅用于点击阶段时滚动定位，见 Web 专题 §5.4.3）。 */
  stage?: string | null;
}

/** 审核卡片数据（`review_gate` 触发）。 */
export interface ReviewCardData {
  runId: string;
  stage: string;
  summary: string;
  /** 已提交的结论（提交后卡片置灰，见 Web 专题 §5.4.2）。 */
  resolved?: "approve" | "retry";
  feedback?: string;
}

/** 对话流消息类型。 */
export type WorkbenchMessageKind = "user" | "assistant" | "system" | "tool" | "review";

/** 对话流中的一条消息（气泡 / 工具卡片 / 审核卡片统一建模）。 */
export interface WorkbenchMessage {
  id: string;
  kind: WorkbenchMessageKind;
  /** 文本消息内容（user / assistant / system）。 */
  text?: string;
  /** 工具卡片（kind === "tool"）。 */
  tool?: ToolCardData;
  /** 审核卡片（kind === "review"）。 */
  review?: ReviewCardData;
  /** 创建时间（本地乐观追加时写入，服务端消息不可得，见汇报受控偏差）。 */
  at?: string;
  /** assistant 气泡是否仍在流式追加（`turn_end` 定稿）。 */
  streaming?: boolean;
}

/** 工作台完整状态。 */
export interface WorkbenchState {
  project: Project | null;
  session: SessionSummary | null;
  currentRun: RunSummary | null;
  stages: StageProgress[];
  artifacts: ArtifactIndex | null;
  messages: WorkbenchMessage[];
  /** SSE 连接状态（连续失败 3 次置 disconnected）。 */
  connection: "connected" | "disconnected";
  /** agent 是否正在回复（`text_delta`/`tool_start` 起，`turn_end` 止）。 */
  agentStreaming: boolean;
  /** 最近一次 `error` 事件载荷（供全局提示）。 */
  lastError: { code: string; message: string } | null;
  /** 收到 `resync`：需要全量重拉（store 负责执行）。 */
  needsResync: boolean;
  /** 产物刷新令牌：`tool_end`/`run_stage(done)`/`run_end(done)` 时自增，store 据此局部刷新产物面板。 */
  artifactRefreshToken: number;
  /** run 是否已完成（成功时产物面板自动切到「成片」Tab）。 */
  finalReady: boolean;
}

// ---------------------------------------------------------------------------
// 初始化与工具函数
// ---------------------------------------------------------------------------

/**
 * 构造七阶段「全部待执行」的初始阶段进度。
 * @returns 按固定顺序排列的 7 条 `pending` 阶段
 */
export function sevenStages(): StageProgress[] {
  return STAGE_ORDER.map((stage) => ({
    stage,
    status: "pending",
    attempt: 0,
    error_code: null,
    started_at: null,
    ended_at: null,
  }));
}

/**
 * 构造工作台初始状态。
 * @returns 空白状态
 */
export function createInitialState(): WorkbenchState {
  return {
    project: null,
    session: null,
    currentRun: null,
    stages: sevenStages(),
    artifacts: null,
    messages: [],
    connection: "connected",
    agentStreaming: false,
    lastError: null,
    needsResync: false,
    artifactRefreshToken: 0,
    finalReady: false,
  };
}

/**
 * 构造一个仅含 id 与 running 状态的最小 run（SSE `run_start` 早于详情拉取时使用）。
 * @param id run id
 * @returns 最小 run 视图
 */
function blankRun(id: string): RunSummary {
  return {
    id,
    project_id: "",
    session_id: "",
    status: "running",
    trigger: "user",
    current_stage: null,
    error_code: null,
    created_at: "",
    started_at: null,
    ended_at: null,
  };
}

/**
 * 把服务端阶段行转成阶段进度；缺失的 pending 阶段按固定顺序补齐。
 * @param rows 服务端 `run_stages` 行（字段已为 snake_case）
 * @returns 恒为 7 条的阶段进度数组
 */
export function toStageProgress(
  rows: Array<{
    stage: string;
    status: string;
    attempt: number;
    error_code?: string | null;
    started_at?: string | null;
    ended_at?: string | null;
  }>,
): StageProgress[] {
  const byStage = new Map<string, StageProgress>();
  for (const row of rows) {
    byStage.set(row.stage, {
      stage: row.stage,
      status: row.status,
      attempt: row.attempt,
      error_code: row.error_code ?? null,
      started_at: row.started_at ?? null,
      ended_at: row.ended_at ?? null,
    });
  }
  return STAGE_ORDER.map(
    (stage) =>
      byStage.get(stage) ?? {
        stage,
        status: "pending",
        attempt: 0,
        error_code: null,
        started_at: null,
        ended_at: null,
      },
  );
}

/** 取阶段中文名（缺失回退阶段标识）。 */
function stageLabel(stage: string | null | undefined): string {
  if (!stage) return "";
  return STAGE_LABELS[stage] ?? stage;
}

// ---------------------------------------------------------------------------
// 事件落点（逐条对应 §7.2）
// ---------------------------------------------------------------------------

/**
 * `text_delta`：追加到对话流末尾 assistant 气泡（无则新建）。
 * @param state 当前状态
 * @param text 增量文本
 * @returns 新状态
 */
function applyTextDelta(state: WorkbenchState, text: string): WorkbenchState {
  if (text.length === 0) {
    return state;
  }
  const messages = [...state.messages];
  const last = messages[messages.length - 1];
  if (last && last.kind === "assistant" && last.streaming) {
    messages[messages.length - 1] = { ...last, text: (last.text ?? "") + text };
  } else {
    messages.push({ id: `assistant-${messages.length}`, kind: "assistant", text, streaming: true });
  }
  return { ...state, messages, agentStreaming: true };
}

/**
 * `tool_start`：对话流新建工具卡片（loading 态）。
 * @param state 当前状态
 * @param data 事件载荷
 * @returns 新状态
 */
function applyToolStart(state: WorkbenchState, data: Record<string, unknown>): WorkbenchState {
  const toolCallId = String(data.toolCallId ?? "");
  const card: ToolCardData = {
    toolCallId,
    tool: String(data.tool ?? ""),
    args: data.args,
    status: "running",
    startedAt: typeof data.startedAt === "string" ? data.startedAt : undefined,
    stage: state.currentRun?.current_stage ?? null,
  };
  const messages = [...state.messages, { id: `tool-${toolCallId}`, kind: "tool", tool: card }];
  return { ...state, messages, agentStreaming: true };
}

/**
 * `tool_end`：卡片收尾（状态 / 耗时 / 产物）；含 `artifactPaths` 时自增刷新令牌。
 * @param state 当前状态
 * @param data 事件载荷
 * @returns 新状态
 */
function applyToolEnd(state: WorkbenchState, data: Record<string, unknown>): WorkbenchState {
  const toolCallId = String(data.toolCallId ?? "");
  const ok = data.ok === true;
  const artifactPaths = Array.isArray(data.artifactPaths)
    ? (data.artifactPaths as string[])
    : undefined;
  let matched = false;

  const messages = state.messages.map((message) => {
    if (message.kind !== "tool" || !message.tool || message.tool.toolCallId !== toolCallId) {
      return message;
    }
    matched = true;
    return {
      ...message,
      tool: {
        ...message.tool,
        status: ok ? ("done" as const) : ("failed" as const),
        durationMs: typeof data.durationMs === "number" ? data.durationMs : message.tool.durationMs,
        errorCode: typeof data.errorCode === "string" ? data.errorCode : message.tool.errorCode,
        artifactPaths: artifactPaths ?? message.tool.artifactPaths,
      },
    };
  });

  // 丢帧兜底：未匹配到建卡时仍落一张终态卡片，保证可见性
  if (!matched && toolCallId.length > 0) {
    messages.push({
      id: `tool-${toolCallId}`,
      kind: "tool",
      tool: {
        toolCallId,
        tool: String(data.tool ?? ""),
        status: ok ? "done" : "failed",
        durationMs: typeof data.durationMs === "number" ? data.durationMs : undefined,
        errorCode: typeof data.errorCode === "string" ? data.errorCode : null,
        artifactPaths,
      },
    });
  }

  const refresh = artifactPaths && artifactPaths.length > 0;
  return {
    ...state,
    messages,
    artifactRefreshToken: refresh ? state.artifactRefreshToken + 1 : state.artifactRefreshToken,
  };
}

/**
 * `turn_end`：气泡定稿、隐藏「中断」按钮、输入框解锁。
 * @param state 当前状态
 * @returns 新状态
 */
function applyTurnEnd(state: WorkbenchState): WorkbenchState {
  const messages = state.messages.map((message) =>
    message.kind === "assistant" && message.streaming ? { ...message, streaming: false } : message,
  );
  return { ...state, messages, agentStreaming: false };
}

/**
 * `run_start`：页头 run Tag → 运行中；步骤条复位并从 `fromStage` 起算。
 * @param state 当前状态
 * @param data 事件载荷
 * @returns 新状态
 */
function applyRunStart(state: WorkbenchState, data: Record<string, unknown>): WorkbenchState {
  const runId = String(data.runId ?? "");
  const fromStage = typeof data.fromStage === "string" ? data.fromStage : null;
  const sameRun = state.currentRun?.id === runId;

  // 同一 run（resume 复用 runId）保留既有阶段进度；新 run 复位为全 pending
  let stages =
    sameRun && state.stages.length === STAGE_ORDER.length
      ? state.stages.map((s) => ({ ...s }))
      : sevenStages();
  if (fromStage) {
    const fromIndex = STAGE_ORDER.indexOf(fromStage);
    if (fromIndex > 0) {
      stages = stages.map((stage) =>
        STAGE_ORDER.indexOf(stage.stage) < fromIndex ? { ...stage, status: "skipped" } : stage,
      );
    }
  }

  const currentRun =
    sameRun && state.currentRun
      ? { ...state.currentRun, status: "running", error_code: null }
      : blankRun(runId);

  return { ...state, currentRun, stages, finalReady: false };
}

/**
 * `run_stage`：更新步骤条对应阶段状态（含 `skipped`）。
 * @param state 当前状态
 * @param data 事件载荷
 * @returns 新状态
 */
function applyRunStage(state: WorkbenchState, data: Record<string, unknown>): WorkbenchState {
  const stage = String(data.stage ?? "");
  const status = String(data.status ?? "pending");
  const attempt = typeof data.attempt === "number" ? data.attempt : 0;
  const errorCode = typeof data.errorCode === "string" ? data.errorCode : null;
  const artifactPaths = Array.isArray(data.artifactPaths)
    ? (data.artifactPaths as string[])
    : undefined;
  // 服务端 stage_started / stage_done / stage_failed 携带起止时间，用于步骤条实时耗时
  const startedAt = typeof data.startedAt === "string" ? data.startedAt : undefined;
  const endedAt = typeof data.endedAt === "string" ? data.endedAt : undefined;

  const stages = (state.stages.length === STAGE_ORDER.length ? state.stages : sevenStages()).map(
    (item) =>
      item.stage === stage
        ? {
            ...item,
            status,
            attempt,
            error_code: errorCode,
            started_at: startedAt ?? item.started_at,
            // 重跑（status=running）时清空上一轮的结束时间，避免步骤条展示过期耗时
            ended_at: status === "running" ? null : (endedAt ?? item.ended_at),
          }
        : item,
  );

  let runStatus = state.currentRun?.status ?? "running";
  if (status === "running" || status === "skipped") {
    runStatus = "running";
  }

  const currentRun = state.currentRun
    ? { ...state.currentRun, status: runStatus, current_stage: stage }
    : blankRun("");

  const refresh = status === "done" && artifactPaths && artifactPaths.length > 0;
  return {
    ...state,
    stages,
    currentRun,
    artifactRefreshToken: refresh ? state.artifactRefreshToken + 1 : state.artifactRefreshToken,
  };
}

/**
 * `review_gate`：页头 run Tag → 待审核；对话流插入审核卡片。
 * @param state 当前状态
 * @param data 事件载荷
 * @returns 新状态
 */
function applyReviewGate(state: WorkbenchState, data: Record<string, unknown>): WorkbenchState {
  const runId = String(data.runId ?? "");
  const stage = String(data.stage ?? "");
  const summary = String(data.summary ?? "");
  const review: ReviewCardData = { runId, stage, summary };
  const messages = [
    ...state.messages,
    { id: `review-${runId}-${stage}-${state.messages.length}`, kind: "review" as const, review },
  ];
  const currentRun = state.currentRun
    ? { ...state.currentRun, status: "waiting_review", current_stage: stage }
    : blankRun(runId);
  return { ...state, messages, currentRun };
}

/**
 * `run_end`：页头 run Tag → 终态；成功切「成片」Tab；失败追加系统条说明失败阶段与 errorCode。
 * @param state 当前状态
 * @param data 事件载荷
 * @returns 新状态
 */
function applyRunEnd(state: WorkbenchState, data: Record<string, unknown>): WorkbenchState {
  const status = String(data.status ?? state.currentRun?.status ?? "done");
  const errorCode = typeof data.errorCode === "string" ? data.errorCode : null;
  const currentRun = state.currentRun
    ? { ...state.currentRun, status, error_code: errorCode }
    : blankRun("");

  let messages = state.messages;
  if (status === "failed") {
    const label = stageLabel(currentRun.current_stage);
    const text = `运行失败：${label ? `${label} 阶段失败` : "运行终止"}${errorCode ? `（${errorCode}）` : ""}`;
    messages = [...messages, { id: `system-${messages.length}`, kind: "system", text }];
  }

  return {
    ...state,
    currentRun,
    messages,
    agentStreaming: false,
    finalReady: status === "done",
    artifactRefreshToken:
      status === "done" ? state.artifactRefreshToken + 1 : state.artifactRefreshToken,
  };
}

/**
 * `resync`：丢弃本地消息 / run / 阶段 / 产物缓存（保留项目与会话），置 `needsResync` 触发全量重拉。
 * @param state 当前状态
 * @returns 新状态
 */
function applyResync(state: WorkbenchState): WorkbenchState {
  return {
    ...state,
    currentRun: null,
    stages: sevenStages(),
    artifacts: null,
    messages: [],
    agentStreaming: false,
    needsResync: true,
    finalReady: false,
  };
}

/**
 * 依据单帧 SSE 事件推进工作台状态（纯函数）。
 * @param state 当前状态
 * @param frame SSE 帧（type 为事件名，data 为载荷）
 * @returns 新状态；未知事件类型原样返回
 */
export function applyEvent(state: WorkbenchState, frame: SseFrame): WorkbenchState {
  const data = (frame.data ?? {}) as Record<string, unknown>;
  switch (frame.type) {
    case "text_delta":
      return applyTextDelta(state, String(data.text ?? ""));
    case "tool_start":
      return applyToolStart(state, data);
    case "tool_end":
      return applyToolEnd(state, data);
    case "turn_end":
      return applyTurnEnd(state);
    case "run_start":
      return applyRunStart(state, data);
    case "run_stage":
      return applyRunStage(state, data);
    case "review_gate":
      return applyReviewGate(state, data);
    case "run_end":
      return applyRunEnd(state, data);
    case "resync":
      return applyResync(state);
    case "error":
      return {
        ...state,
        lastError: {
          code: String(data.code ?? "UNKNOWN"),
          message: String(data.message ?? "未知错误"),
        },
      };
    default:
      return state;
  }
}
