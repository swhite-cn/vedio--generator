import { z } from "zod";
import { contractVersionSchema, findDuplicates } from "./common.js";

/** 时间戳来源：TTS 原生 / ASR 对齐 / 按字速估算。 */
export const TIMING_SOURCES = ["tts-native", "asr-aligned", "estimated"] as const;

/** 时间戳来源 schema。 */
export const timingSourceSchema = z.enum(TIMING_SOURCES);

/** 时间戳来源类型。 */
export type TimingSource = z.infer<typeof timingSourceSchema>;

/**
 * 镜头在时间轴上的切点；相邻镜头必须首尾相接。
 */
export const shotSpanSchema = z.object({
  // 镜头 ID，必须存在于 copy v2
  shotId: z.string().trim().min(1),
  // 所属叙事段落 ID
  sceneId: z.string().trim().min(1),
  // 起始毫秒
  startMs: z.number().int().min(0),
  // 结束毫秒
  endMs: z.number().int().min(0),
  // 时长毫秒
  durationMs: z.number().int().positive(),
});

/** 镜头切点类型。 */
export type ShotSpan = z.infer<typeof shotSpanSchema>;

/**
 * 旁白 cue：一句口播在时间轴上的起止，是字幕与审核定位的索引。
 */
export const narrationCueSchema = z.object({
  // cue 唯一 ID
  cueId: z.string().trim().min(1),
  // 所属镜头
  shotId: z.string().trim().min(1),
  // 固定为 narration
  kind: z.literal("narration"),
  // 起始毫秒（相对全片）
  startMs: z.number().int().min(0),
  // 结束毫秒（相对全片）
  endMs: z.number().int().min(0),
  // 口播文本
  text: z.string().trim().min(1),
});

/** 旁白 cue 类型。 */
export type NarrationCue = z.infer<typeof narrationCueSchema>;

/**
 * 动效 cue：固定 0.3–0.8 秒，只决定何时发生，不随时长拉伸。
 */
export const animationCueSchema = z.object({
  // cue 唯一 ID
  cueId: z.string().trim().min(1),
  // 所属镜头
  shotId: z.string().trim().min(1),
  // 固定为 animation
  kind: z.literal("animation"),
  // 触发时刻（相对全片）
  atMs: z.number().int().min(0),
  // 动效时长，范围 300–800ms
  durationMs: z.number().int().min(300).max(800),
  // 动效标识，例如 underline-sweep
  effect: z.string().trim().min(1),
});

/** cue 联合类型。 */
export const cueSchema = z.discriminatedUnion("kind", [narrationCueSchema, animationCueSchema]);

/** 动效 cue 类型。 */
export type AnimationCue = z.infer<typeof animationCueSchema>;

/** cue 类型。 */
export type CueV2 = z.infer<typeof cueSchema>;

/**
 * timeline.json v2：镜头切点 + 句级 cue + 动效触发点的唯一时间真相。
 */
export const timelineDocV2Schema = z
  .object({
    // 契约版本，必须为 2.0
    contractVersion: contractVersionSchema,
    // 帧率，范围 1–120
    fps: z.number().int().min(1).max(120),
    // 片尾停顿毫秒
    tailPauseMs: z.number().int().min(0),
    // 时间戳来源；降级必须在产物中可见
    timingSource: timingSourceSchema,
    // 全片总时长
    totalMs: z.number().int().positive(),
    // 镜头切点（按时间升序）
    shots: z.array(shotSpanSchema).min(1),
    // 句级/动效 cue
    cues: z.array(cueSchema),
  })
  .superRefine((doc, ctx) => {
    const shotIds = doc.shots.map((shot) => shot.shotId);
    const duplicatedShotIds = findDuplicates(shotIds);
    if (duplicatedShotIds.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `timeline.shots 的 shotId 重复：${duplicatedShotIds.join(", ")}`,
        path: ["shots"],
      });
    }

    const cueIds = doc.cues.map((cue) => cue.cueId);
    const duplicatedCueIds = findDuplicates(cueIds);
    if (duplicatedCueIds.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `timeline.cues 的 cueId 重复：${duplicatedCueIds.join(", ")}`,
        path: ["cues"],
      });
    }

    for (const [index, shot] of doc.shots.entries()) {
      if (shot.endMs - shot.startMs !== shot.durationMs) {
        ctx.addIssue({
          code: "custom",
          message: `镜头 ${shot.shotId} 的 durationMs 必须等于 endMs - startMs`,
          path: ["shots", index, "durationMs"],
        });
      }
      const next = doc.shots[index + 1];
      if (next && next.startMs !== shot.endMs) {
        ctx.addIssue({
          code: "custom",
          message: `镜头 ${shot.shotId} 与 ${next.shotId} 未首尾相接`,
          path: ["shots", index + 1, "startMs"],
        });
      }
    }

    const lastEndMs = doc.shots[doc.shots.length - 1]?.endMs ?? 0;
    if (doc.totalMs < lastEndMs) {
      ctx.addIssue({
        code: "custom",
        message: "totalMs 不能小于最后一个镜头的 endMs",
        path: ["totalMs"],
      });
    }

    const shotById = new Map(doc.shots.map((shot) => [shot.shotId, shot]));
    for (const [index, cue] of doc.cues.entries()) {
      const shot = shotById.get(cue.shotId);
      if (!shot) {
        ctx.addIssue({
          code: "custom",
          message: `cue ${cue.cueId} 引用了不存在的镜头 ${cue.shotId}`,
          path: ["cues", index, "shotId"],
        });
        continue;
      }
      if (cue.kind === "narration") {
        if (cue.endMs <= cue.startMs) {
          ctx.addIssue({
            code: "custom",
            message: `旁白 cue ${cue.cueId} 的 endMs 必须大于 startMs`,
            path: ["cues", index, "endMs"],
          });
        }
        if (cue.startMs < shot.startMs || cue.endMs > shot.endMs) {
          ctx.addIssue({
            code: "custom",
            message: `旁白 cue ${cue.cueId} 超出镜头 ${shot.shotId} 的时间范围`,
            path: ["cues", index],
          });
        }
      } else {
        const cueEnd = cue.atMs + cue.durationMs;
        if (cue.atMs < shot.startMs || cueEnd > shot.endMs) {
          ctx.addIssue({
            code: "custom",
            message: `动效 cue ${cue.cueId} 超出镜头 ${shot.shotId} 的时间范围`,
            path: ["cues", index],
          });
        }
      }
    }
  });

/** timeline.json v2 类型。 */
export type TimelineDocV2 = z.infer<typeof timelineDocV2Schema>;
