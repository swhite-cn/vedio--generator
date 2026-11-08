import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  parseCopyV2Json,
  writeCopyDocV2,
} from "../../packages/pipeline/src/index";
import {
  assetBindingCounts,
  parseVisualCategory,
} from "../../apps/server/src/domain/asset-binding";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "videoforge-asset-binding-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** 写入一份 v1 copy.json（无 contractVersion 字段）。 */
async function seedCopyV1(projectDir: string): Promise<void> {
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, "copy.json"),
    JSON.stringify({
      topic: "水银变黄金",
      style: "科普",
      title: "旧版文案",
      scenes: [
        {
          sceneId: "s1",
          title: "开场",
          narration: "第一句。",
          imagePrompt: "水银特写",
        },
      ],
    }),
    "utf-8",
  );
}

/**
 * 写入一份 v2 copy.json：
 * - 锚点 mercury 绑定 asset-anchor；
 * - sh-001 引用 asset-anchor（背景）+ asset-b；
 * - sh-002 引用 asset-anchor（符号）。
 */
async function seedCopyV2WithRefs(projectDir: string): Promise<void> {
  const copy = parseCopyV2Json(
    JSON.stringify({
      title: "水银变黄金",
      styleAnchors: [
        { key: "mercury", label: "水银", color: "#C9CED6", assetId: "asset-anchor" },
        { key: "gold", label: "黄金", color: "#E4B95B" },
      ],
      scenes: [
        {
          sceneId: "s1",
          chapterNo: 1,
          title: "开场",
          shots: [
            {
              shotId: "sh-001",
              narration: "第一句。",
              visualType: "image",
              assetRefs: [
                { assetId: "asset-anchor", role: "background" },
                { assetId: "asset-b", role: "overlay" },
              ],
            },
            {
              shotId: "sh-002",
              narration: "第二句。",
              visualType: "symbol",
              assetRefs: [{ assetId: "asset-anchor", role: "symbol" }],
            },
          ],
        },
      ],
    }),
    { topic: "水银变黄金", style: "科普", themeId: "documentary-dark" },
  );
  await writeCopyDocV2(join(projectDir, "copy.json"), copy);
}

describe("parseVisualCategory", () => {
  test("6 类合法分类逐一通过并原样返回", () => {
    const categories = [
      "ai-generated",
      "live-action",
      "archive-photo",
      "3d-render",
      "video-clip",
      "style-anchor",
    ];
    for (const category of categories) {
      expect(parseVisualCategory(category)).toBe(category);
    }
  });

  test("空值归一化为 undefined（不过滤）", () => {
    expect(parseVisualCategory(undefined)).toBeUndefined();
    expect(parseVisualCategory(null)).toBeUndefined();
    expect(parseVisualCategory("")).toBeUndefined();
  });

  test("非法分类抛 ASSET_INVALID 并列出可选值", () => {
    try {
      parseVisualCategory("not-a-category");
      expect.unreachable("应抛出 ASSET_INVALID");
    } catch (error) {
      expect((error as { code: string }).code).toBe("ASSET_INVALID");
      expect((error as Error).message).toContain("ai-generated");
    }
  });
});

describe("assetBindingCounts", () => {
  test("copy.json 不存在时返回空对象", () => {
    const projectDir = join(directory, "missing");
    expect(assetBindingCounts(projectDir)).toEqual({});
  });

  test("v1 copy 不计绑定数（返回空对象）", async () => {
    const projectDir = join(directory, "v1");
    await seedCopyV1(projectDir);
    expect(assetBindingCounts(projectDir)).toEqual({});
  });

  test("v2 copy 按锚点与镜头引用累计绑定数", async () => {
    const projectDir = join(directory, "v2");
    await seedCopyV2WithRefs(projectDir);
    // asset-anchor：锚点 1 次 + sh-001 1 次 + sh-002 1 次 = 3
    // asset-b：sh-001 1 次
    expect(assetBindingCounts(projectDir)).toEqual({
      "asset-anchor": 3,
      "asset-b": 1,
    });
  });
});
