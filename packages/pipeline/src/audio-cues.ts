import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  VideoForgeError,
  contractVersionSchema,
  findDuplicates,
  narrationCueSchema,
  timingSourceSchema,
  type NarrationCue,
  type TimingSource,
} from "@videoforge/shared";

/** v2 音频 cue 文件相对项目目录的路径（POSIX `/`）。 */
export const AUDIO_CUES_RELATIVE_PATH = "audio/cues.json";

/**
 * 音频阶段产出的镜头切点：起止由实测音频时长累加得到。
 */
export const audioShotSpanSchema = z.object({
  // 镜头 ID
  shotId: z.string().trim().min(1),
  // 所属章节
  sceneId: z.string().trim().min(1),
  // 音频相对路径
  audioPath: z.string().trim().min(1),
  // 实测音频时长
  durationMs: z.number().int().positive(),
  // 全片起始毫秒
  startMs: z.number().int().min(0),
  // 全片结束毫秒
  endMs: z.number().int().min(0),
});

/** 音频镜头切点类型。 */
export type AudioShotSpan = z.infer<typeof audioShotSpanSchema>;

/**
 * audio/cues.json：TTS 阶段的中间时间真相，供 captions 与 storyboard 消费。
 */
export const audioCuesDocSchema = z
  .object({
    // 契约版本，必须 2.0
    contractVersion: contractVersionSchema,
    // 时间戳来源；无原生时间戳时为 estimated
    timingSource: timingSourceSchema,
    // 镜头切点
    shots: z.array(audioShotSpanSchema).min(1),
    // 旁白 cue
    cues: z.array(narrationCueSchema),
  })
  .superRefine((doc, ctx) => {
    const shotIds = doc.shots.map((shot) => shot.shotId);
    const duplicatedShots = findDuplicates(shotIds);
    if (duplicatedShots.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `audio cues 的 shotId 重复：${duplicatedShots.join(", ")}`,
        path: ["shots"],
      });
    }

    const cueIds = doc.cues.map((cue) => cue.cueId);
    const duplicatedCues = findDuplicates(cueIds);
    if (duplicatedCues.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `audio cues 的 cueId 重复：${duplicatedCues.join(", ")}`,
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
          message: `镜头 ${shot.shotId} 与 ${next.shotId} 的音频切点不连续`,
          path: ["shots", index + 1, "startMs"],
        });
      }
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
      if (cue.startMs < shot.startMs || cue.endMs > shot.endMs) {
        ctx.addIssue({
          code: "custom",
          message: `cue ${cue.cueId} 超出镜头 ${shot.shotId} 的音频范围`,
          path: ["cues", index],
        });
      }
    }
  });

/** 音频 cue 文档类型。 */
export type AudioCuesDoc = z.infer<typeof audioCuesDocSchema>;

/** 构造 cue 文档所需的镜头音频信息。 */
export interface AudioCueShotInput {
  shotId: string;
  sceneId: string;
  audioPath: string;
  durationMs: number;
  narration: string;
}

/**
 * 把一句口播按标点拆成逐句 cue，并按字符数分配音频时长。
 * 每段至少 1ms，最后一段吃掉舍入余量，保证总和等于镜头时长。
 * @param text 口播文本
 * @param startMs 镜头在全片中的起始毫秒
 * @param durationMs 镜头音频时长
 * @param shotId 所属镜头
 * @returns 旁白 cue 列表（相对全片时间）
 */
export function splitNarrationIntoCues(
  text: string,
  startMs: number,
  durationMs: number,
  shotId: string,
): NarrationCue[] {
  const segments = text
    .split(/(?<=[。！？；!?;])/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return [];

  const lengths = segments.map((segment) => Array.from(segment).length);
  const totalChars = lengths.reduce((total, length) => total + length, 0);
  let cursor = startMs;
  return segments.map((segment, index) => {
    const isLast = index === segments.length - 1;
    const remaining = startMs + durationMs - cursor;
    const allocated = isLast
      ? Math.max(1, remaining)
      : Math.max(1, Math.round((durationMs * lengths[index]) / totalChars));
    const cueStart = cursor;
    const cueEnd = isLast ? startMs + durationMs : Math.min(startMs + durationMs, cueStart + allocated);
    cursor = cueEnd;
    return {
      cueId: `${shotId}-cue-${String(index + 1).padStart(2, "0")}`,
      shotId,
      kind: "narration" as const,
      startMs: cueStart,
      endMs: cueEnd,
      text: segment,
    };
  });
}

/**
 * 按镜头顺序构造 audio/cues.json：切点连续，cue 由口播逐句拆分。
 * @param input 时间戳来源与全部镜头音频信息（顺序即全片顺序）
 * @returns 合法 cue 文档
 */
export function buildAudioCuesDoc(input: {
  timingSource: TimingSource;
  shots: AudioCueShotInput[];
}): AudioCuesDoc {
  let cursor = 0;
  const shots: AudioShotSpan[] = [];
  const cues: NarrationCue[] = [];
  for (const shot of input.shots) {
    const startMs = cursor;
    const endMs = startMs + shot.durationMs;
    cursor = endMs;
    shots.push({
      shotId: shot.shotId,
      sceneId: shot.sceneId,
      audioPath: shot.audioPath,
      durationMs: shot.durationMs,
      startMs,
      endMs,
    });
    cues.push(...splitNarrationIntoCues(shot.narration, startMs, shot.durationMs, shot.shotId));
  }
  return {
    contractVersion: "2.0",
    timingSource: input.timingSource,
    shots,
    cues,
  };
}

/**
 * 读取并校验 audio/cues.json。
 * @param path 文件路径
 * @returns 合法文档
 * @throws VideoForgeError(`ADAPTER_PROTOCOL_INVALID`) 文件不可读或结构非法时
 */
export function readAudioCues(path: string): AudioCuesDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `audio cues 解析失败：${path}（${(err as Error).message}）`,
    );
  }
  const result = audioCuesDocSchema.safeParse(raw);
  if (!result.success) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `audio cues 结构非法：${path}（${result.error.issues[0]?.message ?? "unknown"}）`,
    );
  }
  return result.data;
}

/**
 * 校验后写 audio/cues.json，自动创建父目录。
 * @param path 输出路径
 * @param doc 文档
 */
export function writeAudioCues(path: string, doc: AudioCuesDoc): void {
  const result = audioCuesDocSchema.safeParse(doc);
  if (!result.success) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `audio cues 结构非法：${path}（${result.error.issues[0]?.message ?? "unknown"}）`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(result.data, null, 2), "utf-8");
}
