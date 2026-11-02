import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { arkGenerateImage } from "../../packages/pipeline/src/ark-client";
import { generateImages } from "../../packages/pipeline/src/image-generate";
import { readGenerationRecords } from "../../packages/pipeline/src/manifest";

// Ark 与密钥全部 mock：本测试只验证「场景范围 → 实际调用」与提示词落盘
vi.mock("../../packages/pipeline/src/ark-client", () => ({ arkGenerateImage: vi.fn() }));
vi.mock("../../packages/pipeline/src/env", () => ({ getArkApiKey: () => "test-key" }));

const mockedGenerate = vi.mocked(arkGenerateImage);
/** 仓库根目录：真实读取 config/default.yaml（不依赖 .env.local） */
const repoRoot = process.cwd();
let projectDir: string;
let copyPath: string;

/** 写入一份三场景的 copy.json 夹具。 */
function writeCopy(): void {
  writeFileSync(
    copyPath,
    JSON.stringify(
      {
        topic: "测试主题",
        style: "科普",
        title: "测试标题",
        scenes: [
          { sceneId: "s1", title: "一", narration: "口播一", imagePrompt: "画面一" },
          { sceneId: "s2", title: "二", narration: "口播二", imagePrompt: "画面二" },
          { sceneId: "s3", title: "三", narration: "口播三", imagePrompt: "画面三" },
        ],
      },
      null,
      2,
    ),
    "utf-8",
  );
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "videoforge-image-scope-"));
  copyPath = join(projectDir, "copy.json");
  writeCopy();
  mockedGenerate.mockReset();
  mockedGenerate.mockResolvedValue(Buffer.from("png"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("配图定向生成", () => {
  test("只传 sceneIds 时仅重画该场景，其余图片保持不动", async () => {
    const result = await generateImages({ rootDir: repoRoot, copyPath, sceneIds: ["s2"] });

    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    expect(result.generated).toEqual(["s2"]);
    expect(existsSync(join(projectDir, "images", "s2.png"))).toBe(true);
    expect(existsSync(join(projectDir, "images", "s1.png"))).toBe(false);
    expect(existsSync(join(projectDir, "images", "s3.png"))).toBe(false);
  });

  test("promptOverride 只影响目标场景的实际提示词", async () => {
    await generateImages({
      rootDir: repoRoot,
      copyPath,
      sceneIds: ["s2"],
      promptOverride: "改成夜景霓虹街道",
    });

    const prompt = mockedGenerate.mock.calls[0][0].prompt;
    expect(prompt).toContain("改成夜景霓虹街道");
    expect(prompt).not.toContain("画面二");
  });

  test("每次生成都写入清单：包含完整提示词、模型、提示词集与模板快照", async () => {
    await generateImages({ rootDir: repoRoot, copyPath, sceneIds: ["s1"], runId: "run-9" });

    const records = readGenerationRecords(projectDir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      stage: "image",
      sceneId: "s1",
      assetPath: "images/s1.png",
      runId: "run-9",
      ok: true,
    });
    expect(records[0].prompt).toContain("画面一");
    expect(records[0].promptSha256).toBeTruthy();
    expect(records[0].templateSnapshot?.["image-suffix.txt"]).toBeTruthy();
  });

  test("重复生成同一场景会归档旧图并形成版本链", async () => {
    await generateImages({ rootDir: repoRoot, copyPath, sceneIds: ["s1"] });
    await generateImages({ rootDir: repoRoot, copyPath, sceneIds: ["s1"] });

    const [first, second] = readGenerationRecords(projectDir);
    expect(second.supersedesId).toBe(first.id);
    expect(existsSync(join(projectDir, "images", "history"))).toBe(true);
    const archived = readFileSync(join(projectDir, "images", "s1.png"));
    expect(archived.length).toBeGreaterThan(0);
  });

  test("mode=missing 时已存在的图片不再重复生成", async () => {
    await generateImages({ rootDir: repoRoot, copyPath, sceneIds: ["s1"] });
    mockedGenerate.mockClear();

    const result = await generateImages({
      rootDir: repoRoot,
      copyPath,
      sceneIds: ["s1"],
      mode: "missing",
    });

    expect(mockedGenerate).not.toHaveBeenCalled();
    expect(result.generated).toEqual([]);
  });

  test("promptOverride 搭配多个场景时拒绝执行", async () => {
    await expect(
      generateImages({
        rootDir: repoRoot,
        copyPath,
        sceneIds: ["s1", "s2"],
        promptOverride: "统一改成夜景",
      }),
    ).rejects.toThrowError(/CONFIG_INVALID/);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  test("未知场景 ID 直接拒绝，不产生任何调用", async () => {
    await expect(
      generateImages({ rootDir: repoRoot, copyPath, sceneIds: ["s9"] }),
    ).rejects.toThrowError(/CONFIG_INVALID/);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });
});
