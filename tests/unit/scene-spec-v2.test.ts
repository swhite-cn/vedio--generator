import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  SCENE_SPEC_RELATIVE_PATH,
  buildShotSpecs,
  mergeSceneSpecShots,
  parseSceneSelectionJson,
  parseCopyV2Json,
  readSceneSpec,
  writeSceneSpec,
} from "../../packages/pipeline/src/index";

/**
 * 最小 copy v2：3 个镜头（component / image / component）。
 * 第 3 镜的 onScreenText 超过 18 字，用于验证降级截断。
 */
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
          narration: "把水银原子核里的质子敲掉一个。",
          onScreenText: "水银 → 黄金",
          emphasis: ["水银"],
          visualType: "component",
          anchorKeys: ["mercury"],
          transitionIn: "title-card",
          transitionOut: "fade-120",
          sourceRef: { label: "CERN 公开资料" },
        },
        {
          shotId: "sh-002",
          narration: "这不是炼金术，是核物理。",
          onScreenText: "不是炼金术",
          visualType: "image",
        },
        {
          shotId: "sh-003",
          narration: "中子在原子核里静静等待。",
          onScreenText: "中子在原子核里静静等待下一次衰变的过程",
          visualType: "component",
        },
      ],
    },
  ],
};

/** 用 copy 夹具解析出 v2 文档。 */
function buildCopy() {
  return parseCopyV2Json(JSON.stringify(COPY_OUTPUT), {
    topic: "水银变黄金",
    style: "硬核科普",
    themeId: "documentary-dark",
  });
}

describe("场景选型解析", () => {
  test("容忍 json 围栏并返回逐镜头选型", () => {
    const text = '```json\n{"shots":[{"shotId":"sh-001","componentId":"keyword-block","props":{"title":"水银"}}]}\n```';
    const selections = parseSceneSelectionJson(text);
    expect(selections).toEqual([
      { shotId: "sh-001", componentId: "keyword-block", props: { title: "水银" } },
    ]);
  });

  test("非 JSON 或结构非法抛 ADAPTER_PROTOCOL_INVALID", () => {
    expect(() => parseSceneSelectionJson("不是 JSON")).toThrowError(/ADAPTER_PROTOCOL_INVALID/);
    expect(() => parseSceneSelectionJson('{"shots":"none"}')).toThrowError(
      /ADAPTER_PROTOCOL_INVALID/,
    );
  });

  test("shotId 重复抛 ADAPTER_PROTOCOL_INVALID", () => {
    expect(() =>
      parseSceneSelectionJson(
        JSON.stringify({
          shots: [
            { shotId: "sh-001", componentId: "keyword-block", props: {} },
            { shotId: "sh-001", componentId: "data-card", props: {} },
          ],
        }),
      ),
    ).toThrowError(/重复/);
  });
});

describe("SceneSpec 装配", () => {
  test("合法选型装配为组件镜头，保留 copy 的转场与来源", () => {
    const copy = buildCopy();
    const { shots, fallbackShotIds } = buildShotSpecs({
      copy,
      selections: [
        { shotId: "sh-001", componentId: "keyword-block", props: { title: "水银 → 黄金" } },
      ],
    });

    // sh-003 未被模型选型，按缺失选型降级关键词块（同一降级口径）
    expect(fallbackShotIds).toEqual(["sh-003"]);
    expect(shots[0]).toMatchObject({
      shotId: "sh-001",
      visualType: "component",
      componentId: "keyword-block",
      transition: { in: "title-card", out: "fade-120" },
      source: { label: "CERN 公开资料" },
    });
    expect(shots[0]?.animations.every((animation) => animation.durationMs === 400)).toBe(true);
  });

  test("非 component 镜头不选组件，动效留空交渲染层默认策略", () => {
    const copy = buildCopy();
    const { shots } = buildShotSpecs({ copy, selections: [] });
    const imageShot = shots.find((shot) => shot.shotId === "sh-002");

    expect(imageShot).toMatchObject({ visualType: "image", animations: [], props: {} });
    expect(imageShot?.componentId).toBeUndefined();
  });

  test("未知组件 / 非法参数降级关键词块并截断标题", () => {
    const copy = buildCopy();
    const { shots, fallbackShotIds } = buildShotSpecs({
      copy,
      selections: [
        { shotId: "sh-001", componentId: "no-such", props: {} },
        { shotId: "sh-003", componentId: "data-card", props: { label: "只有标签" } },
      ],
    });

    expect(fallbackShotIds).toEqual(["sh-001", "sh-003"]);
    const degraded = shots.find((shot) => shot.shotId === "sh-003");
    expect(degraded).toMatchObject({ visualType: "component", componentId: "keyword-block" });
    const title = (degraded?.props as { title: string }).title;
    expect(Array.from(title)).toHaveLength(18);
  });

  test("scope 只装配指定镜头，其余不出现", () => {
    const copy = buildCopy();
    const { shots } = buildShotSpecs({ copy, selections: [], shotIds: ["sh-002"] });
    expect(shots.map((shot) => shot.shotId)).toEqual(["sh-002"]);
  });

  test("增量合并：替换同 ID 镜头、保留其余、追加新镜头", () => {
    const copy = buildCopy();
    const first = mergeSceneSpecShots(
      null,
      buildShotSpecs({ copy, selections: [], shotIds: ["sh-001", "sh-002"] }).shots,
      "documentary-dark",
    );
    const next = buildShotSpecs({ copy, selections: [], shotIds: ["sh-003"] }).shots;
    const merged = mergeSceneSpecShots(first, next, "documentary-dark");

    expect(merged.shots.map((shot) => shot.shotId)).toEqual(["sh-001", "sh-002", "sh-003"]);
    expect(merged.themeId).toBe("documentary-dark");
    expect(merged.contractVersion).toBe("2.0");
  });
});

describe("SceneSpec 落盘", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "videoforge-scene-spec-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("写入 scenes/spec.json 后可读回并保持结构", () => {
    const copy = buildCopy();
    const spec = mergeSceneSpecShots(
      null,
      buildShotSpecs({ copy, selections: [] }).shots,
      "documentary-dark",
    );
    writeSceneSpec(projectDir, spec);
    expect(readSceneSpec(projectDir)).toEqual(spec);
    expect(SCENE_SPEC_RELATIVE_PATH).toBe("scenes/spec.json");
  });

  test("文件缺失返回 null", () => {
    expect(readSceneSpec(projectDir)).toBeNull();
  });
});
