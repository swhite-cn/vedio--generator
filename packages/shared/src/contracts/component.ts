import { z } from "zod";
import { findDuplicates } from "./common.js";

/** 版式组件类别；固定 7 类，不允许自创第 8 类。 */
export const COMPONENT_CATEGORIES = [
  "text",
  "data",
  "quote",
  "compare",
  "progress",
  "chapter",
  "source",
] as const;

/** 组件类别 schema。 */
export const componentCategorySchema = z.enum(COMPONENT_CATEGORIES);

/** 组件类别类型。 */
export type ComponentCategory = z.infer<typeof componentCategorySchema>;

/**
 * 需要来源标注的数据展示组件（T402）：
 * 质检「来源标签」与渲染层来源覆盖共用同一份清单，避免两处漂移。
 */
export const DATA_COMPONENT_IDS: ReadonlySet<string> = new Set([
  "data-card",
  "comparison-bars",
  "progress-ring",
]);

/** 组件参数类型。 */
export const COMPONENT_PARAM_TYPES = ["string", "number", "boolean", "enum"] as const;

/**
 * 单个组件参数的声明；用于装配期校验与组件库展示。
 */
export const componentParamSpecSchema = z
  .object({
    // 参数类型
    type: z.enum(COMPONENT_PARAM_TYPES),
    // 是否必填
    required: z.boolean().default(false),
    // 字符串最大长度
    maxLength: z.number().int().positive().optional(),
    // 数值最小值
    min: z.number().optional(),
    // 数值最大值
    max: z.number().optional(),
    // 枚举取值；type=enum 时必填
    enumValues: z.array(z.string().trim().min(1)).optional(),
    // 面向用户的参数说明
    description: z.string().trim().optional(),
  })
  .refine((spec) => spec.type !== "enum" || (spec.enumValues?.length ?? 0) > 0, {
    message: "type=enum 时必须提供 enumValues",
    path: ["enumValues"],
  })
  .refine((spec) => !spec.enumValues || findDuplicates(spec.enumValues).length === 0, {
    message: "enumValues 不能重复",
    path: ["enumValues"],
  });

/** 组件参数声明类型。 */
export type ComponentParamSpec = z.infer<typeof componentParamSpecSchema>;

/**
 * 组件注册表条目：LLM 只能按 ID 选型并填参数，不能输出 HTML。
 */
export const componentRegistryEntrySchema = z.object({
  // 组件 ID，例如 keyword-block
  id: z.string().trim().min(1),
  // 组件展示名，例如「关键词块」
  name: z.string().trim().min(1),
  // 固定类别
  category: componentCategorySchema,
  // 参考片占比说明，例如「参考片占比 28%」
  coverageNote: z.string().trim().optional(),
  // 参数声明表
  paramsSchema: z.record(z.string(), componentParamSpecSchema).default({}),
  // 可用动效标识
  animations: z.array(z.string().trim().min(1)).default([]),
  // 预览 fixture 相对路径
  previewFixture: z.string().trim().optional(),
});

/** 组件注册表条目类型。 */
export type ComponentRegistryEntry = z.infer<typeof componentRegistryEntrySchema>;

/**
 * 组件预览 fixture：组件库页面与 `/api/components/:id/preview` 的静态样例。
 * props 必须能通过对应条目的 paramsSchema 校验。
 */
export const componentPreviewFixtureSchema = z.object({
  // 组件 ID，必须与注册表条目一致
  componentId: z.string().trim().min(1),
  // 预览参数
  props: z.record(z.string(), z.unknown()).default({}),
});

/** 组件预览 fixture 类型。 */
export type ComponentPreviewFixture = z.infer<typeof componentPreviewFixtureSchema>;
