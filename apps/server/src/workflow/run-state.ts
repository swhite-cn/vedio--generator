import type { RunStageStatus, RunStatus } from "@videoforge/shared";
import { VideoForgeError } from "@videoforge/shared";

// ---------------------------------------------------------------------------
// 工作流状态机（run 与 run_stages）的合法流转表，来源见设计文档 §6.2 / §8.4。
// 引擎与 HTTP 层在推进状态前统一调用本模块的断言，避免非法流转落到数据库。
// ---------------------------------------------------------------------------

/**
 * run 状态机合法流转表（冻结常量，见设计文档 §6.2）。
 * - `queued → running | canceled`
 * - `running → waiting_review | done | failed | canceled`
 * - `waiting_review → running | canceled`（`approve`/`retry` 均回到 `running`）
 * - `failed → running`（用户重试，从失败阶段续跑）
 * - `done` / `canceled` 为终态，无出边
 */
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = Object.freeze({
  queued: Object.freeze(["running", "canceled"] as const),
  running: Object.freeze(["waiting_review", "done", "failed", "canceled"] as const),
  waiting_review: Object.freeze(["running", "canceled"] as const),
  failed: Object.freeze(["running"] as const),
  done: Object.freeze([] as const),
  canceled: Object.freeze([] as const),
});

/**
 * 阶段（run_stages）状态机合法流转表（冻结常量，见设计文档 §6.2）。
 * - `pending → running | skipped`
 * - `running → done | failed`
 * - `failed → running`（重试，`attempt` 递增）
 * - `done` / `skipped` 为终态，无出边
 */
export const RUN_STAGE_TRANSITIONS: Readonly<Record<RunStageStatus, readonly RunStageStatus[]>> =
  Object.freeze({
    pending: Object.freeze(["running", "skipped"] as const),
    running: Object.freeze(["done", "failed"] as const),
    done: Object.freeze([] as const),
    failed: Object.freeze(["running"] as const),
    skipped: Object.freeze([] as const),
  });

/** 持有项目租约的活跃 run 状态（见设计文档 §8.4、§6.2）。 */
const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "queued",
  "running",
  "waiting_review",
]);

/** run 终态集合（无出边的状态，见设计文档 §6.2）。 */
const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(["done", "canceled"]);

/**
 * 判断 run 状态流转是否合法。
 * @param from 当前状态
 * @param to 目标状态
 * @returns 合法返回 `true`，否则 `false`
 */
export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

/**
 * 判断阶段状态流转是否合法。
 * @param from 当前状态
 * @param to 目标状态
 * @returns 合法返回 `true`，否则 `false`
 */
export function canTransitionStage(from: RunStageStatus, to: RunStageStatus): boolean {
  return RUN_STAGE_TRANSITIONS[from].includes(to);
}

/**
 * 断言 run 状态流转合法，非法时抛 `RUN_STATE_INVALID`（HTTP 409）。
 * @param from 当前状态
 * @param to 目标状态
 * @throws VideoForgeError(`RUN_STATE_INVALID`) 流转非法时（信息含 from/to）
 */
export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) {
    throw new VideoForgeError("RUN_STATE_INVALID", `Illegal run transition: ${from} -> ${to}`);
  }
}

/**
 * 断言阶段状态流转合法，非法时抛 `RUN_STATE_INVALID`（HTTP 409）。
 * @param from 当前状态
 * @param to 目标状态
 * @throws VideoForgeError(`RUN_STATE_INVALID`) 流转非法时（信息含 from/to）
 */
export function assertStageTransition(from: RunStageStatus, to: RunStageStatus): void {
  if (!canTransitionStage(from, to)) {
    throw new VideoForgeError("RUN_STATE_INVALID", `Illegal stage transition: ${from} -> ${to}`);
  }
}

/**
 * 判断 run 是否处于终态（`done` / `canceled`，无出边）。
 * @param status run 状态
 * @returns 终态返回 `true`，否则 `false`
 */
export function isRunTerminal(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/**
 * 判断 run 是否处于活跃态（持有项目租约，见设计文档 §8.4）。
 * 活跃 = `queued` / `running` / `waiting_review`。
 * @param status run 状态
 * @returns 活跃返回 `true`，否则 `false`
 */
export function isRunActive(status: RunStatus): boolean {
  return ACTIVE_RUN_STATUSES.has(status);
}
