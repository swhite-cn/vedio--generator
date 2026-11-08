import { describe, expect, it } from "vitest";
import { parseCopyV2Json } from "../../packages/pipeline/src/copy-generate";

/** 最小合法 v2 模型输出：2 个镜头、1 个章节、2 个风格锚。 */
const VALID_OUTPUT = {
  title: "水银如何变成黄金",
  styleAnchors: [
    { key: "mercury", label: "水银", color: "#C9CED6" },
    { key: "gold", label: "黄金", color: "#E2B53E" },
  ],
  scenes: [
    {
      sceneId: "s1",
      chapterNo: 1,
      title: "开场钩子",
      shots: [
        {
          shotId: "sh-001",
          narration: "把水银原子核里的质子敲掉一个。",
          onScreenText: "水银 → 黄金",
          emphasis: ["水银", "黄金"],
          visualType: "component",
          assetRefs: [],
          transitionIn: "hard-cut",
          transitionOut: "hard-cut",
          sourceRef: { label: "CERN 公开资料" },
        },
        {
          shotId: "sh-002",
          narration: "这不是炼金术，是核物理。",
          onScreenText: "不是炼金术，是核物理",
          visualType: "image",
        },
      ],
    },
  ],
};

describe("copy v2 模型输出解析", () => {
  it("容忍 ```json 围栏，并注入契约版本与主题", () => {
    const text = `\`\`\`json\n${JSON.stringify(VALID_OUTPUT)}\n\`\`\``;
    const doc = parseCopyV2Json(text, {
      topic: "水银变黄金",
      style: "硬核科普",
      themeId: "documentary-dark",
    });

    expect(doc.contractVersion).toBe("2.0");
    expect(doc.topic).toBe("水银变黄金");
    expect(doc.style).toBe("硬核科普");
    expect(doc.theme.id).toBe("documentary-dark");
    expect(doc.scenes[0].shots).toHaveLength(2);
    expect(doc.scenes[0].shots[0].component).toBeUndefined();
  });

  it("未指定主题时使用兜底主题", () => {
    const doc = parseCopyV2Json(JSON.stringify(VALID_OUTPUT), {
      topic: "topic",
      style: "style",
    });
    expect(doc.theme.id).toBe("documentary-dark");
  });

  it("非 JSON 输出抛 ADAPTER_PROTOCOL_INVALID", () => {
    expect(() =>
      parseCopyV2Json("这不是 JSON", { topic: "t", style: "s" }),
    ).toThrowError(/ADAPTER_PROTOCOL_INVALID/);
  });

  it("缺少 shots 的输出被拒绝", () => {
    const broken = {
      ...VALID_OUTPUT,
      scenes: [{ sceneId: "s1", title: "空章节", shots: [] }],
    };
    expect(() =>
      parseCopyV2Json(JSON.stringify(broken), { topic: "t", style: "s" }),
    ).toThrowError(/v2 结构非法/);
  });

  it("shotId 重复的输出被拒绝", () => {
    const broken = structuredClone(VALID_OUTPUT);
    broken.scenes[0].shots[1].shotId = "sh-001";
    expect(() =>
      parseCopyV2Json(JSON.stringify(broken), { topic: "t", style: "s" }),
    ).toThrowError(/shotId 必须全片唯一/);
  });
});
