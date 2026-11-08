import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  VideoForgeError,
  timelineDocV2Schema,
  type CueV2,
  type TimelineDocV2,
} from "@videoforge/shared";
import type { AudioCuesDoc } from "./audio-cues.js";

/** timeline.json 相对项目目录的路径（POSIX `/`）。 */
export const TIMELINE_V2_RELATIVE_PATH = "timeline.json";

/** 构建 timeline v2 的入参。 */
export interface BuildTimelineV2Input {
  /** TTS 阶段产出的镜头切点与旁白 cue */
  audio: AudioCuesDoc;
  /** 帧率，来自输出 Profile */
  fps: number;
  /** 片尾停顿毫秒，来自配置 */
  tailPauseMs: number;
  /** 额外动效 cue（来自 SceneSpec）；必须落在所属镜头内 */
  extraCues?: CueV2[];
}

/**
 * 把音频 cue 升级为完整 timeline v2：补齐 fps、尾停顿与总时长。
 * 保留旁白 cue 时间不变，只追加动效 cue 并按时间排序。
 * @param input 音频 cue、帧率、尾停顿与可选动效 cue
 * @returns 合法 timeline v2
 * @throws VideoForgeError(`ADAPTER_PROTOCOL_INVALID`) 结果不满足契约时
 */
export function buildTimelineV2(input: BuildTimelineV2Input): TimelineDocV2 {
  const shots = input.audio.shots.map((shot) => ({
    shotId: shot.shotId,
    sceneId: shot.sceneId,
    startMs: shot.startMs,
    endMs: shot.endMs,
    durationMs: shot.durationMs,
  }));
  const cues: CueV2[] = [...input.audio.cues, ...(input.extraCues ?? [])];
  cues.sort((left, right) => {
    const leftAt = left.kind === "narration" ? left.startMs : left.atMs;
    const rightAt = right.kind === "narration" ? right.startMs : right.atMs;
    return leftAt - rightAt || left.cueId.localeCompare(right.cueId);
  });

  const lastEndMs = shots[shots.length - 1]?.endMs ?? 0;
  const candidate = {
    contractVersion: "2.0",
    fps: input.fps,
    tailPauseMs: input.tailPauseMs,
    timingSource: input.audio.timingSource,
    totalMs: lastEndMs + input.tailPauseMs,
    shots,
    cues,
  };
  const result = timelineDocV2Schema.safeParse(candidate);
  if (!result.success) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `timeline v2 结构非法：${result.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  return result.data;
}

/**
 * 读取并校验 timeline.json v2。
 * @param path 文件路径
 * @returns 合法时间轴
 * @throws VideoForgeError(`ADAPTER_PROTOCOL_INVALID`) 文件不可读或结构非法时
 */
export function readTimelineV2(path: string): TimelineDocV2 {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `timeline v2 解析失败：${path}（${(err as Error).message}）`,
    );
  }
  const result = timelineDocV2Schema.safeParse(raw);
  if (!result.success) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `timeline v2 结构非法：${path}（${result.error.issues[0]?.message ?? "unknown"}）`,
    );
  }
  return result.data;
}

/**
 * 校验后写 timeline.json v2，自动创建父目录。
 * @param path 输出路径
 * @param doc 时间轴
 */
export function writeTimelineV2(path: string, doc: TimelineDocV2): void {
  const result = timelineDocV2Schema.safeParse(doc);
  if (!result.success) {
    throw new VideoForgeError(
      "ADAPTER_PROTOCOL_INVALID",
      `timeline v2 结构非法：${path}（${result.error.issues[0]?.message ?? "unknown"}）`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(result.data, null, 2), "utf-8");
}
