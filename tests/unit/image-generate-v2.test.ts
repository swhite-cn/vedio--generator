import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { arkGenerateImage } from "../../packages/pipeline/src/ark-client";
import { readCopyDocument } from "../../packages/pipeline/src/copy-contract";
import {
  buildShotImagePrompt,
  generateImages,
  stableSeed,
} from "../../packages/pipeline/src/image-generate";
import { readGenerationRecords } from "../../packages/pipeline/src/manifest";
import type { ShotV2, StyleAnchor } from "../../packages/shared/src/index";

// Ark 与密钥全部 mock：只验证镜头范围、锚点复用与落盘
vi.mock("../../packages/pipeline/src/ark-client", () => ({ arkGenerateImage: vi.fn() }));
vi.mock("../../packages/pipeline/src/env", () => ({ getArkApiKey: () => "test-key" }));

const mockedGenerate = vi.mocked(arkGenerateImage);
const repoRoot = process.cwd();
let projectDir: string;
let copyPath: string;

/** 写入一份三镜头 v2 copy 夹具；sh-002 为单符号镜头。 */
function writeCopy(): void {
  const doc = {
    contractVersion: "2.0",
    topic: "水银变黄金",
    style: "硬核科普",
    title: "水银变黄金",
    theme: { id: "documentary-dark" },
    styleAnchors: [
      { key: "mercury", label: "水银", color: "#C9CED6", assetId: "ast-mercury" },
      { key: "gold", label: "黄金", color: "#E2B53E", assetId: "ast-gold" },
    ],
    scenes: [
      {
        sceneId: "s1",
        chapterNo: 1,
        title: "开场",
        shots: [
          {
            shotId: "sh-001",
            narration: "把质子敲掉一个。",
            onScreenText: "水银 → 黄金",
            visualType: "component",
            anchorKeys: ["mercury"],
          },
          {
            shotId: "sh-002",
            narration: "水银球。",
            visualType: "symbol",
            anchorKeys: ["mercury"],
          },
          {
            shotId: "sh-003",
            narration: "实验室全景。",
            visualType: "image",
          },
        ],
      },
    ],
  };
  writeFileSync(copyPath, JSON.stringify(doc, null, 2), "utf-8");
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "videoforge-image-v2-"));
  copyPath = join(projectDir, "copy.json");
  writeCopy();
  mockedGenerate.mockReset();
  mockedGenerate.mockResolvedValue(Buffer.from("png"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("v2 逐镜头配图与风格锚复用", () => {
  test("锚点先生成一次，符号镜头直接复用锚点资产", async () => {
    const result = await generateImages({ rootDir: repoRoot, copyPath, runId: "run-v2" });

    // 锚点 1 次 + sh-001 1 次 + sh-003 1 次；sh-002 复制锚点，不再调用模型
    expect(mockedGenerate).toHaveBeenCalledTimes(3);
    expect(result.generated).toEqual(["sh-001", "sh-002", "sh-003"]);
    expect(existsSync(join(projectDir, "images", "anchors", "mercury.png"))).toBe(true);
    expect(existsSync(join(projectDir, "images", "sh-001.png"))).toBe(true);
    expect(existsSync(join(projectDir, "images", "sh-002.png"))).toBe(true);
    expect(existsSync(join(projectDir, "images", "sh-003.png"))).toBe(true);

    const document = readCopyDocument(copyPath);
    if (document.version !== "2") throw new Error("fixture 必须是 v2");
    expect(document.doc.styleAnchors[0].assetPath).toBe("images/anchors/mercury.png");
    expect(document.doc.styleAnchors[0].seed).toBe(stableSeed("anchor:mercury"));
    expect(document.doc.scenes[0].shots.map((shot) => shot.imagePath)).toEqual([
      "images/sh-001.png",
      "images/sh-002.png",
      "images/sh-003.png",
    ]);

    const records = readGenerationRecords(projectDir);
    expect(records.every((record) => record.contractVersion === "2.0")).toBe(true);
    expect(records.filter((record) => record.shotId).map((record) => record.shotId)).toEqual([
      "sh-001",
      "sh-002",
      "sh-003",
    ]);
  });

  test("shotIds 只生成目标镜头，其余镜头保持不动", async () => {
    const result = await generateImages({
      rootDir: repoRoot,
      copyPath,
      shotIds: ["sh-003"],
    });

    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    expect(result.generated).toEqual(["sh-003"]);
    expect(existsSync(join(projectDir, "images", "sh-001.png"))).toBe(false);
    expect(existsSync(join(projectDir, "images", "sh-003.png"))).toBe(true);

    const document = readCopyDocument(copyPath);
    if (document.version !== "2") throw new Error("fixture 必须是 v2");
    expect(document.doc.scenes[0].shots[0].imagePath).toBeUndefined();
    expect(document.doc.scenes[0].shots[2].imagePath).toBe("images/sh-003.png");
  });

  test("单独重生成符号镜头时先生成锚点再复用，不重复调用", async () => {
    await generateImages({ rootDir: repoRoot, copyPath, shotIds: ["sh-002"] });

    // 锚点生成 1 次；sh-002 复制，不再调用
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    expect(existsSync(join(projectDir, "images", "sh-002.png"))).toBe(true);
  });

  test("未知 shotId 直接拒绝", async () => {
    await expect(
      generateImages({ rootDir: repoRoot, copyPath, shotIds: ["sh-999"] }),
    ).rejects.toThrowError(/未知的镜头 ID/);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  test("promptOverride 搭配多个镜头时拒绝", async () => {
    await expect(
      generateImages({
        rootDir: repoRoot,
        copyPath,
        shotIds: ["sh-001", "sh-003"],
        promptOverride: "统一改成夜景",
      }),
    ).rejects.toThrowError(/CONFIG_INVALID/);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  test("mode=missing 时已存在的镜头图片不再生成", async () => {
    await generateImages({ rootDir: repoRoot, copyPath });
    mockedGenerate.mockClear();

    const result = await generateImages({
      rootDir: repoRoot,
      copyPath,
      mode: "missing",
    });

    expect(result.generated).toEqual([]);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  test("镜头提示词包含口播、锚点与无文字后缀", () => {
    const shot = {
      shotId: "sh-001",
      narration: "把质子敲掉一个。",
      onScreenText: "水银 → 黄金",
      emphasis: ["水银", "黄金"],
      visualType: "component",
      component: undefined,
      assetRefs: [],
      anchorKeys: ["mercury"],
      transitionIn: "hard-cut",
      transitionOut: "hard-cut",
      sourceRef: null,
    } satisfies ShotV2;
    const anchors: StyleAnchor[] = [{ key: "mercury", label: "水银", color: "#C9CED6" }];
    const prompt = buildShotImagePrompt(shot, anchors, "画面中绝对不要出现任何文字");

    expect(prompt).toContain("把质子敲掉一个");
    expect(prompt).toContain("水银（#C9CED6）");
    expect(prompt).toContain("不要出现任何文字");
    expect(stableSeed("same")).toBe(stableSeed("same"));
    expect(stableSeed("a")).not.toBe(stableSeed("b"));
  });
});
