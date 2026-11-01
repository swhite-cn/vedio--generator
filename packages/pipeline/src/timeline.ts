export interface SceneDuration {
  sceneId: string;
  durationMs: number;
}

export interface TimelineEntry extends SceneDuration {
  startMs: number;
  endMs: number;
}

/**
 * 根据实测旁白时长生成连续时间轴，并在末尾增加停顿。
 * @param scenes 场景实测时长
 * @param tailPauseMs 尾部停顿毫秒数
 * @returns 时间轴和总时长
 */
export function buildTimeline(
  scenes: SceneDuration[],
  tailPauseMs: number,
): { entries: TimelineEntry[]; totalMs: number } {
  let cursor = 0;
  const entries = scenes.map((scene) => {
    const entry = { ...scene, startMs: cursor, endMs: cursor + scene.durationMs };
    cursor = entry.endMs;
    return entry;
  });
  console.info(`[timeline] built ${entries.length} scenes, total ${cursor + tailPauseMs}ms`);
  return { entries, totalMs: cursor + tailPauseMs };
}
