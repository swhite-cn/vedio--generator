import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUDIO_CUES_RELATIVE_PATH,
  audioCuesDocSchema,
  buildAudioCuesDoc,
  readAudioCues,
  splitNarrationIntoCues,
  writeAudioCues,
} from "../../packages/pipeline/src/audio-cues";

describe("音频 cue 构建", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("按标点拆句并按字符比例分配时长，尾句吃掉余量", () => {
    const cues = splitNarrationIntoCues("第一句。第二句更长一些！", 1000, 3000, "sh-001");

    expect(cues).toHaveLength(2);
    expect(cues[0].startMs).toBe(1000);
    expect(cues[0].endMs).toBe(cues[1].startMs);
    expect(cues[1].endMs).toBe(4000);
    expect(cues[0].text).toBe("第一句。");
    expect(cues[1].text).toBe("第二句更长一些！");
    expect(cues.every((cue) => cue.kind === "narration")).toBe(true);
  });

  it("没有标点时只产出一条覆盖整镜的 cue", () => {
    const cues = splitNarrationIntoCues("没有标点的一句话", 0, 1500, "sh-002");
    expect(cues).toHaveLength(1);
    expect(cues[0].startMs).toBe(0);
    expect(cues[0].endMs).toBe(1500);
  });

  it("构造连续切点与 cue，并通过契约校验", () => {
    const doc = buildAudioCuesDoc({
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

    expect(audioCuesDocSchema.safeParse(doc).success).toBe(true);
    expect(doc.shots[0]).toMatchObject({ startMs: 0, endMs: 2000 });
    expect(doc.shots[1]).toMatchObject({ startMs: 2000, endMs: 5000 });
    expect(doc.cues.map((cue) => cue.cueId)).toEqual([
      "sh-001-cue-01",
      "sh-001-cue-02",
      "sh-002-cue-01",
    ]);
  });

  it("中文路径下可写回并读回", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-audio-cues-"));
    dirs.push(dir);
    const path = join(dir, "项目 甲", AUDIO_CUES_RELATIVE_PATH);
    const doc = buildAudioCuesDoc({
      timingSource: "estimated",
      shots: [
        {
          shotId: "sh-001",
          sceneId: "s1",
          audioPath: "audio/sh-001.mp3",
          durationMs: 1200,
          narration: "一句话。",
        },
      ],
    });
    writeAudioCues(path, doc);
    expect(readAudioCues(path)).toEqual(doc);
  });

  it("切点不连续时拒绝写入", () => {
    const doc = buildAudioCuesDoc({
      timingSource: "estimated",
      shots: [
        {
          shotId: "sh-001",
          sceneId: "s1",
          audioPath: "audio/sh-001.mp3",
          durationMs: 1000,
          narration: "一。",
        },
        {
          shotId: "sh-002",
          sceneId: "s1",
          audioPath: "audio/sh-002.mp3",
          durationMs: 1000,
          narration: "二。",
        },
      ],
    });
    const broken = structuredClone(doc);
    broken.shots[1].startMs += 1;
    expect(() => writeAudioCues(join(tmpdir(), "never-written.json"), broken)).toThrowError(
      /结构非法/,
    );
  });
});
