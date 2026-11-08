import { VideoForgeError, type ShotSpec, type TimelineDocV2 } from "@videoforge/shared";

/**
 * 镜头预览切片（T208，Player 单镜头模式）。
 * 把 timeline v2 中目标镜头平移到 0ms 起，构造只含该镜头的 timeline——
 * Player 的 `<Player>` 以切片为输入，composition 无需支持时间平移，
 * 也保证 renderShots 的绝对帧号语义不受预览影响。
 */

/** 单镜头预览的完整切片：timeline + 该镜头的规格与图片映射。 */
export interface ShotSlice {
  /** 平移后的单镜头 timeline（startMs=0，cues 仅保留该镜头内）。 */
  timeline: TimelineDocV2;
  /** 目标镜头的规格；scene 未跑时为 undefined。 */
  specShot: ShotSpec | undefined;
}

/**
 * 切出单镜头预览输入。
 * @param timeline 全片 timeline v2
 * @param shotId 目标镜头 ID
 * @param specShots SceneSpec 镜头规格（可选，用于带出组件参数）
 * @returns 单镜头切片
 * @throws VideoForgeError(`CONFIG_INVALID`) 目标镜头不在时间轴内
 */
export function sliceTimelineForShot(
  timeline: TimelineDocV2,
  shotId: string,
  specShots?: ShotSpec[] | null,
): ShotSlice {
  const shot = timeline.shots.find((candidate) => candidate.shotId === shotId);
  if (!shot) {
    throw new VideoForgeError("CONFIG_INVALID", `镜头不在时间轴内：${shotId}`);
  }
  const offset = shot.startMs;
  return {
    timeline: {
      ...timeline,
      totalMs: shot.durationMs,
      shots: [{ ...shot, startMs: 0, endMs: shot.durationMs }],
      // cue 时间同步平移；越出镜头的 cue（理论不存在）丢弃
      cues: timeline.cues
        .filter((cue) => {
          const start = cue.kind === "narration" ? cue.startMs : cue.atMs;
          return start >= shot.startMs && start < shot.endMs;
        })
        .map((cue) =>
          cue.kind === "narration"
            ? { ...cue, startMs: cue.startMs - offset, endMs: cue.endMs - offset }
            : { ...cue, atMs: cue.atMs - offset },
        ),
    },
    specShot: specShots?.find((spec) => spec.shotId === shotId),
  };
}
