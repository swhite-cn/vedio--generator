import type { Actor } from "@videoforge/shared";
import { VideoForgeError } from "@videoforge/shared";
import {
  findActiveRun,
  recoverInterruptedRuns as recoverInterruptedRunsInDb,
} from "../db/repositories/run-repository.js";

// ---------------------------------------------------------------------------
// 项目租约与启动恢复，见设计文档 §8.4 并发写保护。
// 租约语义由 `runs.status` 落库表达（单进程，无需额外内存 Map）；
// 活跃态（`queued`/`running`/`waiting_review`）均持有项目租约。
// ---------------------------------------------------------------------------

/**
 * 断言项目当前无活跃 run（持有项目租约）——创建 run 前的并发写保护。
 * 复用 `findActiveRun`（活跃 = `queued`/`running`/`waiting_review`，见设计文档 §8.4）。
 * @param db Drizzle 数据库实例
 * @param actor 请求主体（归属校验：仅检查 actor 自己的项目）
 * @param projectId 项目 ID
 * @throws VideoForgeError(`PROJECT_BUSY`) 项目已存在活跃 run 时
 */
export function assertProjectLease(db: any, actor: Actor, projectId: string): void {
  const active = findActiveRun(db, actor, projectId);
  if (active) {
    console.warn(
      `[workflow-lease] project busy: ${projectId} held by run ${active.id} (${active.status})`,
    );
    throw new VideoForgeError(
      "PROJECT_BUSY",
      `Project ${projectId} already has an active run: ${active.id} (${active.status})`,
    );
  }
}

/**
 * 启动恢复（见设计文档 §6.5、§8.4）：把 `running`（及残留 `queued`）的 run 置为
 * `canceled` 且 `error_code = 'INTERRUPTED'`，避免进程异常退出后项目被永久锁死；
 * `waiting_review` 不重置。系统启动专用、跨用户，无 actor 归属校验。
 * 实现委托给仓储的同名函数，保持单一实现。
 * @param db Drizzle 数据库实例
 * @returns 被重置为 `canceled` 的 run 条数
 */
export function recoverInterruptedRuns(db: any): number {
  return recoverInterruptedRunsInDb(db);
}
