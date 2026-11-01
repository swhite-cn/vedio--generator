/**
 * 审核卡片交互逻辑（Web 专题 §5.4.2）。
 *
 * 把「payload 构造」与「可提交性判断」抽为纯函数，便于单元测试覆盖
 * （提交后置灰的语义在此集中定义，组件只做渲染）。
 */

/** 审核结论：`approve` 通过继续；`retry` 重跑此阶段。 */
export type ReviewAction = "approve" | "retry";

/** `POST /api/runs/:id/resume` 请求体（见服务端 `runs.ts` 契约）。 */
export interface ResumePayload {
  /** 结论。 */
  action: ReviewAction;
  /** 反馈文本（仅 `retry` 且非空时携带）。 */
  feedback?: string;
}

/**
 * 构造 `POST /api/runs/:id/resume` 的请求体。
 * `approve` 不携带反馈；`retry` 仅在反馈去空白后非空时携带（服务端仅识别 `approve`/`retry`）。
 * @param action 审核结论
 * @param feedback 可选反馈文本
 * @returns 请求体
 */
export function buildResumePayload(action: ReviewAction, feedback = ""): ResumePayload {
  const trimmed = feedback.trim();
  if (action === "retry" && trimmed.length > 0) {
    return { action, feedback: trimmed };
  }
  return { action };
}

/**
 * 判断审核结论是否可提交（提交后卡片置灰）。
 * @param input 可提交性输入
 * @returns 可提交返回 true
 */
export function canSubmitReview(input: {
  /** 已提交的结论（非空即置灰）。 */
  resolved?: ReviewAction | null;
  /** 是否正在提交。 */
  submitting?: boolean;
}): boolean {
  if (input.resolved) {
    return false;
  }
  return input.submitting !== true;
}
