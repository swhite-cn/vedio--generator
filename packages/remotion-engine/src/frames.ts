import type { TimelineDocV2 } from "@videoforge/shared";

/**
 * timeline v2 → Remotion 帧计划（T201 纯逻辑，可穷举单测）。
 * 契约保证 startMs/endMs 连续且 fps 来自输出 Profile；这里只做 ms → frame 的确定性换算，
 * 不做四舍五入纠偏（切点连续性由 T106 构建期保证）。
 */

/** 单个镜头的帧区间计划。 */
export interface ShotFramePlan {
  /** 镜头 ID。 */
  shotId: string;
  /** 所属场景 ID（trace/日志定位用）。 */
  sceneId: string;
  /** 起始帧（含）。 */
  fromFrame: number;
  /** 帧数（durationMs * fps / 1000，向下取整，至少 1 帧）。 */
  durationInFrames: number;
  /** 对应毫秒（透传，供日志与帧号回查）。 */
  startMs: number;
  durationMs: number;
}

/**
 * 把 timeline v2 换算为逐镜头帧计划。
 * @param timeline 已校验的 timeline v2
 * @returns 按时间轴顺序的帧计划；空 shots 返回空数组
 */
export function buildShotFramePlan(timeline: TimelineDocV2): ShotFramePlan[] {
  return timeline.shots.map((shot) => ({
    shotId: shot.shotId,
    sceneId: shot.sceneId,
    fromFrame: msToFrame(shot.startMs, timeline.fps),
    durationInFrames: Math.max(1, Math.floor((shot.durationMs * timeline.fps) / 1000)),
    startMs: shot.startMs,
    durationMs: shot.durationMs,
  }));
}

/**
 * 毫秒 → 帧号（向下取整）。
 * @param ms 毫秒（非负）
 * @param fps 帧率（正整数）
 * @returns 帧号
 */
export function msToFrame(ms: number, fps: number): number {
  return Math.max(0, Math.floor((ms * fps) / 1000));
}

/**
 * 按 shotIds 过滤帧计划（镜头级重渲入口）。
 * @param plan 全量帧计划
 * @param shotIds 目标镜头；缺省/空数组表示全部
 * @returns 过滤后的计划（保持原顺序）
 */
export function selectShotPlans(plan: readonly ShotFramePlan[], shotIds?: readonly string[]): ShotFramePlan[] {
  if (!shotIds || shotIds.length === 0) return [...plan];
  const wanted = new Set(shotIds);
  return plan.filter((entry) => wanted.has(entry.shotId));
}
