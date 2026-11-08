import { z } from "zod";
import {
  assetRefSchema,
  contractVersionSchema,
  findDuplicates,
  sourceRefSchema,
  styleAnchorSchema,
  transitionSchema,
} from "./common.js";

/** 镜头的视觉类型：组件版式 / 图片 / 视频 / 符号图形。 */
export const VISUAL_TYPES = ["component", "image", "video", "symbol"] as const;

/** 视觉类型 schema。 */
export const visualTypeSchema = z.enum(VISUAL_TYPES);

/**
 * 组件选择：只允许「组件 ID + 参数」，禁止 LLM 输出原始 HTML。
 * 参数由组件注册表在 scene 阶段校验。
 */
export const componentSelectionSchema = z.object({
  // 组件注册表中的组件 ID，例如 keyword-block
  id: z.string().trim().min(1),
  // 组件参数；键值由具体组件 schema 定义
  params: z.record(z.string(), z.unknown()).default({}),
});

/** 组件选择类型。 */
export type ComponentSelection = z.infer<typeof componentSelectionSchema>;

/**
 * 最小视觉单位：一句或短句口播对应一个镜头。
 * 时长不写死在这里，由 TimelineDoc 的 cue 推导。
 */
export const shotSchema = z.object({
  // 全片唯一镜头号，稳定不变；建议 sh-001 形式
  shotId: z.string().trim().min(1),
  // 本镜口播文本，必填
  narration: z.string().trim().min(1),
  // 屏幕文字；可超过 18 字，但会被字幕/版式质检拦截
  onScreenText: z.string().trim().default(""),
  // 需要强调的词，供模板下划线/变色使用
  emphasis: z.array(z.string().trim().min(1)).default([]),
  // 视觉类型
  visualType: visualTypeSchema,
  // visualType=component 时必填
  component: componentSelectionSchema.optional(),
  // 本镜使用的项目资产引用
  assetRefs: z.array(assetRefSchema).default([]),
  // 本镜复用的风格锚 key（对应 styleAnchors[].key）
  anchorKeys: z.array(z.string().trim().min(1)).default([]),
  // 可选：image 阶段生成/复用后的项目内相对路径；由流水线回填
  imagePath: z.string().trim().min(1).optional(),
  // 可选：tts 阶段生成后的项目内音频相对路径；由流水线回填
  audioPath: z.string().trim().min(1).optional(),
  // 可选：tts 阶段实测的音频时长（毫秒）；由流水线回填
  audioDurationMs: z.number().int().positive().optional(),
  // 入场转场
  transitionIn: transitionSchema.default("hard-cut"),
  // 出场转场
  transitionOut: transitionSchema.default("hard-cut"),
  // 来源/免责信息；数据类镜头必须提供
  sourceRef: sourceRefSchema.nullable().optional(),
  // 建议时长（毫秒），仅供提示，不参与最终时间轴
  targetDurationMs: z.number().int().min(1000).max(15000).optional(),
});

/** 镜头类型。 */
export type ShotV2 = z.infer<typeof shotSchema>;

/**
 * 叙事段落/章节：只做分组与章节点，不再是渲染单位。
 */
export const sceneV2Schema = z.object({
  // 场景（章节）ID，段内唯一即可
  sceneId: z.string().trim().min(1),
  // 章节序号，从 1 开始；用于章节角标
  chapterNo: z.number().int().min(1).optional(),
  // 章节标题
  title: z.string().trim().min(1),
  // 至少一个镜头
  shots: z.array(shotSchema).min(1),
});

/** 场景类型。 */
export type SceneV2 = z.infer<typeof sceneV2Schema>;

/**
 * copy.json v2：内容层唯一真相，供 image/scene/tts/storyboard/captions 消费。
 */
export const copyDocV2Schema = z
  .object({
    // 契约版本，必须为 2.0
    contractVersion: contractVersionSchema,
    // 视频主题
    topic: z.string().trim().min(1),
    // 风格提示
    style: z.string().trim().min(1),
    // 视频标题
    title: z.string().trim().min(1),
    // 主题引用；视觉 token 由主题层解析
    theme: z.object({ id: z.string().trim().min(1) }),
    // 风格锚列表
    styleAnchors: z.array(styleAnchorSchema).default([]),
    // 叙事段落列表
    scenes: z.array(sceneV2Schema).min(1),
  })
  .superRefine((doc, ctx) => {
    const shotIds = doc.scenes.flatMap((scene) => scene.shots.map((shot) => shot.shotId));
    const duplicatedShotIds = findDuplicates(shotIds);
    if (duplicatedShotIds.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `shotId 必须全片唯一，重复：${duplicatedShotIds.join(", ")}`,
        path: ["scenes"],
      });
    }

    // copy 阶段只表达"这一镜想用组件版式"，真正选型在 scene 阶段；
    // 因此 component 允许为空，由 SceneSpec 的 componentId 做最终强校验。

    const duplicatedAnchorKeys = findDuplicates(doc.styleAnchors.map((anchor) => anchor.key));
    if (duplicatedAnchorKeys.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `styleAnchors.key 必须唯一，重复：${duplicatedAnchorKeys.join(", ")}`,
        path: ["styleAnchors"],
      });
    }
  });

/** copy.json v2 类型。 */
export type CopyDocV2 = z.infer<typeof copyDocV2Schema>;
