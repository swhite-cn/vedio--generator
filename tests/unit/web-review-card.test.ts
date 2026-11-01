/**
 * 审核卡片交互逻辑纯函数单测（Web 专题 §5.4.2）。
 *
 * 覆盖 `buildResumePayload`（`POST /api/runs/:id/resume` 请求体构造）
 * 与 `canSubmitReview`（提交后置灰 / 提交中不可重复提交）两类判断。
 */
import { describe, expect, test } from "vitest";
import { buildResumePayload, canSubmitReview } from "../../apps/web/src/components/review-logic";

describe("buildResumePayload", () => {
  test("approve 结论仅携带 action", () => {
    expect(buildResumePayload("approve")).toEqual({ action: "approve" });
  });

  test("approve 忽略反馈文本", () => {
    expect(buildResumePayload("approve", "请再润色")).toEqual({ action: "approve" });
  });

  test("retry 且反馈非空时携带去空白后的 feedback", () => {
    expect(buildResumePayload("retry", "  台词再口语化一点  ")).toEqual({
      action: "retry",
      feedback: "台词再口语化一点",
    });
  });

  test("retry 但反馈为空或仅空白时仅携带 action", () => {
    expect(buildResumePayload("retry", "")).toEqual({ action: "retry" });
    expect(buildResumePayload("retry", "   ")).toEqual({ action: "retry" });
  });
});

describe("canSubmitReview", () => {
  test("未提交且不在提交中时可提交", () => {
    expect(canSubmitReview({})).toBe(true);
    expect(canSubmitReview({ resolved: null, submitting: false })).toBe(true);
  });

  test("已有结论时置灰不可提交", () => {
    expect(canSubmitReview({ resolved: "approve" })).toBe(false);
    expect(canSubmitReview({ resolved: "retry" })).toBe(false);
  });

  test("提交中不可重复提交", () => {
    expect(canSubmitReview({ submitting: true })).toBe(false);
  });
});
