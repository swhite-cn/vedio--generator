import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { arkTtsToFile } from "../../packages/pipeline/src/ark-client";
import { readAudioCues } from "../../packages/pipeline/src/audio-cues";
import { readCopyDocument } from "../../packages/pipeline/src/copy-contract";
import { readGenerationRecords } from "../../packages/pipeline/src/manifest";
import { probeDurationMs } from "../../packages/pipeline/src/media";
import { generateSpeech } from "../../packages/pipeline/src/tts-generate";

vi.mock("../../packages/pipeline/src/ark-client", () => ({ arkTtsToFile: vi.fn() }));
vi.mock("../../packages/pipeline/src/media", () => ({ probeDurationMs: vi.fn() }));
vi.mock("../../packages/pipeline/src/env", () => ({ getArkApiKey: () => "test-key" }));

const mockedTts = vi.mocked(arkTtsToFile);
const mockedProbe = vi.mocked(probeDurationMs);
const repoRoot = process.cwd();
let projectDir: string;
let copyPath: string;

/** 写入一份两镜头 v2 copy 夹具。 */
function writeCopy(): void {
  writeFileSync(
    copyPath,
    JSON.stringify(
      {
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
              {
                shotId: "sh-001",
                narration: "第一句。第二句。",
                visualType: "component",
              },
              {
                shotId: "sh-002",
                narration: "第三句。",
                visualType: "image",
              },
            ],
          },
        ],
      },
      null,
      2,
    ),
    "utf-8",
  );
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "videoforge-tts-v2-"));
  copyPath = join(projectDir, "copy.json");
  writeCopy();
  mockedTts.mockReset();
  mockedTts.mockImplementation(async (options) => options.outputPath);
  mockedProbe.mockReset();
  mockedProbe.mockImplementation(async (_ffprobe, path) =>
    path.includes("sh-001") ? 2000 : 3000,
  );
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("v2 逐镜头配音与 cue", () => {
  test("全量合成后回填音频时长并产出连续 cue", async () => {
    const result = await generateSpeech({ rootDir: repoRoot, copyPath, runId: "run-tts" });

    expect(result.generated).toEqual(["sh-001", "sh-002"]);
    expect(mockedTts).toHaveBeenCalledTimes(2);

    const document = readCopyDocument(copyPath);
    if (document.version !== "2") throw new Error("fixture 必须是 v2");
    expect(document.doc.scenes[0].shots[0]).toMatchObject({
      audioPath: "audio/sh-001.mp3",
      audioDurationMs: 2000,
    });
    expect(document.doc.scenes[0].shots[1]).toMatchObject({
      audioPath: "audio/sh-002.mp3",
      audioDurationMs: 3000,
    });

    const cues = readAudioCues(join(projectDir, "audio", "cues.json"));
    expect(cues.timingSource).toBe("estimated");
    expect(cues.shots[0]).toMatchObject({ startMs: 0, endMs: 2000 });
    expect(cues.shots[1]).toMatchObject({ startMs: 2000, endMs: 5000 });
    expect(cues.cues.map((cue) => cue.cueId)).toEqual([
      "sh-001-cue-01",
      "sh-001-cue-02",
      "sh-002-cue-01",
    ]);

    const records = readGenerationRecords(projectDir);
    expect(records.every((record) => record.contractVersion === "2.0")).toBe(true);
    expect(records.map((record) => record.shotId)).toEqual(["sh-001", "sh-002"]);
  });

  test("定向重合成只更新目标镜头并重算全片 cue", async () => {
    await generateSpeech({ rootDir: repoRoot, copyPath });
    mockedTts.mockClear();
    mockedProbe.mockImplementation(async (_ffprobe, path) =>
      path.includes("sh-002") ? 2500 : 2000,
    );

    const result = await generateSpeech({
      rootDir: repoRoot,
      copyPath,
      shotIds: ["sh-002"],
    });

    expect(result.generated).toEqual(["sh-002"]);
    expect(mockedTts).toHaveBeenCalledTimes(1);

    const cues = readAudioCues(join(projectDir, "audio", "cues.json"));
    expect(cues.shots[0]).toMatchObject({ startMs: 0, endMs: 2000 });
    expect(cues.shots[1]).toMatchObject({ startMs: 2000, endMs: 4500 });
  });

  test("全新项目只跑单个镜头时拒绝，提示先全量运行", async () => {
    await expect(
      generateSpeech({ rootDir: repoRoot, copyPath, shotIds: ["sh-002"] }),
    ).rejects.toThrowError(/请先全量运行/);
  });

  test("未知 shotId 直接拒绝", async () => {
    await expect(
      generateSpeech({ rootDir: repoRoot, copyPath, shotIds: ["sh-999"] }),
    ).rejects.toThrowError(/未知的镜头 ID/);
    expect(mockedTts).not.toHaveBeenCalled();
  });
});
