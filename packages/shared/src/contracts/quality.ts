import { z } from "zod";

/** 质检项的固定 ID 集合（顺序即 UI 展示顺序）。 */
export const QUALITY_CHECK_IDS = [
  "freeze",
  "subtitle-overflow",
  "source-label",
  "contrast",
  "animation-duration",
] as const;

/** 质检项 ID 类型。 */
export type QualityCheckId = (typeof QUALITY_CHECK_IDS)[number];

/** 质检结论状态：通过 / 失败 / 警告 / 跳过。 */
export const QUALITY_STATUSES = ["pass", "fail", "warn", "skipped"] as const;

/** 质检结论状态 schema。 */
export const qualityStatusSchema = z.enum(QUALITY_STATUSES);

/** 质检结论状态类型。 */
export type QualityStatus = z.infer<typeof qualityStatusSchema>;

/**
 * 单条违规：必须尽量定位到镜头，供 UI 直接展示"#34 #57"。
 */
export const qualityViolationSchema = z.object({
  // 关联镜头 ID；无法定位到镜头时为空
  shotId: z.string().trim().min(1).optional(),
  // 人类可读的失败说明
  detail: z.string().trim().min(1),
});

/** 单条违规类型。 */
export type QualityViolation = z.infer<typeof qualityViolationSchema>;

/**
 * 单个质检项结论。
 */
export const qualityCheckSchema = z.object({
  // 固定检查项 ID
  id: z.enum(QUALITY_CHECK_IDS),
  // 面向用户的检查项名
  label: z.string().trim().min(1),
  // 结论
  status: qualityStatusSchema,
  // 违规列表；pass 时为空数组
  violations: z.array(qualityViolationSchema).default([]),
});

/** 单个质检项类型。 */
export type QualityCheck = z.infer<typeof qualityCheckSchema>;

/**
 * 质检报告：阶段钩子产出，落盘为 quality/report.json，并通过 trace 留痕。
 */
export const qualityReportSchema = z
  .object({
    // 报告版本，当前固定 1
    version: z.literal("1"),
    // 关联 run
    runId: z.string().trim().min(1),
    // 生成时间（ISO 8601）
    generatedAt: z.string().trim().min(1),
    // 5 个固定检查项
    checks: z.array(qualityCheckSchema),
  })
  .superRefine((report, ctx) => {
    const ids = report.checks.map((check) => check.id);
    const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicated.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `质检项重复：${[...new Set(duplicated)].join(", ")}`,
        path: ["checks"],
      });
    }
    const missing = QUALITY_CHECK_IDS.filter((id) => !ids.includes(id));
    if (missing.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `质检报告缺少检查项：${missing.join(", ")}`,
        path: ["checks"],
      });
    }
  });

/** 质检报告类型。 */
export type QualityReport = z.infer<typeof qualityReportSchema>;
