import { describe, expect, test } from "vitest";
import {
  buildShotSpecs,
  mergeSceneSpecShots,
  parseCopyV2Json,
} from "../../packages/pipeline/src/index";
import {
  applyShotPatch,
  applyShotPatchToSpec,
} from "../../apps/server/src/domain/shot-patch";

/** 最小 copy v2：2 个镜头（component + image）。 */
const COPY_OUTPUT = {
  title: "水银变黄金",
  styleAnchors: [{ key: "mercury", label: "水银", color: "#C9CED6" }],
  scenes: [
    {
      sceneId: "s1",
      chapterNo: 1,
      title: "开场",
      shots: [
        {
          shotId: "sh-001",
          narration: "第一句。",
          onScreenText: "水银 → 黄金",
          visualType: "component",
          transitionIn: "title-card",
          transitionOut: "hard-cut",
        },
        {
          shotId: "sh-002",
          narration: "第二句。",
          onScreenText: "不是炼金术",
          visualType: "image",
        },
      ],
    },
  ],
};

/** 解析 copy 夹具。 */
function buildCopy() {
  return parseCopyV2Json(JSON.stringify(COPY_OUTPUT), {
    topic: "水银变黄金",
    style: "科普",
    themeId: "documentary-dark",
  });
}

describe("镜头补丁：copy v2", () => {
  test("修改屏上文字与转场，返回 before/after 且原文档不变", () => {
    const copy = buildCopy();
    const original = structuredClone(copy);
    const result = applyShotPatch(copy, "sh-001", {
      onScreenText: "新的屏上文字",
      transitionOut: "fade-120",
    });

    expect(result.after).toMatchObject({
      shotId: "sh-001",
      onScreenText: "新的屏上文字",
      transitionOut: "fade-120",
    });
    expect(result.before.onScreenText).toBe("水银 → 黄金");
    expect(result.before.transitionOut).toBe("hard-cut");
    expect(copy).toEqual(original);
    expect(result.copy.scenes[0].shots[0]).toEqual(result.after);
  });

  test("强调词去重、去空并保持顺序", () => {
    const result = applyShotPatch(buildCopy(), "sh-001", {
      emphasis: [" 水银 ", "黄金", "水银", "  "],
    });
    expect(result.after.emphasis).toEqual(["水银", "黄金"]);
  });

  test("设置合法组件后 visualType 变为 component", () => {
    const result = applyShotPatch(buildCopy(), "sh-002", {
      component: { id: "data-card", params: { label: "命中率", value: "98.7" } },
    });
    expect(result.after).toMatchObject({
      visualType: "component",
      component: { id: "data-card" },
    });
  });

  test("未知组件或非法参数被拒绝，且不产生新文档", () => {
    const copy = buildCopy();
    expect(() =>
      applyShotPatch(copy, "sh-002", { component: { id: "no-such", params: {} } }),
    ).toThrowError(/未知组件/);
    expect(() =>
      applyShotPatch(copy, "sh-002", { component: { id: "data-card", params: { label: "缺值" } } }),
    ).toThrowError(/缺少必填参数 value/);
  });

  test("未知镜头、空补丁与非法来源/转场被拒绝", () => {
    const copy = buildCopy();
    expect(() => applyShotPatch(copy, "sh-999", { onScreenText: "x" })).toThrowError(/镜头不存在/);
    expect(() => applyShotPatch(copy, "sh-001", {})).toThrowError(/不能为空/);
    expect(() =>
      applyShotPatch(copy, "sh-001", { sourceRef: { label: "来源", url: "not-a-url" } }),
    ).toThrowError(/来源信息非法/);
    expect(() =>
      applyShotPatch(copy, "sh-001", { transitionIn: "wipe" as never }),
    ).toThrowError(/入场转场非法/);
  });

  test("来源信息可设置也可清空", () => {
    const withSource = applyShotPatch(buildCopy(), "sh-001", {
      sourceRef: { label: "CERN 公开资料", note: "数据截至 2024 年" },
    });
    expect(withSource.after.sourceRef).toMatchObject({ label: "CERN 公开资料" });

    const cleared = applyShotPatch(withSource.copy, "sh-001", { sourceRef: null });
    expect(cleared.after.sourceRef).toBeNull();
  });
});

describe("镜头补丁：SceneSpec 同步", () => {
  test("组件变化重新装配该镜头，其他镜头保持不变", () => {
    const copy = buildCopy();
    const spec = mergeSceneSpecShots(
      null,
      buildShotSpecs({ copy, selections: [] }).shots,
      copy.theme.id,
    );

    const applied = applyShotPatch(copy, "sh-001", {
      component: { id: "data-card", params: { label: "命中率", value: "98.7", unit: "%" } },
    });
    const next = applyShotPatchToSpec(spec, applied.before, applied.after, {
      animationDurationMs: 600,
    });

    expect(next.shots[0]).toMatchObject({
      shotId: "sh-001",
      componentId: "data-card",
      props: { label: "命中率", value: "98.7", unit: "%" },
    });
    expect(next.shots[0]?.animations.every((animation) => animation.durationMs === 600)).toBe(true);
    expect(next.shots[1]).toEqual(spec.shots[1]);
  });

  test("仅改转场/来源时直接覆盖 spec，不重装配动效", () => {
    const copy = buildCopy();
    const spec = mergeSceneSpecShots(
      null,
      buildShotSpecs({ copy, selections: [] }).shots,
      copy.theme.id,
    );
    const applied = applyShotPatch(copy, "sh-001", {
      transitionOut: "fade-120",
      sourceRef: { label: "示例来源" },
    });
    const next = applyShotPatchToSpec(spec, applied.before, applied.after);

    expect(next.shots[0]?.transition).toEqual({ in: "title-card", out: "fade-120" });
    expect(next.shots[0]?.source).toEqual({ label: "示例来源" });
    expect(next.shots[0]?.animations).toEqual(spec.shots[0]?.animations);
  });

  test("spec 中不存在该镜头时原样返回", () => {
    const copy = buildCopy();
    const spec = mergeSceneSpecShots(
      null,
      buildShotSpecs({ copy, selections: [], shotIds: ["sh-002"] }).shots,
      copy.theme.id,
    );
    const applied = applyShotPatch(copy, "sh-001", { onScreenText: "x" });
    expect(applyShotPatchToSpec(spec, applied.before, applied.after)).toBe(spec);
  });
});
