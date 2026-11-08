import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { buildAudioCuesDoc, writeAudioCues } from "../../packages/pipeline/src/audio-cues";
import { writeCopyDocV2 } from "../../packages/pipeline/src/copy-contract";
import { probeDurationMs } from "../../packages/pipeline/src/media";
import { generateStoryboard } from "../../packages/pipeline/src/storyboard-generate";
import { readTimelineV2 } from "../../packages/pipeline/src/timeline-v2";
import type { CopyDocV2 } from "../../packages/shared/src/index";

vi.mock("../../packages/pipeline/src/media", () => ({ probeDurationMs: vi.fn() }));

const mockedProbe = vi.mocked(probeDurationMs);
const repoRoot = process.cwd();
let projectDir: string;
let copyPath: string;
let outFile: string;

/** v2 copy：两个镜头。 */
const COPY_V2: CopyDocV2 = {
  contractVersion: "2.0",
  topic: "水银变黄金",
  style: "硬核科普",
  title: "水银变黄金",
  theme: { id: "documentary-dark" },
  styleAnchors: [],
  scenes: [
    {
      sceneId: "s1",
      chapterNo: 1,
      title: "开场",
      shots: [
        { shotId: "sh-001", narration: "第一句。第二句。", onScreenText: "", emphasis: [], visualType: "component", assetRefs: [], anchorKeys: [], transitionIn: "hard-cut", transitionOut: "hard-cut" },
        { shotId: "sh-002", narration: "第三句。", onScreenText: "", emphasis: [], visualType: "image", assetRefs: [], anchorKeys: [], transitionIn: "hard-cut", transitionOut: "hard-cut" },
      ],
    },
  ],
};

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "videoforge-storyboard-v2-"));
  copyPath = join(projectDir, "copy.json");
  outFile = join(projectDir, "timeline.json");
  mockedProbe.mockReset();
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/** 写入 v2 copy 与对应音频 cue。 */
function seedV2(): void {
  writeCopyDocV2(copyPath, COPY_V2);
  writeAudioCues(
    join(projectDir, "audio", "cues.json"),
    buildAudioCuesDoc({
      timingSource: "estimated",
      shots: [
        { shotId: "sh-001", sceneId: "s1", audioPath: "audio/sh-001.mp3", durationMs: 2000, narration: "第一句。第二句。" },
        { shotId: "sh-002", sceneId: "s1", audioPath: "audio/sh-002.mp3", durationMs: 3000, narration: "第三句。" },
      ],
    }),
  );
}

describe("storyboard v2", () => {
  test("消费 audio/cues.json 产出镜头级 timeline v2", async () => {
    seedV2();
    const result = await generateStoryboard({
      rootDir: repoRoot,
      copyPath,
      outFile,
      profile: "LANDSCAPE_1080P",
    });

    expect(result.totalMs).toBe(5500);
    const timeline = readTimelineV2(outFile);
    expect(timeline.fps).toBe(30);
    expect(timeline.shots.map((shot) => shot.shotId)).toEqual(["sh-001", "sh-002"]);
    expect(timeline.cues).toHaveLength(3);
    expect(mockedProbe).not.toHaveBeenCalled();
  });

  test("缺少 audio/cues.json 时抛 ADAPTER_PROTOCOL_INVALID", async () => {
    writeCopyDocV2(copyPath, COPY_V2);
    await expect(
      generateStoryboard({ rootDir: repoRoot, copyPath, outFile }),
    ).rejects.toThrowError(/audio cues 解析失败/);
  });

  test("audio/cues.json 与 copy 镜头不一致时拒绝", async () => {
    writeCopyDocV2(copyPath, COPY_V2);
    writeAudioCues(
      join(projectDir, "audio", "cues.json"),
      buildAudioCuesDoc({
        timingSource: "estimated",
        shots: [
          { shotId: "sh-001", sceneId: "s1", audioPath: "audio/sh-001.mp3", durationMs: 2000, narration: "第一句。" },
        ],
      }),
    );
    await expect(
      generateStoryboard({ rootDir: repoRoot, copyPath, outFile }),
    ).rejects.toThrowError(/不一致/);
  });

  test("v1 copy 不再支持时间轴生成（T501 legacy 路径已移除）", async () => {
    writeFileSync(
      copyPath,
      JSON.stringify({
        topic: "黑洞",
        style: "科普",
        title: "黑洞",
        scenes: [
          { sceneId: "s1", title: "一", narration: "一", imagePrompt: "图一", audioPath: "audio/s1.mp3" },
          { sceneId: "s2", title: "二", narration: "二", imagePrompt: "图二", audioPath: "audio/s2.mp3" },
        ],
      }),
      "utf-8",
    );
    mockedProbe.mockResolvedValue(2500);

    await expect(
      generateStoryboard({ rootDir: repoRoot, copyPath, outFile }),
    ).rejects.toThrowError(/旧项目（copy\.json 契约版本 1\.0）/);
    // legacy 分支已删除：不应再调用 ffprobe 实测场景时长
    expect(mockedProbe).not.toHaveBeenCalled();
  });
});
