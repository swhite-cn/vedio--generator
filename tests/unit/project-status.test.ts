import { describe, expect, test } from "vitest";
import type { Run, RunStage, RunStatus } from "@videoforge/shared";
import { deriveProjectStatus } from "../../apps/server/src/domain/project-status";

/**
 * 构造一条用于状态推导的 run 测试夹具（只填推导所需字段）。
 * @param status run 状态
 * @param createdAt 创建时间（用于“取最近一条 run”的排序）
 * @returns Run 实例
 */
function makeRun(status: RunStatus, createdAt: string): Run {
  return {
    id: `run-${createdAt}-${status}`,
    project_id: "project-1",
    session_id: "session-1",
    status,
    trigger: "user",
    current_stage: null,
    error_code: null,
    created_at: createdAt,
    started_at: null,
    ended_at: null,
  };
}

/**
 * 构造一个空 run_stages 列表（当前推导未使用，仅验证入参可接受）。
 * @returns 空 RunStage 数组
 */
function noStages(): RunStage[] {
  return [];
}

describe("project-status 纯函数推导（§8.4）", () => {
  test("final.mp4 存在 → done（最高优先级，即使存在活跃/失败 run）", () => {
    expect(
      deriveProjectStatus({
        runs: [
          makeRun("failed", "2026-10-25T00:00:00.000Z"),
          makeRun("running", "2026-10-25T00:01:00.000Z"),
        ],
        runStages: noStages(),
        artifacts: { finalVideoExists: true },
      }),
    ).toBe("done");
  });

  test("无任何 run 且无成片 → draft", () => {
    expect(
      deriveProjectStatus({
        runs: [],
        runStages: noStages(),
        artifacts: { finalVideoExists: false },
      }),
    ).toBe("draft");
  });

  test("存在 queued 活跃 run → running", () => {
    expect(
      deriveProjectStatus({
        runs: [makeRun("queued", "2026-10-25T00:00:00.000Z")],
        runStages: noStages(),
        artifacts: { finalVideoExists: false },
      }),
    ).toBe("running");
  });

  test("存在 running 活跃 run → running", () => {
    expect(
      deriveProjectStatus({
        runs: [makeRun("running", "2026-10-25T00:00:00.000Z")],
        runStages: noStages(),
        artifacts: { finalVideoExists: false },
      }),
    ).toBe("running");
  });

  test("最近 run 为 waiting_review → review", () => {
    expect(
      deriveProjectStatus({
        runs: [makeRun("waiting_review", "2026-10-25T00:00:00.000Z")],
        runStages: noStages(),
        artifacts: { finalVideoExists: false },
      }),
    ).toBe("review");
  });

  test("最近 run 为 failed → failed", () => {
    expect(
      deriveProjectStatus({
        runs: [makeRun("failed", "2026-10-25T00:00:00.000Z")],
        runStages: noStages(),
        artifacts: { finalVideoExists: false },
      }),
    ).toBe("failed");
  });

  test("最近 run 为 done（无 final.mp4）→ review", () => {
    expect(
      deriveProjectStatus({
        runs: [makeRun("done", "2026-10-25T00:00:00.000Z")],
        runStages: noStages(),
        artifacts: { finalVideoExists: false },
      }),
    ).toBe("review");
  });

  test("最近 run 为 canceled → review", () => {
    expect(
      deriveProjectStatus({
        runs: [makeRun("canceled", "2026-10-25T00:00:00.000Z")],
        runStages: noStages(),
        artifacts: { finalVideoExists: false },
      }),
    ).toBe("review");
  });

  test("多个 run 取最近（created_at 降序）：后创建 failed 覆盖先前 done", () => {
    expect(
      deriveProjectStatus({
        runs: [
          makeRun("done", "2026-10-25T00:00:00.000Z"),
          makeRun("failed", "2026-10-25T01:00:00.000Z"),
        ],
        runStages: noStages(),
        artifacts: { finalVideoExists: false },
      }),
    ).toBe("failed");
  });

  test("多个 run 取最近：后创建 waiting_review 覆盖先前 failed（用户已重试）", () => {
    expect(
      deriveProjectStatus({
        runs: [
          makeRun("failed", "2026-10-25T00:00:00.000Z"),
          makeRun("waiting_review", "2026-10-25T01:00:00.000Z"),
        ],
        runStages: noStages(),
        artifacts: { finalVideoExists: false },
      }),
    ).toBe("review");
  });

  test("存在活跃 run 时优先于最近 run（即使更早创建）", () => {
    expect(
      deriveProjectStatus({
        runs: [
          makeRun("queued", "2026-10-25T00:00:00.000Z"),
          makeRun("failed", "2026-10-25T01:00:00.000Z"),
        ],
        runStages: noStages(),
        artifacts: { finalVideoExists: false },
      }),
    ).toBe("running");
  });
});
