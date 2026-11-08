import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAudioCuesDoc } from "../../packages/pipeline/src/audio-cues";
import {
  buildTimelineV2,
  readTimelineV2,
  writeTimelineV2,
} from "../../packages/pipeline/src/timeline-v2";

/** 构造两镜头音频 cue 文档。 */
function audioFixture() {
  return buildAudioCuesDoc({
    timingSource: "estimated",
    shots: [
      {
        shotId: "sh-001",
        sceneId: "s1",
        audioPath: "audio/sh-001.mp3",
        durationMs: 2000,
        narration: "第一句。第二句。",
      },
      {
        shotId: "sh-002",
        sceneId: "s1",
        audioPath: "audio/sh-002.mp3",
        durationMs: 3000,
        narration: "第三句。",
      },
    ],
  });
}

describe("Timeline v2 构建", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("补齐 fps、尾停顿与总时长，并保留旁白 cue", () => {
    const timeline = buildTimelineV2({
      audio: audioFixture(),
      fps: 30,
      tailPauseMs: 500,
    });

    expect(timeline.contractVersion).toBe("2.0");
    expect(timeline.fps).toBe(30);
    expect(timeline.tailPauseMs).toBe(500);
    expect(timeline.totalMs).toBe(5500);
    expect(timeline.shots.map((shot) => shot.shotId)).toEqual(["sh-001", "sh-002"]);
    expect(timeline.cues).toHaveLength(3);
    expect(timeline.timingSource).toBe("estimated");
  });

  it("追加动效 cue 并按时间排序", () => {
    const timeline = buildTimelineV2({
      audio: audioFixture(),
      fps: 30,
      tailPauseMs: 500,
      extraCues: [
        {
          cueId: "anim-1",
          shotId: "sh-001",
          kind: "animation",
          atMs: 300,
          durationMs: 400,
          effect: "underline-sweep",
        },
      ],
    });

    expect(timeline.cues).toHaveLength(4);
    expect(timeline.cues[0]).toMatchObject({ cueId: "sh-001-cue-01" });
    expect(timeline.cues[1]).toMatchObject({ cueId: "anim-1", atMs: 300 });
  });

  it("动效 cue 超出镜头范围时拒绝", () => {
    expect(() =>
      buildTimelineV2({
        audio: audioFixture(),
        fps: 30,
        tailPauseMs: 500,
        extraCues: [
          {
            cueId: "anim-bad",
            shotId: "sh-001",
            kind: "animation",
            atMs: 1800,
            durationMs: 600,
            effect: "title-in",
          },
        ],
      }),
    ).toThrowError(/ADAPTER_PROTOCOL_INVALID/);
  });

  it("非法帧率或负尾停顿时拒绝", () => {
    expect(() => buildTimelineV2({ audio: audioFixture(), fps: 0, tailPauseMs: 500 })).toThrowError(
      /ADAPTER_PROTOCOL_INVALID/,
    );
    expect(() =>
      buildTimelineV2({ audio: audioFixture(), fps: 30, tailPauseMs: -1 }),
    ).toThrowError(/ADAPTER_PROTOCOL_INVALID/);
  });

  it("中文路径下可写回并读回", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-timeline-v2-"));
    dirs.push(dir);
    const path = join(dir, "项目 甲", "timeline.json");
    const timeline = buildTimelineV2({ audio: audioFixture(), fps: 30, tailPauseMs: 500 });
    writeTimelineV2(path, timeline);
    expect(readTimelineV2(path)).toEqual(timeline);
  });

  it("写入非法时间轴时拒绝", () => {
    const timeline = buildTimelineV2({ audio: audioFixture(), fps: 30, tailPauseMs: 500 });
    const broken = { ...timeline, totalMs: 100 };
    expect(() => writeTimelineV2(join(tmpdir(), "never-written.json"), broken)).toThrowError(
      /结构非法/,
    );
  });
});
