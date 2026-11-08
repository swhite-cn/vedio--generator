/**
 * 管理总览 4 指标口径（T405）：
 * - 注册用户 = 全部账号数；
 * - 项目总数 = 全站项目数；
 * - 本周运行 = 本地时区周一 00:00 起创建的 run；
 * - 运行成功率 = done / (done + failed)，保留 1 位小数；canceled 不计入分子/分母。
 *
 * 纯函数便于单测复算；HTTP 层只负责取数与序列化。
 */

/** 计算所需的最小 run 字段（结构兼容 shared `Run`）。 */
export interface OverviewRun {
  status: string;
  created_at: string;
}

/** 汇总入参。 */
export interface AdminOverviewInput {
  users: readonly unknown[];
  projects: readonly unknown[];
  runs: readonly OverviewRun[];
  /** 当前时间（测试注入）；缺省系统时间。 */
  now?: Date;
}

/** 4 个 KPI + 可复算口径。 */
export interface AdminOverviewSummary {
  totalUsers: number;
  totalProjects: number;
  runsThisWeek: number;
  successRate: number;
  basis: {
    doneRuns: number;
    failedRuns: number;
    canceledRuns: number;
    completedRuns: number;
    /** 本周起点（ISO 8601，本地时区周一 00:00）。 */
    weekStart: string;
    /** 成功率公式（固定文案，前端可直接展示）。 */
    formula: "done / (done + failed)";
  };
}

/** 成功率保留的小数位。 */
const SUCCESS_RATE_DIGITS = 1;

/**
 * 计算本地时区「本周一 00:00」的 ISO 时间。
 * @param now 当前时间；缺省系统时间
 * @returns ISO 8601 字符串
 */
export function startOfWeekIso(now: Date = new Date()): string {
  const start = new Date(now);
  const offset = (start.getDay() + 6) % 7; // 距周一的天数（0=周日）
  start.setDate(start.getDate() - offset);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

/**
 * 汇总管理页 4 个 KPI（口径固定，可复算）。
 * @param input 用户/项目/run 列表与可注入的当前时间
 * @returns KPI 与 basis
 */
export function summarizeAdminOverview(input: AdminOverviewInput): AdminOverviewSummary {
  const weekStart = startOfWeekIso(input.now);
  const doneRuns = input.runs.filter((run) => run.status === "done").length;
  const failedRuns = input.runs.filter((run) => run.status === "failed").length;
  const canceledRuns = input.runs.filter((run) => run.status === "canceled").length;
  const completedRuns = doneRuns + failedRuns;
  const successRate =
    completedRuns > 0
      ? Math.round((doneRuns / completedRuns) * 100 * 10 ** SUCCESS_RATE_DIGITS) /
        10 ** SUCCESS_RATE_DIGITS
      : 0;

  return {
    totalUsers: input.users.length,
    totalProjects: input.projects.length,
    runsThisWeek: input.runs.filter((run) => run.created_at >= weekStart).length,
    successRate,
    basis: {
      doneRuns,
      failedRuns,
      canceledRuns,
      completedRuns,
      weekStart,
      formula: "done / (done + failed)",
    },
  };
}
