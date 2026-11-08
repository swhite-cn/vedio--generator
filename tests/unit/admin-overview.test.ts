import { describe, expect, test } from "vitest";
import {
  startOfWeekIso,
  summarizeAdminOverview,
} from "../../apps/server/src/domain/admin-overview";

/**
 * T405 管理 KPI 口径单测：
 * 固定四项指标定义，并验证成功率可由 basis 中的 done/failed/completed 复算。
 */

/** 固定“当前时间”（本地时区周日中午），避免测试依赖运行时刻。 */
const NOW = new Date(2026, 10, 8, 12, 0, 0);

/** 生成本地时区 ISO 时间。 */
function localIso(year: number, month: number, day: number, hour = 12): string {
  return new Date(year, month - 1, day, hour).toISOString();
}

describe("startOfWeekIso", () => {
  test("周日取前一个周一 00:00，周一取当天 00:00", () => {
    const sunday = startOfWeekIso(NOW);
    const expectedMonday = new Date(2026, 10, 2, 0, 0, 0, 0).toISOString();
    expect(sunday).toBe(expectedMonday);

    const monday = startOfWeekIso(new Date(2026, 10, 2, 9, 30));
    expect(monday).toBe(expectedMonday);
  });
});

describe("summarizeAdminOverview", () => {
  test("4 项指标口径固定，成功率 = done/(done+failed) 且 canceled 不计", () => {
    const weekStart = startOfWeekIso(NOW);
    const runs = [
      { status: "done", created_at: localIso(2026, 11, 3) },
      { status: "done", created_at: localIso(2026, 11, 4) },
      { status: "failed", created_at: localIso(2026, 11, 4) },
      { status: "failed", created_at: localIso(2026, 11, 5) },
      { status: "failed", created_at: localIso(2026, 11, 6) },
      { status: "canceled", created_at: localIso(2026, 11, 7) },
      { status: "running", created_at: localIso(2026, 11, 8) },
      // 上周：不计入本周，但计入总数与成功率
      { status: "done", created_at: localIso(2026, 10, 30) },
    ];

    const summary = summarizeAdminOverview({
      users: [{}, {}, {}],
      projects: [{}, {}],
      runs,
      now: NOW,
    });

    expect(summary.totalUsers).toBe(3);
    expect(summary.totalProjects).toBe(2);
    // 本周一 00:00 起：11-03 至 11-08 共 7 条，上周 1 条不计
    expect(summary.runsThisWeek).toBe(7);
    // done 3 / (done 3 + failed 3) = 50%
    expect(summary.successRate).toBe(50);
    expect(summary.basis).toEqual({
      doneRuns: 3,
      failedRuns: 3,
      canceledRuns: 1,
      completedRuns: 6,
      weekStart,
      formula: "done / (done + failed)",
    });
    // 成功率可由 basis 复算
    expect(summary.successRate).toBe(
      Math.round((summary.basis.doneRuns / summary.basis.completedRuns) * 1000) / 10,
    );
  });

  test("无已完成 run 时成功率为 0；1/3 保留一位小数", () => {
    expect(
      summarizeAdminOverview({
        users: [],
        projects: [],
        runs: [{ status: "running", created_at: localIso(2026, 11, 8) }],
        now: NOW,
      }).successRate,
    ).toBe(0);

    const oneThird = summarizeAdminOverview({
      users: [],
      projects: [],
      runs: [
        { status: "done", created_at: localIso(2026, 11, 3) },
        { status: "failed", created_at: localIso(2026, 11, 4) },
        { status: "failed", created_at: localIso(2026, 11, 5) },
      ],
      now: NOW,
    });
    expect(oneThird.successRate).toBe(33.3);
  });
});
