import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  componentRegistryEntrySchema,
  copyDocV2Schema,
  qualityReportSchema,
  sceneSpecSchema,
  themeSchema,
  timelineDocV2Schema,
} from "../../packages/shared/src/index";

/** 契约 v2 fixture 所在目录。 */
const FIXTURE_DIR = join(__dirname, "..", "fixtures", "contracts-v2");

/**
 * 读取并解析一个 JSON fixture。
 * @param name fixture 文件名
 * @returns 解析后的任意 JSON
 */
function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf-8"));
}

/**
 * 深拷贝 fixture，避免用例之间互相污染。
 * @param value 原始值
 * @returns 深拷贝结果
 */
function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("CopyDoc v2", () => {
  it("fixture 可解析且字段完整", () => {
    const result = copyDocV2Schema.safeParse(loadFixture("copy-v2.json"));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scenes[0].shots).toHaveLength(2);
      expect(result.data.contractVersion).toBe("2.0");
    }
  });

  it("shotId 全片重复时拒绝", () => {
    const doc = clone(loadFixture("copy-v2.json")) as any;
    doc.scenes[0].shots[1].shotId = "sh-001";
    expect(copyDocV2Schema.safeParse(doc).success).toBe(false);
  });

  it("visualType=component 可省略 component，由 scene 阶段选型", () => {
    const doc = clone(loadFixture("copy-v2.json")) as any;
    delete doc.scenes[0].shots[0].component;
    expect(copyDocV2Schema.safeParse(doc).success).toBe(true);
  });

  it("风格锚 key 重复时拒绝", () => {
    const doc = clone(loadFixture("copy-v2.json")) as any;
    doc.styleAnchors[1].key = doc.styleAnchors[0].key;
    expect(copyDocV2Schema.safeParse(doc).success).toBe(false);
  });

  it("未知转场类型时拒绝", () => {
    const doc = clone(loadFixture("copy-v2.json")) as any;
    doc.scenes[0].shots[0].transitionIn = "wipe-left";
    expect(copyDocV2Schema.safeParse(doc).success).toBe(false);
  });
});

describe("TimelineDoc v2", () => {
  it("fixture 可解析且切点连续", () => {
    const result = timelineDocV2Schema.safeParse(loadFixture("timeline-v2.json"));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.shots[1].startMs).toBe(result.data.shots[0].endMs);
      expect(result.data.cues).toHaveLength(3);
    }
  });

  it("镜头切点不连续时拒绝", () => {
    const doc = clone(loadFixture("timeline-v2.json")) as any;
    doc.shots[1].startMs += 1;
    expect(timelineDocV2Schema.safeParse(doc).success).toBe(false);
  });

  it("cue 超出镜头范围时拒绝", () => {
    const doc = clone(loadFixture("timeline-v2.json")) as any;
    doc.cues[0].endMs = doc.shots[0].endMs + 100;
    expect(timelineDocV2Schema.safeParse(doc).success).toBe(false);
  });

  it("动效时长不在 300–800ms 时拒绝", () => {
    const doc = clone(loadFixture("timeline-v2.json")) as any;
    doc.cues[1].durationMs = 200;
    expect(timelineDocV2Schema.safeParse(doc).success).toBe(false);
  });

  it("cueId 重复时拒绝", () => {
    const doc = clone(loadFixture("timeline-v2.json")) as any;
    doc.cues[1].cueId = doc.cues[0].cueId;
    expect(timelineDocV2Schema.safeParse(doc).success).toBe(false);
  });
});

describe("SceneSpec v2", () => {
  it("fixture 可解析", () => {
    expect(sceneSpecSchema.safeParse(loadFixture("scene-spec-v2.json")).success).toBe(true);
  });

  it("component 镜头缺少 componentId 时拒绝", () => {
    const spec = clone(loadFixture("scene-spec-v2.json")) as any;
    delete spec.shots[0].componentId;
    expect(sceneSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("动效时长超过 800ms 时拒绝", () => {
    const spec = clone(loadFixture("scene-spec-v2.json")) as any;
    spec.shots[0].animations[0].durationMs = 900;
    expect(sceneSpecSchema.safeParse(spec).success).toBe(false);
  });
});

describe("QualityReport", () => {
  it("fixture 可解析且含 5 项", () => {
    const result = qualityReportSchema.safeParse(loadFixture("quality-report.json"));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.checks).toHaveLength(5);
  });

  it("缺少固定检查项时拒绝", () => {
    const report = clone(loadFixture("quality-report.json")) as any;
    report.checks.pop();
    expect(qualityReportSchema.safeParse(report).success).toBe(false);
  });
});

describe("Theme", () => {
  it("fixture 可解析", () => {
    expect(themeSchema.safeParse(loadFixture("theme.json")).success).toBe(true);
  });

  it("动效下界大于上界时拒绝", () => {
    const theme = clone(loadFixture("theme.json")) as any;
    theme.motion.min_duration_ms = 900;
    expect(themeSchema.safeParse(theme).success).toBe(false);
  });

  it("非法颜色时拒绝", () => {
    const theme = clone(loadFixture("theme.json")) as any;
    theme.tokens.accent = "yellow";
    expect(themeSchema.safeParse(theme).success).toBe(false);
  });
});

describe("ComponentRegistry", () => {
  it("合法组件条目可解析", () => {
    const entry = {
      id: "keyword-block",
      name: "关键词块",
      category: "text",
      paramsSchema: {
        title: { type: "string", required: true, maxLength: 18 },
        underline: { type: "enum", enumValues: ["none", "sweep", "grow"] },
      },
      animations: ["title-in", "underline-sweep"],
      previewFixture: "fixtures/keyword-block.json",
    };
    expect(componentRegistryEntrySchema.safeParse(entry).success).toBe(true);
  });

  it("enum 参数缺少 enumValues 时拒绝", () => {
    const entry = {
      id: "keyword-block",
      name: "关键词块",
      category: "text",
      paramsSchema: { underline: { type: "enum" } },
    };
    expect(componentRegistryEntrySchema.safeParse(entry).success).toBe(false);
  });
});
