import { z } from "zod";
import {
  assetRefSchema,
  contractVersionSchema,
  findDuplicates,
  sourceRefSchema,
  transitionSchema,
} from "./common.js";
import { visualTypeSchema } from "./copy.js";

/**
 * 单个固定时长动效：只允许 300–800ms，且不随镜头时长拉伸。
 */
export const animationSpecSchema = z.object({
  // 动效标识，例如 title-in / underline-sweep
  effect: z.string().trim().min(1),
  // 相对镜头开始的触发时刻
  atMs: z.number().int().min(0),
  // 固定动效时长，范围 300–800ms
  durationMs: z.number().int().min(300).max(800),
});

/** 动效规格类型。 */
export type AnimationSpec = z.infer<typeof animationSpecSchema>;

/**
 * 单镜头的视觉规格：组件 ID + 参数 + 资产 + 动效，HTML 不再是源头产物。
 */
export const shotSpecSchema = z.object({
  // 镜头 ID，必须存在于 copy v2
  shotId: z.string().trim().min(1),
  // 视觉类型，用于降级与质检判断
  visualType: visualTypeSchema,
  // 组件 ID；visualType=component 时必填
  componentId: z.string().trim().min(1).optional(),
  // 组件参数
  props: z.record(z.string(), z.unknown()).default({}),
  // 资产引用
  assetRefs: z.array(assetRefSchema).default([]),
  // 入场/出场转场
  transition: z.object({
    in: transitionSchema.default("hard-cut"),
    out: transitionSchema.default("hard-cut"),
  }),
  // 固定时长动效列表
  animations: z.array(animationSpecSchema).default([]),
  // 来源/免责信息
  source: sourceRefSchema.nullable().optional(),
});

/** 单镜头视觉规格类型。 */
export type ShotSpec = z.infer<typeof shotSpecSchema>;

/**
 * scene 阶段产物：结构与主题驱动的视觉规格集合，由模板层装配为渲染输入。
 */
export const sceneSpecSchema = z
  .object({
    // 契约版本，必须为 2.0
    contractVersion: contractVersionSchema,
    // 主题 ID
    themeId: z.string().trim().min(1),
    // 镜头规格列表
    shots: z.array(shotSpecSchema).min(1),
  })
  .superRefine((doc, ctx) => {
    const duplicatedShotIds = findDuplicates(doc.shots.map((shot) => shot.shotId));
    if (duplicatedShotIds.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `scene spec 的 shotId 重复：${duplicatedShotIds.join(", ")}`,
        path: ["shots"],
      });
    }

    for (const [index, shot] of doc.shots.entries()) {
      if (shot.visualType === "component" && !shot.componentId) {
        ctx.addIssue({
          code: "custom",
          message: `镜头 ${shot.shotId} 的 visualType=component 时必须提供 componentId`,
          path: ["shots", index, "componentId"],
        });
      }
    }
  });

/** scene 视觉规格类型。 */
export type SceneSpecV2 = z.infer<typeof sceneSpecSchema>;
