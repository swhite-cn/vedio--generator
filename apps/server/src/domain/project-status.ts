import type { ProjectStatus, Run, RunStage } from "@videoforge/shared";

/** 项目产物索引（由文件层扫描得到；`done` 的唯一判据是 `final.mp4` 存在）。 */
export interface ProjectArtifacts {
  /** 项目目录内是否存在 `final.mp4`。 */
  finalVideoExists: boolean;
}

/** 项目状态推导输入（纯数据，便于穷举测试）。 */
export interface ProjectStatusInput {
  /** 该项目下的全部 run（顺序无关，函数内部按 `created_at` 取最近一条）。 */
  runs: Run[];
  /** 该项目下全部 run 的阶段实例（当前推导未用到，保留入参供后续细化，如阶段耗时/失败定位）。 */
  runStages: RunStage[];
  artifacts: ProjectArtifacts;
}

/** 处于活跃态（持有项目租约）的 run 状态，见设计文档 §8.4。 */
const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);

/**
 * 推导项目状态（见设计文档 §8.4 项目状态机）。纯函数、无 IO、无数据库依赖。
 *
 * 优先级（自上而下命中即返回）：
 * 1. `final.mp4` 存在 → `done`（done 的唯一判据，见 §8.4）；
 * 2. 无任何 run → `draft`；
 * 3. 存在活跃 run（`queued` / `running`）→ `running`；
 * 4. 否则取最近一条 run（按 `created_at` 降序）判定：
 *    - `waiting_review` → `review`；
 *    - `failed` → `failed`；
 *    - `done` / `canceled`（run 已结束且项目内无 `final.mp4`）→ `review`。
 *
 * 说明：“最近 run 以 failed 收场且用户未重试”由“取最近一条 run”自然表达——用户重试会创建更新的 run。
 * @param input 项目状态推导输入
 * @returns 项目状态 `draft|running|review|done|failed`
 */
export function deriveProjectStatus(input: ProjectStatusInput): ProjectStatus {
  if (input.artifacts.finalVideoExists) return "done";
  if (input.runs.length === 0) return "draft";
  if (input.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status))) return "running";

  const latest = [...input.runs].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!latest) return "draft";

  switch (latest.status) {
    case "waiting_review":
      return "review";
    case "failed":
      return "failed";
    case "done":
    case "canceled":
      return "review";
    default:
      return "running";
  }
}
