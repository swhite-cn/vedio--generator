import { describe, expect, test } from "vitest";
import { parseCopyV2Json } from "../../packages/pipeline/src/index";
import {
  anchorBoundShotIds,
  applyStyleAnchorPatch,
  applyStyleAnchorRebuild,
  assertAnchorKeyPathSafe,
} from "../../apps/server/src/domain/style-anchor-edit";

/**
 * 风格锚运营纯逻辑单测（T401）：
 * 覆盖绑定/解绑、seed 编辑、显式重建、引用镜头计算与非法输入。
 */

/** 构造含两个锚点的 copy v2 夹具：mercury 被 sh-001/sh-002 引用，gold 未被引用。 */
function makeCopy() {
  return parseCopyV2Json(
    JSON.stringify({
      title: "水银变黄金",
      styleAnchors: [
        {
          key: "mercury",
          label: "水银",
          color: "#C9CED6",
          assetId: "asset-old",
          assetPath: "assets/uploads/asset-old/anchor.png",
          seed: 7,
        },
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
              anchorKeys: ["mercury"],
            },
            {
              shotId: "sh-002",
              narration: "第二句。",
              visualType: "symbol",
              anchorKeys: ["mercury"],
            },
          ],
        },
        {
          sceneId: "s2",
          chapterNo: 2,
          title: "结尾",
          shots: [
            {
              shotId: "sh-003",
              narration: "第三句。",
              visualType: "image",
              anchorKeys: [],
            },
          ],
        },
      ],
    }),
    { topic: "水银变黄金", style: "科普", themeId: "documentary-dark" },
  );
}

/** 断言抛出指定错误码。 */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`应抛出 ${code}`);
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
  }
}

describe("anchorBoundShotIds", () => {
  test("按 copy 顺序返回引用锚点的镜头", () => {
    expect(anchorBoundShotIds(makeCopy(), "mercury")).toEqual(["sh-001", "sh-002"]);
    expect(anchorBoundShotIds(makeCopy(), "gold")).toEqual([]);
  });
});

describe("applyStyleAnchorPatch", () => {
  test("绑定资产并更新 seed，原文档不变", () => {
    const copy = makeCopy();
    const result = applyStyleAnchorPatch(copy, "mercury", {
      assetId: "asset-new",
      assetPath: "assets/uploads/asset-new/anchor.png",
      seed: 4242,
    });
    expect(result.before.assetId).toBe("asset-old");
    expect(result.after).toMatchObject({
      key: "mercury",
      assetId: "asset-new",
      assetPath: "assets/uploads/asset-new/anchor.png",
      seed: 4242,
    });
    // 入参保持不可变
    expect(copy.styleAnchors[0]?.assetId).toBe("asset-old");
    expect(result.copy.styleAnchors[0]?.assetId).toBe("asset-new");
  });

  test("解绑资产时同时清空路径与 assetId", () => {
    const result = applyStyleAnchorPatch(makeCopy(), "mercury", { assetId: null });
    expect(result.after.assetId).toBeUndefined();
    expect(result.after.assetPath).toBeUndefined();
  });

  test("seed 传 null 清除，label/color 可单独更新", () => {
    const result = applyStyleAnchorPatch(makeCopy(), "gold", {
      label: " 黄金 ",
      color: "#FFD700",
      seed: null,
    });
    expect(result.after.label).toBe("黄金");
    expect(result.after.color).toBe("#FFD700");
    expect(result.after.seed).toBeUndefined();
  });

  test("空补丁/未知锚点/非法 seed/孤立 assetPath 均报 CONFIG_INVALID", () => {
    expectCode(() => applyStyleAnchorPatch(makeCopy(), "mercury", {}), "CONFIG_INVALID");
    expectCode(() => applyStyleAnchorPatch(makeCopy(), "missing", { seed: 1 }), "CONFIG_INVALID");
    expectCode(
      () => applyStyleAnchorPatch(makeCopy(), "mercury", { seed: -1 }),
      "CONFIG_INVALID",
    );
    expectCode(
      () => applyStyleAnchorPatch(makeCopy(), "mercury", { seed: 1.5 }),
      "CONFIG_INVALID",
    );
    expectCode(
      () =>
        applyStyleAnchorPatch(makeCopy(), "mercury", {
          assetPath: "assets/x.png",
        }),
      "CONFIG_INVALID",
    );
  });

  test("颜色不合法时按契约拒绝", () => {
    expectCode(
      () => applyStyleAnchorPatch(makeCopy(), "gold", { color: "gold" }),
      "CONFIG_INVALID",
    );
  });
});

describe("applyStyleAnchorRebuild", () => {
  test("默认保留 seed，只清空资产绑定", () => {
    const result = applyStyleAnchorRebuild(makeCopy(), "mercury");
    expect(result.after.assetId).toBeUndefined();
    expect(result.after.assetPath).toBeUndefined();
    expect(result.after.seed).toBe(7);
  });

  test("传入新 seed 时覆盖，传 null 清除", () => {
    expect(applyStyleAnchorRebuild(makeCopy(), "mercury", 99).after.seed).toBe(99);
    expect(applyStyleAnchorRebuild(makeCopy(), "mercury", null).after.seed).toBeUndefined();
  });

  test("未知锚点报 CONFIG_INVALID", () => {
    expectCode(() => applyStyleAnchorRebuild(makeCopy(), "missing"), "CONFIG_INVALID");
  });
});

describe("assertAnchorKeyPathSafe", () => {
  test("拒绝路径分隔符与上跳", () => {
    expectCode(() => assertAnchorKeyPathSafe("../escape"), "CONFIG_INVALID");
    expectCode(() => assertAnchorKeyPathSafe("a/b"), "CONFIG_INVALID");
    expectCode(() => assertAnchorKeyPathSafe("a\\b"), "CONFIG_INVALID");
    expectCode(() => assertAnchorKeyPathSafe(" "), "CONFIG_INVALID");
  });

  test("合法 key 原样返回", () => {
    expect(assertAnchorKeyPathSafe("proton-red")).toBe("proton-red");
  });
});
