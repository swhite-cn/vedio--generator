import { describe, expect, test } from "vitest";
import {
  RUN_STAGE_STATUSES,
  RUN_STATUSES,
  VideoForgeError,
  type RunStatus,
} from "@videoforge/shared";
import {
  RUN_STAGE_TRANSITIONS,
  RUN_TRANSITIONS,
  assertRunTransition,
  assertStageTransition,
  canTransitionRun,
  canTransitionStage,
  isRunActive,
  isRunTerminal,
} from "../../apps/server/src/workflow/run-state";

/**
 * run / 阶段状态机合法流转表单测（Phase 8 Step 1）。
 * 穷举全部 (from,to) 组合，断言合法性与 `RUN_STATE_INVALID` 抛出行为，
 * 并覆盖终态无出边与活跃态判定。
 */

/** 捕获函数抛出的异常，未抛出时返回 undefined。 */
function captureError(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

describe("run 状态机流转表", () => {
  test("穷举全部 (from,to) 组合：合法性与断言行为一致", () => {
    for (const from of RUN_STATUSES) {
      for (const to of RUN_STATUSES) {
        const legal = RUN_TRANSITIONS[from].includes(to);
        expect(canTransitionRun(from, to)).toBe(legal);
        if (legal) {
          expect(() => assertRunTransition(from, to)).not.toThrow();
        } else {
          const error = captureError(() => assertRunTransition(from, to));
          expect(error).toBeInstanceOf(VideoForgeError);
          expect((error as VideoForgeError).code).toBe("RUN_STATE_INVALID");
          const message = String((error as Error).message);
          expect(message).toContain(from);
          expect(message).toContain(to);
        }
      }
    }
  });

  test("流转表与设计文档 §6.2 逐条一致", () => {
    expect(RUN_TRANSITIONS.queued).toEqual(["running", "canceled"]);
    expect(RUN_TRANSITIONS.running).toEqual(["waiting_review", "done", "failed", "canceled"]);
    expect(RUN_TRANSITIONS.waiting_review).toEqual(["running", "canceled"]);
    expect(RUN_TRANSITIONS.failed).toEqual(["running"]);
  });

  test("终态 done / canceled 无出边", () => {
    expect(RUN_TRANSITIONS.done).toHaveLength(0);
    expect(RUN_TRANSITIONS.canceled).toHaveLength(0);
    for (const to of RUN_STATUSES) {
      expect(canTransitionRun("done", to)).toBe(false);
      expect(canTransitionRun("canceled", to)).toBe(false);
    }
  });
});

describe("阶段状态机流转表", () => {
  test("穷举全部 (from,to) 组合：合法性与断言行为一致", () => {
    for (const from of RUN_STAGE_STATUSES) {
      for (const to of RUN_STAGE_STATUSES) {
        const legal = RUN_STAGE_TRANSITIONS[from].includes(to);
        expect(canTransitionStage(from, to)).toBe(legal);
        if (legal) {
          expect(() => assertStageTransition(from, to)).not.toThrow();
        } else {
          const error = captureError(() => assertStageTransition(from, to));
          expect(error).toBeInstanceOf(VideoForgeError);
          expect((error as VideoForgeError).code).toBe("RUN_STATE_INVALID");
          const message = String((error as Error).message);
          expect(message).toContain(from);
          expect(message).toContain(to);
        }
      }
    }
  });

  test("流转表与设计文档 §6.2 逐条一致", () => {
    expect(RUN_STAGE_TRANSITIONS.pending).toEqual(["running", "skipped"]);
    expect(RUN_STAGE_TRANSITIONS.running).toEqual(["done", "failed"]);
    expect(RUN_STAGE_TRANSITIONS.failed).toEqual(["running"]);
    expect(RUN_STAGE_TRANSITIONS.done).toHaveLength(0);
    expect(RUN_STAGE_TRANSITIONS.skipped).toHaveLength(0);
  });

  test("终态 done / skipped 无出边", () => {
    for (const to of RUN_STAGE_STATUSES) {
      expect(canTransitionStage("done", to)).toBe(false);
      expect(canTransitionStage("skipped", to)).toBe(false);
    }
  });
});

describe("run 终态与活跃态判定", () => {
  test("isRunTerminal：仅 done / canceled 为终态", () => {
    const expected: Record<RunStatus, boolean> = {
      queued: false,
      running: false,
      waiting_review: false,
      done: true,
      failed: false,
      canceled: true,
    };
    for (const status of RUN_STATUSES) {
      expect(isRunTerminal(status)).toBe(expected[status]);
    }
  });

  test("isRunActive：queued / running / waiting_review 持有项目租约", () => {
    const expected: Record<RunStatus, boolean> = {
      queued: true,
      running: true,
      waiting_review: true,
      done: false,
      failed: false,
      canceled: false,
    };
    for (const status of RUN_STATUSES) {
      expect(isRunActive(status)).toBe(expected[status]);
    }
  });

  test("终态与活跃态互斥；failed 既非终态也非活跃", () => {
    for (const status of RUN_STATUSES) {
      expect(isRunActive(status) && isRunTerminal(status)).toBe(false);
    }
    expect(isRunActive("failed")).toBe(false);
    expect(isRunTerminal("failed")).toBe(false);
  });
});
